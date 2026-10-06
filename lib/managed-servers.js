const fs = require("node:fs");
const path = require("node:path");
const { Emitter } = require("lumine");
const InstallApi = require("./install-api");
const InstallationStore = require("./installation-store");
const InstallationController = require("./installation-controller");
const ServerReleaseSources = require("./server-release-sources");
const { combinedSignal, abortable } = require("./installation-io");
const LATEST_CACHE_MS = 10 * 60 * 1000;
const BINARY_SEARCH_DEPTH = 3;
const NPM_PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const npmPackageEntry = (entry) => (typeof entry === "string" ? { name: entry } : entry);
function compareVersions(a, b) {
  const parse = (value) => {
    const normalized = String(value ?? "").replace(/^v/, "");
    const calendar = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (calendar) {
      return { parts: calendar.slice(1).map(Number), prerelease: null };
    }
    const separator = normalized.indexOf("-");
    const core = separator === -1 ? normalized : normalized.slice(0, separator);
    const prerelease = separator === -1 ? null : normalized.slice(separator + 1);
    return {
      parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      prerelease,
    };
  };
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference) return difference;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

// Adapter policy and staging sit here; the controller owns operation lifetime,
// the store owns filesystem transactions, and sources own transfer protocols.
module.exports = class ManagedServers {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.fetchUrl =
      options.fetchUrl || ((url, init) => fetch(url, { redirect: "follow", ...init }));
    this.fetchPolicy = options.fetchPolicy || {};
    this.storageRoot =
      options.storageRoot || path.join(lumine.getConfigDirPath(), "language-servers");
    this.store = new InstallationStore({ storageRoot: this.storageRoot });
    this.sources = new ServerReleaseSources({
      fetchUrl: (...args) => this.fetchUrl(...args),
      fetchPolicy: this.fetchPolicy,
    });
    this.latest = new Map();
    this.latestOwners = new Map();
    this.statuses = new Map();
    this.adapterScopes = new Map();
    this.emitter = new Emitter();
    this.disposed = false;
    this.controller = new InstallationController({
      assertActive: (adapter) => this.assertActive(adapter),
      acquire: (id, options) => this.store.acquire(id, options),
      setStatus: (id, status) => this.setInstallationStatus(id, status),
    });
    this.adapterSubscription = manager.onDidChangeAdapters(({ adapter, registered }) => {
      if (registered) return;
      this.controller.cancelAdapter(adapter);
      this.adapterScopes
        .get(adapter)
        ?.abort(new DOMException("The server adapter was unregistered", "AbortError"));
      this.adapterScopes.delete(adapter);
      this.latest.delete(adapter.id);
      this.latestOwners.delete(adapter.id);
    });
  }
  static manages(adapter) {
    return !!(adapter?.managedServer || typeof adapter?.installServer === "function");
  }
  get signal() {
    return this.controller.signal;
  }
  assertActive(adapter) {
    this.signal.throwIfAborted();
    if (
      this.disposed ||
      this.manager.tearingDown ||
      (adapter && this.manager.adapters.get(adapter.id) !== adapter)
    )
      throw new DOMException("The server installation owner is no longer active", "AbortError");
  }
  scopeSignal(adapter, signal) {
    this.assertActive(adapter);
    if (!this.adapterScopes.has(adapter)) this.adapterScopes.set(adapter, new AbortController());
    return combinedSignal(
      combinedSignal(this.signal, this.adapterScopes.get(adapter).signal),
      signal,
    );
  }
  adapters() {
    return [...this.manager.adapters.values()].filter(ManagedServers.manages);
  }
  adapterFor(id) {
    this.assertActive();
    const adapter = this.manager.adapters.get(id);
    if (!ManagedServers.manages(adapter))
      throw new Error(`'${id}' does not declare a managed language server`);
    return adapter;
  }
  onDidChangeInstallation(callback) {
    return this.emitter.on("did-change-installation", callback);
  }
  installationStatus(id) {
    return this.statuses.get(id) ?? null;
  }
  setInstallationStatus(id, status) {
    if (this.disposed) return;
    if (status) this.statuses.set(id, status);
    else this.statuses.delete(id);
    this.emitter.emit("did-change-installation", { adapterId: id, status: status ?? null });
  }
  apiFor(adapter, operation) {
    const signal = this.scopeSignal(adapter, operation?.signal);
    return new InstallApi(this, adapter, {
      signal,
      assertActive: () => {
        this.assertActive(adapter);
        operation?.assertActive();
      },
      setStatus: (status) => operation?.setStatus(status),
    });
  }
  directoryFor(adapter) {
    return this.store.directoryFor(adapter.id);
  }
  recordPath(adapter) {
    return path.join(this.directoryFor(adapter), "install.json");
  }
  installFor(adapter) {
    if (!ManagedServers.manages(adapter)) return null;
    return this.store.read(adapter.id, { allowEmptyPayload: !!adapter.bundledServer });
  }
  describe(adapter) {
    let installed, error;
    try {
      installed = this.installFor(adapter);
    } catch (failure) {
      error = failure.message;
    }
    const latest = this.latest.get(adapter.id);
    const descriptor = adapter.managedServer || {};
    return {
      adapter,
      displayName:
        descriptor.displayName || adapter.managedServerDisplayName || adapter.displayName,
      source: descriptor.source || "adapter",
      hasFallback: !!descriptor.bundled || !!adapter.bundledServer,
      installed: installed?.version || null,
      hasInstall: !!installed,
      available: latest?.version || null,
      updatable: !!(installed && latest && compareVersions(latest.version, installed.version) > 0),
      status: this.installationStatus(adapter.id) || (error ? "failed" : null),
      ...(error ? { broken: true, error } : {}),
    };
  }
  async latestVersion(adapter, { force = false, signal, operation } = {}) {
    signal = this.scopeSignal(adapter, operation?.signal || signal);
    const cached = this.latest.get(adapter.id);
    if (
      !force &&
      this.latestOwners.get(adapter.id) === adapter &&
      cached &&
      Date.now() - cached.fetchedAt < LATEST_CACHE_MS
    )
      return cached;
    let found;
    try {
      found =
        adapter.managedServer?.source === "npm"
          ? await this.latestFromNpm(adapter, { signal })
          : adapter.managedServer
            ? await this.latestFromGithub(adapter, { signal })
            : await this.latestFromAdapter(adapter, { signal, operation });
    } catch (error) {
      signal.throwIfAborted();
      this.assertActive(adapter);
      if (error?.name === "AbortError") throw error;
      return null;
    }
    signal.throwIfAborted();
    this.assertActive(adapter);
    if (!found) return null;
    const entry = { ...found, fetchedAt: Date.now() };
    this.latest.set(adapter.id, entry);
    this.latestOwners.set(adapter.id, adapter);
    return entry;
  }
  async latestFromGithub(adapter, options) {
    const release = await this.githubRelease(adapter.managedServer.repository, "latest", options);
    return release?.tag_name
      ? { version: String(release.tag_name).replace(/^v/, ""), tag: release.tag_name }
      : null;
  }
  async latestFromAdapter(adapter, { signal, operation } = {}) {
    const version = await abortable(
      adapter.latestServerVersion?.(this.apiFor(adapter, operation)),
      signal,
    );
    return version ? { version: String(version) } : null;
  }
  async latestFromNpm(adapter, options) {
    const { name } = npmPackageEntry(adapter.managedServer.packages[0]);
    const metadata = await this.npmMetadata(name, "latest", options);
    return metadata?.version ? { version: metadata.version } : null;
  }
  async install(id, options = {}) {
    const adapter = this.adapterFor(id);
    return this.controller.run(
      adapter,
      (operation, lease) => this.installWithin(adapter, options, operation, lease),
      options,
    );
  }
  async update(id, options = {}) {
    const adapter = this.adapterFor(id);
    return this.controller.run(
      adapter,
      async (operation, lease) => {
        operation.setStatus("checking");
        const latest = await this.latestVersion(adapter, { force: true, operation });
        operation.assertActive();
        const installed = this.store.read(adapter.id, {
          allowEmptyPayload: !!adapter.bundledServer,
          lease,
        });
        if (latest && installed && compareVersions(latest.version, installed.version) <= 0)
          return { upToDate: true, version: installed.version };
        return this.installWithin(adapter, options, operation, lease, latest);
      },
      options,
    );
  }
  async uninstall(id, options = {}) {
    const adapter = this.adapterFor(id);
    return this.controller.run(
      adapter,
      async (operation, lease) => {
        operation.setStatus("installing");
        await this.mutateInstallation(adapter, operation, async (stop) => {
          await stop();
          await lease.uninstall();
        });
      },
      options,
    );
  }
  async installWithin(adapter, { version } = {}, operation, lease, resolved) {
    operation.setStatus("checking");
    resolved = version
      ? { version, tag: version }
      : resolved || (await this.latestVersion(adapter, { force: true, operation }));
    operation.assertActive();
    if (!resolved && adapter.managedServer)
      throw new Error(
        `Could not find out which version of ${adapter.managedServer.displayName || adapter.displayName} to install. Check the network connection and try again.`,
      );
    const stage = await lease.createStage();
    operation.assertActive();
    operation.setStatus("downloading");
    const record = adapter.managedServer
      ? adapter.managedServer.source === "npm"
        ? await this.stageNpm(adapter, stage, resolved, operation)
        : await this.stageGithubRelease(adapter, stage, resolved, operation)
      : await this.stageFromAdapter(adapter, stage, resolved, operation);
    operation.assertActive();
    operation.setStatus("installing");
    await this.mutateInstallation(adapter, operation, (stop) =>
      lease.replace(record, {
        allowEmptyPayload: !!adapter.bundledServer,
        validate: stop,
      }),
    );
    operation.assertActive();
    return record;
  }
  async stageFromAdapter(adapter, stage, resolved, operation) {
    const returned = await adapter.installServer({
      storagePath: stage,
      version: resolved?.version ?? null,
      signal: operation.signal,
      api: this.apiFor(adapter, operation),
      adapter,
    });
    operation.assertActive();
    if (!returned?.binary && !returned?.module && !adapter.bundledServer)
      throw new Error(
        `${adapter.displayName} installed its server but did not say which file to launch; installServer must return a 'binary' or a 'module' path unless the adapter declares a bundledServer fallback.`,
      );
    return {
      ...returned,
      source: "adapter",
      version: returned?.version || resolved?.version || null,
      installedAt: new Date().toISOString(),
    };
  }
  async stageGithubRelease(adapter, stage, resolved, operation) {
    const descriptor = adapter.managedServer;
    const asset = descriptor.assetFor({
      platform: process.platform,
      arch: process.arch,
      version: resolved.version,
    });
    if (!asset)
      throw new Error(
        `${descriptor.displayName || adapter.displayName} publishes no build for ${process.platform}-${process.arch}.`,
      );
    if (typeof asset !== "string" || /[/\\\0]/.test(asset) || [".", ".."].includes(asset))
      throw new Error("The selected release asset must name one file inside staging.");

    const tag = resolved.tag || resolved.version;
    const url = `https://github.com/${descriptor.repository}/releases/download/${tag}/${asset}`;
    operation.assertActive();
    const payload = await this.download(url, `${descriptor.displayName} ${resolved.version}`, {
      signal: operation.signal,
    });
    await this.verify(payload, url, descriptor.checksum, { signal: operation.signal });

    if (descriptor.assetType === "binary") {
      const binary = descriptor.binary;
      const binaryPath = path.join(stage, binary);
      operation.assertActive();
      await fs.promises.writeFile(binaryPath, payload);
      operation.assertActive();
      if (process.platform !== "win32") await fs.promises.chmod(binaryPath, 0o755);
      return {
        source: "github-release",
        version: resolved.version,
        repository: descriptor.repository,
        asset,
        assetType: "binary",
        checksum: descriptor.checksum,
        binary,
        installedAt: new Date().toISOString(),
      };
    }

    const archivePath = path.join(stage, asset);
    operation.assertActive();
    await fs.promises.writeFile(archivePath, payload);
    operation.assertActive();
    operation.assertActive();
    await this.extract(archivePath, stage, asset, descriptor.strip ?? 0, {
      signal: operation.signal,
    });
    operation.assertActive();
    await this.remove(archivePath);
    operation.assertActive();

    const binary = this.locateBinary(stage, descriptor.binary);
    if (!binary) throw new Error(`The downloaded archive does not contain '${descriptor.binary}'.`);
    if (process.platform !== "win32") await fs.promises.chmod(path.join(stage, binary), 0o755);

    return {
      source: "github-release",
      version: resolved.version,
      repository: descriptor.repository,
      asset,
      assetType: "archive",
      checksum: descriptor.checksum,
      binary,
      installedAt: new Date().toISOString(),
    };
  }

  async stageNpm(adapter, stage, resolved, operation) {
    const descriptor = adapter.managedServer;
    const modules = path.join(stage, "node_modules");
    operation.assertActive();
    await fs.promises.mkdir(modules, { recursive: true });
    operation.assertActive();

    const installedPackages = [];
    let installedVersion = null;
    for (let index = 0; index < descriptor.packages.length; index++) {
      const entry = npmPackageEntry(descriptor.packages[index]);
      const { name } = entry;
      if (!NPM_PACKAGE.test(name))
        throw new Error(`The managed npm package name '${name}' is invalid.`);
      // The leading package follows the resolved server version. Companions
      // keep the historical `latest` default, while an object entry can pin a
      // compatible version or range explicitly.
      const wanted = entry.version || (index === 0 ? resolved.version : "latest");
      operation.assertActive();
      const metadata = await this.npmMetadata(name, wanted, { signal: operation.signal });
      if (index === 0) installedVersion = metadata.version;
      const tarball = metadata?.dist?.tarball;
      if (!tarball) throw new Error(`npm published no tarball for ${name}@${wanted}.`);

      operation.assertActive();
      const payload = await this.download(tarball, `${name} ${metadata.version}`, {
        signal: operation.signal,
      });
      this.verifyIntegrity(payload, metadata.dist.integrity, name, { signal: operation.signal });

      const target = path.join(modules, ...name.split("/"));
      operation.assertActive();
      await fs.promises.mkdir(target, { recursive: true });
      operation.assertActive();
      const archivePath = path.join(stage, `.${path.basename(name)}.tgz`);
      operation.assertActive();
      await fs.promises.writeFile(archivePath, payload);
      operation.assertActive();
      // Every npm tarball wraps its files in a single `package/` directory.
      operation.assertActive();
      await this.extract(archivePath, target, archivePath, 1, { signal: operation.signal });
      operation.assertActive();
      await this.remove(archivePath);
      operation.assertActive();

      // A tarball carries the package and nothing it depends on. Most language
      // servers have a real dependency tree, so unpacking alone would install
      // something that dies on its first `require` — npm is asked to complete
      // the tree, and only then. `pyright`, whose only dependency is an
      // optional one it works around, therefore still installs with no npm on
      // the machine at all.
      if (Object.keys(metadata.dependencies || {}).length) {
        operation.setStatus("installing");
        await this.apiFor(adapter, operation).npmInstallPackage(name, metadata.version, stage);
      }
      installedPackages.push(name);
    }

    return {
      source: "npm",
      version: installedVersion || resolved.version,
      packages: installedPackages,
      checksum: "npm-integrity",
      module: descriptor.module,
      installedAt: new Date().toISOString(),
    };
  }

  locateBinary(root, name, depth = BINARY_SEARCH_DEPTH) {
    if (!name) return null;
    const walk = (directory, relative, remaining) => {
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const entry of entries)
        if (entry.isFile() && entry.name === name) return path.join(relative, entry.name);
      if (remaining <= 1) return null;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = walk(
          path.join(directory, entry.name),
          path.join(relative, entry.name),
          remaining - 1,
        );
        if (found) return found;
      }
      return null;
    };
    return walk(root, "", depth);
  }

  async stopSessions(adapter, operation) {
    operation.assertActive();
    const sessions = [
      ...new Set([...this.manager.allSessions(), ...(this.manager.knownSessions?.() || [])]),
    ].filter((session) => session.adapter === adapter);
    const results = await Promise.allSettled(
      sessions.map((session) => this.manager.disconnect(session)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    operation.assertActive();
    if (sessions.some((session) => !this.manager.sessionPhysicallyExited(session)))
      throw new Error(
        `Cannot replace ${adapter.displayName}: its previous server process is still running.`,
      );
  }
  async mutateInstallation(adapter, operation, mutate) {
    let stopped = false,
      failed = true;
    try {
      await mutate(async () => {
        stopped = true;
        await this.stopSessions(adapter, operation);
        operation.assertActive();
      });
      failed = false;
    } finally {
      if (
        stopped &&
        !operation.signal.aborted &&
        !this.disposed &&
        this.manager.adapters.get(adapter.id) === adapter
      ) {
        // Failed stopping can leave a quarantined live process. Reattachment
        // remains guarded by the session controller and must not delay reporting
        // the installation error while waiting for that process to exit.
        if (failed) this.manager.scheduleReattachAll();
        else await this.manager.reattachAll();
      }
    }
  }
  remove(target) {
    return fs.promises.rm(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
  sweep() {
    this.assertActive();
    return this.store.sweep({ signal: this.signal });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.dispose();
    this.adapterSubscription.dispose();
    this.statuses.clear();
    this.latest.clear();
    this.latestOwners.clear();
    this.emitter.dispose();
  }
};

// Thin public primitives remain observable for adapter hooks and specs; every
// implementation and its cancellation rules live in the source component.
for (const [name, position] of Object.entries({
  githubRelease: 2,
  githubReleases: 1,
  npmMetadata: 2,
  download: 2,
  verify: 3,
  verifyIntegrity: 3,
  verifyDigest: 3,
  extract: 4,
  extractZip: 3,
})) {
  module.exports.prototype[name] = function (...args) {
    this.assertActive();
    const options = args[position] || {};
    const signal = combinedSignal(this.signal, options.signal);
    signal.throwIfAborted();
    args[position] = { ...options, signal };
    this.sources.fetchPolicy = this.fetchPolicy;
    return this.sources[name](...args);
  };
}
module.exports.prototype.toRelease = function (...args) {
  return this.sources.toRelease(...args);
};
module.exports.compareVersions = compareVersions;
module.exports.parseSidecar = ServerReleaseSources.parseSidecar;
module.exports.npmPackageEntry = npmPackageEntry;
