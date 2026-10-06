const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createServerResolver,
  mergeEnvironment,
  validateServerLaunch,
} = require("../lib/server-resolver");

describe("shared language server resolution", () => {
  let directory, resolver;
  const file = (name, mode = 0o755) => {
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "// server fixture\n", { mode });
    fs.chmodSync(filename, mode);
    return filename;
  };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ide-resolver-"));
    resolver = createServerResolver();
  });
  afterEach(() => {
    if (
      path.dirname(directory) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith("ide-resolver-")
    )
      throw new Error("Refusing to remove an unexpected resolver test path");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("selects an explicit server before evaluating other candidate sources", async () => {
    const configuredPath = file("configured");
    const managed = jasmine.createSpy("managed").and.throwError("corrupt install record");
    const bundledPath = jasmine.createSpy("bundled");
    const candidates = jasmine.createSpy("discovered");
    const selected = await resolver.select({
      configuredPath,
      managed,
      bundledPath,
      candidates,
    });
    expect(selected).toEqual({ path: configuredPath, kind: "executable", source: "configured" });
    expect(bundledPath).not.toHaveBeenCalled();
    expect(managed).not.toHaveBeenCalled();
    expect(candidates).not.toHaveBeenCalled();
  });
  it("keeps broken explicit and managed selections authoritative", async () => {
    const bundledPath = jasmine.createSpy("bundled").and.returnValue(file("bundled.js"));
    for (const chosen of [
      { configuredPath: path.join(directory, "missing") },
      { managed: () => ({ path: path.join(directory, "missing") }) },
    ])
      await expectAsync(
        resolver.select({ ...chosen, kind: "node", bundledPath }),
      ).toBeRejectedWithError(/server path:.*ENOENT/);
    expect(bundledPath).not.toHaveBeenCalled();
  });
  it("attaches installation version only to the selected managed generation", async () => {
    const managedPath = file("managed.js"),
      bundledPath = file("bundled.js");
    const managed = await resolver.select({
      kind: "node",
      managed: () => ({ path: managedPath, version: "2.0" }),
      bundledPath,
    });
    expect(managed.source).toBe("managed");
    expect((await resolver.launch(managed)).version).toBe("2.0");
    const bundled = await resolver.select({ kind: "node", managed: () => null, bundledPath });
    expect(bundled.source).toBe("bundled");
    expect((await resolver.launch(bundled)).version).toBeUndefined();
  });
  it("rejects an invalid explicit path before reading a corrupt managed installation", async () => {
    const managed = jasmine.createSpy("managed").and.throwError("damaged install.json");
    await expectAsync(
      resolver.select({ configuredPath: path.join(directory, "missing"), managed }),
    ).toBeRejectedWithError(/configured server path:.*ENOENT/);
    expect(managed).not.toHaveBeenCalled();
  });
  it("preserves the selected managed failure without evaluating bundled or discovered sources", async () => {
    const failure = new Error("damaged managed installation");
    const bundledPath = jasmine.createSpy("bundled"),
      candidates = jasmine.createSpy("discovered");
    await expectAsync(
      resolver.select({
        managed: () => {
          throw failure;
        },
        bundledPath,
        candidates,
      }),
    ).toBeRejectedWith(failure);
    expect(bundledPath).not.toHaveBeenCalled();
    expect(candidates).not.toHaveBeenCalled();
  });
  it("accepts an asynchronous managed lookup with its path and version from one result", async () => {
    const controller = new AbortController();
    const managed = jasmine.createSpy("managed").and.callFake(async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      return { path: file("managed-async.js"), version: "3.2.1" };
    });
    const selected = await resolver.select({ kind: "node", signal: controller.signal, managed });
    expect(selected.version).toBe("3.2.1");
    expect(selected.source).toBe("managed");
    expect(managed).toHaveBeenCalledTimes(1);
  });
  it("refuses malformed managed candidates instead of falling back to the bundled server", async () => {
    const bundledPath = jasmine.createSpy("bundled");
    for (const candidate of [false, [], {}, { path: "" }, { path: file("managed"), version: 123 }])
      await expectAsync(
        resolver.select({ managed: () => candidate, bundledPath }),
      ).toBeRejectedWithError(TypeError);
    expect(bundledPath).not.toHaveBeenCalled();
  });
  it("cancels a stalled managed lookup and consumes its late rejection", async () => {
    const controller = new AbortController();
    let reject, entered;
    const started = new Promise((resolve) => (entered = resolve));
    const pending = resolver.select({
      signal: controller.signal,
      managed: ({ signal }) => {
        expect(signal).toBe(controller.signal);
        entered();
        return new Promise((_resolve, fail) => (reject = fail));
      },
    });
    await started;
    controller.abort(new DOMException("cancelled managed lookup", "AbortError"));
    await expectAsync(pending).toBeRejectedWithError(/cancelled managed lookup/);
    reject(new Error("late lookup failure"));
    await flushMicrotasks();
  });
  it("rejects directories and relative configured files", async () => {
    await expectAsync(resolver.select({ configuredPath: directory })).toBeRejectedWithError(
      /must name a file/,
    );
    await expectAsync(resolver.select({ configuredPath: "relative-server" })).toBeRejectedWithError(
      /absolute/,
    );
    expect((await resolver.select({ configuredPath: directory, kind: "directory" })).kind).toBe(
      "directory",
    );
  });
  it("classifies configured JavaScript as a readable Node entry", async () => {
    const entry = file("server.mjs", 0o644);
    const selected = await resolver.select({ configuredPath: entry, configuredKind: "auto" });
    const args = ["--stdio"];
    const launched = await resolver.launch(selected, {
      args,
      cwd: directory,
      env: { ELECTRON_RUN_AS_NODE: "0", FLAG: "yes" },
    });
    args.push("later");
    expect(launched.command).toBe(process.execPath);
    expect(launched.args).toEqual([entry, "--stdio"]);
    expect(launched.env).toEqual({ FLAG: "yes", ELECTRON_RUN_AS_NODE: "1" });
  });
  it("builds IPC Node launches with the module as the fork target", async () => {
    const entry = file("ipc.cjs");
    const launch = await resolver.nodeEntry(entry, ["argument"], { transport: "ipc" });
    expect(launch.command).toBe(entry);
    expect(launch.args).toEqual(["argument"]);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });
  it("keeps the native launch environment absent when there are no overrides", async () => {
    const selected = await resolver.select({ configuredPath: file("native") });
    expect(await resolver.launch(selected)).toEqual({ command: selected.path, args: [] });
    await expectAsync(resolver.launch(selected, { transport: "ipc" })).toBeRejectedWithError(
      /IPC transport requires a Node entry/,
    );
  });
  it("continues discovered candidates after an adapter-specific runtime check fails", async () => {
    const bad = file("bad-runtime"),
      good = file("good-runtime");
    const validate = jasmine.createSpy("validate").and.callFake(async (filename) => {
      if (filename === bad) throw new Error("wrong runtime");
      return { major: 21 };
    });
    const selected = await resolver.select({ candidates: async () => [bad, good], validate });
    expect(selected).toEqual({
      path: good,
      kind: "executable",
      source: "discovered",
      data: { major: 21 },
    });
    await expectAsync(
      resolver.select({ configuredPath: bad, candidates: [good], validate }),
    ).toBeRejectedWithError(/wrong runtime/);
  });
  it("skips missing paths and directory entries during discovery", async () => {
    expect(
      await resolver.select({ candidates: [path.join(directory, "missing"), directory] }),
    ).toBeNull();
  });
  it("preserves PATH order and validates executable files", () => {
    const first = file(path.join("first", "language-server"));
    const second = file(path.join("second", "language-server"));
    const env = {
      PATH: [path.dirname(first), path.dirname(second), path.dirname(first)].join(path.delimiter),
    };
    expect(resolver.findExecutables("language-server", { env })).toEqual([first, second]);
  });
  it("resolves relative PATH entries against the explicit discovery directory", () => {
    const command = file(path.join("bin", "language-server"));
    expect(
      resolver.findExecutables("language-server", { env: { PATH: "bin" }, cwd: directory }),
    ).toEqual([command]);
  });
  it("uses Windows PATH names, quoted directories, native suffixes and case deduplication", async () => {
    const files = new Set([
      "c:\\first\\server.exe",
      "c:\\first\\server.exe.exe",
      "c:\\second\\server.exe",
      "c:\\first\\shim.cmd",
    ]);
    const exists = (filename) => {
      if (!files.has(filename.toLowerCase()))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true, isDirectory: () => false };
    };
    const api = createServerResolver({
      platform: "win32",
      cwd: "C:\\",
      fileSystem: {
        constants: fs.constants,
        statSync: exists,
        accessSync: exists,
        promises: {
          stat: async (p) => exists(p),
          access: async (p) => {
            exists(p);
          },
        },
      },
    });
    expect(
      api.findExecutables("server", {
        env: { PATH: "C:\\ignored", Path: '"C:\\First";C:\\Second;c:\\FIRST' },
      }),
    ).toEqual(["C:\\First\\server.exe", "C:\\Second\\server.exe"]);
    expect(api.findExecutables("server.exe", { env: { Path: "C:\\First" } })).toEqual([
      "C:\\First\\server.exe",
    ]);
    expect(api.findExecutables("shim", { env: { Path: "C:\\First" } })).toEqual([]);
    expect(api.findExecutables("shim.cmd", { env: { Path: "C:\\First" } })).toEqual([]);
    expect(
      api.findExecutables("shim.cmd", {
        env: { Path: "C:\\First" },
        allowShellWrapper: true,
      }),
    ).toEqual(["C:\\First\\shim.cmd"]);
    await expectAsync(api.validateFile("C:\\First\\shim.cmd")).toBeRejectedWithError(
      /shell wrapper/,
    );
    expect(await api.validateFile("C:\\First\\shim.cmd", { allowShellWrapper: true })).toBe(
      "C:\\First\\shim.cmd",
    );
  });
  it("preserves filesystem failure context and code for companion validation", async () => {
    try {
      await resolver.validateFile(path.join(directory, "missing-sdk"), {
        kind: "file",
        label: "TypeScript SDK",
      });
      fail("expected failure");
    } catch (error) {
      expect(error.message).toContain("TypeScript SDK");
      expect(error.code).toBe("ENOENT");
      expect(error.cause.code).toBe("ENOENT");
    }
  });
  it("cancels a stuck validator and consumes its later rejection", async () => {
    const controller = new AbortController();
    resolver = createServerResolver({ signal: controller.signal });
    let reject, entered;
    const started = new Promise((resolve) => (entered = resolve));
    const pending = resolver.select({
      configuredPath: file("probe"),
      validate: (_path, { signal }) => {
        expect(signal).toBe(controller.signal);
        entered();
        return new Promise((_resolve, fail) => (reject = fail));
      },
    });
    await started;
    controller.abort(new DOMException("obsolete probe", "AbortError"));
    await expectAsync(pending).toBeRejectedWithError(/obsolete probe/);
    reject(new Error("late failed probe"));
    await flushMicrotasks();
  });
  it("checks a capability lifetime before doing filesystem work", async () => {
    let active = true;
    resolver = createServerResolver({
      assertActive: () => {
        if (!active) throw new DOMException("retired", "AbortError");
      },
    });
    const command = file("server");
    active = false;
    await expectAsync(resolver.select({ configuredPath: command })).toBeRejectedWithError(
      /retired/,
    );
  });
  it("cancels selection when either the resolver lifetime or operation signal ends", async () => {
    for (const cancelled of ["lifetime", "operation"]) {
      const lifetime = new AbortController();
      const operation = new AbortController();
      const api = createServerResolver({ signal: lifetime.signal });
      let entered;
      const started = new Promise((resolve) => (entered = resolve));
      const pending = api.select({
        configuredPath: file(`combined-${cancelled}`),
        signal: operation.signal,
        validate: (_path, { signal }) => {
          expect(signal.aborted).toBe(false);
          entered();
          return new Promise(() => {});
        },
      });
      await started;
      (cancelled === "lifetime" ? lifetime : operation).abort(
        new DOMException(`cancelled ${cancelled}`, "AbortError"),
      );
      await expectAsync(pending).toBeRejectedWithError(`cancelled ${cancelled}`);
    }
  });
  it("preserves cancellation when a synchronous selection hook aborts and throws", async () => {
    const configuredPath = file("probe");
    for (const hook of ["validate", "managed", "bundledPath", "candidates"]) {
      const controller = new AbortController();
      const options = {
        signal: controller.signal,
        [hook]: () => {
          controller.abort(new DOMException("cancelled hook", "AbortError"));
          throw new Error("obsolete hook failure");
        },
        ...(hook === "validate" ? { configuredPath } : {}),
      };
      await expectAsync(resolver.select(options)).toBeRejectedWithError(/cancelled hook/);
    }
  });
});

describe("server launch boundary", () => {
  it("rejects malformed transport, arguments and environment before spawning", () => {
    for (const value of [
      { command: " " },
      { command: "server", transport: "unknown" },
      { command: "server", args: [1] },
      { command: "server", env: { VALUE: 1 } },
      { command: "server", args: ["nul\0byte"] },
      { command: "server", transport: "socket", port: 0 },
    ])
      expect(() => validateServerLaunch(value)).toThrowError(TypeError);
    expect(
      validateServerLaunch({
        command: "server",
        env: { REMOVE: undefined },
        transport: "socket",
        port: 1234,
      }),
    ).toBeTruthy();
  });
  it("merges Windows environment overrides and removals by case-insensitive identity", () => {
    expect(
      mergeEnvironment(
        { Path: "old", ELECTRON_RUN_AS_NODE: "0", CLIENT_PORT: "123" },
        { PATH: "new", electron_run_as_node: "1", client_port: undefined },
        "win32",
      ),
    ).toEqual({ PATH: "new", electron_run_as_node: "1" });
    expect(mergeEnvironment({ Path: "old", PATH: "old-posix" }, { PATH: "new" }, "linux")).toEqual({
      Path: "old",
      PATH: "new",
    });
  });
});
