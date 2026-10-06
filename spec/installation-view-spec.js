const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Manager = require("../lib/language-server-manager");
const ManagedServers = require("../lib/managed-servers");
const ManagedServersView = require("../lib/managed-servers-view");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("managed installation view", () => {
  let manager, managed, scratch, storageRoot, adapter, view;
  beforeEach(async () => {
    jasmine.useRealClock();
    manager = new Manager();
    spyOn(manager, "reattachAll").and.resolveTo();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ide-installation-view-"));
    storageRoot = path.join(scratch, "language-servers");
    managed = new ManagedServers(manager, {
      storageRoot,
      fetchUrl: () => Promise.reject(new Error("Unexpected network request")),
    });
    manager.setManagedServers(managed);
    adapter = {
      id: "installation-view-test",
      displayName: "View Test Server",
      grammarScopes: ["source.installation-view-test"],
      resolveServer: async () => null,
      latestServerVersion: async () => "1.0.0",
      installServer: async ({ storagePath }) => {
        await fs.promises.writeFile(path.join(storagePath, "server.js"), "healthy server");
        return { module: "server.js", version: "1.0.0" };
      },
    };
    manager.registerAdapter(adapter);
    await managed.install(adapter.id);
  });
  afterEach(async () => {
    if (view && !view.destroyed) await view.destroy();
    await manager.deactivate();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const show = async () => {
    view = new ManagedServersView({
      managedServers: managed,
      installServer: (id) => managed.install(id),
      updateServer: (id) => managed.update(id),
    });
    await view.listHost.show();
  };

  for (const damage of ["record", "payload"]) {
    it(`keeps a damaged ${damage} visible and removable through the actual list action`, async () => {
      const target = path.join(storageRoot, adapter.id);
      if (damage === "record") fs.writeFileSync(path.join(target, "install.json"), "{broken");
      else fs.rmSync(path.join(target, "server.js"));
      await show();
      const row = view.list.getItems().find((item) => item.id === adapter.id);
      expect(row.entry.broken).toBe(true);
      expect(row.state).toBe("failed");
      expect(row.detail).toMatch(/Reinstall or remove/);
      const commands = view.list.getAvailableActions().map((action) => action.command);
      expect(commands).toContain("ide:install-server");
      expect(commands).toContain("ide:uninstall-server");
      await view.list.runAction("ide:uninstall-server");
      expect(fs.existsSync(target)).toBe(false);
      expect(managed.installFor(adapter)).toBe(null);
      expect(view.list.getItems()[0].entry.broken).toBeUndefined();
    });
  }

  it("repairs a damaged installation through the actual install action", async () => {
    const target = path.join(storageRoot, adapter.id);
    fs.writeFileSync(path.join(target, "install.json"), "{broken");
    await show();
    await view.list.runAction("ide:install-server");
    expect(managed.installFor(adapter).version).toBe("1.0.0");
    expect(fs.readFileSync(path.join(target, "server.js"), "utf8")).toBe("healthy server");
    expect(view.list.getItems()[0].entry.broken).toBeUndefined();
  });

  it("keeps update and removal actions available for an installed server with no version", async () => {
    await manager.unregisterAdapter(adapter);
    adapter = {
      ...adapter,
      latestServerVersion: undefined,
      installServer: async ({ storagePath }) => {
        await fs.promises.writeFile(path.join(storagePath, "server.js"), "unversioned server");
        return { module: "server.js" };
      },
    };
    manager.registerAdapter(adapter);
    const record = await managed.install(adapter.id);
    expect(record.version).toBe(null);
    await show();
    const row = view.list.getItems()[0];
    expect(row.entry.hasInstall).toBe(true);
    expect(row.entry.installed).toBe(null);
    expect(row.state).toBe(null);
    expect(row.detail).toMatch(/installed.*version unknown/);
    const commands = view.list.getAvailableActions().map((action) => action.command);
    expect(commands).toContain("ide:update-server");
    expect(commands).toContain("ide:uninstall-server");
    expect(commands).not.toContain("ide:install-server");
    await view.list.runAction("ide:uninstall-server");
    expect(managed.installFor(adapter)).toBe(null);
    expect(fs.existsSync(path.join(storageRoot, adapter.id))).toBe(false);
  });

  it("does not update a destroyed list when a version lookup settles late", async () => {
    await show();
    const entered = deferred();
    const release = deferred();
    adapter.latestServerVersion = async () => {
      entered.resolve();
      return release.promise;
    };
    const checking = view.checkForUpdates();
    await entered.promise;
    await view.destroy();
    const items = spyOn(view.list, "setItems").and.callThrough();
    const info = spyOn(view.list, "setInfoMessage").and.callThrough();
    release.resolve("2.0.0");
    await checking;
    expect(items).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("does not report or render a removal failure after its list is destroyed", async () => {
    await show();
    const release = deferred();
    spyOn(managed, "uninstall").and.returnValue(release.promise);
    const entry = view.list.getItems()[0].entry;
    const removing = view.uninstall(entry);
    await view.destroy();
    const items = spyOn(view.list, "setItems").and.callThrough();
    const info = spyOn(view.list, "setInfoMessage").and.callThrough();
    const failure = spyOn(lumine.notifications, "addError");
    release.reject(new Error("The cancelled view no longer owns this failure"));
    await removing;
    expect(failure).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("does not render an installation result after its list is destroyed", async () => {
    await show();
    const release = deferred();
    const work = jasmine.createSpy("install").and.returnValue(release.promise);
    const installing = view.act(work, view.list.getItems()[0].entry);
    await view.destroy();
    const items = spyOn(view.list, "setItems").and.callThrough();
    release.resolve({ version: "2.0.0" });
    await installing;
    expect(items).not.toHaveBeenCalled();
  });

  it("suppresses a cancellation notification while leaving its healthy row available", async () => {
    await show();
    spyOn(managed, "uninstall").and.rejectWith(new DOMException("Cancelled", "AbortError"));
    const failure = spyOn(lumine.notifications, "addError");
    await view.uninstall(view.list.getItems()[0].entry);
    expect(failure).not.toHaveBeenCalled();
    expect(view.list.getItems()[0].entry.installed).toBe("1.0.0");
  });
});

describe("installation notifications across package lifetimes", () => {
  let main, managed, scratch;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("ide");
    main = lumine.packages.getActivePackage("ide").mainModule;
    const CurrentManagedServers = require("../lib/managed-servers");
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ide-installation-notifications-"));
    managed = new CurrentManagedServers(main.manager, {
      storageRoot: path.join(scratch, "servers"),
    });
    main.managedServers = managed;
    main.manager.setManagedServers(managed);
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const installWithGate = () => {
    const entered = deferred();
    const release = deferred();
    let stage;
    main.provideIde().registerAdapter({
      id: "notification-lifetime-test",
      displayName: "Notification Test Server",
      grammarScopes: ["source.notification-lifetime-test"],
      resolveServer: async () => null,
      installServer: async ({ storagePath }) => {
        stage = storagePath;
        entered.resolve();
        await release.promise;
        await fs.promises.writeFile(path.join(storagePath, "server.js"), "retired server");
        return { module: "server.js", version: "1.0.0" };
      },
    });
    return { entered, release, cleaned: () => !fs.existsSync(stage) };
  };

  it("does not report success or failure when the caller cancels installation", async () => {
    const gate = installWithGate();
    const success = spyOn(lumine.notifications, "addSuccess");
    const failure = spyOn(lumine.notifications, "addError");
    const caller = new AbortController();
    const install = main
      .provideIde()
      .installServer("notification-lifetime-test", { signal: caller.signal })
      .catch((error) => error);
    await gate.entered.promise;
    caller.abort();
    expect((await install).name).toBe("AbortError");
    gate.release.resolve();
    await conditionPromise(gate.cleaned);
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });

  it("does not report an old installation after the package is reactivated", async () => {
    const gate = installWithGate();
    const success = spyOn(lumine.notifications, "addSuccess");
    const failure = spyOn(lumine.notifications, "addError");
    const install = main
      .provideIde()
      .installServer("notification-lifetime-test")
      .catch((error) => error);
    await gate.entered.promise;
    await lumine.packages.deactivatePackage("ide");
    expect((await install).name).toBe("AbortError");
    await lumine.packages.activatePackage("ide");
    main = lumine.packages.getActivePackage("ide").mainModule;
    gate.release.resolve();
    await conditionPromise(gate.cleaned);
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(main.manager.adapters.has("notification-lifetime-test")).toBe(false);
  });
});
