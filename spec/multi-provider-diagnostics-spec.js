const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Range } = require("lumine");
const { Point } = require("lumine");
const HoverProvider = require("../lib/hover-provider");
const CompletionProvider = require("../lib/completion-provider");
const Manager = require("../lib/language-server-manager");
const Session = require("../lib/server-session");
const C = require("../lib/converters");

const diagnostic = (code) => ({
  code,
  message: code,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
});
const full = (resultId, items) => ({ kind: "full", resultId, items });
const unchanged = (resultId) => ({ kind: "unchanged", resultId });
const until = async (check) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Diagnostic test condition timed out");
};

describe("independent diagnostic providers", () => {
  let manager, session, directory, editor, uri, timeout, published, edge, requestId;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(() => {
    jasmine.useRealClock();
    manager = new Manager();
    directory = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "ide-client-multiple-"),
    );
    const file = path.join(directory, "document.sample");
    fs.writeFileSync(file, "bad();\n");
    uri = C.pathToUri(file);
    requestId = 3000;
    published = [];
    edge = manager.onDidPublishDiagnostics((value) => published.push(value));
  });
  afterEach(async () => {
    await session?.stop();
    edge.dispose();
    editor?.destroy();
    await manager.deactivate();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(path.resolve(directory)) !== fs.realpathSync.native(os.tmpdir()) ||
      !path.basename(directory).startsWith("ide-client-multiple-")
    )
      throw new Error("Unsafe diagnostic fixture cleanup");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    session = null;
    editor = null;
  });
  const start = async (config, extra = {}) => {
    const launch = {
      command: process.execPath,
      args: [
        path.join(__dirname, "fixtures", "fake-server.js"),
        JSON.stringify({ capabilities: { textDocumentSync: 2 }, ...config }),
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      transport: "stdio",
    };
    session = new Session(
      manager,
      {
        id: "multi-provider-test",
        displayName: "Diagnostic test",
        grammarScopes: ["text.plain"],
        languageId: "example",
        resolveServer: () => launch,
        ...extra,
      },
      directory,
      launch,
    );
    await session.start();
    return session;
  };
  const open = async () => {
    editor = await lumine.workspace.open(C.uriToPath(uri));
    await session.openEditor(editor);
    return session.documents.get(C.uriKey(uri));
  };
  const notify = (method, params) =>
    session.request("test/notify", { jsonrpc: "2.0", id: ++requestId, method, params });
  const registration = (id, identifier, options = {}) => ({
    id,
    method: "textDocument/diagnostic",
    registerOptions: { identifier, documentSelector: [{ language: "example" }], ...options },
  });
  const register = (...registrations) => notify("client/registerCapability", { registrations });
  const requests = async (method) =>
    (await session.request("test/getReceived")).filter((message) => message.method === method);
  const codes = () =>
    manager
      .diagnosticsFor(session, uri)
      .map(({ code }) => code)
      .sort();

  it("keeps static C# completion and hover when Razor registers the same methods for its own selectors", async () => {
    await start(
      {
        capabilities: { textDocumentSync: 2, hoverProvider: true, completionProvider: {} },
        responses: {
          "textDocument/hover": { contents: "C# documentation" },
          "textDocument/completion": [{ label: "Bad", insertText: "Bad" }],
        },
      },
      { languageId: "csharp" },
    );
    await open();
    await notify("client/registerCapability", {
      registrations: ["textDocument/hover", "textDocument/completion"].map((method) => ({
        id: `razor:${method}`,
        method,
        registerOptions: {
          documentSelector: [{ language: "aspnetcorerazor", pattern: "**/*.{razor,cshtml}" }],
        },
      })),
    });
    expect(manager.dynamicSupport(session, "textDocument/hover", editor)).toBe(false);
    expect(session.supports("textDocument/hover", editor)).toBe(true);
    expect(session.supports("textDocument/completion", editor)).toBe(true);
    spyOn(manager, "activeSessionsForEditor").and.resolveTo([session]);
    const hover = await new HoverProvider(manager).hover(editor, new Point(0, 1));
    expect(hover.contents.value).toBe("C# documentation");
    const suggestions = await new CompletionProvider(manager).getSuggestions({
      editor,
      bufferPosition: new Point(0, 1),
      prefix: "b",
      activatedManually: true,
    });
    expect(suggestions.some((item) => item.text === "Bad")).toBe(true);
    session.capabilities.hoverProvider = false;
    expect(session.supports("textDocument/hover", editor)).toBe(false);
  });

  it("retains independent matching static and dynamic sources and queries a true duplicate only once", async () => {
    await start({
      capabilities: { textDocumentSync: 2, diagnosticProvider: { identifier: "static-provider" } },
      responsesByIdentifier: {
        "textDocument/diagnostic": {
          "static-provider": full("s1", [diagnostic("static-error")]),
          "dynamic-provider": full("d1", [diagnostic("dynamic-style")]),
        },
      },
    });
    await open();
    await until(() => codes().includes("static-error"));
    await register(registration("dynamic-registration", "dynamic-provider"));
    await until(() => codes().length === 2);
    expect(codes()).toEqual(["dynamic-style", "static-error"]);
    const before = (await requests("textDocument/diagnostic")).length;
    await register({
      id: "duplicate-static",
      method: "textDocument/diagnostic",
      registerOptions: { identifier: "static-provider" },
    });
    await until(async () => (await requests("textDocument/diagnostic")).length >= before + 2);
    const next = (await requests("textDocument/diagnostic")).slice(before);
    expect(next.map(({ params }) => params.identifier).sort()).toEqual([
      "dynamic-provider",
      "static-provider",
    ]);
    expect(codes()).toEqual(["dynamic-style", "static-error"]);
  });

  it("merges one complete document batch and retains each source's unchanged results and IDs", async () => {
    await start({
      responseSequencesByIdentifier: {
        "textDocument/diagnostic": {
          compiler: [full("c1", [diagnostic("error")]), unchanged("c2"), full("c3", [])],
          analyzer: [full("a1", [diagnostic("style")]), unchanged("a2"), unchanged("a3")],
        },
      },
    });
    const document = await open();
    await register(
      registration("compiler-registration", "compiler"),
      registration("analyzer-registration", "analyzer"),
    );
    await until(() => codes().length === 2);
    expect(published.filter((event) => C.uriKey(event.uri) === C.uriKey(uri)).length).toBe(1);
    expect(codes()).toEqual(["error", "style"]);
    await session.pullDiagnostics(document);
    expect(codes()).toEqual(["error", "style"]);
    let received = await requests("textDocument/diagnostic");
    expect(
      received.filter(({ params }) => params.identifier === "compiler").at(-1).params
        .previousResultId,
    ).toBe("c1");
    expect(
      received.filter(({ params }) => params.identifier === "analyzer").at(-1).params
        .previousResultId,
    ).toBe("a1");
    editor.setText("fixed();\n");
    await until(() => codes().length === 1);
    expect(codes()).toEqual(["style"]);
    received = await requests("textDocument/diagnostic");
    expect(
      received.filter(({ params }) => params.identifier === "compiler").at(-1).params
        .previousResultId,
    ).toBe("c2");
    expect(
      received.filter(({ params }) => params.identifier === "analyzer").at(-1).params
        .previousResultId,
    ).toBe("a2");
  });

  it("does not mutate cached wire diagnostics when an adapter changes an unchanged source", async () => {
    const item = {
      ...diagnostic("error"),
      relatedInformation: [
        { message: "related", location: { uri, range: diagnostic("related").range } },
      ],
    };
    await start(
      {
        responseSequencesByIdentifier: {
          "textDocument/diagnostic": {
            compiler: [full("c1", [item]), unchanged("c2")],
            analyzer: [full("a1", [diagnostic("style")]), full("a2", [])],
          },
        },
      },
      {
        transformDiagnostics(items) {
          for (const value of items) {
            value.message = `mapped:${value.message}`;
            if (value.relatedInformation)
              value.relatedInformation[0].location.range.start.character += 10;
          }
          return items;
        },
      },
    );
    const document = await open();
    await register(
      registration("compiler-registration", "compiler"),
      registration("analyzer-registration", "analyzer"),
    );
    await until(() => codes().length === 2);
    await session.pullDiagnostics(document);
    const final = manager.diagnosticsFor(session, uri);
    expect(final.length).toBe(1);
    expect(final[0].message).toBe("mapped:error");
    expect(final[0].relatedInformation[0].location.range.start.character).toBe(10);
  });

  it("resets result IDs when the server re-registers the same source and options", async () => {
    await start({
      responsesByIdentifier: {
        "textDocument/diagnostic": {
          compiler: full("c1", [diagnostic("error")]),
          analyzer: full("a1", [diagnostic("style")]),
        },
      },
    });
    await open();
    await register(
      registration("compiler-registration", "compiler"),
      registration("analyzer-registration", "analyzer"),
    );
    await until(() => codes().length === 2);
    const before = (await requests("textDocument/diagnostic")).length;
    await register(registration("compiler-registration", "compiler"));
    await until(async () => (await requests("textDocument/diagnostic")).length > before);
    const after = (await requests("textDocument/diagnostic")).slice(before);
    expect(
      after.find(({ params }) => params.identifier === "compiler").params.previousResultId,
    ).toBeUndefined();
    expect(
      after.find(({ params }) => params.identifier === "analyzer").params.previousResultId,
    ).toBe("a1");
  });

  it("withdraws only one category and keeps pushes and unaffected provider IDs", async () => {
    await start({
      responsesByIdentifier: {
        "textDocument/diagnostic": {
          compiler: full("c1", [diagnostic("error")]),
          analyzer: full("a1", [diagnostic("style")]),
          replacement: full("r1", []),
        },
      },
    });
    await open();
    await register(
      registration("compiler-registration", "compiler"),
      registration("analyzer-registration", "analyzer"),
    );
    await until(() => codes().length === 2);
    manager.publishDiagnostics(session, { uri, diagnostics: [diagnostic("push")] });
    expect(codes()).toEqual(["error", "push", "style"]);
    await notify("client/unregisterCapability", {
      unregisterations: [{ id: "compiler-registration", method: "textDocument/diagnostic" }],
    });
    expect(codes()).toEqual(["push", "style"]);
    await register(registration("compiler-registration", "replacement"));
    await until(async () =>
      (await requests("textDocument/diagnostic")).some(
        ({ params }) => params.identifier === "replacement",
      ),
    );
    const received = await requests("textDocument/diagnostic");
    expect(
      received.find(({ params }) => params.identifier === "replacement").params.previousResultId,
    ).toBeUndefined();
    expect(
      received.filter(({ params }) => params.identifier === "analyzer").at(-1).params
        .previousResultId,
    ).toBe("a1");
    expect(codes()).toEqual(["push", "style"]);
  });

  it("keeps document/workspace streams separate and merges independent partial workspace reports", async () => {
    const workspaceItem = (id, items) => ({ uri, version: null, ...full(id, items) });
    await start({
      responseSequencesByIdentifier: {
        "workspace/diagnostic": {
          compiler: [
            { items: [workspaceItem("wc1", [diagnostic("workspace-error")])] },
            { items: [{ uri, version: null, ...unchanged("wc2") }] },
          ],
          analyzer: [{ items: [] }, { items: [workspaceItem("wa2", [])] }],
        },
      },
      workspaceDiagnosticPartialsByIdentifier: {
        analyzer: [
          { items: [workspaceItem("wa1", [diagnostic("workspace-style")])] },
          { items: [] },
        ],
      },
      responsesByIdentifier: {
        "textDocument/diagnostic": {
          compiler: full("dc1", [diagnostic("document-error")]),
          analyzer: full("da1", []),
        },
      },
    });
    await register(
      registration("compiler-registration", "compiler", { workspaceDiagnostics: true }),
      registration("analyzer-registration", "analyzer", {
        workspaceDiagnostics: true,
        workDoneProgress: true,
      }),
    );
    await until(() => codes().length === 2);
    expect(session.supports("workspace/diagnostic")).toBe(true);
    const document = await open();
    await until(() => codes().includes("document-error"));
    expect(codes()).toEqual(["document-error"]);
    await session.pullWorkspaceDiagnostics();
    expect(codes()).toEqual(["document-error"]);
    const workspace = await requests("workspace/diagnostic");
    expect(
      workspace.filter(({ params }) => params.identifier === "compiler").at(-1).params
        .previousResultIds,
    ).toEqual([{ uri, value: "wc1" }]);
    expect(
      workspace.filter(({ params }) => params.identifier === "analyzer").at(-1).params
        .previousResultIds,
    ).toEqual([{ uri, value: "wa1" }]);
    expect(
      workspace.filter(({ params }) => params.identifier === "analyzer")[0].params.workDoneToken,
    ).toBeDefined();
    await session.pullDiagnostics(document);
    const pulls = await requests("textDocument/diagnostic");
    expect(
      pulls.filter(({ params }) => params.identifier === "compiler").at(-1).params.previousResultId,
    ).toBe("dc1");
    expect(
      pulls.filter(({ params }) => params.identifier === "analyzer").at(-1).params.previousResultId,
    ).toBe("da1");
  });

  it("retains a provider's previous report after its request fails while another category clears", async () => {
    await start({
      responseSequencesByIdentifier: {
        "textDocument/diagnostic": {
          compiler: [full("c1", [diagnostic("error")]), full("c2", [])],
          analyzer: [full("a1", [diagnostic("style")]), full("a2", [])],
        },
      },
      errorSequencesByIdentifier: {
        "textDocument/diagnostic": {
          compiler: [null, { code: -32603, message: "temporary failure" }],
        },
      },
    });
    const document = await open();
    await register(
      registration("compiler-registration", "compiler"),
      registration("analyzer-registration", "analyzer"),
    );
    await until(() => codes().length === 2);
    await session.pullDiagnostics(document);
    expect(codes()).toEqual(["error"]);
    expect(document.diagnosticResultIds.get("dynamic:compiler-registration")).toBe("c1");
  });

  it("rejects stale in-flight document batches without erasing the surviving category", async () => {
    await start({
      responseSequencesByIdentifier: {
        "textDocument/diagnostic": {
          compiler: [full("old", [diagnostic("stale-error")]), full("new", [])],
          analyzer: [full("a1", [diagnostic("style")]), full("a2", [diagnostic("style")])],
        },
      },
      responseDelaysByIdentifier: { "textDocument/diagnostic": { compiler: 400 } },
    });
    await open();
    await register(
      registration("compiler-registration", "compiler"),
      registration("analyzer-registration", "analyzer"),
    );
    await until(async () => (await requests("textDocument/diagnostic")).length >= 2);
    editor.setText("new();\n");
    await until(() => codes().length === 1);
    expect(codes()).toEqual(["style"]);
    expect(
      published.some(({ diagnostics }) => diagnostics.some(({ code }) => code === "stale-error")),
    ).toBe(false);
  });

  it("publishes surviving categories through the projection and adapter funnel after one provider fails", async () => {
    const contexts = [];
    await start(
      {
        responsesByIdentifier: {
          "textDocument/diagnostic": { analyzer: full("a1", [diagnostic("style")]) },
        },
        errorsByIdentifier: {
          "textDocument/diagnostic": {
            compiler: { code: -32603, message: "temporary compiler failure" },
          },
        },
      },
      {
        getDocumentProjection(item) {
          const source = item.getText();
          return {
            source,
            text: source.slice(2),
            isCurrent: () => source === item.getText(),
            fromServerRange: (range) =>
              new Range(
                [range.start.row, range.start.column + 2],
                [range.end.row, range.end.column + 2],
              ),
            isPythonRange: () => true,
          };
        },
        transformDiagnostics(items, context) {
          contexts.push(context);
          return items;
        },
      },
    );
    fs.writeFileSync(C.uriToPath(uri), "# bad();\n");
    await open();
    await register(
      registration("compiler-registration", "compiler"),
      registration("analyzer-registration", "analyzer"),
    );
    await until(() => codes().length === 1);
    expect(codes()).toEqual(["style"]);
    expect(manager.diagnosticsFor(session, uri)[0].range.start.character).toBe(2);
    expect(contexts.at(-1).uri).toBe(uri);
    expect(contexts.at(-1).editor).toBe(editor);
  });

  const reorderedRelatedReport = async (targetFails) => {
    const targetUri = C.pathToUri(path.join(directory, "related.sample"));
    fs.writeFileSync(C.uriToPath(targetUri), "target();\n");
    await start(
      {
        capabilities: { textDocumentSync: 2, diagnosticProvider: { identifier: "compiler" } },
        responseSequencesByIdentifier: {
          "textDocument/diagnostic": {
            compiler: [
              {
                ...full("source", []),
                relatedDocuments: {
                  [targetUri]: full("related-old", [diagnostic("related-error")]),
                },
              },
              full("target-new", []),
            ],
          },
        },
        errorSequencesByIdentifier: targetFails
          ? {
              "textDocument/diagnostic": {
                compiler: [null, { code: -32603, message: "target unavailable" }],
              },
            }
          : undefined,
      },
      { features: { diagnostics: false } },
    );
    const source = await open();
    const targetEditor = await lumine.workspace.open(C.uriToPath(targetUri));
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let sourceReplied = false;
    const request = session.request.bind(session);
    spyOn(session, "request").and.callFake(async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === "textDocument/diagnostic" && params.textDocument.uri === uri) {
        sourceReplied = true;
        await held;
      }
      return result;
    });
    try {
      await session.openEditor(targetEditor);
      const target = session.documents.get(C.uriKey(targetUri));
      session.adapter.features.diagnostics = true;
      const oldSource = session.pullDiagnostics(source);
      await until(() => sourceReplied);
      await session.pullDiagnostics(target);
      expect(manager.diagnosticsFor(session, targetUri)).toEqual([]);
      release();
      await oldSource;
      const received = await requests("textDocument/diagnostic");
      expect(received.map(({ params }) => params.textDocument.uri)).toEqual([uri, targetUri]);
      expect(target.version).toBe(source.version);
      expect(manager.diagnosticsFor(session, targetUri).map(({ code }) => code)).toEqual(
        targetFails ? ["related-error"] : [],
      );
      if (!targetFails) expect(target.diagnosticResultIds.get("static")).toBe("target-new");
    } finally {
      release();
      targetEditor.destroy();
    }
  };
  it("does not restore an older related error after a newer direct report clears the same version", async () => {
    await reorderedRelatedReport(false);
  });
  it("keeps a valid related report when the target's newer direct pull failed", async () => {
    await reorderedRelatedReport(true);
  });
});
