const path = require("node:path");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let tick = 0; tick < 100; tick++) await Promise.resolve();
};

describe("session controller physical process ownership", () => {
  let manager, Session, adapter, editors;
  const root = path.resolve("session-controller-project");
  const otherRoot = path.resolve("session-controller-other-project");
  const editorAt = (folder) => ({
    getPath: () => path.join(folder, "main.test"),
    getGrammar: () => ({ scopeName: "source.controller-test" }),
  });
  const childStarted = (session) => {
    session.process = { exitCode: null, signalCode: null, kill: jasmine.createSpy("kill") };
    session.processExited = false;
  };
  const childExited = (session) => {
    session.processExited = true;
    if (session.process) session.process.exitCode = 0;
    manager.didExitProcess(session);
  };

  beforeEach(() => {
    const Manager = require("../lib/language-server-manager");
    Session = require("../lib/server-session");
    manager = new Manager();
    editors = [];
    spyOn(lumine.project, "getPaths").and.returnValue([]);
    spyOn(lumine.workspace, "getTextEditors").and.callFake(() => editors);
    spyOn(manager, "reattachAll").and.resolveTo();
    spyOn(console, "error");
    spyOn(lumine.notifications, "addError");
    adapter = {
      id: "controller-test",
      displayName: "Controller Test",
      grammarScopes: ["source.controller-test"],
      resolveServer: jasmine.createSpy("resolveServer").and.resolveTo({ command: "test-server" }),
    };
    manager.adapters.set(adapter.id, adapter);
    spyOn(Session.prototype, "stop").and.callFake(async function () {
      this.setState("stopped");
      childExited(this);
    });
  });
  afterEach(async () => {
    for (const session of manager.knownSessions()) childExited(session);
    await manager.deactivate();
  });

  it("waits for an obsolete starting replacement's physical exit after cleanup fails", async () => {
    const initializing = deferred();
    const stopping = deferred();
    let obsolete;
    const start = spyOn(Session.prototype, "start").and.callFake(function () {
      childStarted(this);
      if (start.calls.count() === 2) {
        obsolete = this;
        return initializing.promise;
      }
      this.setState("running");
      return Promise.resolve();
    });
    const original = await manager.ensureSession(adapter, root);
    await original.ready;

    const restarting = manager.restart(original);
    restarting.catch(() => {});
    await flush();
    expect(start.calls.count()).toBe(2);
    obsolete.stop = jasmine.createSpy("obsolete.stop").and.callFake(() => {
      obsolete.setState("stopped");
      return stopping.promise;
    });
    const superseding = manager.restartAdapter(adapter);
    superseding.catch(() => {});
    await flush();
    expect(obsolete.stop).toHaveBeenCalled();
    stopping.reject(new Error("obsolete child survived cleanup"));
    await flush();

    expect(adapter.resolveServer.calls.count()).toBe(2);
    expect(start.calls.count()).toBe(2);
    expect(manager.ownedSessions.has(obsolete)).toBe(true);

    childExited(obsolete);
    initializing.resolve();
    await Promise.allSettled([restarting, superseding]);
    const replacement = await manager.ensureSession(adapter, root);
    await replacement.ready;
    expect(replacement).not.toBe(obsolete);
    expect(replacement.state).toBe("running");
    expect(start.calls.count()).toBe(3);
    expect(manager.ownedSessions.has(obsolete)).toBe(false);
  });

  it("quarantines a failed first start for the same adapter without blocking another root", async () => {
    const editor = editorAt(root);
    editors = [editor];
    let failed;
    const start = spyOn(Session.prototype, "start").and.callFake(async function () {
      childStarted(this);
      if (start.calls.count() === 1) {
        failed = this;
        this.setState("failed", new Error("initialize failed"));
        this.stop = jasmine.createSpy("failed.stop").and.callFake(async () => {
          failed.setState("stopped");
          throw new Error("failed child survived cleanup");
        });
        throw new Error("initialize failed");
      }
      this.setState("running");
    });
    await manager.attachAdapter(adapter, editor);
    await flush();
    expect(failed.stop).toHaveBeenCalled();

    const attaching = manager.ensureSession(adapter, root, { editor });
    attaching.catch(() => {});
    await flush();
    expect(adapter.resolveServer.calls.count()).toBe(1);
    expect(start.calls.count()).toBe(1);
    expect(manager.ownedSessions.has(failed)).toBe(true);

    const independent = await manager.ensureSession(adapter, otherRoot);
    await independent.ready;
    expect(independent.rootPath).toBe(otherRoot);
    expect(start.calls.count()).toBe(2);
    expect(failed.processExited).toBe(false);

    childExited(failed);
    const replacement = await attaching;
    await replacement.ready;
    expect(replacement.rootPath).toBe(root);
    expect(replacement).not.toBe(failed);
    expect(start.calls.count()).toBe(3);
  });

  it("releases a quarantined ensure when the window closes without waiting for child exit", async () => {
    let session;
    const start = spyOn(Session.prototype, "start").and.callFake(async function () {
      childStarted(this);
      this.setState("running");
    });
    session = await manager.ensureSession(adapter, root);
    await session.ready;
    session.stop = jasmine.createSpy("blocked.stop").and.callFake(async () => {
      session.setState("stopped");
      throw new Error("child survived cleanup");
    });
    session.kill = jasmine.createSpy("blocked.kill");
    await expectAsync(manager.restart(session)).toBeRejectedWithError(/child survived cleanup/);

    const attaching = manager.ensureSession(adapter, root);
    await flush();
    expect(start.calls.count()).toBe(1);
    manager.killAllSessions();

    expect(await attaching).toBeNull();
    expect(session.kill).toHaveBeenCalled();
    expect(session.processExited).toBe(false);
    expect(manager.ownedSessions.has(session)).toBe(true);
    expect(manager.allSessions()).toEqual([]);
    childExited(session);
    expect(manager.ownedSessions.has(session)).toBe(false);
  });

  it("retries the current failure after an obsolete child fails during a manual restart", async () => {
    const resolving = deferred();
    const start = spyOn(Session.prototype, "start").and.callFake(async function () {
      childStarted(this);
      this.setState("running");
    });
    const original = await manager.ensureSession(adapter, root);
    await original.ready;
    const controller = manager.controllerForSession(original);
    adapter.resolveServer.and.returnValue(resolving.promise);

    const restarting = manager.restart(original);
    await flush();
    original.setState("failed", new Error("old generation crashed"));
    // Failure reports may still reference a child after its restart began.
    controller.lastFailedSession = original;
    manager.scheduleRestart(original);

    expect(controller.retryTimer).toBeNull();
    expect(controller.retrySource).toBeNull();
    expect(original.failureCount).toBe(0);
    resolving.resolve({ command: "replacement-server" });
    const replacement = await restarting;
    await flush();
    expect(controller.lastFailedSession).toBeNull();

    // Late automatic requests from the old source cannot replace this child.
    expect(await controller.restart({ retry: true, source: original })).toBe(replacement);
    expect(start.calls.count()).toBe(2);
    replacement.setState("failed", new Error("current generation crashed"));
    manager.scheduleRestart(replacement);

    expect(controller.retrySource).toBe(replacement);
    expect(controller.retryTimer).not.toBeNull();
    expect(replacement.failureCount).toBe(1);
    advanceClock(1000);
    await flush();

    const retried = manager.sessionForRoute(adapter, root);
    expect(retried).not.toBe(replacement);
    expect(retried.state).toBe("running");
    expect(start.calls.count()).toBe(3);
    expect(retried.failureCount).toBe(1);
    expect(controller.retryTimer).toBeNull();
    expect(controller.retrySource).toBeNull();
  });

  it("does not start a child disconnected synchronously during its publication", async () => {
    const start = spyOn(Session.prototype, "start").and.callFake(async function () {
      childStarted(this);
      this.setState("running");
    });
    let published, disconnecting;
    const subscription = manager.onDidChangeSession(({ session, state }) => {
      if (state !== "starting" || published) return;
      published = session;
      disconnecting = manager.disconnect(session);
      disconnecting.catch(() => {});
    });

    const session = await manager.ensureSession(adapter, root);
    await disconnecting;

    expect(published).toBeDefined();
    expect(session).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(Session.prototype.stop.calls.count()).toBe(1);
    expect(published.state).toBe("stopped");
    expect(manager.allSessions()).toEqual([]);
    subscription.dispose();
  });

  it("joins a synchronous restart during publication without starting the superseded child", async () => {
    const started = [];
    spyOn(Session.prototype, "start").and.callFake(async function () {
      started.push(this);
      childStarted(this);
      this.setState("running");
    });
    let published, restarting;
    const subscription = manager.onDidChangeSession(({ session, state }) => {
      if (state !== "starting" || published) return;
      published = session;
      restarting = manager.restart(session);
      restarting.catch(() => {});
    });

    const session = await manager.ensureSession(adapter, root);
    const replacement = await restarting;

    expect(session).toBe(replacement);
    expect(replacement).not.toBe(published);
    expect(replacement.state).toBe("running");
    expect(started).toEqual([replacement]);
    expect(published.state).toBe("stopped");
    expect(manager.sessionForRoute(adapter, root)).toBe(replacement);
    expect(Session.prototype.stop.calls.count()).toBe(1);
    subscription.dispose();
  });

  it("retires an unstarted child when its initiating editor closes during publication", async () => {
    let destroyed = false;
    const editor = { ...editorAt(root), isDestroyed: () => destroyed };
    editors = [editor];
    const start = spyOn(Session.prototype, "start").and.callFake(async function () {
      childStarted(this);
      this.setState("running");
    });
    let published;
    const subscription = manager.onDidChangeSession(({ session, state }) => {
      if (state !== "starting" || published) return;
      published = session;
      destroyed = true;
    });

    const session = await manager.ensureSession(adapter, root, { editor });
    await flush();

    expect(session).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(Session.prototype.stop.calls.count()).toBe(1);
    expect(published.state).toBe("stopped");
    expect(manager.controllerForRoute(adapter, root)).toBeNull();
    expect(manager.controllers.size).toBe(0);
    expect(manager.allSessions()).toEqual([]);
    subscription.dispose();
  });

  it("cleans the protocol model when an adapter unregisters after its child already exited", async () => {
    spyOn(Session.prototype, "start").and.callFake(async function () {
      childStarted(this);
      this.setState("running");
    });
    const session = await manager.ensureSession(adapter, root);
    await session.ready;
    const dispose = jasmine.createSpy("protocol model dispose");
    session.connection = { dispose };
    session.documents.set("file:///controller-test/main.test", {
      uri: "file:///controller-test/main.test",
    });
    session.stop = jasmine.createSpy("stop").and.callFake(async () => {
      session.connection.dispose();
      session.documents.clear();
      session.setState("stopped");
    });

    childExited(session);
    expect(manager.ownedSessions.has(session)).toBe(false);
    expect(dispose).not.toHaveBeenCalled();

    await manager.unregisterAdapter(adapter);

    expect(session.stop.calls.count()).toBe(1);
    expect(dispose.calls.count()).toBe(1);
    expect(session.documents.size).toBe(0);
    expect(session.state).toBe("stopped");
    expect(manager.controllers.size).toBe(0);
    expect(manager.allSessions()).toEqual([]);
  });
});
