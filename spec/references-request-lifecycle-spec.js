const { Emitter, Point } = require("lumine");
const ReferencesProvider = require("../lib/references-provider");
const Projections = require("../lib/document-projections");
const RpcConnection = require("../lib/rpc-connection");
const { PassThrough } = require("stream");

describe("References request lifecycle", () => {
  let emitter, provider, editor;
  const uri = "file:///references-lifecycle.ipy";
  const location = {
    uri,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };
  beforeEach(() => {
    emitter = new Emitter();
    const buffer = {
      lineForRow: () => "value = 1",
      onDidChange: (callback) => emitter.on("text", callback),
    };
    editor = {
      getBuffer: () => buffer,
      isDestroyed: () => false,
      onDidChangePath: (callback) => emitter.on("path", callback),
      onDidChangeGrammar: (callback) => emitter.on("grammar", callback),
      onDidChangeCursorPosition: (callback) => emitter.on("cursor", callback),
      onDidDestroy: (callback) => emitter.on("destroy", callback),
    };
  });
  afterEach(() => {
    provider?.dispose();
    emitter.dispose();
  });
  const createProvider = (activeSessionsForEditor) =>
    new ReferencesProvider({
      addCapabilityFragment() {},
      activeSessionsForEditor,
      uriForEditor: () => uri,
      resolveUri: () => ({ kind: "file", path: "references-lifecycle.ipy" }),
    });
  const session = (request) => ({ supports: () => true, request });

  it("does not let an older readiness wait cancel or send a newer lookup", async () => {
    const older = deferred(),
      newer = deferred();
    let readiness = 0;
    const asked = [];
    const server = session(async (_method, params) => {
      asked.push(params.position.character);
      return [location];
    });
    provider = createProvider(() => (++readiness === 1 ? older.promise : newer.promise));
    const first = provider.findReferences(editor, new Point(0, 1));
    const second = provider.findReferences(editor, new Point(0, 2));
    newer.resolve([server]);
    expect((await second).references.length).toBe(1);
    older.resolve([server]);
    expect(await first).toBeNull();
    expect(asked).toEqual([2]);
  });

  it("copies the requested point before waiting for sessions", async () => {
    const readiness = deferred(),
      asked = [];
    provider = createProvider(() => readiness.promise);
    const point = new Point(0, 2);
    const request = provider.findReferences(editor, point);
    point.column = 9;
    readiness.resolve([
      session(async (_method, params) => {
        asked.push(params.position.character);
        return [location];
      }),
    ]);
    expect((await request).symbolName).toBe("value");
    expect(asked).toEqual([2]);
  });

  it("cancels startup and releases request subscriptions when disposed", async () => {
    const readiness = deferred();
    const request = jasmine.createSpy("request").and.resolveTo([location]);
    provider = createProvider(() => readiness.promise);
    const result = provider.findReferences(editor, new Point(0, 2));
    const subscriptions = provider.requestSubscriptions;
    spyOn(subscriptions, "dispose").and.callThrough();
    const signal = provider.abortController.signal;
    provider.dispose();
    expect(signal.aborted).toBe(true);
    expect(subscriptions.dispose).toHaveBeenCalled();
    readiness.resolve([session(request)]);
    expect(await result).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(await provider.findReferences(editor, new Point(0, 2))).toBeNull();
  });

  for (const event of ["text", "path", "grammar", "cursor", "destroy"]) {
    it(`abandons ${event} changes during RPC even if the server ignores the signal`, async () => {
      const started = deferred(),
        reply = deferred();
      let signal;
      provider = createProvider(async () => [
        session(async (_method, _params, options) => {
          signal = options.signal;
          started.resolve();
          return reply.promise;
        }),
      ]);
      const request = provider.findReferences(editor, new Point(0, 2));
      await started.promise;
      emitter.emit(event);
      expect(signal.aborted).toBe(true);
      reply.resolve([location]);
      expect(await request).toBeNull();
      expect(provider.abortController).toBeNull();
    });
  }

  it("abandons a text change before RPC and releases completed request listeners", async () => {
    const readiness = deferred(),
      request = jasmine.createSpy("request").and.resolveTo([location]);
    provider = createProvider(() => readiness.promise);
    const result = provider.findReferences(editor, new Point(0, 2));
    const controller = provider.abortController;
    emitter.emit("text");
    readiness.resolve([session(request)]);
    expect(await result).toBeNull();
    expect(request).not.toHaveBeenCalled();
    provider = createProvider(async () => [session(request)]);
    const completed = provider.findReferences(editor, new Point(0, 2));
    const current = provider.abortController;
    expect((await completed).references.length).toBe(1);
    emitter.emit("text");
    expect(controller.signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(false);
  });

  it("treats only tagged stale projections as cancellation and preserves genuine failures", async () => {
    provider = createProvider(async () => [
      session(async () => {
        throw new Projections.StaleProjectionError();
      }),
    ]);
    expect(await provider.findReferences(editor, new Point(0, 2))).toBeNull();
    for (const error of [
      new Error("Language server projection is stale"),
      Object.assign(new Error("Pending response rejected since connection got disposed"), {
        code: -32097,
      }),
      "server failed",
      null,
    ]) {
      provider = createProvider(async () => [
        session(async () => {
          throw error;
        }),
      ]);
      await expectAsync(provider.findReferences(editor, new Point(0, 2))).toBeRejectedWith(error);
    }
  });

  for (const state of ["stopping", "stopped", "failed"]) {
    it(`abandons a ${state} server before JSON-RPC disposal rejects its pending response`, async () => {
      const reader = new PassThrough();
      const writer = new PassThrough();
      writer.resume();
      const connection = new RpcConnection(reader, writer);
      const lifecycle = new Emitter();
      const started = deferred();
      let signal;
      const server = {
        state: "running",
        supports: () => true,
        onDidChangeState: (callback) => lifecycle.on("state", callback),
        request(method, params, options) {
          signal = options.signal;
          const pending = connection.request(method, params, options);
          started.resolve();
          return pending;
        },
      };
      connection.listen();
      provider = createProvider(async () => [server]);
      try {
        const pending = provider.findReferences(editor, new Point(0, 2));
        await started.promise;
        if (state === "failed") connection.dispose();
        server.state = state;
        lifecycle.emit("state", { session: server, state });
        connection.dispose();
        expect(await pending).toBeNull();
        expect(signal.aborted).toBe(true);
        expect(provider.abortController).toBeNull();
        expect(provider.requestSubscriptions).toBeNull();
      } finally {
        connection.dispose();
        lifecycle.dispose();
      }
    });
  }

  it("does not send references to a session retired during readiness", async () => {
    const request = jasmine.createSpy("request").and.resolveTo([location]);
    provider = createProvider(async () => [{ ...session(request), state: "stopping" }]);
    expect(await provider.findReferences(editor, new Point(0, 2))).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("releases server listeners after successful lookups and uses a replacement session", async () => {
    const lifecycle = new Emitter();
    const subscriptions = [];
    const server = {
      ...session(async () => [location]),
      state: "running",
      onDidChangeState(callback) {
        const subscription = lifecycle.on("state", callback);
        spyOn(subscription, "dispose").and.callThrough();
        subscriptions.push(subscription);
        return subscription;
      },
    };
    provider = createProvider(async () => [server]);
    try {
      expect((await provider.findReferences(editor, new Point(0, 2))).references.length).toBe(1);
      expect(subscriptions.length).toBe(1);
      expect(subscriptions[0].dispose).toHaveBeenCalled();
      server.state = "stopped";
      lifecycle.emit("state", { session: server, state: "stopped" });
      const replacement = { ...session(async () => [location]), state: "running" };
      provider.manager.activeSessionsForEditor = async () => [replacement];
      expect((await provider.findReferences(editor, new Point(0, 2))).references.length).toBe(1);
    } finally {
      lifecycle.dispose();
    }
  });
});
