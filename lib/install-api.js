const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { abortable, combinedSignal } = require("./installation-io");

// The capabilities an adapter needs to fetch its own server.
//
// Modelled on `zed_extension_api`, whose names these mirror, and for the same
// reason: a descriptor can only describe the shapes it was designed for, and an
// adapter whose server does not fit one — several binaries, a dependency tree,
// a release layout nobody anticipated — would otherwise have no way in at all.
//
// The declarative `managedServer` descriptor stays the default and is written
// in terms of these same calls, so the two paths cannot drift: whatever an
// adapter does here, it stages, swaps and reports exactly as the built-in path
// does.
//
// One deliberate difference from Zed: the descriptor path verifies every
// download against the checksum its source publishes, and `downloadFile` cannot
// force that on a caller. An adapter reaching for it owns its own verification.

// npm is spelled differently on Windows, and the shim has a trap. A `.cmd` must
// be spawned through a shell or Node >= 18.20 refuses it outright with EINVAL
// (CVE-2024-27980). The editor's own package installer carries the same two
// lines; a package cannot require them out of `src/`, so they live here too.
const npmCommand = () => (process.platform === "win32" ? "npm.cmd" : "npm");
const npmSpawnOptions = (command, options) =>
  process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
    ? { ...options, shell: true }
    : options;

// A package name and version reach a shell on Windows because of the above, so
// they are checked rather than trusted. They come from a descriptor rather than
// from the user, which makes this cheap insurance and not a real threat model.
const SAFE_PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const SAFE_VERSION = /^[a-zA-Z0-9.\-+~^<>=| ]+$/;

