const path = require("node:path");
const Manager = require("../lib/language-server-manager");
const Session = require("../lib/server-session");
const { publishSession } = require("./helpers/session-fixtures");
const flush = async () => {
  for (let tick = 0; tick < 100; tick++) await Promise.resolve();
};

describe("server resolution ownership", () => {
  let manager;
  const rootPath = path.resolve("resolver-lifecycle-project");
  beforeEach(() => {
    manager = new Manager();
    spyOn(manager, "reattachAll").and.resolveTo();
    spyOn(lumine.project, "getPaths").and.returnValue([]);
  });
  afterEach(async () => manager.deactivate());
  const adapterFor = (resolveServer) => ({
    id: "resolver-lifecycle",
    displayName: "Resolver Lifecycle",
    grammarScopes: ["source.resolver-lifecycle"],
    resolveServer,
  });
  it("rejects an invalid launch before stopping a healthy source", async () => {
    const adapter = adapterFor(async () => ({ command: "server", transport: "bad-transport" }));
    manager.registerAdapter(adapter);
    const stop = jasmine.createSpy("stop").and.resolveTo();
    const source = { adapter, rootPath, state: "running", stop };
    publishSession(manager, source);
    await expectAsync(manager.restart(source)).toBeRejectedWithError(/transport/);
    expect(stop).not.toHaveBeenCalled();
    expect(manager.sessionForRoute(adapter, rootPath)).toBe(source);
  });
  it("aborts a superseded probe context while completing the newest generation", async () => {
    let firstContext, finish;
    let entered;
    const firstEntered = new Promise((resolve) => (entered = resolve));
    let calls = 0;
    const adapter = adapterFor((context) => {
      if (calls++ === 0) {
        firstContext = context;
        entered();
        return new Promise((resolve) => (finish = resolve));
      }
      return { command: "new-server" };
    });
    manager.registerAdapter(adapter);
    spyOn(Session.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(Session.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
    });
    const original = manager.ensureSession(adapter, rootPath);
    await firstEntered;
    const restart = manager.restartAdapter(adapter);
    await flush();
    expect(firstContext.signal.aborted).toBe(true);
    expect(() => firstContext.resolver.findExecutables("anything")).toThrowMatching(
      (error) => error.name === "AbortError",
    );
    finish({ command: "old-server" });
    const [replacement] = await restart;
    expect(await original).toBe(replacement);
    expect(replacement.launch.command).toBe("new-server");
    expect(Session.prototype.start).toHaveBeenCalledTimes(1);
  });
  it("cancels a borrowed resolver when the manager lifetime ends", async () => {
    let entered, finish;
    const started = new Promise((resolve) => (entered = resolve));
    const pending = manager.serverResolver.select({
      configuredPath: process.execPath,
      validate: () => {
        entered();
        return new Promise((resolve) => (finish = resolve));
      },
    });
    await started;
    const outcome = pending.catch((error) => error);
    await manager.deactivate();
    expect((await outcome).name).toBe("AbortError");
    finish();
  });
});
