const path = require("path");
const SymbolProvider = require("../lib/symbol-provider");
const LanguageServerManager = require("../lib/language-server-manager");
const ServerSession = require("../lib/server-session");
const C = require("../lib/converters");

const root = path.resolve(__dirname, "workspace");
const symbol = (name, file = "source.js", character = 0) => ({
  name,
  kind: 12,
  location: {
    uri: C.pathToUri(path.join(root, file)),
    range: { start: { line: 0, character }, end: { line: 0, character: character + 1 } },
  },
});

describe("symbol services", () => {
  let manager, provider;
  const addSession = (id, items, options = {}) => {
    const adapter = { id, displayName: id, grammarScopes: ["source.js"], ...options.adapter };
    const session = new ServerSession(manager, adapter, options.root || root, {});
    session.state = options.state || "running";
    session.capabilities = { workspaceSymbolProvider: true, ...options.capabilities };
    session.request = jasmine.createSpy("request").and.callFake(async () => items);
    manager.sessions.set(id, session);
    return session;
  };
  beforeEach(() => {
    manager = new LanguageServerManager();
    spyOn(manager, "log");
    provider = new SymbolProvider(manager);
  });
  afterEach(() => {
    provider.destroy();
    manager.sessions.clear();
  });
  it("searches every relevant running backend once without touching an editor", async () => {
    const js = addSession("js", [symbol("jsSymbol")]);
    const py = addSession("py", [symbol("pySymbol", "source.py")]);
    manager.sessions.set("duplicate-root", py);
    const other = addSession("outside", [symbol("outside")], {
      root: path.join(root, "..", "elsewhere"),
    });
    spyOn(manager, "activeSessionsForEditor").and.throwError("must not attach documents");
    spyOn(manager, "ensureSession").and.throwError("must not start servers");
    const status = jasmine.createSpy("status");
    const found = await provider.searchWorkspaceSymbols("Symbol", {
      paths: [root],
      onStatus: status,
    });
    expect(found.map(({ name }) => name)).toEqual(["jsSymbol", "pySymbol"]);
    expect(js.request.calls.count()).toBe(1);
    expect(py.request.calls.count()).toBe(1);
    expect(other.request).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith({ state: "ready" });
  });
  it("keeps successful empty searches separate from missing or starting backends", async () => {
    const status = jasmine.createSpy("status");
    expect(await provider.searchWorkspaceSymbols("", { paths: [root], onStatus: status })).toEqual(
      [],
    );
    expect(status).toHaveBeenCalledWith({ state: "unavailable" });
    const session = addSession("js", [], { state: "starting" });
    await provider.searchWorkspaceSymbols("", { paths: [root], onStatus: status });
    expect(status).toHaveBeenCalledWith({ state: "starting" });
    expect(session.request).not.toHaveBeenCalled();
    session.state = "running";
    await provider.searchWorkspaceSymbols("", { paths: [root], onStatus: status });
    expect(status.calls.mostRecent().args[0]).toEqual({ state: "ready" });
  });
  it("preserves accumulated results and deduplicates overlapping server answers", async () => {
    addSession("first", [symbol("shared"), symbol("other", "source.js", 2)]);
    const failure = addSession("failure", []);
    failure.request.and.rejectWith(new Error("failed"));
    addSession("second", [symbol("shared")]);
    const status = jasmine.createSpy("status");
    const accumulated = jasmine.createSpy("accumulated");
    const found = await provider.searchWorkspaceSymbols("", {
      paths: [root],
      onStatus: status,
      onSymbols: accumulated,
    });
    expect(found.map(({ name }) => name)).toEqual(["shared", "other"]);
    expect(accumulated.calls.mostRecent().args[0]).toEqual(found);
    expect(status).toHaveBeenCalledWith({ state: "partial" });
    expect(manager.log).toHaveBeenCalled();
  });
  it("reports an error when every supporting backend fails", async () => {
    addSession("failed", []).request.and.rejectWith(new Error("failed"));
    const status = jasmine.createSpy("status");
    expect(await provider.searchWorkspaceSymbols("", { paths: [root], onStatus: status })).toEqual(
      [],
    );
    expect(status).toHaveBeenCalledWith({ state: "error" });
  });
  it("honours scoped feature switches and dynamic workspace capabilities without an active editor", async () => {
    const session = addSession("custom:js", [symbol("enabled")], {
      adapter: { features: { symbols: false } },
      capabilities: { workspaceSymbolProvider: false },
    });
    manager.registerCapabilities(session, [
      { id: "workspace", method: "workspace/symbol", registerOptions: {} },
    ]);
    expect(await provider.searchWorkspaceSymbols("", { paths: [root] })).toEqual([]);
    session.adapter.features.symbols = true;
    expect((await provider.searchWorkspaceSymbols("", { paths: [root] }))[0].name).toBe("enabled");
  });
  it("uses the adapter's workspace protocol and abandons late results after cancellation", async () => {
    let finish;
    const hook = jasmine.createSpy("hook").and.callFake(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const session = addSession("js", [], { adapter: { searchWorkspaceSymbols: hook } });
    const controller = new AbortController();
    const accumulated = jasmine.createSpy("accumulated");
    const pending = provider.searchWorkspaceSymbols("query", {
      paths: [root],
      signal: controller.signal,
      onSymbols: accumulated,
    });
    controller.abort();
    await expectAsync(pending).toBeRejected();
    finish([symbol("late")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.request).not.toHaveBeenCalled();
    expect(accumulated).not.toHaveBeenCalled();
    expect(hook.calls.first().args[0]).toBe("query");
  });
  it("keeps notebook cell identity when deduplicating workspace symbols", async () => {
    const notebookPath = path.join(root, "book.ipynb");
    const firstUri = C.cellUri(notebookPath, "a");
    const secondUri = C.cellUri(notebookPath, "b");
    spyOn(manager, "resolveUri").and.callFake((uri) => ({
      kind: "cell",
      notebookPath,
      cellIndex: uri === firstUri ? 0 : 1,
    }));
    const first = symbol("shared");
    const second = symbol("shared");
    first.location.uri = firstUri;
    second.location.uri = secondUri;
    addSession("notebook", [first, second]);
    const found = await provider.searchWorkspaceSymbols("", { paths: [root] });
    expect(found.map(({ cell }) => cell)).toEqual([1, 2]);
    expect(found.map(({ uri }) => uri)).toEqual([firstUri, secondUri]);
  });
  it("captures definition position before awaiting document readiness", async () => {
    const target = symbol("target").location;
    const session = addSession("js", [target], { capabilities: { definitionProvider: true } });
    let ready;
    spyOn(manager, "activeSessionsForEditor").and.callFake(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    const editor = {
      getPath: () => path.join(root, "source.js"),
      getLastCursor: () => ({ getBufferPosition: () => ({ row: 3, column: 4 }) }),
    };
    const pending = provider.getDefinitions(editor);
    ready([session]);
    expect((await pending)[0].path).toBe(path.join(root, "source.js"));
    expect(session.request.calls.first().args[1].position).toEqual({ line: 3, character: 4 });
  });

  it("settles a timed-out document request before its server is ready", async () => {
    jasmine.useRealClock();
    let finish;
    spyOn(manager, "activeSessionsForEditor").and.callFake(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const editor = {};
    await expectAsync(provider.getDocumentSymbols(editor, { timeoutMs: 5 })).toBeRejectedWithError(
      "Symbol request timed out",
    );
    finish([]);
  });

  it("invalidates workspace results when project roots or normal server availability change", async () => {
    const callback = jasmine.createSpy("invalidate");
    provider.onDidInvalidateWorkspaceSymbols(callback);
    const session = addSession("starting", [], { state: "starting" });
    manager.didChangeSession(session);
    session.state = "running";
    manager.didChangeSession(session);
    await Promise.resolve();
    expect(callback.calls.count()).toBe(1);
    provider.destroy();
    manager.didChangeSession(session);
    await Promise.resolve();
    expect(callback.calls.count()).toBe(1);
  });
});
