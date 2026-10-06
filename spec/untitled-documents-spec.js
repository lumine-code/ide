const fs = require("fs");
const os = require("os");
const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const RefactorProvider = require("../lib/refactor-provider");
const SymbolProvider = require("../lib/symbol-provider");
const ReferencesProvider = require("../lib/references-provider");
const C = require("../lib/converters");

const FIXTURE = path.join(__dirname, "fixtures", "fake-server.js");
const until = async (condition) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for an untitled document session");
};

describe("Unsaved language-server documents", () => {
  let manager, editor, tempDir;

  beforeEach(async () => {
    jasmine.useRealClock();
    manager = new LanguageServerManager();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-untitled-"));
    lumine.project.setPaths([tempDir]);
    await lumine.project.getWatcherPromise(tempDir);
    editor = await lumine.workspace.open();
    manager.activate();
  });

  afterEach(async () => {
    await manager.deactivate();
    editor?.destroy();
    lumine.project.setPaths([]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const register = (config = {}) => {
    const adapter = {
      id: "untitled-test",
      displayName: "Untitled Test Server",
      grammarScopes: [editor.getGrammar().scopeName, "text.html.basic"],
      languageId: "html",
      resolveServer: () => ({
        command: process.execPath,
        args: [
          FIXTURE,
          JSON.stringify({
            ...config,
            capabilities: { textDocumentSync: 2, ...config.capabilities },
          }),
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      }),
    };
    manager.registerAdapter(adapter);
    return adapter;
  };

  it("assigns distinct stable URIs and resolves edits to the existing buffer", async () => {
    const uri = manager.uriForEditor(editor);
    const other = { getPath: () => null };
    expect(uri.startsWith("untitled:")).toBe(true);
    expect(manager.uriForEditor(editor)).toBe(uri);
    expect(manager.uriForEditor(other)).not.toBe(uri);
    expect(manager.resolveUri(uri)).toEqual({ kind: "untitled", editor });
    expect(await manager.workspaceEdits.editorForWorkspaceEdit(uri)).toBe(editor);
    const result = await manager.applyWorkspaceEdit({
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "<div>",
          },
        ],
      },
    });
    expect(result).toBe(true);
    expect(editor.getText()).toBe("<div>");
    expect(editor.getPath()).toBeUndefined();
  });

  it("opens and updates an unsaved buffer, then closes it when saved", async () => {
    const uri = manager.uriForEditor(editor);
    const adapter = register();
    await manager.attachEditor(editor);
    await until(async () => (await manager.activeSessionsForEditor(editor)).length === 1);
    const session = manager.sessionsForEditor(editor)[0];
    const received = () => session.request("test/getReceived");
    const didOpen = (await received()).filter(
      (message) => message.method === "textDocument/didOpen",
    );
    expect(didOpen.length).toBe(1);
    expect(didOpen[0].params.textDocument.uri).toBe(uri);
    expect(didOpen[0].params.textDocument.languageId).toBe("html");
    expect(manager.controllerForSession(session).explicitDemand).toBe(false);

    editor.setText("<div>");
    await until(async () =>
      (await received()).some((message) => message.method === "textDocument/didChange"),
    );
    const target = path.join(tempDir, "saved.html");
    await editor.saveAs(target);
    await until(async () => session.documents.has(C.uriKey(C.pathToUri(target))));
    const messages = await received();
    const close = messages.findIndex(
      (message) =>
        message.method === "textDocument/didClose" && message.params.textDocument.uri === uri,
    );
    const open = messages.findIndex(
      (message) =>
        message.method === "textDocument/didOpen" &&
        message.params.textDocument.uri === C.pathToUri(target),
    );
    expect(close).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(close);
    expect(session.documents.has(C.uriKey(uri))).toBe(false);
    expect(manager.resolveUri(uri)).toBeNull();
    expect(manager.sessionsForEditor(editor)).toEqual([session]);
    expect(manager.rootForEditor(editor, adapter)).toBe(tempDir);
  });

  it("releases the document identity and demand when the scratch editor closes", async () => {
    const uri = manager.uriForEditor(editor);
    register();
    await manager.attachEditor(editor);
    await until(async () => (await manager.activeSessionsForEditor(editor)).length === 1);
    const session = manager.sessionsForEditor(editor)[0];
    editor.destroy();
    expect(manager.resolveUri(uri)).toBeNull();
    expect(session.documents.has(C.uriKey(uri))).toBe(false);
    expect(manager.sessionsForEditor(editor)).toEqual([]);
  });

  it("uses the working directory without a project and follows a new project root", () => {
    const adapter = { sessionScope: "project-root" };
    spyOn(lumine.project, "getPaths").and.returnValue([]);
    expect(manager.rootForEditor(editor, adapter)).toBe(process.cwd());
    lumine.project.getPaths.and.returnValue([tempDir]);
    expect(manager.rootForEditor(editor, adapter)).toBe(tempDir);
  });

  it("carries a grammar extension and replaces its URI when the language changes", () => {
    let fileTypes = ["sass"];
    const scratch = { getPath: () => null, getGrammar: () => ({ fileTypes }) };
    const sassUri = manager.uriForEditor(scratch);
    expect(sassUri.startsWith("untitled:")).toBe(true);
    expect(sassUri.endsWith(".sass")).toBe(true);
    expect(manager.uriForEditor(scratch)).toBe(sassUri);
    fileTypes = ["*.unsupported", "html"];
    const htmlUri = manager.uriForEditor(scratch);
    expect(htmlUri.endsWith(".html")).toBe(true);
    expect(manager.resolveUri(sassUri)).toBeNull();
    expect(manager.resolveUri(htmlUri)).toEqual({ kind: "untitled", editor: scratch });
  });

  for (const shape of ["changes", "documentChanges"]) {
    it(`applies a rename to the existing unsaved editor through ${shape}`, async () => {
      editor.setText("<div></div>");
      const uri = manager.uriForEditor(editor);
      const edits = [
        {
          range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
          newText: "section",
        },
        {
          range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
          newText: "section",
        },
      ];
      const edit =
        shape === "changes"
          ? { changes: { [uri]: edits } }
          : { documentChanges: [{ textDocument: { uri, version: 1 }, edits }] };
      register({
        capabilities: { renameProvider: true },
        responses: { "textDocument/rename": edit },
      });
      await manager.attachEditor(editor);
      const provider = new RefactorProvider(manager);

      const result = await provider.rename(editor, { row: 0, column: 2 }, "section");
      expect(result.outcome).toBe("applied");
      expect(editor.getText()).toBe("<section></section>");
      expect(editor.getPath()).toBeUndefined();
      expect(manager.uriForEditor(editor)).toBe(uri);
      expect(lumine.workspace.getTextEditors().filter((item) => item === editor).length).toBe(1);
    });
  }

  it("previews a scratch rename without applying it", async () => {
    editor.setText("<div></div>");
    const uri = manager.uriForEditor(editor);
    const edit = {
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
            newText: "section",
          },
        ],
      },
    };
    register({
      capabilities: { renameProvider: true },
      responses: { "textDocument/rename": edit },
    });
    await manager.attachEditor(editor);
    spyOn(manager, "applyWorkspaceEdit").and.callThrough();
    const provider = new RefactorProvider(manager);

    const result = await provider.rename(editor, { row: 0, column: 2 }, "section", {
      dryRun: true,
    });
    expect(result.outcome).toBe("edits");
    expect(result.externalTargets).toBe(true);
    expect(result.edits.size).toBe(0);
    expect(manager.applyWorkspaceEdit).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("<div></div>");
  });

  it("keeps local scratch symbols and omits pathless cross-document navigation", () => {
    const uri = manager.uriForEditor(editor);
    const provider = new SymbolProvider(manager);
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
    const symbol = { name: "section", kind: 8, range, selectionRange: range };
    try {
      expect(provider.convert([symbol], uri)[0].name).toBe("section");
      expect(provider.convert([{ ...symbol, location: { uri, range } }])).toEqual([]);
      expect(provider.locations([{ uri, range }])).toEqual([]);
      const fileUri = C.pathToUri(path.join(tempDir, "saved.html"));
      expect(provider.locations([{ uri: fileUri, range }])[0].path).toBe(
        path.join(tempDir, "saved.html"),
      );
    } finally {
      provider.destroy();
    }
  });

  it("omits scratch reference locations that the references panel cannot represent", async () => {
    editor.setText("const value = 1;");
    const uri = manager.uriForEditor(editor);
    const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } };
    const filePath = path.join(tempDir, "saved.js");
    register({
      capabilities: { referencesProvider: true },
      responses: {
        "textDocument/references": [
          { uri, range },
          { uri: C.pathToUri(filePath), range },
        ],
      },
    });
    await manager.attachEditor(editor);
    const provider = new ReferencesProvider(manager);
    const result = await provider.findReferences(editor, { row: 0, column: 8 });
    expect(result.references.length).toBe(1);
    expect(result.references[0].path).toBe(filePath);
  });
});
