const path = require("path");
const SymbolProvider = require("../lib/symbol-provider");
const LanguageServerManager = require("../lib/language-server-manager");
const ServerSession = require("../lib/server-session");
const C = require("../lib/converters");
const { publishSession } = require("./helpers/session-fixtures");

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
    manager.adapters.set(id, adapter);
    publishSession(manager, session);
    return session;
  };
  beforeEach(() => {
    manager = new LanguageServerManager();
    spyOn(manager, "log");
    provider = new SymbolProvider(manager);
  });
  afterEach(async () => {
    provider.destroy();
    await manager.deactivate();
  });
  it("searches every relevant running backend once without touching an editor", async () => {
    const js = addSession("js", [symbol("jsSymbol")]);
    const py = addSession("py", [symbol("pySymbol", "source.py")]);
    publishSession(manager, py, path.join(root, "another-root"));
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
    addSession("js", [], { capabilities: { documentSymbolProvider: true } });
    let finish;
    spyOn(manager, "activeSessionsForEditor").and.callFake(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const editor = {
      getGrammar: () => ({ scopeName: "source.js" }),
      getPath: () => path.join(root, "source.js"),
    };
    await expectAsync(
      provider.getDocumentSymbols(editor, { sourceId: "ide-client:js", timeoutMs: 5 }),
    ).toBeRejectedWithError("Symbol request timed out");
    finish([]);
  });

  it("declines the document request when its selected backend disappears before retrieval", async () => {
    const session = addSession("js", [], { capabilities: { documentSymbolProvider: true } });
    const editor = {
      getGrammar: () => ({ scopeName: "source.js" }),
      getPath: () => path.join(root, "source.js"),
    };
    spyOn(manager, "activeSessionsForEditor").and.resolveTo([]);
    expect(provider.getDocumentSymbolSources(editor)[0].state).toBe("ready");
    expect(await provider.getDocumentSymbols(editor, { sourceId: "ide-client:js" })).toBeNull();
    expect(session.request).not.toHaveBeenCalled();
  });

  it("declines definition retrieval when its backend becomes unavailable", async () => {
    const session = addSession("js", [], { capabilities: { definitionProvider: true } });
    const editor = {
      getPath: () => path.join(root, "source.js"),
      getLastCursor: () => ({ getBufferPosition: () => ({ row: 0, column: 0 }) }),
    };
    spyOn(manager, "activeSessionsForEditor").and.returnValues(
      Promise.resolve([session]),
      Promise.resolve([]),
    );
    expect(await provider.canProvideDefinitions(editor)).toBe(true);
    expect(await provider.getDefinitions(editor)).toBeNull();
    expect(session.request).not.toHaveBeenCalled();
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

  it("invalidates workspace symbols when notebook cell topology changes", async () => {
    const callback = jasmine.createSpy("invalidate");
    provider.onDidInvalidateWorkspaceSymbols(callback);
    manager.emitter.emit("did-change-notebook", { record: {} });
    await Promise.resolve();
    expect(callback.calls.count()).toBe(1);
    provider.destroy();
    manager.emitter.emit("did-change-notebook", { record: {} });
    await Promise.resolve();
    expect(callback.calls.count()).toBe(1);
  });

  it("enumerates concrete sources without starting or waiting for a server", () => {
    const ready = addSession("ready", [], { capabilities: { documentSymbolProvider: true } });
    addSession("starting", [], { state: "starting" });
    addSession("unsupported", []);
    const editor = {
      getGrammar: () => ({ scopeName: "source.js" }),
      getPath: () => path.join(root, "source.js"),
    };
    spyOn(manager, "ensureSession").and.throwError("must not start servers");
    spyOn(manager, "activeSessionsForEditor").and.throwError("must not wait for servers");
    const sources = provider.getDocumentSymbolSources(editor);
    expect(sources.map(({ id, state }) => [id, state])).toEqual([
      ["ide-client:ready", "ready"],
      ["ide-client:starting", "starting"],
      ["ide-client:unsupported", "unavailable"],
    ]);
    expect(sources[0]).toEqual({
      id: "ide-client:ready",
      name: "ready",
      shortLabel: "LS",
      score: 1,
      state: "ready",
    });
    expect(ready.request).not.toHaveBeenCalled();
  });

  it("requests only the named adapter and declines missing or unsupported IDs", async () => {
    const first = addSession("first", [symbol("first")], {
      capabilities: { documentSymbolProvider: true },
    });
    const second = addSession("second", [symbol("second")], {
      capabilities: { documentSymbolProvider: true },
    });
    const editor = {
      getGrammar: () => ({ scopeName: "source.js" }),
      getPath: () => path.join(root, "source.js"),
    };
    spyOn(manager, "activeSessionsForEditor").and.resolveTo([first, second]);
    expect(
      (await provider.getDocumentSymbols(editor, { sourceId: "ide-client:second" }))[0].name,
    ).toBe("second");
    expect(first.request).not.toHaveBeenCalled();
    expect(
      await provider.getDocumentSymbols(editor, { sourceId: "ide-client:missing" }),
    ).toBeNull();
    expect(
      await provider.getDocumentSymbols(editor, { sourceId: "symbol-tree-sitter" }),
    ).toBeNull();
    expect(await provider.getDocumentSymbols(editor)).toBeNull();
    second.capabilities.documentSymbolProvider = false;
    expect(await provider.getDocumentSymbols(editor, { sourceId: "ide-client:second" })).toBeNull();
    expect(second.request.calls.count()).toBe(1);
  });

  it("reports a disabled source as unavailable without substituting an enabled server", async () => {
    const disabled = addSession("custom:disabled", [], {
      adapter: { features: { symbols: false } },
      capabilities: { documentSymbolProvider: true },
    });
    const enabled = addSession("enabled", [symbol("enabled")], {
      capabilities: { documentSymbolProvider: true },
    });
    const editor = {
      getGrammar: () => ({ scopeName: "source.js" }),
      getPath: () => path.join(root, "source.js"),
    };
    expect(
      provider
        .getDocumentSymbolSources(editor)
        .find(({ id }) => id === "ide-client:custom:disabled").state,
    ).toBe("unavailable");
    spyOn(manager, "activeSessionsForEditor").and.resolveTo([disabled, enabled]);
    expect(
      await provider.getDocumentSymbols(editor, { sourceId: "ide-client:custom:disabled" }),
    ).toBeNull();
    expect(enabled.request).not.toHaveBeenCalled();
  });

  it("omits foreign embedded sources and refuses exact requests before opening a document", async () => {
    const session = addSession("html", [symbol("fragment")], {
      adapter: {
        grammarScopes: ["text.html.basic", "source.gfm"],
        documentSymbolScopes: ["text.html.basic"],
      },
      capabilities: { documentSymbolProvider: true, hoverProvider: true, definitionProvider: true },
    });
    const host = {
      getGrammar: () => ({ scopeName: "source.gfm" }),
      getPath: () => path.join(root, "readme.md"),
    };
    spyOn(manager, "activeSessionsForEditor").and.throwError("must not attach a foreign document");
    spyOn(session, "openEditor").and.throwError("must not open a foreign document");
    expect(manager.adaptersForEditor(host)).toEqual([session.adapter]);
    expect(provider.getDocumentSymbolSources(host)).toEqual([]);
    expect(await provider.getDocumentSymbols(host, { sourceId: "ide-client:html" })).toBeNull();
    expect(manager.activeSessionsForEditor).not.toHaveBeenCalled();
    expect(session.openEditor).not.toHaveBeenCalled();
    expect(session.request).not.toHaveBeenCalled();
    expect(session.supports("textDocument/documentSymbol", host)).toBe(true);
    expect(session.supports("textDocument/hover", host)).toBe(true);
    expect(session.supports("textDocument/definition", host)).toBe(true);
    expect((await provider.searchWorkspaceSymbols("", { paths: [root] }))[0].name).toBe("fragment");
    const native = { ...host, getGrammar: () => ({ scopeName: "text.html.basic" }) };
    expect(provider.getDocumentSymbolSources(native)[0].state).toBe("ready");
  });

  it("uses the current root grammar and defaults ordinary adapters to their served grammars", async () => {
    const session = addSession("js", [symbol("native")], {
      capabilities: { documentSymbolProvider: true },
    });
    spyOn(manager, "activeSessionsForEditor").and.resolveTo([session]);
    let scopeName = "source.js";
    const editor = {
      getGrammar: () => ({ scopeName }),
      getPath: () => path.join(root, "source.js"),
    };
    expect(provider.getDocumentSymbolSources(editor)[0].id).toBe("ide-client:js");
    expect((await provider.getDocumentSymbols(editor, { sourceId: "ide-client:js" }))[0].name).toBe(
      "native",
    );
    scopeName = "source.gfm";
    expect(provider.getDocumentSymbolSources(editor)).toEqual([]);
    expect(await provider.getDocumentSymbols(editor, { sourceId: "ide-client:js" })).toBeNull();
    expect(session.request.calls.count()).toBe(1);
    scopeName = "source.js";
    session.adapter.documentSymbolScopes = [];
    expect(provider.getDocumentSymbolSources(editor)).toEqual([]);
    expect(await provider.getDocumentSymbols(editor, { sourceId: "ide-client:js" })).toBeNull();
    expect(session.request.calls.count()).toBe(1);
  });

  it("declines a document that changes to a foreign grammar while its session becomes ready", async () => {
    const session = addSession("html", [symbol("fragment")], {
      adapter: {
        grammarScopes: ["text.html.basic", "source.gfm"],
        documentSymbolScopes: ["text.html.basic"],
      },
      capabilities: { documentSymbolProvider: true },
    });
    let ready;
    spyOn(manager, "activeSessionsForEditor").and.callFake(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    let scopeName = "text.html.basic";
    const editor = {
      getGrammar: () => ({ scopeName }),
      getPath: () => path.join(root, "source.html"),
    };
    const pending = provider.getDocumentSymbols(editor, { sourceId: "ide-client:html" });
    scopeName = "source.gfm";
    ready([session]);
    expect(await pending).toBeNull();
    expect(session.request).not.toHaveBeenCalled();
  });

  it("routes a concrete source only through a session holding the embedded cell", async () => {
    const session = addSession("cell", [symbol("cell-symbol")], {
      adapter: {
        grammarScopes: ["source.js", "source.gfm"],
        documentSymbolScopes: ["source.js"],
      },
      capabilities: { documentSymbolProvider: true },
    });
    const editor = { getGrammar: () => ({ scopeName: "source.js" }), getPath: () => undefined };
    const uri = C.cellUri(path.join(root, "book.ipynb"), "a");
    const record = {
      filePath: path.join(root, "book.ipynb"),
      cellIndexOf: () => 0,
      routedEditors: new Map([["a", new Set([editor])]]),
    };
    manager.registerExternalDocument(editor, { editor, uri, cellId: "a", record });
    expect(provider.getDocumentSymbolSources(editor)[0].state).toBe("unavailable");
    session.documents.set(C.uriKey(uri), { editor, uri, subscriptions: { dispose() {} } });
    expect(provider.getDocumentSymbolSources(editor)[0].state).toBe("ready");
    await provider.getDocumentSymbols(editor, { sourceId: "ide-client:cell" });
    expect(session.request.calls.first().args[1].textDocument.uri).toBe(uri);
    const changed = jasmine.createSpy("changed");
    provider.onDidInvalidateDocumentSymbols(changed);
    manager.emitter.emit("did-change-notebook", { record });
    await Promise.resolve();
    expect(changed).toHaveBeenCalledWith({ editor });
    const host = { ...editor, getGrammar: () => ({ scopeName: "source.gfm" }) };
    expect(provider.getDocumentSymbolSources(host)).toEqual([]);
    expect(await provider.getDocumentSymbols(host, { sourceId: "ide-client:cell" })).toBeNull();
    expect(session.request.calls.count()).toBe(1);
  });

  it("invalidates document source state during normal server startup", async () => {
    const session = addSession("starting", [], { state: "starting" });
    const editor = {};
    spyOn(manager, "editorsForSession").and.returnValue([editor]);
    const changed = jasmine.createSpy("changed");
    provider.onDidInvalidateDocumentSymbols(changed);
    manager.didChangeSession(session);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledWith({ editor });
  });
});
