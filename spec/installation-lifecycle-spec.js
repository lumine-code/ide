const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Manager = require("../lib/language-server-manager");
const ManagedServers = require("../lib/managed-servers");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let tick = 0; tick < 100; tick++) await Promise.resolve();
};
const outcome = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
const promptly = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("An abandoned operation did not settle")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const response = (buffer) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
});

describe("managed installation ownership", () => {
  let manager, managed, scratch, storageRoot, requests;
  const payloadPath = (id = "installation-test") => path.join(storageRoot, id, "server.js");
  const writePayload = async ({ storagePath, version }) => {
    await fs.promises.writeFile(path.join(storagePath, "server.js"), version || "unversioned");
    return { module: "server.js", version: version || "1.0.0" };
  };
  const register = (installServer = writePayload, id = "installation-test") => {
    const adapter = {
      id,
      displayName: `Server ${id}`,
      grammarScopes: [`source.${id}`],
      resolveServer: async () => null,
      installServer,
    };
    manager.registerAdapter(adapter);
    return adapter;
  };
  const transientPaths = () => {
    if (!fs.existsSync(storageRoot)) return [];
    const paths = fs.readdirSync(storageRoot).filter((name) => /^\.(stage|backup)-/.test(name));
    const transactions = path.join(storageRoot, ".transactions");
    if (fs.existsSync(transactions))
      for (const adapterId of fs.readdirSync(transactions)) {
        const directory = path.join(transactions, adapterId);
        for (const token of fs.readdirSync(directory))
          paths.push(path.join(".transactions", adapterId, token));
      }
    return paths;
  };

  beforeEach(() => {
    jasmine.useRealClock();
    manager = new Manager();
    spyOn(manager, "reattachAll").and.resolveTo();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ide-installation-lifecycle-"));
    storageRoot = path.join(scratch, "language-servers");
    requests = [];
    managed = new ManagedServers(manager, {
      storageRoot,
      fetchUrl: async (url, options) => {
        requests.push({ url, options });
        return response(Buffer.from("downloaded server"));
      },
    });
    manager.setManagedServers(managed);
  });
  afterEach(async () => {
    await manager.deactivate();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("queues uninstall behind the same adapter's in-progress installation", async () => {
    const entered = deferred();
    const release = deferred();
    register(async (context) => {
      entered.resolve();
      await release.promise;
      return writePayload(context);
    });
    const install = outcome(managed.install("installation-test", { version: "1.0.0" }));
    await entered.promise;
    let removed = false;
    const uninstall = outcome(managed.uninstall("installation-test").then(() => (removed = true)));
    await flush();
    expect(removed).toBe(false);
    release.resolve();
    expect((await install).error).toBeUndefined();
    expect((await uninstall).error).toBeUndefined();
    expect(fs.existsSync(payloadPath())).toBe(false);
    expect(managed.installationStatus("installation-test")).toBe(null);
    expect(transientPaths()).toEqual([]);
  });

  it("serializes concurrent versions and keeps the last requested version", async () => {
    const entered = deferred();
    const release = deferred();
    const versions = [];
    register(async (context) => {
      versions.push(context.version);
      if (context.version === "1.0.0") {
        entered.resolve();
        await release.promise;
      }
      return writePayload(context);
    });
    const first = outcome(managed.install("installation-test", { version: "1.0.0" }));
    await entered.promise;
    const second = outcome(managed.install("installation-test", { version: "2.0.0" }));
    await flush();
    expect(versions).toEqual(["1.0.0"]);
    release.resolve();
    expect((await first).error).toBeUndefined();
    expect((await second).error).toBeUndefined();
    expect(versions).toEqual(["1.0.0", "2.0.0"]);
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("2.0.0");
    expect(transientPaths()).toEqual([]);
  });

  it("does not block a different adapter behind a stuck installation hook", async () => {
    const entered = deferred();
    const release = deferred();
    register(async (context) => {
      entered.resolve();
      await release.promise;
      return writePayload(context);
    });
    register(writePayload, "independent-test");
    const first = outcome(managed.install("installation-test", { version: "1.0.0" }));
    await entered.promise;
    try {
      await promptly(managed.install("independent-test", { version: "2.0.0" }));
      expect(fs.readFileSync(payloadPath("independent-test"), "utf8")).toBe("2.0.0");
      expect(fs.existsSync(payloadPath())).toBe(false);
    } finally {
      release.resolve();
      await first;
    }
  });

  it("checks an update against the installation left by its queued predecessor", async () => {
    const entered = deferred();
    const release = deferred();
    const versions = [];
    const adapter = register(async (context) => {
      versions.push(context.version);
      if (context.version === "1.0.0") {
        entered.resolve();
        await release.promise;
      }
      return writePayload(context);
    });
    adapter.latestServerVersion = jasmine.createSpy("latestServerVersion").and.resolveTo("2.0.0");
    const install = outcome(managed.install(adapter.id, { version: "1.0.0" }));
    await entered.promise;
    const update = outcome(managed.update(adapter.id));
    await flush();
    expect(adapter.latestServerVersion).not.toHaveBeenCalled();
    release.resolve();
    expect((await install).error).toBeUndefined();
    expect((await update).value.version).toBe("2.0.0");
    expect(versions).toEqual(["1.0.0", "2.0.0"]);
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("2.0.0");
  });

  it("installs a genuinely missing server when update owns its first installation lease", async () => {
    const adapter = register();
    adapter.latestServerVersion = async () => "2.0.0";
    expect(managed.installFor(adapter)).toBe(null);
    const record = await managed.update(adapter.id);
    expect(record.version).toBe("2.0.0");
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("2.0.0");
    expect(managed.installFor(adapter).version).toBe("2.0.0");
    expect(managed.installationStatus(adapter.id)).toBe(null);
    expect(transientPaths()).toEqual([]);
  });

  it("reports release cleanup failure and keeps the installation queue reusable", async () => {
    const adapter = register();
    const remove = fs.promises.rm;
    let failed = false;
    spyOn(fs.promises, "rm").and.callFake((filename, options) => {
      if (!failed && path.basename(filename).startsWith(`.released-${adapter.id}-`)) {
        failed = true;
        return Promise.reject(new Error("Released lock cleanup failed"));
      }
      return remove(filename, options);
    });
    await expectAsync(managed.install(adapter.id, { version: "1.0.0" })).toBeRejectedWithError(
      /Released lock cleanup failed/,
    );
    expect(failed).toBe(true);
    expect(managed.installationStatus(adapter.id)).toBe("failed");
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("1.0.0");
    const next = await promptly(managed.install(adapter.id, { version: "2.0.0" }));
    expect(next.version).toBe("2.0.0");
    expect(managed.installationStatus(adapter.id)).toBe(null);
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("2.0.0");
    expect(transientPaths()).toEqual([]);
  });

  it("expires a completed hook's API signal without replacing its successful result", async () => {
    let api, signal;
    const adapter = register(async (context) => {
      api = context.api;
      signal = context.signal;
      expect(api.signal.aborted).toBe(false);
      return writePayload(context);
    });
    const record = await managed.install(adapter.id, { version: "1.0.0" });
    expect(record.version).toBe("1.0.0");
    await conditionPromise(() => api.signal.aborted && signal.aborted);
    expect(api.signal.reason.name).toBe("AbortError");
    expect(() => api.setServerInstallationStatus("failed")).toThrowMatching(
      (error) => error.name === "AbortError",
    );
    expect(managed.installationStatus(adapter.id)).toBe(null);
    expect(managed.installFor(adapter).version).toBe("1.0.0");
  });

  it("continues the queue after an invalid staged installation fails validation", async () => {
    const entered = deferred();
    const release = deferred();
    const adapter = register(async (context) => {
      if (context.version === "1.0.0") {
        entered.resolve();
        await release.promise;
        return { version: "1.0.0", module: "missing.js" };
      }
      return writePayload(context);
    });
    const first = outcome(managed.install(adapter.id, { version: "1.0.0" }));
    await entered.promise;
    const second = outcome(managed.install(adapter.id, { version: "2.0.0" }));
    release.resolve();
    expect((await first).error.message).toMatch(/missing\.js/);
    expect((await second).error).toBeUndefined();
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("2.0.0");
    expect(transientPaths()).toEqual([]);
  });

  it("cancels a stuck update lookup without changing a healthy installation", async () => {
    const entered = deferred();
    const release = deferred();
    let api;
    const adapter = register();
    await managed.install(adapter.id, { version: "1.0.0" });
    adapter.latestServerVersion = async (capabilities) => {
      api = capabilities;
      entered.resolve();
      await release.promise;
      return "2.0.0";
    };
    const caller = new AbortController();
    const update = outcome(managed.update(adapter.id, { signal: caller.signal }));
    await entered.promise;
    caller.abort();
    try {
      expect((await promptly(update)).error?.name).toBe("AbortError");
      expect(api.signal.aborted).toBe(true);
      expect(fs.readFileSync(payloadPath(), "utf8")).toBe("1.0.0");
      expect(managed.installFor(adapter).version).toBe("1.0.0");
    } finally {
      release.resolve();
      await update;
    }
    await flush();
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("1.0.0");
  });

  it("cancels a queued caller without entering its hook or disrupting its predecessor", async () => {
    const entered = deferred();
    const release = deferred();
    const versions = [];
    register(async (context) => {
      versions.push(context.version);
      entered.resolve();
      await release.promise;
      return writePayload(context);
    });
    const first = outcome(managed.install("installation-test", { version: "1.0.0" }));
    await entered.promise;
    const caller = new AbortController();
    const second = outcome(
      managed.install("installation-test", { version: "2.0.0", signal: caller.signal }),
    );
    caller.abort();
    try {
      expect((await promptly(second)).error?.name).toBe("AbortError");
      expect(versions).toEqual(["1.0.0"]);
    } finally {
      release.resolve();
      await first;
      await second;
    }
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("1.0.0");
    expect(transientPaths()).toEqual([]);
  });

  it("cancels a stuck hook and expires its download and status capabilities", async () => {
    const entered = deferred();
    const release = deferred();
    const finished = deferred();
    const lateErrors = [];
    let hookContext;
    const events = [];
    managed.onDidChangeInstallation((event) => events.push(event));
    register(async (context) => {
      hookContext = context;
      entered.resolve();
      await release.promise;
      try {
        context.api.setServerInstallationStatus("installing");
      } catch (error) {
        lateErrors.push(error);
      }
      try {
        await context.api.downloadFile(
          "https://fixture.test/late",
          path.join(context.storagePath, "server.js"),
        );
      } catch (error) {
        lateErrors.push(error);
      }
      finished.resolve();
      return { module: "server.js", version: "1.0.0" };
    });
    const caller = new AbortController();
    const install = outcome(managed.install("installation-test", { signal: caller.signal }));
    await entered.promise;
    caller.abort();
    try {
      expect((await promptly(install)).error?.name).toBe("AbortError");
      expect(hookContext.signal.aborted).toBe(true);
      expect(hookContext.api.signal.aborted).toBe(true);
      const settledEvents = events.slice();
      release.resolve();
      await promptly(finished.promise);
      await conditionPromise(() => transientPaths().length === 0);
      expect(lateErrors.map((error) => error.name)).toEqual(["AbortError", "AbortError"]);
      expect(events).toEqual(settledEvents);
      expect(requests).toEqual([]);
      expect(fs.existsSync(payloadPath())).toBe(false);
    } finally {
      release.resolve();
      await install;
    }
  });

  it("cancels a stuck descriptor download without writing its late response", async () => {
    const entered = deferred();
    const release = deferred();
    const payload = Buffer.from("native server");
    const adapter = {
      id: "installation-test",
      displayName: "Release Server",
      grammarScopes: ["source.installation-test"],
      resolveServer: async () => null,
      managedServer: {
        source: "github-release",
        repository: "fixture/server",
        displayName: "Release Server",
        assetType: "binary",
        assetFor: () => "server.exe",
        checksum: "sha256-sidecar",
        binary: "server.exe",
      },
    };
    manager.registerAdapter(adapter);
    managed.fetchUrl = async (url, options) => {
      requests.push({ url, options });
      entered.resolve(options);
      await release.promise;
      return response(payload);
    };
    const caller = new AbortController();
    const install = outcome(
      managed.install(adapter.id, { version: "1.0.0", signal: caller.signal }),
    );
    const fetchOptions = await entered.promise;
    caller.abort();
    try {
      expect((await promptly(install)).error?.name).toBe("AbortError");
      expect(fetchOptions.signal.aborted).toBe(true);
      await conditionPromise(() => transientPaths().length === 0);
      expect(transientPaths()).toEqual([]);
      release.resolve();
      await flush();
      expect(requests.length).toBe(1);
      expect(fs.existsSync(path.join(storageRoot, adapter.id))).toBe(false);
      expect(transientPaths()).toEqual([]);
    } finally {
      release.resolve();
      await install;
    }
  });

  it("retires an unregistered adapter's queued and active operations", async () => {
    const entered = deferred();
    const release = deferred();
    const versions = [];
    const adapter = register(async (context) => {
      versions.push(context.version);
      entered.resolve();
      await release.promise;
      return { module: "server.js", version: context.version };
    });
    const first = outcome(managed.install(adapter.id, { version: "1.0.0" }));
    await entered.promise;
    const queued = outcome(managed.install(adapter.id, { version: "2.0.0" }));
    await manager.unregisterAdapter(adapter);
    try {
      expect((await promptly(first)).error?.name).toBe("AbortError");
      expect((await promptly(queued)).error?.name).toBe("AbortError");
      expect(versions).toEqual(["1.0.0"]);
      expect(managed.installationStatus(adapter.id)).toBe(null);
    } finally {
      release.resolve();
      await Promise.all([first, queued]);
    }
    await conditionPromise(() => transientPaths().length === 0);
  });

  it("lets a replacement adapter install without receiving the old hook's late effects", async () => {
    const entered = deferred();
    const release = deferred();
    let oldApi;
    const retired = register(async ({ api, storagePath }) => {
      oldApi = api;
      entered.resolve();
      await release.promise;
      await fs.promises.writeFile(path.join(storagePath, "server.js"), "retired server");
      return { module: "server.js", version: "old" };
    });
    const old = outcome(managed.install(retired.id));
    await entered.promise;
    await manager.unregisterAdapter(retired);
    const replacement = register();
    const next = outcome(managed.install(replacement.id, { version: "2.0.0" }));
    try {
      expect((await promptly(old)).error?.name).toBe("AbortError");
      const events = [];
      managed.onDidChangeInstallation((event) => events.push(event));
      expect(() => oldApi.setServerInstallationStatus("failed")).toThrowMatching(
        (error) => error.name === "AbortError",
      );
      release.resolve();
      expect((await promptly(next)).error).toBeUndefined();
      const settledEvents = events.slice();
      await conditionPromise(() => transientPaths().length === 0);
      await flush();
      expect(fs.readFileSync(payloadPath(), "utf8")).toBe("2.0.0");
      expect(managed.installFor(replacement).version).toBe("2.0.0");
      expect(events).toEqual(settledEvents);
      expect(transientPaths()).toEqual([]);
    } finally {
      release.resolve();
      await Promise.all([old, next]);
    }
  });

  it("aborts outstanding hooks and removes their staging when the manager deactivates", async () => {
    const entered = deferred();
    const release = deferred();
    let context;
    register(async (next) => {
      context = next;
      entered.resolve();
      await release.promise;
      return { module: "server.js", version: "1.0.0" };
    });
    const install = outcome(managed.install("installation-test"));
    await entered.promise;
    try {
      await promptly(manager.deactivate());
      expect((await promptly(install)).error?.name).toBe("AbortError");
      expect(context.signal.aborted).toBe(true);
      expect(fs.existsSync(payloadPath())).toBe(false);
      await expectAsync(managed.install("installation-test")).toBeRejected();
    } finally {
      release.resolve();
      await install;
    }
    await conditionPromise(() => transientPaths().length === 0);
  });

  it("can dispose repeatedly while cancelling both active and queued work", async () => {
    const entered = deferred();
    const release = deferred();
    register(async () => {
      entered.resolve();
      await release.promise;
      return { module: "server.js", version: "1.0.0" };
    });
    const active = outcome(managed.install("installation-test"));
    await entered.promise;
    const queued = outcome(managed.uninstall("installation-test"));
    try {
      await promptly(Promise.all([managed.dispose(), managed.dispose()]));
      expect((await promptly(active)).error?.name).toBe("AbortError");
      expect((await promptly(queued)).error?.name).toBe("AbortError");
    } finally {
      release.resolve();
      await Promise.all([active, queued]);
    }
    await conditionPromise(() => transientPaths().length === 0);
  });

  it("keeps a healthy installation when stopping its sessions fails during replacement", async () => {
    const adapter = register();
    await managed.install(adapter.id, { version: "1.0.0" });
    spyOn(managed, "stopSessions").and.rejectWith(new Error("The server could not stop"));
    const reattach = spyOn(manager, "scheduleReattachAll");
    manager.reattachAll.calls.reset();
    await expectAsync(managed.install(adapter.id, { version: "2.0.0" })).toBeRejectedWithError(
      /could not stop/,
    );
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("1.0.0");
    expect(managed.installFor(adapter).version).toBe("1.0.0");
    expect(manager.reattachAll).not.toHaveBeenCalled();
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(transientPaths()).toEqual([]);
  });

  it("keeps a healthy installation when stopping its sessions fails during uninstall", async () => {
    const adapter = register();
    await managed.install(adapter.id, { version: "1.0.0" });
    spyOn(managed, "stopSessions").and.rejectWith(new Error("The server could not stop"));
    const reattach = spyOn(manager, "scheduleReattachAll");
    manager.reattachAll.calls.reset();
    await expectAsync(managed.uninstall(adapter.id)).toBeRejectedWithError(/could not stop/);
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("1.0.0");
    expect(managed.installFor(adapter).version).toBe("1.0.0");
    expect(manager.reattachAll).not.toHaveBeenCalled();
    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it("schedules reattachment after a failed swap restores the old installation", async () => {
    const adapter = register();
    await managed.install(adapter.id, { version: "1.0.0" });
    const target = path.join(storageRoot, adapter.id);
    const rename = fs.promises.rename;
    spyOn(fs.promises, "rename").and.callFake((from, to) => {
      if (path.basename(from) === "stage" && to === target)
        return Promise.reject(new Error("Staged replacement failed"));
      return rename(from, to);
    });
    const reattach = spyOn(manager, "scheduleReattachAll");
    manager.reattachAll.calls.reset();
    await expectAsync(managed.install(adapter.id, { version: "2.0.0" })).toBeRejectedWithError(
      /Staged replacement failed/,
    );
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("1.0.0");
    expect(managed.installFor(adapter).version).toBe("1.0.0");
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(manager.reattachAll).not.toHaveBeenCalled();
    expect(transientPaths()).toEqual([]);
  });

  it("reports a missing managed payload rather than silently falling back", async () => {
    const adapter = register();
    await managed.install(adapter.id, { version: "1.0.0" });
    fs.rmSync(payloadPath());
    expect(() => managed.installFor(adapter)).toThrowError(/installation-test.*server\.js/i);
    expect(() => manager.adapterContext(adapter, scratch)).toThrowError(/reinstall|install again/i);
  });

  it("reports a corrupt install record and preserves it for recovery", async () => {
    const adapter = register();
    await managed.install(adapter.id, { version: "1.0.0" });
    const recordPath = path.join(storageRoot, adapter.id, "install.json");
    fs.writeFileSync(recordPath, "{unreadable record");
    expect(() => managed.installFor(adapter)).toThrowError(/installation-test.*install\.json/i);
    expect(fs.readFileSync(recordPath, "utf8")).toBe("{unreadable record");
    expect(fs.readFileSync(payloadPath(), "utf8")).toBe("1.0.0");
  });

  it("verifies a custom hook download before committing its install record", async () => {
    const payload = Buffer.from("downloaded server");
    const digest = `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
    const adapter = register(async ({ api, storagePath, version }) => {
      await api.downloadFile("https://fixture.test/server", path.join(storagePath, "server.js"), {
        digest,
      });
      return { module: "server.js", version };
    });
    const record = await managed.install(adapter.id, { version: "1.0.0" });
    expect(record.version).toBe("1.0.0");
    expect(fs.readFileSync(payloadPath())).toEqual(payload);
    expect(requests.length).toBe(1);
    expect(requests[0].options.signal).toBeDefined();
    expect(transientPaths()).toEqual([]);
  });
});
