const path = require("node:path");
const { publishSession } = require("./helpers/session-fixtures");

describe("IDE document command ownership in the workspace", () => {
  let main, editor, session, finish, requestStarted, pending;
  const range = (start, end) => ({
    start: { line: 0, character: start },
    end: { line: 0, character: end },
  });
  const resultFor = (method) =>
    method === "textDocument/foldingRange"
      ? [{ startLine: 0, endLine: 2 }]
      : method === "textDocument/selectionRange"
        ? [{ range: range(0, 7) }]
        : { ranges: [range(0, 3), range(4, 7)] };
  const start = async (method) => {
    const response = new Promise((resolve) => (finish = resolve));
    const started = new Promise((resolve) => (requestStarted = resolve));
    session.connection.request = jasmine.createSpy("controlled RPC").and.callFake((name) => {
      if (name !== method) return Promise.resolve(null);
      requestStarted();
      return response;
    });
    const features = main.ensureProviders().documentFeatures;
    pending =
      method === "textDocument/foldingRange"
        ? features.foldRanges(editor)
        : method === "textDocument/selectionRange"
          ? features.expandSelectionRanges(editor)
          : features.selectLinkedRanges(editor);
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error("Fixture command never reached the controlled RPC");
      }),
    ]);
  };

  beforeEach(async () => {
    // Every native shell path is intercepted before package activation.
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    await lumine.packages.activatePackage("ide");
    main = lumine.packages.getActivePackage("ide").mainModule;
    const ServerSession = require("../lib/server-session");
    const adapter = {
      id: "command-ownership-test",
      displayName: "Command Ownership Test",
      grammarScopes: ["text.plain.null-grammar"],
      resolveServer: async () => null,
    };
    main.provideIde().registerAdapter(adapter);
    session = new ServerSession(main.manager, adapter, path.resolve("command-test"), {});
    session.state = "running";
    session.capabilities = {
      textDocumentSync: 2,
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      linkedEditingRangeProvider: true,
      colorProvider: true,
    };
    session.ready = Promise.resolve();
    session.connection = {
      request: async () => null,
      notify: async () => {},
      dispose() {},
    };
    editor = await lumine.workspace.open();
    editor.setText("one two\nsecond\nthird");
    editor.setSelectedBufferRange([
      [0, 1],
      [0, 2],
    ]);
    publishSession(main.manager, session, main.manager.rootForEditor(editor, adapter));
  });

  afterEach(async () => {
    finish?.(null);
    await pending;
    await lumine.packages.deactivatePackage("ide");
    editor?.destroy();
    main = editor = session = finish = requestStarted = pending = null;
  });

  for (const method of [
    "textDocument/foldingRange",
    "textDocument/selectionRange",
    "textDocument/linkedEditingRange",
  ]) {
    it(`ignores ${method} for text edited while the server answers`, async () => {
      await start(method);
      editor.setText("current\nsecond\nthird");
      editor.setSelectedBufferRange([
        [0, 4],
        [0, 5],
      ]);
      finish(resultFor(method));
      expect(await pending).toBe(false);
      expect(editor.getSelectedText()).toBe("e");
      expect(editor.isFoldedAtBufferRow(0)).toBe(false);
    });
  }

  for (const method of ["textDocument/selectionRange", "textDocument/linkedEditingRange"]) {
    it(`preserves a selection moved during ${method}`, async () => {
      await start(method);
      editor.setSelectedBufferRange([
        [0, 4],
        [0, 5],
      ]);
      finish(resultFor(method));
      expect(await pending).toBe(false);
      expect(editor.getSelectedText()).toBe("t");
    });
    it(`preserves the cursor head reversed within the same range during ${method}`, async () => {
      await start(method);
      editor.setSelectedBufferRange(
        [
          [0, 1],
          [0, 2],
        ],
        { reversed: true },
      );
      finish(resultFor(method));
      expect(await pending).toBe(false);
      expect(editor.getSelectedText()).toBe("n");
      expect(editor.getCursorBufferPosition().toArray()).toEqual([0, 1]);
    });
  }

  it("does not apply an ordinary response after the package is deactivated", async () => {
    await start("textDocument/selectionRange");
    await lumine.packages.deactivatePackage("ide");
    finish(resultFor("textDocument/selectionRange"));
    expect(await pending).toBe(false);
    expect(editor.getSelectedText()).toBe("n");
  });

  it("continues to expand a live unchanged selection through the same manager and session", async () => {
    await start("textDocument/selectionRange");
    finish(resultFor("textDocument/selectionRange"));
    expect(await pending).toBe(true);
    expect(editor.getSelectedText()).toBe("one two");
  });

  it("declines a retained color presentation after its source text changes", async () => {
    editor.setCursorBufferPosition([0, 1]);
    session.connection.request = jasmine.createSpy("color RPC").and.callFake(async (method) => {
      if (method === "textDocument/documentColor")
        return [{ range: range(0, 3), color: { red: 1, green: 0, blue: 0, alpha: 1 } }];
      if (method === "textDocument/colorPresentation")
        return [{ label: "red", textEdit: { range: range(0, 3), newText: "red" } }];
      return null;
    });
    const features = main.ensureProviders().documentFeatures;
    expect(await features.colorPresentations(editor)).toBe(true);
    const item = features.colorList.getItems()[0];
    editor.setText("new content");
    expect(await features.applyColorPresentation(item)).toBe(false);
    expect(editor.getText()).toBe("new content");
  });
});
