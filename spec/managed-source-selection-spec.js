const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURE = path.join(__dirname, "fixtures", "fake-server.js");
const MODULE = "node_modules/test-language-server/server.js";

describe("managed server selection through actual startup", () => {
  let manager, managed, adapter, scratch, configuredPath, bundledPath, candidates, leases;

  const writeInstallation = (version = "1.0.0") => {
    const directory = managed.directoryFor(adapter);
    const filename = path.join(directory, MODULE);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.copyFileSync(FIXTURE, filename);
    fs.writeFileSync(
      managed.recordPath(adapter),
      JSON.stringify({
        version,
        source: "npm",
        installedAt: new Date().toISOString(),
        module: MODULE,
      }),
    );
    return filename;
  };

  beforeEach(() => {
    jasmine.useRealClock();
    const Manager = require("../lib/language-server-manager");
    const ManagedServers = require("../lib/managed-servers");
    manager = new Manager();
    spyOn(manager, "reattachAll").and.resolveTo();
    spyOn(lumine.project, "getPaths").and.returnValue([]);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ide-managed-selection-"));
    managed = new ManagedServers(manager, { storageRoot: path.join(scratch, "servers") });
    manager.setManagedServers(managed);
    configuredPath = FIXTURE;
    leases = [];
    bundledPath = jasmine.createSpy("bundled server").and.returnValue(FIXTURE);
    candidates = jasmine.createSpy("discovered servers").and.returnValue([FIXTURE]);
    adapter = {
      id: "managed-selection",
      displayName: "Managed Selection",
      grammarScopes: ["source.managed-selection"],
      managedServer: {
        source: "npm",
        packages: ["test-language-server"],
        module: MODULE,
      },
      async resolveServer(context) {
        const selection = await context.resolver.select({
          kind: "node",
          configuredPath,
          managed: () => {
            const installed = context.getManagedServer();
            return installed ? { path: installed.modulePath, version: installed.version } : null;
          },
          bundledPath,
          candidates,
          names: [path.basename(process.execPath)],
          env: { PATH: path.dirname(process.execPath) },
          signal: context.signal,
        });
        return context.resolver.launch(selection, { args: ["{}"], signal: context.signal });
      },
    };
    manager.registerAdapter(adapter);
  });

  afterEach(async () => {
    await manager.deactivate();
    for (const lease of leases) await lease.release();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const start = async () => {
    const session = await manager.ensureSession(adapter, scratch);
    await session.ready;
    return session;
  };

  const failures = [
    {
      name: "unreadable install.json",
      prepare: () => {
        fs.mkdirSync(managed.directoryFor(adapter), { recursive: true });
        fs.writeFileSync(managed.recordPath(adapter), "{");
      },
      message: /damaged:.*install.json is missing or unreadable/,
    },
    {
      name: "missing managed payload",
      prepare: () => fs.unlinkSync(writeInstallation()),
      message: /damaged:.*module payload is missing or unusable/,
    },
    {
      name: "active installation lease without a target",
      prepare: async () => {
        leases.push(await managed.store.acquire(adapter.id));
        expect(fs.existsSync(managed.directoryFor(adapter))).toBe(false);
      },
      message: /being changed or requires recovery/,
    },
  ];

  for (const failure of failures) {
    it(`starts the configured server despite ${failure.name}`, async () => {
      await failure.prepare();
      const read = spyOn(managed.store, "read").and.callThrough();
      const session = await start();
      const messages = await session.request("test/getReceived");
      expect(session.state).toBe("running");
      expect(session.launch.args).toEqual([FIXTURE, "{}"]);
      expect(messages.some(({ method }) => method === "initialize")).toBe(true);
      expect(read).not.toHaveBeenCalled();
      expect(bundledPath).not.toHaveBeenCalled();
      expect(candidates).not.toHaveBeenCalled();
    });

    it(`preserves the healthy server when restart selects ${failure.name}`, async () => {
      const session = await start();
      await failure.prepare();
      configuredPath = "";
      const stop = spyOn(session, "stop").and.callThrough();
      const read = spyOn(managed.store, "read").and.callThrough();
      await expectAsync(manager.restart(session)).toBeRejectedWithError(failure.message);
      expect(stop).not.toHaveBeenCalled();
      expect(session.state).toBe("running");
      expect(manager.sessionForRoute(adapter, scratch)).toBe(session);
      expect(read).toHaveBeenCalledTimes(1);
      expect(bundledPath).not.toHaveBeenCalled();
      expect(candidates).not.toHaveBeenCalled();
      const messages = await session.request("test/getReceived");
      expect(messages.some(({ method }) => method === "shutdown")).toBe(false);
    });
  }

  it("keeps one installed value per snapshot and reads a changed record in a fresh context", () => {
    writeInstallation("1.0.0");
    const read = spyOn(managed.store, "read").and.callThrough();
    const context = manager.adapterContext(adapter, scratch);
    const first = context.getManagedServer();
    writeInstallation("2.0.0");
    expect(context.getManagedServer()).toBe(first);
    expect(first.version).toBe("1.0.0");
    expect(read).toHaveBeenCalledTimes(1);
    const current = manager.adapterContext(adapter, scratch).getManagedServer();
    expect(current.version).toBe("2.0.0");
    expect(current.modulePath).toBe(path.join(managed.directoryFor(adapter), MODULE));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a missing installation in its snapshot and sees a new install in a fresh context", () => {
    const read = spyOn(managed.store, "read").and.callThrough();
    const context = manager.adapterContext(adapter, scratch);
    expect(context.getManagedServer()).toBeNull();
    writeInstallation("2.0.0");
    expect(context.getManagedServer()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(manager.adapterContext(adapter, scratch).getManagedServer().version).toBe("2.0.0");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps one corruption error per snapshot and sees a repaired record in a fresh context", () => {
    failures[0].prepare();
    const read = spyOn(managed.store, "read").and.callThrough();
    const context = manager.adapterContext(adapter, scratch);
    let error;
    try {
      context.getManagedServer();
    } catch (failure) {
      error = failure;
    }
    expect(error.message).toMatch(failures[0].message);
    writeInstallation("2.0.0");
    expect(() => context.getManagedServer()).toThrow(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(manager.adapterContext(adapter, scratch).getManagedServer().version).toBe("2.0.0");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
