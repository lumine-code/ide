const path = require("path");
const ContextHelpProvider = require("../lib/context-help-provider");
const SignatureProvider = require("../lib/signature-provider");

const stubEditor = {
  getPath: () => path.join(__dirname, "example.js"),
  getGrammar: () => ({ scopeName: "source.js", name: "JavaScript" }),
};

const C = require("../lib/converters");

const managerWith = (...args) => {
  const sessions = args.filter(Boolean);
  return {
    addCapabilityFragment() {},
    onDidChangeSession: () => ({ dispose() {} }),
    onDidChangeFeatures: () => ({ dispose() {} }),
    onDidChangeCapabilities: () => ({ dispose() {} }),
    allGrammarScopes: () => ["source.js"],
    activeSessionsForEditor: async () => sessions,
    activeSessionForEditor: async () => sessions[0] || null,
    activeSessionForFeature: async (editor, method, feature) =>
      sessions.find((session) => session.supports(method, editor, feature)) || null,
    sessions: new Map(sessions.map((session, index) => [`key-${index}`, session])),
    allSessions() {
      return [...new Set(this.sessions.values())];
    },
    uriForEditor: (editor) => {
      const editorPath = editor.getPath?.();
      return editorPath ? C.pathToUri(editorPath) : null;
    },
    resolveUri: (uri) => {
      const resolvedPath = C.uriToPath(uri);
      return resolvedPath ? { kind: "file", path: resolvedPath } : null;
    },
  };
};

const sessionWith = (result, capabilities = {}) => ({
  state: "running",
  capabilities,
  supports: () => true,
  capabilityOptions: (method) =>
    ({
      "textDocument/completion": capabilities.completionProvider,
      "textDocument/signatureHelp": capabilities.signatureHelpProvider,
      "textDocument/semanticTokens": capabilities.semanticTokensProvider,
      "textDocument/onTypeFormatting": capabilities.documentOnTypeFormattingProvider,
      "textDocument/codeAction": capabilities.codeActionProvider,
      "textDocument/rename": capabilities.renameProvider,
    })[method],
  request: async () => result,
});

