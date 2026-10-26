const path = require("path");
const Manager = require("../lib/language-server-manager");
const ServerSession = require("../lib/server-session");
const C = require("../lib/converters");
const { publishSession } = require("./helpers/session-fixtures");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

describe("Pending editor document readiness", () => {
  let manager, session, editor, editors, ready, adapter;
  const root = path.resolve("pending-document-readiness");
  const filePath = path.join(root, "preview.ts");

  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    manager = new Manager();
    editors = [];
    editor = buildEditor(filePath);
    ready = deferred();
    adapter = {
      id: "pending-readiness",
      displayName: "Pending Readiness",
      grammarScopes: [editor.getGrammar().scopeName, "source.other"],
      languageId: "typescript",
      languageIdForScope: () => "typescript",
      caseSensitiveFileNames: false,
      resolveServer: async () => null,
    };
    manager.adapters.set(adapter.id, adapter);
    session = new ServerSession(manager, adapter, root, {});
    session.ready = ready.promise;
    session.capabilities = { textDocumentSync: 2 };
    session.connection = { notify: jasmine.createSpy("document notification").and.resolveTo() };
    spyOn(session, "scheduleDiagnostics");
    spyOn(session, "stop").and.callFake(async () => {
      session.documentSync.dispose();
      session.state = "stopped";
    });
    publishSession(manager, session);
    spyOn(manager, "sessionsForEditor").and.callFake((item) =>
      item.isDestroyed() ? [] : [session],
    );
    spyOn(session, "openEditor").and.callThrough();
  });

  afterEach(async () => {
    await manager.deactivate();
    for (const item of editors) item.destroy();
  });

  function buildEditor(filename) {
    const item = lumine.workspace.buildTextEditor();
    item.getBuffer().setPath(filename);
    item.setText("const value = 1;\nvalue;");
    editors.push(item);
    return item;
  }

  function finishStartup() {
    session.state = "running";
    ready.resolve();
  }

  it("abandons a closed preview during startup and opens a later preview at the same URI", async () => {
    const request = manager.activeSessionsForEditor(editor);
    editor.destroy();
    finishStartup();

    expect(await request).toEqual([]);
    expect(session.openEditor).not.toHaveBeenCalled();
    expect(session.documents.size).toBe(0);

    const replacement = buildEditor(filePath);
    expect(await manager.activeSessionsForEditor(replacement)).toEqual([session]);
    expect(session.documents.get(C.uriKey(manager.uriForEditor(replacement))).editor).toBe(
      replacement,
    );
    expect(session.connection.notify).toHaveBeenCalledOnceWith("textDocument/didOpen", {
      textDocument: {
        uri: manager.uriForEditor(replacement),
        languageId: "typescript",
        version: 1,
        text: replacement.getText(),
      },
    });
  });

  it("does not attach a different URI after startup finishes", async () => {
    const request = manager.activeSessionsForEditor(editor);
    editor.getBuffer().setPath(path.join(root, "other.ts"));
    finishStartup();

    expect(await request).toEqual([]);
    expect(session.openEditor).not.toHaveBeenCalled();
    expect(session.documents.size).toBe(0);
  });

  it("does not attach a different grammar after startup finishes", async () => {
    const request = manager.activeSessionsForEditor(editor);
    spyOn(editor, "getGrammar").and.returnValue({ scopeName: "source.other" });
    finishStartup();

    expect(await request).toEqual([]);
    expect(session.openEditor).not.toHaveBeenCalled();
    expect(session.documents.size).toBe(0);
  });

  it("does not expose an attachment retired while its didOpen write was pending", async () => {
    const write = deferred();
    const writing = deferred();
    session.connection.notify.and.callFake(() => {
      writing.resolve();
      return write.promise;
    });
    finishStartup();
    const request = manager.activeSessionsForEditor(editor);
    await writing.promise;
    editor.destroy();
    write.resolve();

    expect(await request).toEqual([]);
    expect(session.documents.size).toBe(0);
  });

  it("does not expose an alias whose distinct buffer lost source ownership while opening", async () => {
    const alias = buildEditor(path.join(root, "Preview.ts"));
    const first = manager.activeSessionsForEditor(editor);
    const second = manager.activeSessionsForEditor(alias);
    finishStartup();

    expect(await first).toEqual([]);
    expect(await second).toEqual([session]);
    expect(session.documents.size).toBe(1);
    expect(session.documents.values().next().value.editor).toBe(alias);
  });
});
