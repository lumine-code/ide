const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("../lib/converters");
const ServerSession = require("../lib/server-session");
const Manager = require("../lib/language-server-manager");
const Projections = require("../lib/document-projections");
const CompletionProvider = require("../lib/completion-provider");
const { publishSession } = require("./helpers/session-fixtures");

describe("AST document projections", () => {
  let directory, manager, session, source, editor;
  const fixture = path.join(__dirname, "fixtures", "fake-server.js");
  const text =
    "value = %p\nnext_name = value\n# %% [markdown]\n# literal Markdown\n# %% [raw]\nraw payload\n# %%\nresult: int = 'wrong'\n";

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ide-projection-"));
    lumine.project.setPaths([directory]);
    const grammar = await lumine.packages.activatePackage("language-ipython");
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

  async function useIdentitySource() {
    editor.setText("first = 1\n# %% [code]\nsecond = 2\n");
    await editor.whenGrammarSettled();
    expect((await source.project(editor)).isIdentity).toBe(true);
  }
  it("sends original incremental ranges when both AST snapshots use original text", async () => {
    await useIdentitySource();
    await start();
    await session.openEditor(editor);
    editor.setTextInBufferRange(
      [
        [0, 8],
        [0, 9],
      ],
      "3",
    );
    await session.request("textDocument/hover", params(0, 2));
    const changes = (await messages()).filter((item) => item.method === "textDocument/didChange");
    expect(changes.length).toBe(1);
    expect(changes[0].params.contentChanges).toEqual([
      {
        range: { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } },
        rangeLength: 1,
        text: "3",
      },
    ]);
    expect(session.projectionForEditor(editor).isCurrent()).toBe(true);
  });
  it("coalesces identity edits in original transaction order before concurrent queries", async () => {
    await useIdentitySource();
    await start();
    await session.openEditor(editor);
    let release, entered;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const preparing = new Promise((resolve) => {
      entered = resolve;
    });
    session.adapter.getDocumentProjection = async (item, options) => {
      entered();
      await waiting;
      return source.project(item, options);
    };
    editor.setTextInBufferRange(
      [
        [0, 0],
        [0, 0],
      ],
      "pre_",
    );
    await preparing;
    editor.setTextInBufferRange(
      [
        [0, 4],
        [0, 4],
      ],
      "post_",
    );
    editor.setTextInBufferRange(
      [
        [2, 9],
        [2, 10],
      ],
      "4",
    );
    const requests = Promise.all(
      [0, 1, 2].map(() => session.request("textDocument/hover", params(0, 2))),
    );
    release();
    await requests;
    const traffic = await messages();
    const changes = traffic.filter((item) => item.method === "textDocument/didChange");
    expect(changes.length).toBe(1);
    expect(changes[0].params.textDocument.version).toBe(4);
    expect(changes[0].params.contentChanges.map((item) => item.text)).toEqual([
      "pre_",
      "post_",
      "4",
    ]);
    const opened = traffic.find((item) => item.method === "textDocument/didOpen");
    const { TextBuffer } = require("lumine");
    const serverBuffer = new TextBuffer({ text: opened.params.textDocument.text });
    try {
      for (const change of changes[0].params.contentChanges)
        serverBuffer.setTextInRange(C.rangeFromLsp(change.range), change.text);
      expect(serverBuffer.getText()).toBe(editor.getText());
    } finally {
      serverBuffer.destroy();
    }
    expect(traffic.indexOf(changes[0])).toBeLessThan(
      traffic.findIndex((item) => item.method === "textDocument/hover"),
    );
    expect(traffic.filter((item) => item.method === "textDocument/hover").length).toBe(3);
  });
  for (const transition of ["raw cell", "foreign cell magic", "expanded assignment magic"]) {
    it(`uses full updates across ${transition} transitions and resumes safe original ranges`, async () => {
      await useIdentitySource();
      await start();
      await session.openEditor(editor);
      let restore;
      if (transition === "raw cell") {
        editor.setTextInBufferRange(
          [
            [1, 0],
            [1, editor.getBuffer().lineLengthForRow(1)],
          ],
          "# %% [raw]",
        );
        restore = () =>
          editor.setTextInBufferRange(
            [
              [1, 0],
              [1, editor.getBuffer().lineLengthForRow(1)],
            ],
            "# %% [code]",
          );
      } else if (transition === "foreign cell magic") {
        editor.setTextInBufferRange(
          [
            [2, 0],
            [2, 0],
          ],
          "%%bash\n",
        );
        restore = () =>
          editor.setTextInBufferRange(
            [
              [2, 0],
              [3, 0],
            ],
            "",
          );
      } else {
        editor.setTextInBufferRange(
          [
            [0, 8],
            [0, 9],
          ],
          "%pwd",
        );
        restore = () =>
          editor.setTextInBufferRange(
            [
              [0, 8],
              [0, 12],
            ],
            "1",
          );
      }
      await session.request("textDocument/hover", params(0, 2));
      expect(session.projectionForEditor(editor).isIdentity).toBe(false);
      restore();
      await session.request("textDocument/hover", params(0, 2));
      expect(session.projectionForEditor(editor).isIdentity).toBe(true);
      editor.setTextInBufferRange(
        [
          [0, 8],
          [0, 9],
        ],
        "3",
      );
      await session.request("textDocument/hover", params(0, 2));
      const changes = (await messages()).filter((item) => item.method === "textDocument/didChange");
      expect(changes.length).toBe(3);
      expect(
        changes
          .slice(0, 2)
          .every(
            (item) =>
              item.params.contentChanges.length === 1 && !item.params.contentChanges[0].range,
          ),
      ).toBe(true);
      expect(changes[2].params.contentChanges[0].range).toEqual({
        start: { line: 0, character: 8 },
        end: { line: 0, character: 9 },
      });
      expect(changes[2].params.contentChanges[0].text).toBe("3");
      expect(changes[0].params.contentChanges[0].text).not.toContain("%%bash");
      expect(changes[0].params.contentChanges[0].text).not.toContain("%pwd");
    });
  }
  it("keeps full synchronization for snapshots without an explicit identity contract", async () => {
    await useIdentitySource();
    await start({
      getDocumentProjection: async (item, options) => ({
        ...(await source.project(item, options)),
        isIdentity: undefined,
      }),
    });
    await session.openEditor(editor);
    editor.setTextInBufferRange(
      [
        [0, 8],
        [0, 9],
      ],
      "3",
    );
    await session.request("textDocument/hover", params(0, 2));
    const changes = (await messages()).filter((item) => item.method === "textDocument/didChange");
    expect(changes.length).toBe(1);
    expect(changes[0].params.contentChanges).toEqual([{ text: editor.getText() }]);
  });
  it("does not replay identity edits already represented by a pending didOpen snapshot", async () => {
    await useIdentitySource();
    let release, entered;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const preparing = new Promise((resolve) => {
      entered = resolve;
    });
    await start({
      getDocumentProjection: async (item, options) => {
        entered();
        await waiting;
        return source.project(item, options);
      },
    });
    const opening = session.openEditor(editor);
    await preparing;
    editor.setTextInBufferRange(
      [
        [0, 0],
        [0, 0],
      ],
      "pre_",
    );
    const request = session.request("textDocument/hover", params(0, 2));
    release();
    await opening;
    await request;
    const traffic = await messages();
    const opened = traffic.find((item) => item.method === "textDocument/didOpen");
    const changes = traffic.filter((item) => item.method === "textDocument/didChange");
    expect(opened.params.textDocument.text).toBe(editor.getText());
    expect(changes.length).toBe(1);
    expect(changes[0].params.contentChanges).toEqual([{ text: editor.getText() }]);
    expect(traffic.indexOf(opened)).toBeLessThan(traffic.indexOf(changes[0]));
    expect(traffic.indexOf(changes[0])).toBeLessThan(
      traffic.findIndex((item) => item.method === "textDocument/hover"),
    );
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
  it("tags a stale projection before RPC without sending its coordinates", async () => {
    await start();
    await session.openEditor(editor);
    const document = session.documents.get(C.uriKey(C.pathToUri(editor.getPath())));
    document.projection = { ...document.projection, isCurrent: () => false };
    const request = spyOn(session.connection, "request").and.resolveTo([]);
    let error;
    try {
      await session.request("textDocument/references", params(1, 2));
    } catch (value) {
      error = value;
    }
    expect(error?.code).toBe("PROJECTION_STALE");
    expect(request).not.toHaveBeenCalled();
  });
  it("tags an edited source after RPC rather than mapping an old response through new coordinates", async () => {
    await start();
    await session.openEditor(editor);
    let entered, reply;
    const started = new Promise((resolve) => (entered = resolve));
    const waiting = new Promise((resolve) => (reply = resolve));
    spyOn(session.connection, "request").and.callFake(() => {
      entered();
      return waiting;
    });
    const pending = session.request("textDocument/references", params(1, 2)).then(
      () => null,
      (error) => error,
    );
    await started;
    editor.setTextInBufferRange(
      [
        [0, 0],
        [0, 0],
      ],
      "changed = 1\n",
    );
    reply([
      {
        uri: C.pathToUri(editor.getPath()),
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
      },
    ]);
    expect((await pending)?.code).toBe("PROJECTION_STALE");
  });
  for (const scope of ["source.python", "source.python.ipy"]) {
    it(`uses captured reference target geometry from a ${scope} origin`, async () => {
      if (scope === "source.python") {
        editor.setText("value = 1\n");
        lumine.grammars.assignLanguageMode(editor.getBuffer(), scope);
        await editor.whenGrammarSettled();
      }
      const filename = path.join(directory, "reference-target.ipy");
      fs.writeFileSync(filename, "x = %p\nnext_name = x\n");
      const target = await lumine.workspace.open(filename);
      try {
        await start();
        await session.openEditor(editor);
        await session.openEditor(target);
        const uri = C.pathToUri(filename),
          location = {
            uri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
          };
        const send = session.connection.request.bind(session.connection);
        let entered,
          reply,
          reads = 0;
        const started = new Promise((resolve) => (entered = resolve));
        const waiting = new Promise((resolve) => (reply = resolve));
        spyOn(session.connection, "request").and.callFake((method, ...args) => {
          if (method !== "textDocument/references") return send(method, ...args);
          if (++reads === 1) return Promise.resolve([location]);
          entered();
          return waiting;
        });
        const unchanged = await session.request("textDocument/references", params(0, 2));
        expect(unchanged[0].range.end.character).toBe(6);
        const pending = session.request("textDocument/references", params(0, 2)).then(
          () => null,
          (error) => error,
        );
        await started;
        target.setText("x = 123456789012\nnext_name = x\n");
        await session.waitForDocumentSync(session.documents.get(C.uriKey(uri)));
        expect(session.projectionForEditor(target).isIdentity).toBe(true);
        expect(session.projectionForEditor(editor)?.isCurrent() ?? true).toBe(true);
        reply([location]);
        expect((await pending)?.code).toBe("PROJECTION_STALE");
      } finally {
        target.destroy();
      }
    });
  }
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
  async function completionFixture({ sourceText, textEdit, resolve } = {}) {
    editor.setText(sourceText || "import os\n# %% [code]\npr\n");
    await editor.whenGrammarSettled();
    await start();
    session.capabilities.completionProvider = { resolveProvider: true };
    await session.openEditor(editor);
    spyOn(manager, "activeSessionsForEditor").and.resolveTo([session]);
    const item = {
      label: "print",
      textEdit: textEdit || {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } },
        newText: "print",
      },
      additionalTextEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "from package import print\n",
        },
      ],
      data: { symbol: "print" },
      command: { command: "server.afterImport" },
    };
    const send = session.connection.request.bind(session.connection);
    const wire = spyOn(session.connection, "request").and.callFake((method, params, options) => {
      if (method === "textDocument/completion")
        return Promise.resolve({ isIncomplete: false, items: [item] });
      if (method === "completionItem/resolve")
        return Promise.resolve(
          resolve ? resolve(params) : { ...params, documentation: "Resolved print" },
        );
      return send(method, params, options);
    });
    const provider = new CompletionProvider(manager);
    const complete = (prefix, activatedManually = false) =>
      provider.getSuggestions({
        editor,
        bufferPosition: { row: 2, column: prefix.length },
        prefix,
        activatedManually,
      });
    const append = (column, value) =>
      editor.setTextInBufferRange(
        [
          [2, column],
          [2, column],
        ],
        value,
      );
    const requests = (method) => wire.calls.allArgs().filter((args) => args[0] === method);
    return { provider, item, complete, append, requests };
  }
  it("reuses complete identity suggestions with fresh resolve geometry while a prefix grows", async () => {
    const { provider, item, complete, append, requests } = await completionFixture();
    const first = (await complete("pr"))[0];
    append(2, "i");
    const second = (await complete("pri"))[0];
    expect(requests("textDocument/completion").length).toBe(1);
    expect(session.isResponseCurrent(first._lspItem)).toBe(false);
    expect(session.isResponseCurrent(second._lspItem)).toBe(true);
    expect(second.textEdit.range).toEqual([
      [2, 0],
      [2, 3],
    ]);
    expect(second._lspItem.textEdit.range.end.character).toBe(3);
    expect(second._lspItem.data).toBe(item.data);
    const detailed = await provider.getSuggestionDetailsOnSelect(second);
    expect(detailed.description).toBe("Resolved print");
    expect(requests("completionItem/resolve")[0][1].textEdit.range.end.character).toBe(3);
    expect(detailed.textEdit.range).toEqual([
      [2, 0],
      [2, 3],
    ]);
    append(3, "n");
    const third = (await complete("prin"))[0];
    expect(requests("textDocument/completion").length).toBe(1);
    expect(third.textEdit.range).toEqual([
      [2, 0],
      [2, 4],
    ]);
    expect(third.description).toBe("Resolved print");
    editor.setTextInBufferRange(third.textEdit.range, third.textEdit.newText);
    expect(editor.lineTextForBufferRow(2)).toBe("print");
  });
  it("retains native edits, import data and commands when sparse resolved suggestions are renewed", async () => {
    const { provider, complete, append, requests } = await completionFixture({
      resolve: () => ({ label: "print", documentation: "Sparse documentation" }),
    });
    const first = (await complete("pr"))[0];
    const detailed = await provider.getSuggestionDetailsOnSelect(first);
    expect(detailed._lspItem.data).toEqual({ symbol: "print" });
    append(2, "i");
    const renewed = (await complete("pri"))[0];
    expect(requests("textDocument/completion").length).toBe(1);
    expect(renewed.textEdit.range).toEqual([
      [2, 0],
      [2, 3],
    ]);
    expect(renewed.additionalTextEdits[0].newText).toBe("from package import print\n");
    expect(renewed._lspItem.command.command).toBe("server.afterImport");
    expect((await provider.getSuggestionDetailsOnSelect(renewed)).description).toBe(
      "Sparse documentation",
    );
    expect(requests("completionItem/resolve").length).toBe(1);
  });
  it("rebases native insert and replace ranges and additional edits after the caret", async () => {
    const { complete, append, requests, item } = await completionFixture({
      sourceText: "import os\n# %% [code]\nprsuffix rest\n",
      textEdit: {
        insert: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } },
        replace: { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } },
        newText: "print",
      },
    });
    item.additionalTextEdits.push({
      range: { start: { line: 2, character: 10 }, end: { line: 2, character: 12 } },
      newText: "tail",
    });
    await complete("pr");
    append(2, "i");
    const renewed = (await complete("pri"))[0];
    expect(requests("textDocument/completion").length).toBe(1);
    expect(renewed._lspItem.textEdit.insert.end.character).toBe(3);
    expect(renewed._lspItem.textEdit.replace.end.character).toBe(9);
    expect(renewed.additionalTextEdits[0].range).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(renewed.additionalTextEdits[1].range).toEqual([
      [2, 11],
      [2, 13],
    ]);
    expect(item.textEdit.insert.end.character).toBe(2);
  });
  for (const change of ["another row", "masked source", "grammar", "reopened document"]) {
    it(`requests a new list after ${change} instead of renewing stale completion data`, async () => {
      const { complete, append, requests } = await completionFixture({
        sourceText: change === "masked source" ? "%pwd\n# %% [code]\npr\n" : undefined,
      });
      await complete("pr");
      if (change === "another row")
        editor.setTextInBufferRange(
          [
            [0, 7],
            [0, 9],
          ],
          "sys",
        );
      if (change === "grammar") {
        await lumine.packages.activatePackage("language-python");
        lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python");
        await editor.whenGrammarSettled();
      }
      if (change === "reopened document") {
        session.closeDocument(C.pathToUri(editor.getPath()));
        await session.openEditor(editor);
      }
      append(2, "i");
      await complete("pri");
      expect(requests("textDocument/completion").length).toBe(2);
    });
  }
  it("requests a new list when reacquiring the current projection fails", async () => {
    const { complete, append, requests } = await completionFixture();
    await complete("pr");
    append(2, "i");
    spyOn(session, "currentDocumentProjection").and.rejectWith(new Error("Projection unavailable"));
    await complete("pri");
    expect(requests("textDocument/completion").length).toBe(2);
  });
  it("does not let a superseded projection failure cancel the newer completion request", async () => {
    const { complete, append, requests } = await completionFixture();
    await complete("pr");
    append(2, "i");
    let reject, entered;
    const started = new Promise((resolve) => (entered = resolve));
    spyOn(session, "currentDocumentProjection").and.callFake(() => {
      entered();
      return new Promise((_, fail) => (reject = fail));
    });
    const stale = complete("pri");
    await started;
    append(3, "n");
    const current = await complete("prin", true);
    reject(new Error("Superseded projection unavailable"));
    expect(await stale).toEqual([]);
    expect(current.length).toBe(1);
    expect(requests("textDocument/completion").length).toBe(2);
    expect(requests("textDocument/completion")[1][2].signal.aborted).toBe(false);
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
  async function prepareProjectedFileOperation(operation, targetUri, extra = {}) {
    const edit = {
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
    };
    await start(extra, { [`workspace/will${operation}Files`]: edit });
    session.capabilities.workspace = {
      fileOperations: {
        [`will${operation}`]: {
          filters: [{ scheme: "file", pattern: { glob: "**/*.ipy", matches: "file" } }],
        },
      },
    };
    publishSession(manager, session);
    await session.openEditor(editor);
    const payload =
      operation === "Rename"
        ? {
            files: [
              {
                oldPath: editor.getPath(),
                newPath: path.join(directory, "renamed.ipy"),
                isDirectory: false,
              },
            ],
          }
        : {
            paths: [editor.getPath()],
            entries: [{ path: editor.getPath(), isDirectory: false }],
          };
    return manager[`prepare${operation}Files`](payload);
  }
  for (const operation of ["Create", "Rename", "Delete"]) {
    it(`commits retained Python reference edits from a staged will${operation}Files response`, async () => {
      const preparation = await prepareProjectedFileOperation(
        operation,
        C.pathToUri(editor.getPath()),
      );
      expect(preparation).not.toBe(false);
      expect(editor.getText()).toBe(text);
      expect(await preparation.commit()).toBe(true);
      expect(editor.getText()).toBe(text.replace("result: int", "renamed: int"));
      expect(
        (await messages()).filter((item) => item.method === `workspace/will${operation}Files`)
          .length,
      ).toBe(1);
    });
    it(`rejects a staged will${operation}Files edit when its captured projection expires without a buffer change`, async () => {
      let current = true;
      const preparation = await prepareProjectedFileOperation(
        operation,
        C.pathToUri(editor.getPath()),
        {
          getDocumentProjection: async (item, options) => {
            const projection = await source.project(item, options);
            return {
              ...projection,
              isCurrent: () => current && projection.isCurrent(),
            };
          },
        },
      );
      expect(preparation).not.toBe(false);
      current = false;
      expect(await preparation.commit()).toBe(false);
      expect(editor.getText()).toBe(text);
      expect(fs.readFileSync(editor.getPath(), "utf8")).toBe(text);
    });
  }
  it("refuses staged file-operation edits to an unopened .ipy file without a captured projection", async () => {
    const filename = path.join(directory, "unopened.ipy");
    fs.writeFileSync(filename, text);
    const preparation = await prepareProjectedFileOperation("Rename", C.pathToUri(filename));
    try {
      expect(preparation).not.toBe(false);
      expect(await preparation.commit()).toBe(false);
      expect(editor.getText()).toBe(text);
      expect(fs.readFileSync(filename, "utf8")).toBe(text);
      for (const target of lumine.workspace.getTextEditors()) {
        if (
          target.getPath() &&
          C.uriKey(C.pathToUri(target.getPath())) === C.uriKey(C.pathToUri(filename))
        )
          expect(target.getText()).toBe(text);
      }
    } finally {
      for (const target of lumine.workspace.getTextEditors()) {
        if (
          target.getPath() &&
          C.uriKey(C.pathToUri(target.getPath())) === C.uriKey(C.pathToUri(filename))
        )
          target.destroy();
      }
    }
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
    const { resolveServer } = require(
      path.join(lumine.packages.resolvePackagePath("ide-basedpyright"), "lib", "server"),
    );
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
  it("serves one real Python document across cell imports and references while excluding fenced and raw text", async () => {
    editor.setText(
      [
        "import math",
        "shared = 4",
        "# %% [markdown]",
        "```python",
        "fenced_only = missing_from_markdown",
        "```",
        "# %% [raw]",
        "raw <bytes>",
        "# %% [code]",
        "answer: float = math.sqrt(shared)",
        "broken: int = 'wrong'",
        "",
      ].join("\n"),
    );
    const { resolveServer } = require(
      path.join(lumine.packages.resolvePackagePath("ide-basedpyright"), "lib", "server"),
    );
    session = new ServerSession(
      manager,
      {
        id: "basedpyright-cross-cell-projection",
        displayName: "Basedpyright cross-cell projection",
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
      await resolveServer(""),
    );
    await session.start();
    await session.openEditor(editor);
    const uri = C.pathToUri(editor.getPath());
    const document = session.documents.get(C.uriKey(uri));
    expect(document.uri).toBe(uri);
    expect(document.projection.text).toContain("import math");
    expect(document.projection.text).toContain("math.sqrt(shared)");
    expect(document.projection.text).not.toContain("fenced_only");
    expect(document.projection.text).not.toContain("raw <bytes>");
    const report = await session.request("textDocument/diagnostic", { textDocument: { uri } });
    const diagnostics = session.transformDiagnostics(report.items || [], uri, document);
    expect(diagnostics.some((item) => item.range.start.line === 10)).toBe(true);
    expect(
      diagnostics.some((item) => item.range.start.line >= 3 && item.range.start.line <= 9),
    ).toBe(false);
    const result = await session.request("textDocument/definition", params(9, 28));
    const definitions = Array.isArray(result) ? result : [result];
    expect(
      definitions.some((item) => {
        const target = item?.uri || item?.targetUri;
        const targetRange = item?.range || item?.targetSelectionRange || item?.targetRange;
        return target && C.uriKey(target) === C.uriKey(uri) && targetRange?.start.line === 1;
      }),
    ).toBe(true);
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
