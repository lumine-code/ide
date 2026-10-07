const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const InstallationStore = require("../lib/installation-store");

describe("InstallationStore", () => {
  let scratch, storageRoot, store, leases, children;
  const record = (version = "1.0", payload = { binary: "server" }) => ({
    version,
    source: "adapter",
    installedAt: new Date().toISOString(),
    ...payload,
  });
  const payloadAt = (directory, version = "1.0", payload = { binary: "server" }) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "install.json"),
      JSON.stringify(record(version, payload)),
    );
    for (const relative of [payload.binary, payload.module].filter(Boolean)) {
      const filename = path.join(directory, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, version);
    }
  };
  const acquire = async (options = {}, selectedStore = store) => {
    const lease = await selectedStore.acquire("ide-test", options);
    if (lease) leases.push(lease);
    return lease;
  };
  const childOwner = (body, { retirementFailures = 0 } = {}) => {
    const modulePath = require.resolve("../lib/installation-store");
    const source = `
      const fs = require('node:fs');
      const path = require('node:path');
      const Store = require(${JSON.stringify(modulePath)});
      (async () => {
        let renameFailures = 0;
        const fileSystem = {...fs,promises:{...fs.promises,rename:async (from,to) => {
          if (renameFailures < ${retirementFailures} &&
              ['.released-','.retired-'].some(prefix => path.basename(to).startsWith(prefix))) {
            renameFailures++;
            throw Object.assign(new Error('Lock directory is busy'),{code:'EPERM'});
          }
          return fs.promises.rename(from,to);
        }}};
        const store = new Store({storageRoot:${JSON.stringify(storageRoot)},pollInterval:5,fileSystem});
        const lease = await store.acquire('ide-test');
        ${body}
      })().catch(error => { process.send({error:error.stack}); process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ["-e", source], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    return child;
  };
  const message = (child) =>
    new Promise((resolve, reject) => {
      const received = (value) => {
        cleanup();
        if (value.error) reject(new Error(value.error));
        else resolve(value);
      };
      const closed = (code) => {
        cleanup();
        reject(new Error(`Installation fixture exited before its message (${code})`));
      };
      const cleanup = () => {
        child.off("message", received);
        child.off("close", closed);
      };
      child.on("message", received);
      child.on("close", closed);
    });
  const stopChild = (child) =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("close", resolve);
      child.kill();
    });

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ide-installation-store-"));
    storageRoot = path.join(scratch, "servers");
    store = new InstallationStore({ storageRoot, pollInterval: 5 });
    leases = [];
    children = [];
  });
  afterEach(async () => {
    for (const child of children) await stopChild(child);
    for (const lease of leases) await lease.release();
    if (
      path.dirname(scratch) !== path.resolve(os.tmpdir()) ||
      !path.basename(scratch).startsWith("ide-installation-store-")
    )
      throw new Error("Refusing to remove an unexpected installation store test path");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("distinguishes absent installations from missing and malformed records", () => {
    expect(store.read("ide-test")).toBeNull();
    const target = store.directoryFor("ide-test");
    fs.mkdirSync(target, { recursive: true });
    expect(() => store.read("ide-test")).toThrowError(
      /damaged:.*install.json.*Reinstall or remove/,
    );
    fs.writeFileSync(path.join(target, "install.json"), "{");
    expect(() => store.read("ide-test")).toThrowError(/damaged:.*install.json/);
  });

  it("checks every named payload and required record field", () => {
    const target = store.directoryFor("ide-test");
    payloadAt(target, "1.0", { binary: "server", module: "entry.js" });
    expect(store.read("ide-test").version).toBe("1.0");
    fs.unlinkSync(path.join(target, "entry.js"));
    expect(() => store.read("ide-test")).toThrowError(/module payload is missing or unusable/);
    for (const invalid of [
      [],
      null,
      {},
      record("", { binary: "server" }),
      { ...record(), installedAt: "unknown" },
    ]) {
      fs.writeFileSync(path.join(target, "install.json"), JSON.stringify(invalid));
      expect(() => store.read("ide-test")).toThrowError(/managed installation.*damaged/);
    }
  });

  it("requires an explicit adapter capability for payload-free installations", () => {
    payloadAt(store.directoryFor("ide-test"), "1.0", {});
    expect(() => store.read("ide-test")).toThrowError(/names no server payload/);
    expect(store.read("ide-test", { allowEmptyPayload: true }).version).toBe("1.0");
  });

  it("accepts an explicitly unversioned adapter record without accepting a missing version", async () => {
    const lease = await acquire();
    await lease.createStage();
    payloadAt(lease.stagePath);
    const installed = await lease.replace(record(null));
    expect(installed.version).toBeNull();
    expect(store.read("ide-test").version).toBeNull();
    const missingVersion = record();
    delete missingVersion.version;
    fs.writeFileSync(path.join(lease.targetPath, "install.json"), JSON.stringify(missingVersion));
    expect(() => store.read("ide-test")).toThrowError(/invalid version/);
  });

  it("lets only the operation owning a verified lease inspect its absent install", async () => {
    const lease = await acquire();
    expect(() => store.read("ide-test")).toThrowError(/being changed/);
    expect(store.read("ide-test", { lease })).toBeNull();
    const another = new InstallationStore({ storageRoot });
    expect(() => another.read("ide-test", { lease })).toThrowError(/own lease/);
    await lease.release();
    expect(() => store.read("ide-test", { lease })).toThrowError(/no longer owned/);
  });

  it("refuses path traversal, absolute paths and links to another installation", () => {
    const target = store.directoryFor("ide-test");
    payloadAt(target);
    for (const binary of [
      "../server",
      "..\\server",
      "C:\\outside\\server",
      path.join(scratch, "server"),
    ]) {
      fs.writeFileSync(
        path.join(target, "install.json"),
        JSON.stringify(record("1.0", { binary })),
      );
      expect(() => store.read("ide-test")).toThrowError(/contained relative path|escapes/);
    }
    const outside = path.join(scratch, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "server"), "outside");
    fs.symlinkSync(
      outside,
      path.join(target, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    fs.writeFileSync(
      path.join(target, "install.json"),
      JSON.stringify(record("1.0", { binary: "linked/server" })),
    );
    expect(() => store.read("ide-test")).toThrowError(/payload is missing or unusable/);
    expect(() => store.directoryFor("../ide-test")).toThrowError(/valid adapter ID/);
  });

  it("validates the complete stage before moving the previous installation", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const lease = await acquire();
    await lease.createStage();
    const validate = jasmine.createSpy("validate");
    await expectAsync(lease.replace(record("2.0"), { validate })).toBeRejectedWithError(
      /payload is missing/,
    );
    expect(validate).not.toHaveBeenCalled();
    expect(store.read("ide-test").version).toBe("1.0");
    payloadAt(lease.stagePath, "2.0");
    const outside = path.join(scratch, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(lease.stagePath, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expectAsync(lease.replace(record("2.0"), { validate })).toBeRejectedWithError(
      /link outside/,
    );
    expect(store.read("ide-test").version).toBe("1.0");
  });

  it("atomically installs a validated stage and removes the old backup", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const lease = await acquire();
    await lease.createStage();
    payloadAt(lease.stagePath, "2.0");
    const replaced = await lease.replace(record("2.0"), {
      validate: async (staged) => {
        expect(staged.version).toBe("2.0");
        expect(store.read("ide-test").version).toBe("1.0");
      },
    });
    expect(replaced.version).toBe("2.0");
    expect(fs.existsSync(lease.backupPath)).toBeFalse();
    expect(fs.existsSync(lease.stagePath)).toBeFalse();
  });

  it("serializes same-process windows and aborts a waiting acquisition", async () => {
    const first = await acquire();
    await first.createStage();
    const secondStore = new InstallationStore({ storageRoot, pollInterval: 5 });
    const controller = new AbortController();
    const waiting = secondStore.acquire("ide-test", { signal: controller.signal });
    controller.abort(new Error("Window closed"));
    await expectAsync(waiting).toBeRejectedWithError(/Window closed/);
    expect(await secondStore.acquire("ide-test", { wait: false })).toBeNull();
    expect(fs.existsSync(first.stagePath)).toBeTrue();
    await first.release();
    const second = await acquire({}, secondStore);
    expect(second.token).not.toBe(first.token);
    await second.createStage();
    expect(second.stagePath).not.toBe(first.stagePath);
  });

  it("refuses mutations after the owning lease has been released", async () => {
    const lease = await acquire();
    await lease.release();
    await expectAsync(lease.createStage()).toBeRejectedWithError(/no longer owned/);
    await expectAsync(lease.replace(record())).toBeRejectedWithError(/no longer owned/);
    await expectAsync(lease.uninstall()).toBeRejectedWithError(/no longer owned/);
    await expectAsync(lease.recover()).toBeRejectedWithError(/no longer owned/);
  });

  it("sweeps without waiting behind a live lease and preserves unowned legacy files", async () => {
    const lease = await acquire();
    await lease.createStage();
    for (const name of [".stage-ide-test-1-1", ".backup-ide-test-1-1"])
      fs.mkdirSync(path.join(storageRoot, name));
    await store.sweep();
    expect(fs.existsSync(lease.stagePath)).toBeTrue();
    expect(fs.existsSync(path.join(storageRoot, ".stage-ide-test-1-1"))).toBeTrue();
    expect(fs.existsSync(path.join(storageRoot, ".backup-ide-test-1-1"))).toBeTrue();
  });

  it("enforces the lease across a real second process", async () => {
    const child = childOwner(
      `await lease.createStage(); process.send({stage:lease.stagePath}); process.on('message', async () => { await lease.release(); process.disconnect(); });`,
    );
    const ready = await message(child);
    expect(await store.acquire("ide-test", { wait: false })).toBeNull();
    await store.sweep();
    expect(fs.existsSync(ready.stage)).toBeTrue();
    const waiting = acquire();
    child.send("release");
    const acquired = await waiting;
    expect(acquired).toBeTruthy();
    expect(fs.existsSync(ready.stage)).toBeFalse();
  });

  it("recovers only a conclusively dead process's stage", async () => {
    const child = childOwner(
      `await lease.createStage(); process.send({stage:lease.stagePath}); process.on('message', () => {});`,
    );
    const ready = await message(child);
    await stopChild(child);
    await store.sweep();
    expect(fs.existsSync(ready.stage)).toBeFalse();
    expect(store.read("ide-test")).toBeNull();
  });

  it("restores the previous install after a process dies between renames", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const child = childOwner(
      `await lease.createStage(); lease.transaction.operation='replace'; lease.transaction.phase='prepared'; await lease.writeTransaction(); await fs.promises.rename(lease.targetPath,lease.backupPath); process.send({backup:lease.backupPath}); process.on('message', () => {});`,
    );
    const ready = await message(child);
    expect(fs.existsSync(ready.backup)).toBeTrue();
    expect(() => store.read("ide-test")).toThrowError(/being changed or requires recovery/);
    await stopChild(child);
    await store.sweep();
    expect(store.read("ide-test").version).toBe("1.0");
    expect(fs.existsSync(ready.backup)).toBeFalse();
  });

  it("keeps a successfully swapped install after a crash before the commit journal", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const child = childOwner(
      `await lease.createStage(); fs.writeFileSync(require('node:path').join(lease.stagePath,'server'),'2.0'); fs.writeFileSync(require('node:path').join(lease.stagePath,'install.json'),JSON.stringify(${JSON.stringify(record("2.0"))})); lease.transaction.operation='replace'; lease.transaction.phase='prepared'; await lease.writeTransaction(); await fs.promises.rename(lease.targetPath,lease.backupPath); await fs.promises.rename(lease.stagePath,lease.targetPath); process.send({backup:lease.backupPath}); process.on('message', () => {});`,
    );
    const ready = await message(child);
    await stopChild(child);
    await store.sweep();
    expect(store.read("ide-test").version).toBe("2.0");
    expect(fs.existsSync(ready.backup)).toBeFalse();
  });

  it("rolls back a failed swap without changing the previous install", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from, to) => {
          if (path.basename(from) === "stage" && to === store.directoryFor("ide-test"))
            throw new Error("New payload is locked");
          return fs.promises.rename(from, to);
        },
      },
    };
    const lease = await acquire({}, new InstallationStore({ storageRoot, fileSystem: injected }));
    await lease.createStage();
    payloadAt(lease.stagePath, "2.0");
    await expectAsync(lease.replace(record("2.0"))).toBeRejectedWithError(/New payload is locked/);
    expect(store.read("ide-test").version).toBe("1.0");
    expect(fs.existsSync(lease.backupPath)).toBeFalse();
  });

  it("preserves and later recovers the backup when rollback also fails", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from, to) => {
          if (
            ["stage", "backup"].includes(path.basename(from)) &&
            to === store.directoryFor("ide-test")
          )
            throw new Error("Installation is locked");
          return fs.promises.rename(from, to);
        },
      },
    };
    const lease = await acquire({}, new InstallationStore({ storageRoot, fileSystem: injected }));
    await lease.createStage();
    payloadAt(lease.stagePath, "2.0");
    await expectAsync(lease.replace(record("2.0"))).toBeRejectedWithError(/backup is preserved/);
    expect(fs.existsSync(lease.backupPath)).toBeTrue();
    await lease.release();
    await store.sweep();
    expect(store.read("ide-test").version).toBe("1.0");
    expect(fs.existsSync(lease.backupPath)).toBeFalse();
  });

  it("does not restore a committed uninstall when backup cleanup fails", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rm: async (filename, options) => {
          if (path.basename(filename) === "backup") throw new Error("Backup is locked");
          return fs.promises.rm(filename, options);
        },
      },
    };
    const lease = await acquire({}, new InstallationStore({ storageRoot, fileSystem: injected }));
    await expectAsync(lease.uninstall()).toBeRejectedWithError(/Backup is locked/);
    expect(store.read("ide-test")).toBeNull();
    await lease.release();
    await store.sweep();
    expect(store.read("ide-test")).toBeNull();
    expect(fs.existsSync(lease.backupPath)).toBeFalse();
  });

  it("does not reclaim an owner whose liveness cannot be determined", async () => {
    const lease = await acquire();
    const unknown = new InstallationStore({ storageRoot, isProcessAlive: () => undefined });
    expect(await unknown.acquire("ide-test", { wait: false })).toBeNull();
    await lease.release();
    await delay(1);
  });

  it("retries a busy lock retirement without admitting a contender or honoring cancellation", async () => {
    let renameFailures = 0;
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from, to) => {
          if (path.basename(to).startsWith(".released-") && renameFailures < 2) {
            renameFailures++;
            throw Object.assign(new Error("Lock directory is busy"), { code: "EPERM" });
          }
          return fs.promises.rename(from, to);
        },
      },
    };
    const controller = new AbortController();
    const lease = await acquire(
      { signal: controller.signal },
      new InstallationStore({ storageRoot, fileSystem: injected }),
    );
    let successor;
    const waiting = acquire().then((owned) => (successor = owned));
    controller.abort(new Error("Installation cancelled"));
    const released = lease.release();
    await delay(10);
    expect(successor).toBeUndefined();
    expect(lease.active).toBeTrue();
    expect(store.readOwner(lease.lockPath).token).toBe(lease.token);
    await released;
    expect(renameFailures).toBe(2);
    expect(lease.active).toBeFalse();
    expect((await waiting).token).not.toBe(lease.token);
  });

  it("bounds retirement retries and preserves the owned live lock on persistent failure", async () => {
    let blocked = true;
    let attempts = 0;
    const denied = Object.assign(new Error("Lock directory is busy"), { code: "EACCES" });
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from, to) => {
          if (blocked && path.basename(to).startsWith(".released-")) {
            attempts++;
            throw denied;
          }
          return fs.promises.rename(from, to);
        },
      },
    };
    const lease = await acquire({}, new InstallationStore({ storageRoot, fileSystem: injected }));
    try {
      await expectAsync(lease.release()).toBeRejectedWith(denied);
      expect(attempts).toBe(11);
      expect(lease.active).toBeTrue();
      expect(store.readOwner(lease.lockPath).token).toBe(lease.token);
      expect(await acquire({ wait: false })).toBeNull();
    } finally {
      blocked = false;
    }
    await lease.release();
    expect(lease.active).toBeFalse();
  });

  it("never retires a different lock generation after a failed rename", async () => {
    let attempts = 0;
    const successorToken = randomUUID();
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from, to) => {
          if (path.basename(to).startsWith(".released-") && attempts++ === 0) {
            const owner = store.readOwner(from);
            fs.writeFileSync(
              path.join(from, "owner.json"),
              JSON.stringify({ ...owner, token: successorToken }),
            );
            throw Object.assign(new Error("Lock directory is busy"), { code: "EBUSY" });
          }
          return fs.promises.rename(from, to);
        },
      },
    };
    const lease = await acquire({}, new InstallationStore({ storageRoot, fileSystem: injected }));
    try {
      await expectAsync(lease.release()).toBeRejectedWithError(/no longer owned/);
      expect(attempts).toBe(1);
      expect(store.readOwner(lease.lockPath).token).toBe(successorToken);
      expect(lease.active).toBeTrue();
    } finally {
      fs.writeFileSync(path.join(lease.lockPath, "owner.json"), JSON.stringify(lease.owner));
    }
  });

  for (const changed of ["owner", "liveness", "reaper"]) {
    it(`revalidates ${changed} before retrying an orphaned lock retirement`, async () => {
      const lease = await acquire();
      const replacement = randomUUID();
      let alive = false;
      let attempts = 0;
      const marker = path.join(lease.lockPath, "reaper.json");
      const injected = {
        ...fs,
        promises: {
          ...fs.promises,
          rename: async (from, to) => {
            if (path.basename(to).startsWith(".retired-")) {
              attempts++;
              if (changed === "owner")
                fs.writeFileSync(
                  path.join(from, "owner.json"),
                  JSON.stringify({ ...lease.owner, token: replacement }),
                );
              else if (changed === "liveness") alive = true;
              else {
                const reaper = JSON.parse(fs.readFileSync(marker, "utf8"));
                fs.writeFileSync(marker, JSON.stringify({ ...reaper, token: replacement }));
              }
              throw Object.assign(new Error("Lock directory is busy"), { code: "EPERM" });
            }
            return fs.promises.rename(from, to);
          },
        },
      };
      const recovering = new InstallationStore({
        storageRoot,
        fileSystem: injected,
        isProcessAlive: () => alive,
      });
      try {
        expect(await recovering.acquire("ide-test", { wait: false })).toBeNull();
        expect(attempts).toBe(1);
        expect(store.readOwner(lease.lockPath).token).toBe(
          changed === "owner" ? replacement : lease.token,
        );
        if (changed === "reaper")
          expect(JSON.parse(fs.readFileSync(marker, "utf8")).token).toBe(replacement);
        else expect(fs.existsSync(marker)).toBeFalse();
      } finally {
        fs.writeFileSync(path.join(lease.lockPath, "owner.json"), JSON.stringify(lease.owner));
      }
    });
  }

  for (const retirementFailures of [0, 2]) {
    it(`serializes competing processes that reclaim the same orphaned lock${retirementFailures ? " despite temporary retirement failures" : ""}`, async () => {
      const abandoned = childOwner(
        `await lease.createStage(); process.send({stage:lease.stagePath}); process.on('message', () => {});`,
      );
      await message(abandoned);
      await stopChild(abandoned);
      const activity = path.join(scratch, "activity.jsonl");
      const workers = Array.from({ length: 3 }, () =>
        childOwner(
          `
      fs.appendFileSync(${JSON.stringify(activity)},JSON.stringify({event:'start',token:lease.token})+'\\n');
      await new Promise(resolve => setTimeout(resolve,20));
      fs.appendFileSync(${JSON.stringify(activity)},JSON.stringify({event:'end',token:lease.token})+'\\n');
      await lease.release(); process.send({released:true,renameFailures}); process.disconnect();
    `,
          { retirementFailures },
        ),
      );
      const replies = await Promise.all(workers.map(message));
      expect(replies.map(({ renameFailures }) => renameFailures)).toEqual(
        Array(3).fill(retirementFailures),
      );
      const events = fs
        .readFileSync(activity, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      expect(events.length).toBe(6);
      for (let index = 0; index < events.length; index += 2) {
        expect(events[index].event).toBe("start");
        expect(events[index + 1]).toEqual({ event: "end", token: events[index].token });
      }
      expect(new Set(events.map(({ token }) => token)).size).toBe(3);
      expect(fs.existsSync(path.join(store.locksRoot, "ide-test"))).toBeFalse();
    });
  }

  it("releases a live lock when its own abandoned stage cannot yet be removed", async () => {
    let locked = true;
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rm: async (filename, options) => {
          if (locked && filename.startsWith(path.join(storageRoot, ".transactions")))
            throw new Error("Stage is locked");
          return fs.promises.rm(filename, options);
        },
      },
    };
    const lease = await acquire({}, new InstallationStore({ storageRoot, fileSystem: injected }));
    await lease.createStage();
    await expectAsync(lease.release()).toBeRejectedWithError(/Stage is locked/);
    expect(lease.active).toBeFalse();
    locked = false;
    await store.sweep();
    expect(fs.existsSync(lease.stagePath)).toBeFalse();
  });

  it("refuses cancellation during validation before the previous install moves", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const controller = new AbortController();
    const lease = await acquire({ signal: controller.signal });
    await lease.createStage();
    payloadAt(lease.stagePath, "2.0");
    await expectAsync(
      lease.replace(record("2.0"), {
        validate: async () => {
          controller.abort(new Error("Installation cancelled"));
        },
      }),
    ).toBeRejectedWithError(/Installation cancelled/);
    expect(store.read("ide-test").version).toBe("1.0");
    await lease.release();
    expect(fs.existsSync(lease.stagePath)).toBeFalse();
  });

  it("rolls back when cancellation arrives between the two replacement renames", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const controller = new AbortController();
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from, to) => {
          await fs.promises.rename(from, to);
          if (from === store.directoryFor("ide-test") && path.basename(to) === "backup")
            controller.abort(new Error("Installation cancelled during swap"));
        },
      },
    };
    const lease = await acquire(
      { signal: controller.signal },
      new InstallationStore({ storageRoot, fileSystem: injected }),
    );
    await lease.createStage();
    payloadAt(lease.stagePath, "2.0");
    await expectAsync(lease.replace(record("2.0"))).toBeRejectedWithError(/cancelled during swap/);
    expect(store.read("ide-test").version).toBe("1.0");
    await lease.release();
    expect(fs.existsSync(lease.backupPath)).toBeFalse();
  });

  it("finishes the commit when cancellation arrives after the new target is visible", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const controller = new AbortController();
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from, to) => {
          await fs.promises.rename(from, to);
          if (path.basename(from) === "stage" && to === store.directoryFor("ide-test"))
            controller.abort(new Error("Window closed after commit"));
        },
      },
    };
    const lease = await acquire(
      { signal: controller.signal },
      new InstallationStore({ storageRoot, fileSystem: injected }),
    );
    await lease.createStage();
    payloadAt(lease.stagePath, "2.0");
    expect((await lease.replace(record("2.0"))).version).toBe("2.0");
    expect(fs.existsSync(lease.backupPath)).toBeFalse();
    await lease.release();
    expect(store.read("ide-test").version).toBe("2.0");
  });

  it("finishes a linearized uninstall despite cancellation during its rename", async () => {
    payloadAt(store.directoryFor("ide-test"));
    const controller = new AbortController();
    const injected = {
      ...fs,
      promises: {
        ...fs.promises,
        rename: async (from, to) => {
          await fs.promises.rename(from, to);
          if (from === store.directoryFor("ide-test") && path.basename(to) === "backup")
            controller.abort(new Error("Window closed during uninstall"));
        },
      },
    };
    const lease = await acquire(
      { signal: controller.signal },
      new InstallationStore({ storageRoot, fileSystem: injected }),
    );
    expect(await lease.uninstall()).toBeTrue();
    expect(store.read("ide-test")).toBeNull();
    expect(fs.existsSync(lease.backupPath)).toBeFalse();
    await lease.release();
  });
});
