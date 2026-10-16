const path = require("node:path");
const DocumentMap = require("../lib/document-map");
const ServerSession = require("../lib/server-session");
const C = require("../lib/converters");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

describe("server document file identities", () => {
  const lower = C.pathToUri(path.resolve("document-identities", "source.ts"));
  const upper = C.pathToUri(path.resolve("document-identities", "Source.ts"));

  it("preserves file case unless the server explicitly ignores it", () => {
    for (const setting of [undefined, true]) {
      const map = new DocumentMap(setting, [[lower, "source"]]);
      expect(map.get(upper)).toBeUndefined();
    }
    const map = new DocumentMap(false, [[lower, "source"]]);
    expect(map.get(upper)).toBe("source");
    expect(map.has(C.uriKey(upper))).toBe(true);
    map.set(C.uriKey(upper), "replacement");
    expect(map.size).toBe(1);
    expect(map.get(lower)).toBe("replacement");
    expect(map.delete(upper)).toBe(true);
    expect(map.size).toBe(0);
  });

  it("keeps untitled and notebook cell identities case-sensitive", () => {
    const map = new DocumentMap(false);
    const notebook = path.resolve("document-identities", "Notebook.ipynb");
    const cell = C.cellUri(notebook, "Cell");
    map.set("untitled:Source.ts", "untitled");
    map.set(cell, "cell");
    expect(map.get("untitled:source.ts")).toBeUndefined();
    expect(map.get(C.cellUri(notebook, "cell"))).toBeUndefined();
    expect(map.get(C.cellUri(notebook.toLowerCase(), "Cell"))).toBeUndefined();
    expect(map.get(cell)).toBe("cell");
  });
});

