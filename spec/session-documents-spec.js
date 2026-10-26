const SessionDocuments = require("../lib/session-documents");
const C = require("../lib/converters");
const { Range } = require("lumine");
const ServerSession = require("../lib/server-session");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

describe("session document ownership", () => {
  let documents, session, editor, editors;
  const uri = "file:///session-documents/source.test";
  const changes = {
    changes: [
      {
        oldRange: Range.fromObject([
          [0, 0],
          [0, 1],
        ]),
        oldText: "a",
        newText: "b",
      },
    ],
  };

  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    editors = [];
    session = {
      state: "running",
      adapter: {},
      capabilities: { textDocumentSync: 2 },
      diagnosticTimers: new Map(),
      connection: { notify: jasmine.createSpy("write document notification").and.resolveTo() },
      manager: {
        uriForEditor: () => uri,
        workspaceDocuments: { bindingFor: () => null },
        didCloseDocument: jasmine.createSpy("last document retired"),
        publishDiagnostics: jasmine.createSpy("publish diagnostics"),
        log: jasmine.createSpy("log"),
      },
      supports: () => false,
      scheduleDiagnostics: jasmine.createSpy("schedule diagnostics"),
      scheduleWorkspaceDiagnostics: jasmine.createSpy("schedule workspace diagnostics"),
      clearDiagnosticReportsForUri: jasmine.createSpy("clear diagnostic reports"),
      notify(method, params) {
        return this.connection.notify(method, params);
      },
    };
    documents = new SessionDocuments(session);
    editor = buildEditor();
  });

  afterEach(() => {
    documents.dispose();
    for (const item of editors) item.destroy();
  });

  function buildEditor() {
    const item = lumine.workspace.buildTextEditor();
    item.setText("alpha");
    editors.push(item);
    return item;
  }

  const messages = (method) =>
    session.connection.notify.calls.allArgs().filter(([name]) => name === method);

  it("does not transfer null-grammar text and closes a live document when None is selected", async () => {
    const grammar = editor.getGrammar();
    expect(grammar).not.toBe(lumine.grammars.nullGrammar);
    editor.setGrammar(lumine.grammars.nullGrammar);
    const read = spyOn(editor, "getText").and.callThrough();
    await documents.openEditor(editor);
    expect(read).not.toHaveBeenCalled();
    expect(session.connection.notify).not.toHaveBeenCalled();
    editor.setGrammar(grammar);
    await documents.openEditor(editor);
    expect(messages("textDocument/didOpen").length).toBe(1);
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(documents.items.size).toBe(0);
    expect(messages("textDocument/didClose").length).toBe(1);
    session.connection.notify.calls.reset();
    editor.insertText("changed");
    await Promise.resolve();
    expect(session.connection.notify).not.toHaveBeenCalled();
    editor.setGrammar(grammar);
    await documents.openEditor(editor);
    expect(messages("textDocument/didOpen").length).toBe(1);
  });

  it("does not retain an editor destroyed before document attachment", async () => {
    editor.destroy();
    await documents.openEditor(editor);
    expect(documents.items.size).toBe(0);
    expect(session.connection.notify).not.toHaveBeenCalled();

    const replacement = buildEditor();
    await documents.openEditor(replacement);
    expect(documents.items.get(C.uriKey(uri)).editor).toBe(replacement);
    expect(messages("textDocument/didOpen").length).toBe(1);
  });

  it("does not read a suspended split view while retiring a shared buffer", async () => {
    const split = lumine.workspace.buildTextEditor({ buffer: editor.getBuffer() });
    editors.push(split);
    const grammar = editor.getGrammar();
    await documents.openEditor(editor);
    await documents.openEditor(split);
    await documents.openEditor(editor);
    const firstRead = spyOn(editor, "getText").and.callThrough();
    const splitRead = spyOn(split, "getText").and.callThrough();
    session.connection.notify.calls.reset();
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(split.getGrammar()).toBe(lumine.grammars.nullGrammar);
    expect(firstRead).not.toHaveBeenCalled();
    expect(splitRead).not.toHaveBeenCalled();
    expect(documents.items.size).toBe(0);
    expect(messages("textDocument/didClose").length).toBe(1);
    editor.setGrammar(grammar);
    await documents.openEditor(editor);
    await documents.openEditor(split);
    expect(messages("textDocument/didOpen").length).toBe(1);
    session.connection.notify.calls.reset();
    editor.insertText("changed");
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(messages("textDocument/didChange").length).toBe(1);
  });

  it("refuses an unattached None edit projection before asking an adapter about its source", async () => {
    session.adapter.needsDocumentTransform = jasmine
      .createSpy("needs transform")
      .and.callFake(() => {
        editor.getText();
        return true;
      });
    session.adapter.getDocumentProjection = jasmine.createSpy("projection");
    editor.setGrammar(lumine.grammars.nullGrammar);
    const read = spyOn(editor, "getText").and.callThrough();
    await expectAsync(documents.projectionForEdits(editor, uri)).toBeRejected();
    expect(session.adapter.needsDocumentTransform).not.toHaveBeenCalled();
    expect(session.adapter.getDocumentProjection).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels an unattached edit projection across None and resumes independently", async () => {
    const grammar = editor.getGrammar();
    const previousProjection = deferred();
    spyOn(editor, "whenGrammarSettled").and.resolveTo(true);
    const fresh = { text: "fresh", isCurrent: () => true };
    session.adapter.getDocumentProjection = jasmine
      .createSpy("projection")
      .and.returnValues(previousProjection.promise, fresh);
    const previous = documents.projectionForEdits(editor, uri).catch((error) => error);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(session.adapter.getDocumentProjection.calls.count()).toBe(1);
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setGrammar(grammar);
    expect(await documents.projectionForEdits(editor, uri)).toBe(fresh);
    previousProjection.resolve({ text: "obsolete", isCurrent: () => true });
    expect((await previous).code).toBe("PROJECTION_STALE");
    expect(session.adapter.getDocumentProjection.calls.count()).toBe(2);
    expect(session.connection.notify).not.toHaveBeenCalled();
  });

  it("discards an old projection after None and an immediate grammar restore", async () => {
    const grammar = editor.getGrammar();
    const previousProjection = deferred();
    spyOn(editor, "whenGrammarSettled").and.resolveTo(true);
    session.adapter.getDocumentProjection = jasmine
      .createSpy("projection")
      .and.returnValues(previousProjection.promise, {
        text: "fresh projection",
        isCurrent: () => true,
      });
    const previous = documents.openEditor(editor).then(
      () => ({}),
      (error) => ({ error }),
    );
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(session.adapter.getDocumentProjection.calls.count()).toBe(1);
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setGrammar(grammar);
    await documents.openEditor(editor);
    expect((await previous).error?.name).toBe("AbortError");
    const current = documents.items.get(C.uriKey(uri));
    expect(current.projection.text).toBe("fresh projection");
    previousProjection.resolve({ text: "old projection", isCurrent: () => true });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(documents.items.get(C.uriKey(uri))).toBe(current);
    expect(messages("textDocument/didOpen").length).toBe(1);
  });

  it("reopens a URI left behind by an obsolete editor", async () => {
    await documents.openEditor(editor);
    const obsolete = documents.items.get(C.uriKey(uri));
    // Model a delayed attachment from before the destroyed-editor guard: its
    // subscription was installed after the editor's destroy event had fired.
    obsolete.subscriptions.dispose();
    editor.destroy();
    const replacement = buildEditor();
    await documents.openEditor(replacement);

    expect(documents.items.get(C.uriKey(uri)).editor).toBe(replacement);
    expect(messages("textDocument/didOpen").length).toBe(2);
    expect(messages("textDocument/didClose").length).toBe(1);
  });

  it("rejects change, save and destroy callbacks from a retired URI generation", async () => {
    await documents.openEditor(editor);
    const previous = documents.items.get(C.uriKey(uri));
    documents.detachEditor(editor);
    const replacement = buildEditor();
    await documents.openEditor(replacement);
    const current = documents.items.get(C.uriKey(uri));
    session.connection.notify.calls.reset();

    documents.changeDocument(previous, changes);
    await documents.saveDocument(previous, { includeText: true });
    documents.closeDocument(uri, previous);

    expect(documents.items.get(C.uriKey(uri))).toBe(current);
    expect(current.version).toBe(1);
    expect(session.connection.notify).not.toHaveBeenCalled();
  });

  it("cancels an obsolete grammar wait before reopening the same URI", async () => {
    const grammar = deferred();
    const settled = spyOn(editor, "whenGrammarSettled").and.returnValue(grammar.promise);
    session.adapter.getDocumentProjection = jasmine
      .createSpy("projection")
      .and.callFake((item) => ({
        text: item.getText(),
        isCurrent: () => true,
      }));
    const opening = documents.openEditor(editor);
    const previous = documents.items.get(C.uriKey(uri));
    documents.detachEditor(editor);
    settled.and.resolveTo(true);
    await documents.openEditor(editor);
    grammar.resolve(true);
    await opening;

    expect(previous.syncAbortController.signal.aborted).toBe(true);
    expect(messages("textDocument/didOpen").length).toBe(1);
    expect(session.adapter.getDocumentProjection).toHaveBeenCalledTimes(1);
  });

  it("waits for didOpen before letting a second attachment complete", async () => {
    const write = deferred();
    session.connection.notify.and.returnValue(write.promise);
    const first = documents.openEditor(editor);
    let joined = false;
    const second = documents.openEditor(editor).then(() => (joined = true));
    await Promise.resolve();
    expect(joined).toBe(false);
    write.resolve();
    await Promise.all([first, second]);
    expect(messages("textDocument/didOpen").length).toBe(1);
  });

  it("captures editor-less notebook text and invalidates it when an editor arrives", () => {
    const record = {
      cells: [{ id: "cell", text: "stored = 1" }],
      cellVersion: () => 3,
      cellText: (cell) => cell.text,
    };
    documents.adoptNotebookCell({ record, cellId: "cell", editor: null, uri });
    const snapshot = documents.requestDocumentSnapshots().get(C.uriKey(uri));
    expect(snapshot.text).toBe("stored = 1");
    expect(snapshot.version).toBe(3);
    expect(snapshot.isCurrent()).toBe(true);

    documents.adoptNotebookCell({ record, cellId: "cell", editor, uri });
    expect(snapshot.isCurrent()).toBe(false);
    const attached = documents.requestDocumentSnapshots().get(C.uriKey(uri));
    expect(attached.text).toBe("alpha");
    expect(attached.isCurrent()).toBe(true);
    documents.releaseNotebookCell(uri);
    expect(attached.isCurrent()).toBe(false);
  });

  it("invalidates editor-less notebook snapshots after stored text or ownership changes", () => {
    const record = {
      cells: [{ id: "cell", text: "before" }],
      cellVersion: () => 1,
      cellText: (cell) => cell.text,
    };
    documents.adoptNotebookCell({ record, cellId: "cell", editor: null, uri });
    const snapshot = documents.requestDocumentSnapshots().get(C.uriKey(uri));
    record.cells[0].text = "after";
    expect(snapshot.isCurrent()).toBe(false);
    const changed = documents.requestDocumentSnapshots().get(C.uriKey(uri));
    const cell = record.cells[0];
    record.cells = [];
    expect(changed.isCurrent()).toBe(false);
    record.cells = [cell];
    expect(changed.isCurrent()).toBe(true);
    record.disposed = true;
    expect(changed.isCurrent()).toBe(false);
  });

  it("keeps notebook cells out of the plain document notification lifecycle", async () => {
    const record = { cellVersion: () => 1 };
    documents.adoptNotebookCell({ record, cellId: "cell", editor, uri });
    session.manager.workspaceDocuments.bindingFor = () => ({ record });
    await documents.openEditor(editor);
    documents.changeDocument(documents.items.get(C.uriKey(uri)), changes);
    documents.detachEditor(editor);
    expect(documents.items.size).toBe(1);
    documents.closeDocument(uri);

    expect(session.connection.notify).not.toHaveBeenCalled();
    expect(documents.items.size).toBe(0);
    expect(session.clearDiagnosticReportsForUri).toHaveBeenCalledWith(uri);
    expect(session.manager.publishDiagnostics).toHaveBeenCalledWith(
      session,
      { uri, diagnostics: [] },
      true,
    );
  });

  it("serializes temporary document callbacks and closes failures before the next open", async () => {
    const work = deferred();
    const started = deferred();
    const first = documents.withTemporaryDocument(
      { uri: `${uri}?temporary=1`, languageId: "test", text: "first" },
      async () => {
        started.resolve();
        await work.promise;
        throw new Error("request failed");
      },
    );
    const failed = expectAsync(first).toBeRejectedWithError("request failed");
    await started.promise;
    const second = documents.withTemporaryDocument(
      { uri: `${uri}?temporary=2`, languageId: "test", text: "second" },
      async () => "result",
    );
    expect(messages("textDocument/didOpen").length).toBe(1);
    work.resolve();
    await failed;
    expect(await second).toBe("result");
    expect(session.connection.notify.calls.allArgs().map(([method]) => method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didClose",
      "textDocument/didOpen",
      "textDocument/didClose",
    ]);
    expect(documents.isTemporaryDocumentUri(`${uri}?temporary=1`)).toBe(true);
    expect(documents.temporaryDocuments.size).toBe(0);
  });

  it("refuses a temporary callback after its session generation was disposed", async () => {
    const write = deferred();
    session.connection.notify.and.returnValue(write.promise);
    const callback = jasmine.createSpy("temporary request");
    const opening = documents.withTemporaryDocument(
      { uri: `${uri}?temporary=1`, languageId: "test", text: "temporary" },
      callback,
    );
    const rejected = expectAsync(opening).toBeRejectedWithError(
      "Temporary language server document is no longer open",
    );
    await Promise.resolve();
    documents.dispose();
    write.resolve();
    await rejected;
    expect(callback).not.toHaveBeenCalled();
    expect(messages("textDocument/didClose").length).toBe(0);
  });

  it("aborts projection work and all document snapshots on disposal", async () => {
    session.adapter.getDocumentProjection = (item) => ({
      text: item.getText(),
      isCurrent: () => true,
    });
    await documents.openEditor(editor);
    const document = documents.items.get(C.uriKey(uri));
    const snapshot = documents.requestDocumentSnapshots().get(C.uriKey(uri));
    documents.dispose();
    expect(document.syncAbortController.signal.aborted).toBe(true);
    expect(snapshot.isCurrent()).toBe(false);
    await documents.openEditor(editor);
    expect(messages("textDocument/didOpen").length).toBe(1);
  });

  it("retires documents when emergency teardown follows an already exited process", async () => {
    session.manager.clearProgress = jasmine.createSpy("clear progress");
    const owner = new ServerSession(session.manager, {}, "", {});
    owner.state = "running";
    owner.capabilities = session.capabilities;
    owner.connection = session.connection;
    owner.scheduleDiagnostics = () => {};
    documents = owner.documentSync;
    await documents.openEditor(editor);
    owner.processExited = true;
    owner.kill();

    expect(documents.items.size).toBe(0);
    await documents.openEditor(editor);
    expect(messages("textDocument/didOpen").length).toBe(1);
  });
});
