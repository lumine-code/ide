const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const ADAPTER_ID = /^[a-z0-9][a-z0-9-]*$/;
const TOKEN = /^[a-f0-9-]{36}$/;

function assertAdapterId(adapterId) {
  if (typeof adapterId !== "string" || !ADAPTER_ID.test(adapterId))
    throw new Error("An installation requires a valid adapter ID.");
}

function within(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function ownerIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

module.exports = class InstallationStore {
  constructor({
    storageRoot,
    fileSystem = fs,
    isProcessAlive = ownerIsAlive,
    pollInterval = 25,
  } = {}) {
    if (typeof storageRoot !== "string" || !path.isAbsolute(storageRoot))
      throw new Error("The language-server storage root must be absolute.");
    this.storageRoot = path.resolve(storageRoot);
    this.fs = fileSystem;
    this.isProcessAlive = isProcessAlive;
    this.pollInterval = pollInterval;
    this.host = os.hostname();
    this.locksRoot = path.join(this.storageRoot, ".locks");
    this.transactionsRoot = path.join(this.storageRoot, ".transactions");
  }

  directoryFor(adapterId) {
    assertAdapterId(adapterId);
    return path.join(this.storageRoot, adapterId);
  }

  corrupt(adapterId, directory, detail, cause) {
    return new Error(
      `The managed installation for '${adapterId}' is damaged: ${detail}. Reinstall or remove it (${directory}).`,
      { cause },
    );
  }

  read(adapterId, { allowEmptyPayload = false, lease } = {}) {
    if (lease) {
      if (lease.store !== this || lease.owner.adapterId !== adapterId)
        throw new Error("The installation read requires this adapter's own lease.");
      lease.assertOwned();
    }
    const installed = this.readDirectory(adapterId, this.directoryFor(adapterId), {
      allowEmptyPayload,
    });
    if (installed) return installed;
    const lockPath = path.join(this.locksRoot, adapterId);
    if (this.fs.existsSync(lockPath)) {
      const owner = this.readOwner(lockPath);
      let transaction;
      try {
        transaction = JSON.parse(
          this.fs.readFileSync(
            path.join(this.transactionsRoot, adapterId, owner.token, "transaction.json"),
            "utf8",
          ),
        );
      } catch {
        // An acquired lease may not have started staging yet.
      }
      if (
        owner.token !== lease?.token &&
        (transaction?.operation !== "uninstall" || transaction?.phase !== "committed")
      )
        throw new Error(
          `The managed installation for '${adapterId}' is being changed or requires recovery. Wait for installation to finish, or reload the editor (${lockPath}).`,
        );
    }
    const transactions = path.join(this.transactionsRoot, adapterId);
    if (this.fs.existsSync(transactions))
      for (const entry of this.fs.readdirSync(transactions, { withFileTypes: true }))
        if (
          entry.isDirectory() &&
          TOKEN.test(entry.name) &&
          this.fs.existsSync(path.join(transactions, entry.name, "backup"))
        ) {
          let transaction;
          try {
            transaction = JSON.parse(
              this.fs.readFileSync(path.join(transactions, entry.name, "transaction.json"), "utf8"),
            );
          } catch {
            // A backup with unknown ownership must not be silently ignored.
          }
          if (transaction?.operation !== "uninstall" || transaction?.phase !== "committed")
            throw new Error(
              `The managed installation for '${adapterId}' requires recovery. Its previous server is preserved at ${path.join(transactions, entry.name, "backup")}. Reload the editor before using it.`,
            );
        }
    return null;
  }

  readDirectory(adapterId, directory, { allowEmptyPayload = false } = {}) {
    let stat;
    try {
      stat = this.fs.lstatSync(directory);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw this.corrupt(adapterId, directory, error.message, error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw this.corrupt(adapterId, directory, "the installation root must be a real directory");
    let record;
    try {
      const recordPath = path.join(directory, "install.json");
      if (this.fs.lstatSync(recordPath).isSymbolicLink())
        throw new Error("install.json must not be a link");
      record = JSON.parse(this.fs.readFileSync(recordPath, "utf8"));
    } catch (error) {
      throw this.corrupt(adapterId, directory, "install.json is missing or unreadable", error);
    }
    this.validateRecord(adapterId, directory, record, { allowEmptyPayload });
    return {
      version: record.version,
      source: record.source,
      installedAt: record.installedAt,
      binaryPath: record.binary ? path.resolve(directory, record.binary) : null,
      modulePath: record.module ? path.resolve(directory, record.module) : null,
      directory,
    };
  }

  validateRecord(adapterId, directory, record, { allowEmptyPayload = false } = {}) {
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw this.corrupt(adapterId, directory, "install.json must contain an object");
    if (
      record.version !== null &&
      (typeof record.version !== "string" ||
        !record.version.trim() ||
        record.version.includes("\0"))
    )
      throw this.corrupt(adapterId, directory, "install.json has an invalid version");
    for (const field of ["source", "installedAt"])
      if (
        typeof record[field] !== "string" ||
        !record[field].trim() ||
        record[field].includes("\0")
      )
        throw this.corrupt(adapterId, directory, `install.json has an invalid ${field}`);
    if (!Number.isFinite(Date.parse(record.installedAt)))
      throw this.corrupt(adapterId, directory, "install.json has an invalid installedAt date");
    if (!record.binary && !record.module && !allowEmptyPayload)
      throw this.corrupt(adapterId, directory, "install.json names no server payload");
    const realRoot = this.fs.realpathSync(directory);
    for (const field of ["binary", "module"]) {
      const relative = record[field];
      if (relative == null) continue;
      if (
        typeof relative !== "string" ||
        !relative ||
        relative.includes("\0") ||
        path.isAbsolute(relative) ||
        path.win32.parse(relative).root ||
        relative.split(/[\\/]/).includes("..")
      )
        throw this.corrupt(adapterId, directory, `${field} must be a contained relative path`);
      const filename = path.resolve(directory, relative);
      if (!within(directory, filename))
        throw this.corrupt(adapterId, directory, `${field} escapes its installation`);
      try {
        if (
          !this.fs.statSync(filename).isFile() ||
          !within(realRoot, this.fs.realpathSync(filename))
        )
          throw new Error(`${field} must name a file inside its installation`);
        this.fs.accessSync(filename, this.fs.constants.R_OK);
      } catch (error) {
        throw this.corrupt(
          adapterId,
          directory,
          `${field} payload is missing or unusable (${relative})`,
          error,
        );
      }
    }
    return record;
  }

  validateTree(directory) {
    const root = this.fs.realpathSync(directory);
    const walk = (current) => {
      for (const entry of this.fs.readdirSync(current, { withFileTypes: true })) {
        const filename = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          const real = this.fs.realpathSync(filename);
          if (real !== root && !within(root, real))
            throw new Error(
              `The staged installation contains a link outside its directory: ${filename}`,
            );
        } else if (entry.isDirectory()) walk(filename);
      }
    };
    walk(directory);
  }

  async prepare() {
    await this.fs.promises.mkdir(this.storageRoot, { recursive: true });
    await this.fs.promises.mkdir(this.locksRoot, { recursive: true });
    await this.fs.promises.mkdir(this.transactionsRoot, { recursive: true });
    for (const directory of [this.locksRoot, this.transactionsRoot])
      if (this.fs.lstatSync(directory).isSymbolicLink())
        throw new Error(
          `The installation store metadata directory must not be a link: ${directory}`,
        );
  }

  readOwner(directory) {
    if (this.fs.lstatSync(directory).isSymbolicLink())
      throw new Error(`The installation lock must not be a link: ${directory}`);
    const record = JSON.parse(this.fs.readFileSync(path.join(directory, "owner.json"), "utf8"));
    if (
      record.format !== 1 ||
      !TOKEN.test(record.token) ||
      !ADAPTER_ID.test(record.adapterId) ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.host !== "string"
    )
      throw new Error(`The installation lock has invalid ownership metadata: ${directory}`);
    return record;
  }

  orphaned(owner) {
    return (
      owner.host === this.host &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      this.isProcessAlive(owner.pid) === false
    );
  }

  async remove(filename) {
    const absolute = path.resolve(filename);
    if (!within(this.storageRoot, absolute))
      throw new Error(`Refusing to remove a path outside the installation store: ${filename}`);
    return this.fs.promises.rm(absolute, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }

  async realDirectory(directory) {
    await this.fs.promises.mkdir(directory, { recursive: true });
    if (this.fs.lstatSync(directory).isSymbolicLink())
      throw new Error(`An installation transaction directory must not be a link: ${directory}`);
  }

  async reclaim(lockPath, observed) {
    if (!this.orphaned(observed)) return false;
    const token = randomUUID();
    const temporary = path.join(this.locksRoot, `.reaper-${token}.json`);
    const marker = path.join(lockPath, "reaper.json");
    const identity = { token, pid: process.pid, host: this.host };
    await this.fs.promises.writeFile(temporary, JSON.stringify(identity), { flag: "wx" });
    let claimed = false;
    try {
      try {
        await this.fs.promises.link(temporary, marker);
        claimed = true;
      } catch (error) {
        if (error.code === "ENOENT") return true;
        if (error.code === "EEXIST") {
          // A dead recovery worker is preserved, too. Without an atomic compare
          // and delete, removing its marker could delete a new worker's claim.
          let recovering;
          try {
            recovering = JSON.parse(this.fs.readFileSync(marker, "utf8"));
          } catch (readError) {
            if (readError.code === "ENOENT") return true;
            throw readError;
          }
          if (this.orphaned(recovering))
            throw new Error(
              `Installation lock recovery was interrupted. Preserve its backup and remove this lock after closing the editor: ${lockPath}`,
              { cause: error },
            );
          return false;
        }
        throw error;
      }
      const owner = this.readOwner(lockPath);
      if (owner.token !== observed.token || !this.orphaned(owner)) return false;
      const retired = path.join(this.locksRoot, `.retired-${observed.adapterId}-${token}`);
      await this.fs.promises.rename(lockPath, retired);
      claimed = false;
      await this.remove(retired);
      return true;
    } finally {
      if (claimed) {
        try {
          if (JSON.parse(this.fs.readFileSync(marker, "utf8")).token === token)
            await this.fs.promises.unlink(marker);
        } catch {
          // Failed cleanup retains the recovery marker for manual inspection.
        }
      }
      await this.fs.promises.unlink(temporary).catch(() => {});
    }
  }

  async acquire(adapterId, { signal, wait = true } = {}) {
    assertAdapterId(adapterId);
    signal?.throwIfAborted();
    await this.prepare();
    const token = randomUUID();
    const owner = { format: 1, adapterId, token, pid: process.pid, host: this.host };
    const lockPath = path.join(this.locksRoot, adapterId);
    const claimPath = path.join(this.locksRoot, `.claim-${adapterId}-${token}`);
    await this.fs.promises.mkdir(claimPath);
    await this.fs.promises.writeFile(path.join(claimPath, "owner.json"), JSON.stringify(owner), {
      flag: "wx",
    });
    let acquired = false;
    try {
      while (!acquired) {
        signal?.throwIfAborted();
        try {
          await this.fs.promises.rename(claimPath, lockPath);
          acquired = true;
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
          let observed;
          try {
            observed = this.readOwner(lockPath);
          } catch (readError) {
            if (readError.code === "ENOENT") continue;
            throw new Error(
              `Cannot verify the installation lock (${lockPath}): ${readError.message}`,
              { cause: readError },
            );
          }
          if (observed.adapterId !== adapterId)
            throw new Error(`The installation lock names another adapter: ${lockPath}`, {
              cause: error,
            });
          if (await this.reclaim(lockPath, observed)) continue;
          if (!wait) return null;
          await delay(this.pollInterval, undefined, { signal });
        }
      }
      const lease = new InstallationLease(this, owner, lockPath, signal);
      try {
        signal?.throwIfAborted();
        await lease.recover();
        return lease;
      } catch (error) {
        await lease.release().catch(() => {});
        throw error;
      }
    } finally {
      if (!acquired) await this.remove(claimPath);
    }
  }

  async sweep({ signal } = {}) {
    await this.prepare();
    const ids = new Set();
    for (const entry of this.fs.readdirSync(this.transactionsRoot, { withFileTypes: true }))
      if (entry.isDirectory() && ADAPTER_ID.test(entry.name)) ids.add(entry.name);
    for (const entry of this.fs.readdirSync(this.locksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (ADAPTER_ID.test(entry.name)) ids.add(entry.name);
      else if (entry.name.startsWith(".claim-")) {
        const directory = path.join(this.locksRoot, entry.name);
        try {
          if (this.orphaned(this.readOwner(directory))) await this.remove(directory);
        } catch {
          // Unknown ownership is preserved, including preproduction formats.
        }
      }
    }
    for (const adapterId of ids) {
      signal?.throwIfAborted();
      const lease = await this.acquire(adapterId, { signal, wait: false });
      if (lease) await lease.release();
    }
  }
};

class InstallationLease {
  constructor(store, owner, lockPath, signal) {
    this.store = store;
    this.owner = owner;
    this.token = owner.token;
    this.lockPath = lockPath;
    this.directory = path.join(store.transactionsRoot, owner.adapterId, owner.token);
    this.stagePath = path.join(this.directory, "stage");
    this.backupPath = path.join(this.directory, "backup");
    this.targetPath = store.directoryFor(owner.adapterId);
    this.active = true;
    this.signal = signal;
    this.transaction = { ...owner, operation: "stage", phase: "pending", released: false };
  }

  assertOwned({ ignoreCancellation = false } = {}) {
    if (!this.active || this.store.readOwner(this.lockPath).token !== this.token)
      throw new Error("The installation lease is no longer owned by this operation.");
    if (!ignoreCancellation) this.signal?.throwIfAborted();
  }

  async writeTransaction({ ignoreCancellation = false } = {}) {
    this.assertOwned({ ignoreCancellation });
    await this.store.realDirectory(path.dirname(this.directory));
    await this.store.realDirectory(this.directory);
    this.assertOwned({ ignoreCancellation });
    const temporary = path.join(this.directory, `.transaction-${randomUUID()}.json`);
    await this.store.fs.promises.writeFile(temporary, JSON.stringify(this.transaction), {
      flag: "wx",
    });
    await this.store.fs.promises.rename(temporary, path.join(this.directory, "transaction.json"));
  }

  async createStage() {
    this.assertOwned();
    await this.writeTransaction();
    this.assertOwned();
    await this.store.fs.promises.mkdir(this.stagePath);
    return this.stagePath;
  }

  async replace(record, { allowEmptyPayload = false, validate } = {}) {
    this.assertOwned();
    const fileSystem = this.store.fs;
    await fileSystem.promises.writeFile(
      path.join(this.stagePath, "install.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    this.assertOwned();
    const staged = this.store.readDirectory(this.owner.adapterId, this.stagePath, {
      allowEmptyPayload,
    });
    if (!staged) throw new Error("The staged installation directory is missing.");
    this.store.validateTree(this.stagePath);
    if (validate) await validate(staged);
    this.assertOwned();
    this.transaction = {
      ...this.transaction,
      operation: "replace",
      phase: "prepared",
      allowEmptyPayload,
    };
    await this.writeTransaction();
    let movedAside = false;
    try {
      this.assertOwned();
      if (fileSystem.existsSync(this.targetPath)) {
        await fileSystem.promises.rename(this.targetPath, this.backupPath);
        movedAside = true;
      }
      this.assertOwned();
      await fileSystem.promises.rename(this.stagePath, this.targetPath);
      this.transaction.phase = "committed";
      await this.writeTransaction({ ignoreCancellation: true });
    } catch (error) {
      if (movedAside && !fileSystem.existsSync(this.targetPath)) {
        try {
          this.assertOwned({ ignoreCancellation: true });
          await fileSystem.promises.rename(this.backupPath, this.targetPath);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `The installation failed and its previous copy could not be restored. The backup is preserved at ${this.backupPath}.`,
            { cause: rollbackError },
          );
        }
      }
      throw error;
    }
    await this.store.remove(this.backupPath);
    return this.store.read(this.owner.adapterId, { allowEmptyPayload });
  }

  async uninstall() {
    this.assertOwned();
    this.transaction = { ...this.transaction, operation: "uninstall", phase: "prepared" };
    await this.writeTransaction();
    this.assertOwned();
    if (!this.store.fs.existsSync(this.targetPath)) return false;
    await this.store.fs.promises.rename(this.targetPath, this.backupPath);
    this.transaction.phase = "committed";
    await this.writeTransaction({ ignoreCancellation: true });
    await this.store.remove(this.backupPath);
    return true;
  }

  async recover() {
    this.assertOwned();
    const directory = path.dirname(this.directory);
    await this.store.realDirectory(directory);
    for (const entry of this.store.fs.readdirSync(directory, { withFileTypes: true })) {
      this.assertOwned();
      if (!entry.isDirectory() || !TOKEN.test(entry.name) || entry.name === this.token) continue;
      const transactionDirectory = path.join(directory, entry.name);
      let transaction;
      try {
        transaction = JSON.parse(
          this.store.fs.readFileSync(path.join(transactionDirectory, "transaction.json"), "utf8"),
        );
      } catch {
        continue;
      }
      if (
        transaction.format !== 1 ||
        transaction.adapterId !== this.owner.adapterId ||
        transaction.token !== entry.name ||
        (transaction.released !== true && !this.store.orphaned(transaction))
      )
        continue;
      const backup = path.join(transactionDirectory, "backup");
      if (this.store.fs.existsSync(backup)) {
        this.assertOwned();
        if (transaction.operation === "uninstall" && transaction.phase === "committed")
          await this.store.remove(backup);
        else if (!this.store.fs.existsSync(this.targetPath))
          await this.store.fs.promises.rename(backup, this.targetPath);
        else if (transaction.operation === "replace") {
          this.store.read(this.owner.adapterId, {
            allowEmptyPayload: !!transaction.allowEmptyPayload,
          });
          await this.store.remove(backup);
        } else {
          throw new Error(
            `An interrupted installation has a backup that cannot be safely resolved: ${backup}`,
          );
        }
      }
      await this.store.remove(transactionDirectory);
    }
  }

  async release() {
    if (!this.active) return;
    this.assertOwned({ ignoreCancellation: true });
    let cleanupError;
    if (this.store.fs.existsSync(this.directory)) {
      // A released journal makes a retained stage safe to clean even when its
      // owner process remains alive in another editor window.
      this.transaction.released = true;
      await this.writeTransaction({ ignoreCancellation: true });
      try {
        if (this.store.fs.existsSync(this.backupPath)) await this.store.remove(this.stagePath);
        else await this.store.remove(this.directory);
      } catch (error) {
        cleanupError = error;
      }
    }
    // The lock is atomically moved to this lease's private path before cleanup.
    // Another window can acquire the canonical name without its files being
    // reachable by the cleanup of the generation that just released it.
    const retired = path.join(
      this.store.locksRoot,
      `.released-${this.owner.adapterId}-${this.token}`,
    );
    await this.store.fs.promises.rename(this.lockPath, retired);
    this.active = false;
    await this.store.remove(retired);
    if (cleanupError) throw cleanupError;
  }
}
