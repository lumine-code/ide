const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("../lib/converters");
const ServerSession = require("../lib/server-session");
const Manager = require("../lib/language-server-manager");
const Projections = require("../lib/document-projections");

describe("AST document projections", () => {
  let directory, manager, session, source, editor;
  const fixture = path.join(__dirname, "fixtures", "fake-server.js");
  const text =
    "value = %p\nnext_name = value\n# %% [markdown]\n# literal Markdown\n# %% [raw]\nraw payload\n# %%\nresult: int = 'wrong'\n";

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ide-projection-"));
    lumine.project.setPaths([directory]);
    const grammar = await lumine.packages.activatePackage(
      path.join(__dirname, "../../language-ipython"),
    );
    source = grammar.mainModule.provideIPythonSource();
    manager = new Manager();
    const filename = path.join(directory, "source.ipy");
    fs.writeFileSync(filename, text);
    editor = await lumine.workspace.open(filename);
  });
  afterEach(async () => {
    await session?.stop();
    await manager.deactivate();
    editor?.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function start(extra = {}, responses = {}) {
    const launch = {
      command: process.execPath,
      args: [
        fixture,
        JSON.stringify({
          capabilities: { textDocumentSync: 2, hoverProvider: true },
          responses,
        }),
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      transport: "stdio",
    };
    session = new ServerSession(
      manager,
      {
        id: "projection-contract",
        displayName: "Projection contract",
        grammarScopes: ["source.python.ipy"],
        needsDocumentTransform: (item) => item?.getGrammar().scopeName === "source.python.ipy",
        getDocumentProjection: (item, options) => source.project(item, options),
        ...extra,
      },
      directory,
      launch,
    );
    await session.start();
    return session;
  }
  const messages = () => session.request("test/getReceived");
  const params = (row, column) => ({
    textDocument: { uri: C.pathToUri(editor.getPath()) },
    position: { line: row, character: column },
  });

  it("opens only projected source under the original .ipy URI", async () => {
    await start();
    await session.openEditor(editor);
    const opened = (await messages()).find((item) => item.method === "textDocument/didOpen");
    expect(opened.params.textDocument.uri).toBe(C.pathToUri(editor.getPath()));
    expect(opened.params.textDocument.languageId).toBe("python");
    expect(opened.params.textDocument.text).toContain("eval('')");
    expect(opened.params.textDocument.text).not.toContain("literal Markdown");
    expect(opened.params.textDocument.text).not.toContain("raw payload");
    expect(editor.getText()).toBe(text);
  });
  it("blocks point requests in Markdown and maps expanded endpoint responses", async () => {
    await start(
      {},
      {
        "textDocument/hover": {
          contents: "Any",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 16 },
          },
        },
      },
    );
    await session.openEditor(editor);
    expect(await session.request("textDocument/hover", params(3, 2))).toBeNull();
    const hover = await session.request("textDocument/hover", params(0, 2));
    expect(hover.range.end.character).toBe(10);
    expect((await messages()).filter((item) => item.method === "textDocument/hover").length).toBe(
      1,
    );
  });
  it("filters synthetic diagnostics without discarding ordinary Python reports", async () => {
    await start();
    await session.openEditor(editor);
    const document = session.documents.get(C.uriKey(C.pathToUri(editor.getPath())));
    const result = session.transformDiagnostics(
      [
        {
          range: { start: { line: 0, character: 8 }, end: { line: 0, character: 16 } },
          message: "synthetic",
        },
        {
          range: { start: { line: 7, character: 14 }, end: { line: 7, character: 21 } },
          message: "real",
        },
      ],
      document.uri,
      document,
    );
    expect(result.map((item) => item.message)).toEqual(["real"]);
  });
  it("rejects completion auto-imports that touch a protected cell atomically", async () => {
    await start();
    await session.openEditor(editor);
    const projection = session.projectionForEditor(editor);
    const result = session.mapCompletionItem(
      {
        label: "value",
        textEdit: {
          range: { start: { line: 1, character: 12 }, end: { line: 1, character: 17 } },
          newText: "value",
        },
        additionalTextEdits: [
          {
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } },
            newText: "import os\n",
          },
        ],
      },
      editor,
      C.pathToUri(editor.getPath()),
      projection,
    );
    expect(result).toBeNull();
    expect(editor.getText()).toBe(text);
  });
  it("refuses an unavailable source provider without sending raw didOpen", async () => {
    await start({ getDocumentProjection: async () => null });
    await expectAsync(session.openEditor(editor)).toBeRejected();
    expect((await messages()).some((item) => item.method === "textDocument/didOpen")).toBe(false);
  });
  it("preserves incremental Python changes without grammar waits or projection reads", async () => {
    editor.destroy();
    const filename = path.join(directory, "plain.py");
    fs.writeFileSync(filename, "value = 1\n");
    editor = await lumine.workspace.open(filename);
    await lumine.packages.activatePackage("language-python");
    const project = jasmine
      .createSpy("project")
      .and.callFake((item, options) => source.project(item, options));
    await start({ getDocumentProjection: project });
    const wait = spyOn(editor, "whenGrammarSettled").and.callThrough();
    await session.openEditor(editor);
    const read = spyOn(editor, "getText").and.callThrough();
    editor.setTextInBufferRange(
      [
        [0, 8],
        [0, 9],
      ],
      "2",
    );
    await session.request("textDocument/hover", params(0, 2));
    const changed = (await messages()).find((item) => item.method === "textDocument/didChange");
    expect(changed.params.contentChanges[0].range).toBeDefined();
    expect(changed.params.contentChanges[0].text).toBe("2");
    expect(project).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it("closes temporary formatter documents on errors and suppresses late diagnostics", async () => {
    await start();
    await session.openEditor(editor);
    const uri = C.pathToUri(path.join(directory, ".source-format.py"));
    await expectAsync(
      session.withTemporaryDocument({ uri, languageId: "python", text: "value=1\n" }, async () => {
        throw new Error("formatter failed");
      }),
    ).toBeRejectedWithError("formatter failed");
    const traffic = (await messages()).filter((item) => item.params?.textDocument?.uri === uri);
    expect(traffic.map((item) => item.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didClose",
    ]);
    expect(session.documents.has(C.uriKey(uri))).toBe(false);
    expect(
      manager.publishDiagnostics(session, {
        uri,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            message: "temporary",
          },
        ],
      }),
    ).toBe(false);
  });
  it("atomically rejects a workspace edit that mixes Python and raw targets", async () => {
    await start();
    await session.openEditor(editor);
    const uri = C.pathToUri(editor.getPath());
    const edit = {
      changes: {
        [uri]: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
            newText: "updated",
          },
          {
            range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } },
            newText: "oops",
          },
        ],
      },
    };
    session.captureWorkspaceProjectionContext(edit);
    expect(await manager.applyWorkspaceEdit(edit, "unsafe", session)).toBe(false);
    expect(editor.getText()).toBe(text);
  });
  it("applies one safe projected rename batch in original coordinates", async () => {
    await start();
    await session.openEditor(editor);
    const uri = C.pathToUri(editor.getPath());
    const edit = {
      changes: {
        [uri]: [
          {
            range: {
              start: { line: 7, character: 0 },
              end: { line: 7, character: 6 },
            },
            newText: "renamed",
          },
        ],
      },
    };
    session.captureWorkspaceProjectionContext(edit);
    expect(await manager.applyWorkspaceEdit(edit, "safe", session)).toBe(true);
    expect(editor.getText()).toBe(text.replace("result: int", "renamed: int"));
  });
  it("keeps query-specific formatter documents separate from the same host file", async () => {
    await start();
    await session.openEditor(editor);
    const host = C.pathToUri(editor.getPath());
    const uri = host + "?lumine-format=isolated";
    await session.withTemporaryDocument(
      { uri, languageId: "python", text: "value=1\n" },
      async () => {
        expect(session.documents.get(C.uriKey(host)).editor === editor).toBe(true);
        expect(session.temporaryDocuments.size).toBe(1);
        expect(manager.publishDiagnostics(session, { uri, diagnostics: [] })).toBe(false);
        await session.request("textDocument/formatting", { textDocument: { uri } });
      },
    );
    expect(session.documents.get(C.uriKey(host)).editor === editor).toBe(true);
    expect(session.temporaryDocuments.size).toBe(0);
    expect(manager.publishDiagnostics(session, { uri: host, diagnostics: [] })).toBe(true);
    expect(editor.getText()).toBe(text);
  });
  it("gates read positions independently from enclosing symbol ranges", async () => {
    const projection = await source.project(editor);
    expect(() => Projections.toServerParams(projection, params(0, 9))).toThrow();
    expect(
      Projections.fromServerRange(
        projection,
        { start: { line: 0, character: 0 }, end: { line: 0, character: 16 } },
        { requirePython: false },
      ).end.character,
    ).toBe(10);
  });
  it("coalesces edits during projection preparation and orders requests after the final change", async () => {
    await start();
    await session.openEditor(editor);
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    session.adapter.getDocumentProjection = async (item, options) => {
      await waiting;
      return source.project(item, options);
    };
    editor.setTextInBufferRange(
      [
        [1, 0],
        [1, 9],
      ],
      "other_one",
    );
    await new Promise((resolve) => setImmediate(resolve));
    editor.setTextInBufferRange(
      [
        [1, 0],
        [1, 9],
      ],
      "other_two",
    );
    const request = session.request("textDocument/hover", params(1, 2));
    release();
    await request;
    const traffic = await messages();
    const changes = traffic.filter((item) => item.method === "textDocument/didChange");
    expect(changes.length).toBe(1);
    expect(changes[0].params.contentChanges[0].text).toContain("other_two = value");
    expect(traffic.indexOf(changes[0])).toBeLessThan(
      traffic.findIndex((item) => item.method === "textDocument/hover"),
    );
  });
  it("cancels a pending projection when its editor closes", async () => {
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    await start({
      getDocumentProjection: async (item, options) => {
        await waiting;
        return source.project(item, options);
      },
    });
    const opened = session.openEditor(editor);
    const rejected = expectAsync(opened).toBeRejected();
    await new Promise((resolve) => setImmediate(resolve));
    editor.destroy();
    release();
    await rejected;
    expect((await messages()).some((item) => item.method === "textDocument/didOpen")).toBe(false);
    expect(session.documents.size).toBe(0);
  });
  it("serializes temporary documents and leaves the real host source untouched", async () => {
    await start();
    await session.openEditor(editor);
    const first = C.pathToUri(path.join(directory, "format-first.py"));
    const second = C.pathToUri(path.join(directory, "format-second.py"));
    await Promise.all(
      [first, second].map((uri) =>
        session.withTemporaryDocument(
          {
            uri,
            languageId: "python",
            text: "value=1\n",
          },
          async () => session.request("textDocument/formatting", { textDocument: { uri } }),
        ),
      ),
    );
    const traffic = (await messages()).filter((item) =>
      [first, second].includes(item.params?.textDocument?.uri),
    );
    expect(traffic.map((item) => item.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/formatting",
      "textDocument/didClose",
      "textDocument/didOpen",
      "textDocument/formatting",
      "textDocument/didClose",
    ]);
    expect(editor.getText()).toBe(text);
    expect(session.documents.size).toBe(1);
  });
  it("serves real Basedpyright diagnostics only for retained Python", async () => {
    const { resolveServer } = require("../../ide-pyright/lib/server");
    const launch = await resolveServer("");
    session = new ServerSession(
      manager,
      {
        id: "basedpyright-projection-contract",
        displayName: "Basedpyright projection contract",
        grammarScopes: ["source.python.ipy"],
        needsDocumentTransform: () => true,
        getDocumentProjection: (item, options) => source.project(item, options),
        getSettings: () => ({
          python: { analysis: { typeCheckingMode: "basic", diagnosticMode: "openFilesOnly" } },
        }),
        getWorkspaceConfiguration: (section) =>
          section?.endsWith("analysis")
            ? { typeCheckingMode: "basic", diagnosticMode: "openFilesOnly" }
            : { analysis: { typeCheckingMode: "basic", diagnosticMode: "openFilesOnly" } },
      },
      directory,
      launch,
    );
    await session.start();
    await session.openEditor(editor);
    const result = await session.request("textDocument/diagnostic", {
      textDocument: { uri: C.pathToUri(editor.getPath()) },
    });
    const document = session.documents.get(C.uriKey(C.pathToUri(editor.getPath())));
    const diagnostics = session.transformDiagnostics(result.items || [], document.uri, document);
    expect(diagnostics.some((item) => item.range.start.line === 7)).toBe(true);
    expect(diagnostics.some((item) => [3, 5].includes(item.range.start.line))).toBe(false);
  }, 30000);
  it("maps definitions and validates renames from ordinary Python into an open projection", async () => {
    const targetUri = C.pathToUri(editor.getPath());
    await start(
      {},
      {
        "textDocument/definition": [
          {
            uri: targetUri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 16 },
            },
          },
        ],
        "textDocument/rename": {
          changes: {
            [targetUri]: [
              {
                range: {
                  start: { line: 7, character: 0 },
                  end: { line: 7, character: 6 },
                },
                newText: "renamed",
              },
            ],
          },
        },
      },
    );
    await session.openEditor(editor);
    const filePath = path.join(directory, "caller.py");
    fs.writeFileSync(filePath, "value = 1\n");
    const caller = await lumine.workspace.open(filePath);
    await lumine.packages.activatePackage("language-python");
    try {
      await session.openEditor(caller);
      const request = {
        textDocument: { uri: C.pathToUri(filePath) },
        position: { line: 0, character: 1 },
      };
      const definitions = await session.request("textDocument/definition", request);
      expect(definitions[0].range.end.character).toBe(10);
      const edit = await session.request("textDocument/rename", { ...request, newName: "renamed" });
      expect(await manager.applyWorkspaceEdit(edit, "cross document", session)).toBe(true);
      expect(editor.getText()).toBe(text.replace("result: int", "renamed: int"));
    } finally {
      caller.destroy();
    }
  });
});