describe("shared language-server document ownership", () => {
  let session, editors, first, second;
  const root = path.resolve("document-ownership");

  beforeEach(() => {
    editors = [];
    first = buildEditor("source.ts");
    second = buildEditor("Source.ts");
    const manager = {
      uriForEditor: (editor) => C.pathToUri(editor.getPath()),
      workspaceDocuments: { bindingFor: () => null },
      publishDiagnostics() {},
      didCloseDocument() {},
      dynamicOptions: () => null,
      dynamicSupport: () => false,
      log() {},
    };
    session = new ServerSession(manager, { caseSensitiveFileNames: false }, root, {});
    session.state = "running";
    session.capabilities = { textDocumentSync: 2 };
    session.connection = {
      notify: jasmine.createSpy("notification").and.resolveTo(),
      request: jasmine.createSpy("request").and.resolveTo([]),
    };
    spyOn(session, "scheduleDiagnostics");
    spyOn(session, "scheduleWorkspaceDiagnostics");
    spyOn(session, "requestWithProgress").and.callFake((method, params) =>
      session.connection.request(method, params),
    );
  });

  afterEach(() => {
    session.documentSync.dispose();
    for (const editor of editors) editor.destroy();
  });

  function buildEditor(filename, buffer) {
    const editor = lumine.workspace.buildTextEditor(buffer ? { buffer } : {});
    if (!buffer) {
      editor.getBuffer().setPath(path.join(root, filename));
      editor.setText("const value = 1;\nvalue;");
    }
    editors.push(editor);
    return editor;
  }
  const uriFor = (editor) => C.pathToUri(editor.getPath());
  const messages = (method) =>
    session.connection.notify.calls.allArgs().filter(([name]) => name === method);
  const references = (editor, extra = {}) =>
    session.request(
      "textDocument/references",
      { textDocument: { uri: uriFor(editor) }, position: { line: 1, character: 1 } },
      extra,
    );

  for (const index of [0, 1]) {
    it(`keeps aliases open when owner ${index + 1} closes first`, async () => {
      await session.openEditor(first);
      await session.openEditor(second);
      expect(session.documents.size).toBe(1);
      expect(messages("textDocument/didOpen").length).toBe(1);
      const pair = [first, second];
      const survivor = pair[1 - index];
      pair[index].destroy();
      expect(messages("textDocument/didClose").length).toBe(0);
      survivor.setText("const value = 2;\nvalue;");
      await references(survivor);
      expect(messages("textDocument/didChange").length).toBe(1);
      expect(session.connection.request).toHaveBeenCalledWith("textDocument/references", {
        textDocument: { uri: uriFor(first) },
        position: { line: 1, character: 1 },
      });
      survivor.destroy();
      expect(session.documents.size).toBe(0);
      expect(messages("textDocument/didClose")).toEqual([
        ["textDocument/didClose", { textDocument: { uri: uriFor(first) } }],
      ]);
    });
  }

  it("synchronizes a requesting alias's distinct buffer and preserves the caller parameters", async () => {
    await session.openEditor(first);
    second.setText("const value = 2;\nvalue;\nvalue;");
    await session.openEditor(second);
    expect(messages("textDocument/didChange").at(-1)[1].contentChanges).toEqual([
      { text: second.getText() },
    ]);
    await session.openEditor(first);
    await references(second);
    expect(messages("textDocument/didChange").at(-1)[1].contentChanges).toEqual([
      { text: second.getText() },
    ]);
    const params = { textDocument: { uri: uriFor(second) }, position: { line: 1, character: 1 } };
    await session.request("textDocument/references", params);
    expect(params.textDocument.uri).toBe(uriFor(second));
    expect(session.connection.request.calls.mostRecent().args[1].textDocument.uri).toBe(
      uriFor(first),
    );
    const snapshot = session.documentSync.requestDocumentSnapshots().get(uriFor(second));
    expect(snapshot.uri).toBe(uriFor(first));
    expect(snapshot.text).toBe(second.getText());
  });

  it("sends one change per shared-buffer edit and transfers ownership to the surviving split", async () => {
    const split = buildEditor("ignored", first.getBuffer());
    await session.openEditor(first);
    await session.openEditor(split);
    first.setText("changed");
    expect(messages("textDocument/didChange").length).toBe(1);
    split.destroy();
    expect(messages("textDocument/didClose").length).toBe(0);
    first.setText("changed again");
    expect(messages("textDocument/didChange").length).toBe(2);
    expect(session.documents.get(uriFor(first)).editor).toBe(first);
    first.destroy();
    expect(messages("textDocument/didClose").length).toBe(1);
  });

  it("refuses a temporary document that aliases an already open file", async () => {
    await session.openEditor(first);
    await expectAsync(
      session.documentSync.withTemporaryDocument(
        { uri: uriFor(second), text: "temporary", languageId: "typescript" },
        async () => "unreachable",
      ),
    ).toBeRejectedWithError("Temporary language server URI is already open");
    expect(messages("textDocument/didOpen").length).toBe(1);
    expect(messages("textDocument/didClose").length).toBe(0);
  });

  it("rebuilds the projection after its opening owner closes during grammar readiness", async () => {
    const grammar = deferred();
    spyOn(first, "whenGrammarSettled").and.returnValue(grammar.promise);
    session.adapter.getDocumentProjection = (editor) => ({
      text: editor.getText(),
      editor,
      isCurrent: () => !editor.isDestroyed(),
    });
    const opening = session.openEditor(first);
    const joining = session.openEditor(second);
    first.destroy();
    grammar.resolve(false);
    await Promise.all([opening, joining]);

    const document = session.documents.get(uriFor(second));
    expect(document.editor).toBe(second);
    expect(document.projection.editor).toBe(second);
    expect(messages("textDocument/didOpen").length).toBe(1);
    expect(messages("textDocument/didClose").length).toBe(0);
  });

  it("orders a save after the alias's full source replacement", async () => {
    session.capabilities.textDocumentSync = {
      openClose: true,
      change: 2,
      save: { includeText: true },
    };
    await session.openEditor(first);
    await session.openEditor(second);
    await session.openEditor(first);
    second.setText("const alias = 2;");
    const document = session.documents.get(uriFor(second));
    await session.documentSync.saveDocument(document, { includeText: true });
    const methods = session.connection.notify.calls.allArgs().map(([method]) => method);
    expect(methods).toEqual([
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didSave",
    ]);
    expect(messages("textDocument/didSave")[0][1].text).toBe(second.getText());
  });

  it("abandons a lookup whose distinct-buffer source changes during synchronization", async () => {
    await session.openEditor(first);
    await session.openEditor(second);
    const request = references(first);
    const abandoned = expectAsync(request).toBeRejectedWith(
      jasmine.objectContaining({ code: "PROJECTION_STALE" }),
    );
    second.setText("const other = 1;\nother;");
    await abandoned;
    expect(session.connection.request).not.toHaveBeenCalled();
  });

  it("abandons an in-flight lookup when a different alias becomes the source", async () => {
    await session.openEditor(first);
    await session.openEditor(second);
    const reply = deferred();
    const started = deferred();
    session.connection.request.and.callFake(() => {
      started.resolve();
      return reply.promise;
    });
    const request = references(first);
    const abandoned = expectAsync(request).toBeRejectedWith(
      jasmine.objectContaining({ code: "PROJECTION_STALE" }),
    );
    await started.promise;
    second.setText("const other = 1;\nother;");
    reply.resolve([]);
    await abandoned;
  });
});
