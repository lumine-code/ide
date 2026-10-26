const LanguageServerManager = require("../lib/language-server-manager");
const SessionDocuments = require("../lib/session-documents");

describe("language server attachment across None", () => {
  let editor, manager, documents, session, adapter, grammar;
  const uri = "file:///none-attachment/source.test";
  const settle = async () => {
    for (let index = 0; index < 40; index++) await Promise.resolve();
  };

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("language-text");
    await pack.resourceLoadPromise;
    editor = lumine.workspace.buildTextEditor();
    editor.setText("example");
    grammar = editor.getGrammar();
    spyOn(editor, "whenGrammarSettled").and.resolveTo(true);
    adapter = { id: "test", grammarScopes: [grammar.scopeName] };
    manager = new LanguageServerManager();
    manager.adapters.set(adapter.id, adapter);
    manager._workspaceDocuments = { uriForEditor: () => uri, bindingFor: () => null };
    session = {
      adapter,
      state: "running",
      ready: Promise.resolve(),
      capabilities: { textDocumentSync: 2 },
      diagnosticTimers: new Map(),
      connection: { notify: jasmine.createSpy("notify").and.resolveTo() },
      manager,
      supports: () => false,
      scheduleDiagnostics() {},
      scheduleWorkspaceDiagnostics() {},
      clearDiagnosticReportsForUri() {},
      notify(method, params) {
        return this.connection.notify(method, params);
      },
    };
    documents = new SessionDocuments(session);
    session.documents = documents.items;
    session.openEditor = (item) => documents.openEditor(item);
    session.detachEditor = (item) => documents.detachEditor(item);
    spyOn(manager, "rootForEditor").and.returnValue("/project");
    spyOn(manager, "ensureSession").and.resolveTo(session);
    spyOn(manager, "sessionForRoute").and.returnValue(session);
    spyOn(manager, "allSessions").and.returnValue([session]);
    spyOn(manager, "withdrawSelectionDiagnostics");
    spyOn(manager, "didCloseDocument");
    spyOn(manager, "forget");
    spyOn(manager, "stopSession").and.resolveTo();
    spyOn(manager, "reportStartFailure");
    spyOn(manager, "attachEditor").and.callFake((item) =>
      item.getGrammar() === lumine.grammars.nullGrammar
        ? Promise.resolve()
        : manager.attachAdapter(adapter, item),
    );
    manager.watchEditor(editor);
  });

  afterEach(() => {
    for (const subscription of manager.editorSubscriptions.values()) subscription.dispose();
    documents.dispose();
    manager.subscriptions.dispose();
    editor.destroy();
  });

  it("does not stop a resumed session when its old projection is cancelled", async () => {
    let finishPrevious;
    adapter.getDocumentProjection = jasmine
      .createSpy("projection")
      .and.returnValues(new Promise((resolve) => (finishPrevious = resolve)), {
        text: "fresh",
        isCurrent: () => true,
      });
    const previous = manager.attachAdapter(adapter, editor);
    await settle();
    expect(adapter.getDocumentProjection.calls.count()).toBe(1);
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setGrammar(grammar);
    await settle();
    await previous;
    finishPrevious({ text: "obsolete", isCurrent: () => true });
    await settle();
    expect(manager.forget).not.toHaveBeenCalled();
    expect(manager.stopSession).not.toHaveBeenCalled();
    expect(manager.reportStartFailure).not.toHaveBeenCalled();
    expect([...documents.items.values()][0].projection.text).toBe("fresh");
    expect(
      session.connection.notify.calls
        .allArgs()
        .filter(([method]) => method === "textDocument/didOpen").length,
    ).toBe(1);
  });

  it("does not discover roots or start a server for an initial None attachment", async () => {
    editor.setGrammar(lumine.grammars.nullGrammar);
    manager.rootForEditor.calls.reset();
    manager.ensureSession.calls.reset();
    await manager.attachAdapter(adapter, editor);
    expect(manager.rootForEditor).not.toHaveBeenCalled();
    expect(manager.ensureSession).not.toHaveBeenCalled();
    expect(session.connection.notify).not.toHaveBeenCalled();
  });

  it("retires a readiness request on None even if the same grammar returns before startup", async () => {
    let finishStartup;
    session.ready = new Promise((resolve) => (finishStartup = resolve));
    spyOn(manager, "sessionsForEditor").and.callFake((item) =>
      item.getGrammar() === lumine.grammars.nullGrammar ? [] : [session],
    );
    let previousSettled = false;
    const previous = manager.activeSessionsForEditor(editor).then((sessions) => {
      previousSettled = true;
      return sessions;
    });
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setGrammar(grammar);
    const resumed = manager.activeSessionsForEditor(editor);
    await settle();
    expect(previousSettled).toBeTrue();
    finishStartup();
    expect(await previous).toEqual([]);
    expect(await resumed).toEqual([session]);
    expect(
      session.connection.notify.calls
        .allArgs()
        .filter(([method]) => method === "textDocument/didOpen").length,
    ).toBe(1);
  });
});