module.exports = class InstallApi {
  constructor(managed, adapter, { signal, assertActive = () => {}, setStatus } = {}) {
    this.managed = managed;
    this.adapter = adapter;
    this.signal = signal;
    this.assertActive = assertActive;
    this.setStatus =
      setStatus || ((status) => this.managed.setInstallationStatus(this.adapter.id, status));
    this.resolver = require("./server-resolver").createServerResolver({ signal, assertActive });
  }

  guard(signal = this.signal) {
    this.signal?.throwIfAborted();
    signal?.throwIfAborted();
    this.assertActive();
  }

  // Filesystem mutations and child jobs settle before returning cancellation,
  // so the controller can remove staging without a late writer recreating it.
  async wait(operation, signal = this.signal) {
    this.guard(signal);
    try {
      const value = await operation();
      this.guard(signal);
      return value;
    } catch (error) {
      this.guard(signal);
      throw error;
    }
  }

  async request(operation, signal = this.signal) {
    return this.wait(() => abortable(operation(), signal), signal);
  }

  // ---- release discovery ---------------------------------------------------

  // The newest release of a GitHub repository. Throws rather than resolving to
  // null: an adapter calling this is mid-install and wants to know why.
  async latestGithubRelease(repository, { preRelease = false, signal } = {}) {
    signal = combinedSignal(this.signal, signal);
    const release = preRelease
      ? (
          await this.request(() => this.managed.githubReleases(repository, { signal }), signal)
        ).find(Boolean)
      : await this.request(
          () => this.managed.githubRelease(repository, "latest", { signal }),
          signal,
        );
    this.guard(signal);
    return this.managed.toRelease(release, repository);
  }

  async githubReleaseByTag(repository, tag, { signal } = {}) {
    signal = combinedSignal(this.signal, signal);
    return this.managed.toRelease(
      await this.request(
        () => this.managed.githubRelease(repository, `tags/${tag}`, { signal }),
        signal,
      ),
      repository,
    );
  }

  async npmPackageLatestVersion(name, { signal } = {}) {
    signal = combinedSignal(this.signal, signal);
    const metadata = await this.request(
      () => this.managed.npmMetadata(name, "latest", { signal }),
      signal,
    );
    return metadata.version;
  }

  // The version already sitting in `directory`, or null. An adapter uses this
  // to skip work it has already done.
  npmPackageInstalledVersion(name, directory) {
    this.guard();
    try {
      const manifest = path.join(directory, "node_modules", ...name.split("/"), "package.json");
      return JSON.parse(fs.readFileSync(manifest, "utf8")).version || null;
    } catch {
      return null;
    }
  }

  // ---- transfer ------------------------------------------------------------

  // Installs a package and everything it needs into `directory`.
  //
  // Development dependencies are skipped and install scripts are refused: every
  // server reached this way is plain JavaScript, and a postinstall is a build
  // step this has no business running. A server that genuinely needs one fails
  // loudly at launch rather than installing something subtly wrong.
  async npmInstallPackage(name, version, directory, { signal } = {}) {
    signal = combinedSignal(this.signal, signal);
    this.guard(signal);
    if (!SAFE_PACKAGE.test(name))
      throw new Error(`Refusing to install an odd package name: ${name}`);
    if (version && !SAFE_VERSION.test(String(version)))
      throw new Error(`Refusing to install an odd version range: ${version}`);
    await this.wait(() => fs.promises.mkdir(directory, { recursive: true }), signal);
    // npm refuses to treat a directory as a project without one, and writes the
    // tree beside it rather than walking up to somewhere it does not own.
    const manifest = path.join(directory, "package.json");
    if (!fs.existsSync(manifest))
      await this.wait(
        () =>
          fs.promises.writeFile(manifest, `${JSON.stringify({ private: true }, null, 2)}\n`, {
            signal,
          }),
        signal,
      );

    const command = npmCommand();
    const specifier = version ? `${name}@${version}` : name;
    // A semver range can legitimately contain spaces, pipes and redirects.
    // Validation excludes quotes/expansions; preserve the whole argument when
    // the Windows .cmd wrapper requires a shell.
    const argument = process.platform === "win32" ? `"${specifier}"` : specifier;
    await this.wait(
      () =>
        new Promise((resolve, reject) => {
          let failure;
          let stopping;
          const child = childProcess.execFile(
            command,
            ["install", argument, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
            npmSpawnOptions(command, {
              cwd: directory,
              windowsHide: true,
              // npm can spawn git helpers whose stdio does not keep its parent
              // alive. The installation owns this whole POSIX process group.
              detached: process.platform !== "win32",
            }),
            (error, stdout, stderr) => {
              if (!error) return;
              const detail = String(stderr || stdout || error.message).trim();
              failure =
                error.code === "ENOENT"
                  ? new Error(
                      `Could not find \`${command}\` on your PATH, which is needed to install ${name}.`,
                    )
                  : new Error(`npm could not install ${specifier}:\n${detail}`);
            },
          );
          const cancel = () => {
            if (process.platform === "win32" && child.pid) {
              // Killing the npm.cmd shell alone leaves its Node child writing.
              stopping = new Promise((done) => {
                childProcess.execFile(
                  "taskkill",
                  ["/PID", String(child.pid), "/T", "/F"],
                  { windowsHide: true },
                  () => done(),
                );
              });
            } else if (child.pid) {
              try {
                // Staging is discarded on cancellation; no descendant may
                // keep writing through a graceful-shutdown signal handler.
                process.kill(-child.pid, "SIGKILL");
              } catch (error) {
                if (error.code !== "ESRCH") child.kill("SIGKILL");
              }
            }
          };
          signal?.addEventListener("abort", cancel, { once: true });
          child.once("close", async () => {
            signal?.removeEventListener("abort", cancel);
            await stopping;
            if (signal?.aborted) reject(signal.reason);
            else if (failure) reject(failure);
            else resolve();
          });
          if (signal?.aborted) cancel();
        }),
      signal,
    );
  }

  // Fetches a URL to `destination`, unpacking it when `type` says to. The types
  // mirror Zed's `DownloadedFileType` so an adapter ported from there reads the
  // same.
  async downloadFile(url, destination, { type = "uncompressed", digest, signal } = {}) {
    signal = combinedSignal(this.signal, signal);
    this.guard(signal);
    const suffix = { gzip: ".gz", "gzip-tar": ".tar.gz", "xz-tar": ".tar.xz", zip: ".zip" }[type];
    if (type !== "uncompressed" && !suffix) throw new Error(`Unknown download type '${type}'.`);
    const payload = await this.request(
      () => this.managed.download(url, path.basename(destination), { signal }),
      signal,
    );
    if (digest) this.managed.verifyDigest(payload, digest, path.basename(destination), { signal });
    this.guard(signal);
    if (type === "uncompressed") {
      await this.wait(
        () => fs.promises.mkdir(path.dirname(destination), { recursive: true }),
        signal,
      );
      await this.wait(() => fs.promises.writeFile(destination, payload, { signal }), signal);
      return destination;
    }
    // Everything else lands in a directory, so `destination` names one.
    await this.wait(() => fs.promises.mkdir(destination, { recursive: true }), signal);
    const archive = path.join(destination, `.download${suffix}`);
    await this.wait(() => fs.promises.writeFile(archive, payload, { signal }), signal);
    try {
      await this.wait(
        () => this.managed.extract(archive, destination, archive, 0, { signal }),
        signal,
      );
    } finally {
      await this.managed.remove(archive).catch(() => {});
    }
    return destination;
  }

  async makeFileExecutable(filePath, { signal } = {}) {
    signal = combinedSignal(this.signal, signal);
    this.guard(signal);
    // Windows decides by extension, so there is nothing to set.
    if (process.platform === "win32") return;
    await this.wait(() => fs.promises.chmod(filePath, 0o755), signal);
  }

  async verifyFileChecksum(filePath, digest, { signal } = {}) {
    signal = combinedSignal(this.signal, signal);
    const payload = await this.wait(() => fs.promises.readFile(filePath, { signal }), signal);
    this.managed.verifyDigest(payload, digest, path.basename(filePath), { signal });
    this.guard(signal);
  }

  // ---- reporting -----------------------------------------------------------

  // What the user is shown while this runs. The whole point of routing every
  // adapter through one vocabulary: whatever an install does underneath, it
  // reports the same way and the list renders it the same way.
  setServerInstallationStatus(status) {
    this.guard();
    this.setStatus(status);
  }
};

module.exports.npmCommand = npmCommand;
module.exports.npmSpawnOptions = npmSpawnOptions;