describe("ContextHelpProvider", () => {
  const hoverFor = (result) =>
    new ContextHelpProvider(managerWith(sessionWith(result))).getHelp(stubEditor, {
      row: 0,
      column: 1,
    });

  it("passes MarkupContent through", async () => {
    const result = await hoverFor({ contents: { kind: "plaintext", value: "docs" } });
    expect(result.contents).toEqual({ kind: "plaintext", value: "docs" });
  });
  it("normalizes MarkedString values to markdown", async () => {
    const result = await hoverFor({ contents: { language: "js", value: "const x = 1;" } });
    const { renderCodeBlock, ...markup } = result.contents;
    expect(markup).toEqual({
      kind: "markdown",
      value: "```js\nconst x = 1;\n```",
    });
    expect(typeof renderCodeBlock).toBe("function");
  });
  it("joins MarkedString arrays", async () => {
    const result = await hoverFor({ contents: ["first", { language: "js", value: "second" }] });
    expect(result.contents.value).toBe("first\n\n```js\nsecond\n```");
  });
  it("converts the optional range", async () => {
    const result = await hoverFor({
      contents: "docs",
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
    });
    expect(result.range).toEqual([
      [1, 2],
      [1, 5],
    ]);
  });
  it("returns null for empty responses and missing sessions", async () => {
    expect(await hoverFor(null)).toBeNull();
    expect(await hoverFor({ contents: "" })).toBeNull();
    const provider = new ContextHelpProvider(managerWith(null));
    expect(await provider.getHelp(stubEditor, { row: 0, column: 0 })).toBeNull();
  });
  it("stacks the answers of every server serving the editor", async () => {
    const provider = new ContextHelpProvider(
      managerWith(
        sessionWith({ contents: { kind: "markdown", value: "the type" } }),
        sessionWith({ contents: { kind: "markdown", value: "the lint rule" } }),
      ),
    );
    const result = await provider.getHelp(stubEditor, { row: 0, column: 1 });
    expect(result.contents.value).toBe("the type\n\n---\n\nthe lint rule");
  });
  it("collapses identical answers from several servers", async () => {
    const provider = new ContextHelpProvider(
      managerWith(sessionWith({ contents: "same" }), sessionWith({ contents: "same" })),
    );
    const result = await provider.getHelp(stubEditor, { row: 0, column: 1 });
    expect(result.contents.value).toBe("same");
  });

  it("keeps simultaneous requests independent and forwards each caller's cancellation signal", async () => {
    const requests = [];
    const session = sessionWith(null);
    session.request = (method, params, options) =>
      new Promise((resolve) => requests.push({ method, params, options, resolve }));
    const provider = new ContextHelpProvider(managerWith(session));
    const tooltip = new AbortController();
    const panel = new AbortController();

    const first = provider.getHelp(stubEditor, { row: 0, column: 1 }, { signal: tooltip.signal });
    const second = provider.getHelp(stubEditor, { row: 0, column: 2 }, { signal: panel.signal });
    await Promise.resolve();

    expect(requests.length).toBe(2);
    expect(requests[0].options.signal).toBe(tooltip.signal);
    expect(requests[1].options.signal).toBe(panel.signal);
    expect(tooltip.signal.aborted).toBe(false);
    expect(panel.signal.aborted).toBe(false);
    tooltip.abort();
    requests[1].resolve({ contents: { kind: "plaintext", value: "panel documentation" } });
    requests[0].resolve({ contents: { kind: "plaintext", value: "stale tooltip" } });

    expect(await first).toBeNull();
    expect((await second).contents.value).toBe("panel documentation");
    expect(panel.signal.aborted).toBe(false);
  });

  it("does not start requests when the caller already cancelled", async () => {
    const session = sessionWith({ contents: "docs" });
    const request = spyOn(session, "request").and.callThrough();
    const manager = managerWith(session);
    const lookup = spyOn(manager, "activeSessionsForEditor").and.callThrough();
    const provider = new ContextHelpProvider(manager);
    const controller = new AbortController();
    controller.abort();

    expect(
      await provider.getHelp(stubEditor, { row: 0, column: 1 }, { signal: controller.signal }),
    ).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not send a request cancelled while sessions were starting", async () => {
    const session = sessionWith({ contents: "docs" });
    const request = spyOn(session, "request").and.callThrough();
    let resolveSessions;
    const manager = managerWith(session);
    manager.activeSessionsForEditor = () => new Promise((resolve) => (resolveSessions = resolve));
    const provider = new ContextHelpProvider(manager);
    const controller = new AbortController();
    const pending = provider.getHelp(
      stubEditor,
      { row: 0, column: 1 },
      {
        signal: controller.signal,
      },
    );

    controller.abort();
    resolveSessions([session]);
    expect(await pending).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("drops a reply after the source editor was destroyed", async () => {
    let resolveRequest;
    const session = sessionWith(null);
    session.request = () => new Promise((resolve) => (resolveRequest = resolve));
    const provider = new ContextHelpProvider(managerWith(session));
    let destroyed = false;
    const editor = { ...stubEditor, isDestroyed: () => destroyed };
    const pending = provider.getHelp(editor, { row: 0, column: 1 });
    await Promise.resolve();

    destroyed = true;
    resolveRequest({ contents: "stale documentation" });
    expect(await pending).toBeNull();
  });
});

describe("SignatureProvider", () => {
  it("collects trigger characters from running sessions", () => {
    const session = sessionWith(null, {
      signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [")"] },
    });
    const provider = new SignatureProvider(managerWith(session));
    expect([...provider.triggerCharacters]).toEqual(["(", ","]);
    expect([...provider.retriggerCharacters]).toEqual([")"]);
  });
  it("returns the raw SignatureHelp result with a default context", async () => {
    const help = { signatures: [{ label: "fn(a)" }], activeSignature: 0, activeParameter: 0 };
    const session = sessionWith(help);
    const requests = [];
    session.request = async (method, params) => {
      requests.push({ method, params });
      return help;
    };
    const provider = new SignatureProvider(managerWith(session));
    const result = await provider.getSignature(stubEditor, { row: 0, column: 4 });
    expect(result).toBe(help);
    expect(requests[0].method).toBe("textDocument/signatureHelp");
    expect(requests[0].params.context).toEqual({ triggerKind: 1, isRetrigger: false });
  });
});
