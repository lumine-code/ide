const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { pipeline } = require("node:stream/promises");
const { setTimeout: sleep } = require("node:timers/promises");
const { setTimeout: schedule, clearTimeout: cancelTimer } = require("node:timers");
const { ZipFile } = require("yazl");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const response = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => String(body),
  arrayBuffer: async () => Buffer.from(String(body)),
});

async function within(promise, description, timeout = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = schedule(() => reject(new Error(`Timed out waiting for ${description}.`)), timeout);
      }),
    ]);
  } finally {
    cancelTimer(timer);
  }
}

describe("Installation I/O ownership", () => {
  let scratch, owner, sources, managed, api, InstallApi;

  beforeEach(() => {
    jasmine.useRealClock();
    // Earlier package lifecycle specs may discard both helpers and their
    // dependency modules. Always construct and spy on the current generation.
    InstallApi = require("../lib/install-api");
    const ServerReleaseSources = require("../lib/server-release-sources");
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ide-install-io-"));
    owner = new AbortController();
    sources = new ServerReleaseSources({ fetchUrl: async () => response("payload") });
    managed = {
      download: (...args) => sources.download(...args),
      verifyDigest: (...args) => sources.verifyDigest(...args),
      githubRelease: (...args) => sources.githubRelease(...args),
      githubReleases: (...args) => sources.githubReleases(...args),
      npmMetadata: (...args) => sources.npmMetadata(...args),
      toRelease: (...args) => sources.toRelease(...args),
      extract: (...args) => sources.extract(...args),
      remove: (target) => fs.promises.rm(target, { force: true }),
      setInstallationStatus: jasmine.createSpy("setInstallationStatus"),
    };
    api = new InstallApi(managed, { id: "ide-fixture" }, { signal: owner.signal });
  });

  afterEach(() => {
    owner.abort();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("passes cancellation through release metadata and preserves source errors", async () => {
    const seen = [];
    sources.fetchUrl = async (url, init) => {
      seen.push({ url, init });
      return response({ tag_name: "v2.3.4", assets: [] });
    };
    expect((await api.githubReleaseByTag("example/server", "v2.3.4")).version).toBe("2.3.4");
    expect(seen[0].init.signal.aborted).toBe(false);
    expect(seen[0].init.headers.Accept).toBe("application/vnd.github+json");
    sources.fetchUrl = async () => ({ ok: false, status: 403 });
    await expectAsync(api.latestGithubRelease("example/server")).toBeRejectedWithError(/403/);
  });

  it("cancels metadata that ignores abort without waiting for response headers", async () => {
    const transfer = deferred();
    let signal;
    sources.fetchUrl = (_url, init) => {
      signal = init.signal;
      return transfer.promise;
    };
    const pending = api.npmPackageLatestVersion("server");
    owner.abort();
    await expectAsync(pending).toBeRejectedWith(owner.signal.reason);
    expect(signal.aborted).toBe(true);
    transfer.reject(new Error("late transport failure"));
    await Promise.resolve();
  });

  it("cancels a stalled download body and consumes its late rejection", async () => {
    const body = deferred();
    const entered = deferred();
    sources.fetchUrl = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: () => {
        entered.resolve();
        return body.promise;
      },
    });
    const target = path.join(scratch, "late", "server");
    const pending = api.downloadFile("https://fixture/server", target);
    await entered.promise;
    owner.abort();
    await expectAsync(pending).toBeRejectedWith(owner.signal.reason);
    body.reject(new Error("late body failure"));
    await Promise.resolve();
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it("never writes a late successful payload after its operation is cancelled", async () => {
    const transfer = deferred();
    managed.download = () => transfer.promise;
    const target = path.join(scratch, "late", "server");
    const pending = api.downloadFile("https://fixture/server", target);
    owner.abort();
    await expectAsync(pending).toBeRejectedWith(owner.signal.reason);
    transfer.resolve(Buffer.from("late bytes"));
    await Promise.resolve();
    await Promise.resolve();
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it("combines a call's cancellation with the owner without expiring the owner", async () => {
    const call = new AbortController();
    const transfer = deferred();
    managed.download = () => transfer.promise;
    const target = path.join(scratch, "server");
    const pending = api.downloadFile("https://fixture/server", target, { signal: call.signal });
    call.abort();
    await expectAsync(pending).toBeRejectedWith(call.signal.reason);
    transfer.resolve(Buffer.from("late bytes"));
    expect(owner.signal.aborted).toBe(false);
    managed.download = async () => Buffer.from("current bytes");
    await api.downloadFile("https://fixture/server", target);
    expect(fs.readFileSync(target, "utf8")).toBe("current bytes");
  });

  it("expires synchronous reads, status updates, child jobs and borrowed resolution together", async () => {
    owner.abort();
    expect(api.signal).toBe(owner.signal);
    expect(() => api.setServerInstallationStatus("downloading")).toThrow(owner.signal.reason);
    expect(() => api.npmPackageInstalledVersion("server", scratch)).toThrow(owner.signal.reason);
    await expectAsync(
      api.npmInstallPackage("server", "1.0.0", path.join(scratch, "npm")),
    ).toBeRejectedWith(owner.signal.reason);
    await expectAsync(api.makeFileExecutable(path.join(scratch, "server"))).toBeRejectedWith(
      owner.signal.reason,
    );
    await expectAsync(
      api.verifyFileChecksum(path.join(scratch, "server"), "sha256:00"),
    ).toBeRejectedWith(owner.signal.reason);
    await expectAsync(api.resolver.select({ names: ["node"] })).toBeRejectedWith(
      owner.signal.reason,
    );
    expect(managed.setInstallationStatus).not.toHaveBeenCalled();
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it("checks registration ownership again after a successful download", async () => {
    const transfer = deferred();
    let active = true;
    const reason = new DOMException("Adapter was removed.", "AbortError");
    api = new InstallApi(
      managed,
      { id: "ide-fixture" },
      {
        assertActive: () => {
          if (!active) throw reason;
        },
      },
    );
    managed.download = () => transfer.promise;
    const target = path.join(scratch, "late", "server");
    const pending = api.downloadFile("https://fixture/server", target);
    active = false;
    transfer.resolve(Buffer.from("late bytes"));
    await expectAsync(pending).toBeRejectedWith(reason);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it("does not write an npm project after cancellation during directory creation", async () => {
    const mkdir = fs.promises.mkdir;
    const reason = new DOMException("Installation was cancelled.", "AbortError");
    spyOn(fs.promises, "mkdir").and.callFake(async (...args) => {
      await mkdir(...args);
      owner.abort(reason);
    });
    spyOn(childProcess, "execFile");
    const target = path.join(scratch, "npm");
    await expectAsync(api.npmInstallPackage("server", "1.0.0", target)).toBeRejectedWith(reason);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("waits for the cancelled npm process tree to close before releasing staging", async () => {
    const started = deferred();
    const child = new EventEmitter();
    child.pid = 123;
    child.kill = jasmine.createSpy("kill");
    if (process.platform !== "win32") spyOn(process, "kill");
    let callback;
    spyOn(childProcess, "execFile").and.callFake((command, args, _options, done) => {
      if (command === "taskkill") {
        done();
        return new EventEmitter();
      }
      callback = done;
      expect(args[1]).toBe(process.platform === "win32" ? '"server@^1 || ^2"' : "server@^1 || ^2");
      started.resolve();
      return child;
    });
    const pending = api.npmInstallPackage("server", "^1 || ^2", scratch);
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started.promise;
    owner.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    if (process.platform === "win32") {
      const kill = childProcess.execFile.calls
        .allArgs()
        .find(([command]) => command === "taskkill");
      expect(kill.slice(0, 3)).toEqual([
        "taskkill",
        ["/PID", "123", "/T", "/F"],
        { windowsHide: true },
      ]);
      expect(typeof kill[3]).toBe("function");
    } else {
      expect(process.kill).toHaveBeenCalledWith(-123, "SIGKILL");
    }
    callback(new Error("process terminated"), "", "");
    child.emit("close");
    await expectAsync(pending).toBeRejectedWith(owner.signal.reason);
  });

  it("keeps operation status on its captured owner callback", () => {
    const status = jasmine.createSpy("operation status");
    api = new InstallApi(
      managed,
      { id: "ide-fixture" },
      { signal: owner.signal, setStatus: status },
    );
    api.setServerInstallationStatus("installing");
    expect(status).toHaveBeenCalledWith("installing");
    expect(managed.setInstallationStatus).not.toHaveBeenCalled();
  });

  it("preserves a semver range and a directory containing shell characters in Windows npm", async () => {
    if (process.platform !== "win32") return;
    const target = path.join(scratch, "npm tree & sources");
    const captured = path.join(target, "captured.txt");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "npm.cmd"), `@echo off\r\n> "${captured}" echo %2\r\n`);
    const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") || "PATH";
    const previous = process.env[key];
    try {
      process.env[key] = `${target};${previous || ""}`;
      await api.npmInstallPackage("server", "^1 || >=2 <3", target);
      expect(fs.readFileSync(captured, "utf8").trim()).toBe('"server@^1 || >=2 <3"');
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("kills an npm descendant with ignored stdio before it can write after cancellation", async () => {
    const ready = path.join(scratch, "descendant-ready");
    const late = path.join(scratch, "late-write");
    const trigger = path.join(scratch, "write-after-cancellation");
    const descendant = path.join(scratch, "descendant.cjs");
    const parent = path.join(scratch, "npm.cjs");
    fs.writeFileSync(
      descendant,
      [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        "fs.writeFileSync(process.argv[2], String(process.pid));",
        'const timer = setInterval(() => { if (fs.existsSync(process.argv[4])) { clearInterval(timer); fs.writeFileSync(process.argv[3], "late bytes"); } }, 10);',
      ].join("\n"),
    );
    fs.writeFileSync(
      parent,
      [
        'require("node:child_process").spawn(process.execPath, process.argv.slice(2), { stdio: "ignore", env: process.env });',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const execute = childProcess.execFile;
    let child;
    spyOn(childProcess, "execFile").and.callFake((command, args, options, done) => {
      if (command === "taskkill") return execute(command, args, options, done);
      child = execute(
        process.execPath,
        [parent, descendant, ready, late, trigger],
        {
          ...options,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
        done,
      );
      return child;
    });
    const pending = api.npmInstallPackage("server", "1.0.0", scratch);
    const polling = new AbortController();
    pending.catch(() => {});
    try {
      const marker = async () => {
        while (!fs.existsSync(ready)) await sleep(20, undefined, { signal: polling.signal });
      };
      await within(
        Promise.race([
          marker(),
          pending.then(() => {
            throw new Error("npm fixture exited before its descendant was ready.");
          }),
        ]),
        "npm descendant startup marker",
      );
      owner.abort();
      await expectAsync(within(pending, "cancelled npm process closure")).toBeRejectedWith(
        owner.signal.reason,
      );
      // Arm the write only after the helper releases staging: a write while
      // taskkill is still settling is not a write from an orphaned process.
      fs.writeFileSync(trigger, "write now");
      // Package VM globals can retain the runner's fake setTimeout binding.
      await sleep(500);
      expect(fs.existsSync(late)).toBe(false);
    } finally {
      polling.abort();
      // A surviving fixture descendant exits naturally once its trigger is
      // armed. Never target a PID from the ready file after the tree closed.
      fs.writeFileSync(trigger, "cleanup");
      owner.abort();
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          child.kill();
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            expect(error.code).toBe("ESRCH");
          }
        }
      }
      await within(
        pending.catch(() => {}),
        "npm fixture cleanup",
      );
    }
  });

  it("cancels checksum sidecars and refuses all expired verification policies", async () => {
    const transfer = deferred();
    sources.fetchUrl = () => transfer.promise;
    const pending = sources.verify(
      Buffer.from("payload"),
      "https://fixture/server",
      "sha256-sidecar",
      { signal: owner.signal },
    );
    owner.abort();
    await expectAsync(pending).toBeRejectedWith(owner.signal.reason);
    transfer.resolve(response("0".repeat(64)));
    expect(() =>
      sources.verifyDigest(Buffer.from("payload"), "sha256:00", "server", { signal: owner.signal }),
    ).toThrow(owner.signal.reason);
    expect(() =>
      sources.verifyIntegrity(Buffer.from("payload"), "sha512-AA==", "server", {
        signal: owner.signal,
      }),
    ).toThrow(owner.signal.reason);
  });

  it("validates a verified payload before any filesystem operation", async () => {
    const payload = Buffer.from("payload");
    const digest = `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
    await expectAsync(
      api.downloadFile("https://fixture/server", path.join(scratch, "valid"), { digest }),
    ).toBeResolved();
    await expectAsync(
      api.downloadFile("https://fixture/server", path.join(scratch, "wrong", "server"), {
        digest: `sha256:${"0".repeat(64)}`,
      }),
    ).toBeRejectedWithError(/published checksum/);
    expect(fs.existsSync(path.join(scratch, "wrong"))).toBe(false);
  });

  it("rejects expired archive extraction before creating a destination", async () => {
    owner.abort();
    const target = path.join(scratch, "archive");
    for (const name of ["server.tar.gz", "server.tar.xz", "server.zip"])
      await expectAsync(
        sources.extract("absent", target, name, 0, { signal: owner.signal }),
      ).toBeRejectedWith(owner.signal.reason);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("stops a ZIP before later entries and closes its current writer on cancellation", async () => {
    const archive = path.join(scratch, "server.zip");
    const zip = new ZipFile();
    zip.addBuffer(Buffer.alloc(1024, "a"), "first");
    zip.addBuffer(Buffer.from("later bytes"), "second");
    zip.end();
    await pipeline(zip.outputStream, fs.createWriteStream(archive));
    const write = fs.createWriteStream;
    let output;
    spyOn(fs, "createWriteStream").and.callFake((filename, options) => {
      const stream = write(filename, options);
      if (path.basename(filename) === "first") {
        output = stream;
        stream.once("finish", () => owner.abort());
      }
      return stream;
    });
    const target = path.join(scratch, "zip");
    const pending = sources.extract(archive, target, archive, 0, { signal: owner.signal });
    await expectAsync(pending).toBeRejected();
    expect(owner.signal.aborted).toBe(true);
    expect(output.closed).toBe(true);
    expect(fs.existsSync(path.join(target, "second"))).toBe(false);
  });

  it("removes decoded XZ staging and closes its writer when cancelled before unpacking", async () => {
    const archive = path.join(__dirname, "fixtures", "install-server.tar.xz");
    const write = fs.createWriteStream;
    let output;
    spyOn(fs, "createWriteStream").and.callFake((filename, options) => {
      const stream = write(filename, options);
      if (path.basename(filename) === "payload.tar") {
        output = stream;
        stream.once("finish", () => owner.abort());
      }
      return stream;
    });
    const target = path.join(scratch, "xz");
    await expectAsync(
      sources.extract(archive, target, archive, 0, { signal: owner.signal }),
    ).toBeRejected();
    expect(owner.signal.aborted).toBe(true);
    expect(output.closed).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("lets a started tar file settle while refusing later entries on cancellation", async () => {
    const tar = require("tar");
    const source = path.join(scratch, "tar-source");
    const target = path.join(scratch, "tar");
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, "first"), Buffer.alloc(65536, "a"));
    fs.writeFileSync(path.join(source, "second"), "later bytes");
    const archive = path.join(scratch, "server.tar.gz");
    tar.c({ file: archive, cwd: source, gzip: true, sync: true }, ["first", "second"]);
    const extract = tar.x;
    spyOnProperty(tar, "x", "get").and.returnValue((options) =>
      extract({
        ...options,
        filter: (name, entry) => {
          const allowed = options.filter(name, entry);
          if (name === "first") owner.abort();
          return allowed;
        },
      }),
    );
    await expectAsync(
      sources.extract(archive, target, archive, 0, { signal: owner.signal }),
    ).toBeRejected();
    expect(owner.signal.aborted).toBe(true);
    expect(fs.statSync(path.join(target, "first")).size).toBe(65536);
    expect(fs.existsSync(path.join(target, "second"))).toBe(false);
  });
});
