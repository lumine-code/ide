const DocumentFeatures = require("../lib/document-features");
const C = require("../lib/converters");
const { Emitter } = require("lumine");

const lspRange = (row, start, end) => ({
  start: { line: row, character: start },
  end: { line: row, character: end },
});

const makeEditor = () => {
  const editor = {
    getPath: () => "C:\\project\\file.js",
    getBuffer: () => ({ onDidChangeText: () => ({ dispose() {} }) }),
    onDidDestroy: () => ({ dispose() {} }),
    getCursorBufferPosition: () => ({ row: 0, column: 2 }),
    getCursorBufferPositions: () => [{ row: 0, column: 2 }],
    getSelectedBufferRanges: () => [{ start: { row: 0, column: 1 }, end: { row: 0, column: 3 } }],
    setSelectedBufferRanges: jasmine.createSpy("setSelectedBufferRanges"),
    foldBufferRange: jasmine.createSpy("foldBufferRange"),
  };
  return editor;
};

const makeSession = (respond, options = {}) => ({
  requests: [],
  capabilityOptions: (method) => options[method],
  async request(method, params) {
    this.requests.push({ method, params });
    return respond(method, params);
  },
});

const makeManager = (session) => ({
  activeSessionForFeature: jasmine
    .createSpy("activeSessionForFeature")
    .and.callFake(async () => session),
  uriForEditor: () => "file:///C:/project/file.js",
  resolveUri: (uri) => (uri.startsWith("file:") ? { kind: "file", path: uri } : null),
  showDocument: jasmine.createSpy("showDocument").and.resolveTo({ success: true }),
  applyWorkspaceEdit: jasmine.createSpy("applyWorkspaceEdit").and.resolveTo(true),
  onDidChangeSession: () => ({ dispose() {} }),
  onDidChangeCapabilities: () => ({ dispose() {} }),
  onDidChangeFeatures: () => ({ dispose() {} }),
});

describe("DocumentFeatures", () => {
  let features, editor;

  beforeEach(() => {
    editor = makeEditor();
  });

  afterEach(() => features?.destroy());

  it("provides cached document links and resolves a lazy target only on click", async () => {
    const source = { range: lspRange(0, 0, 4), data: 7 };
    const session = makeSession(
      (method, params) => {
        if (method === "textDocument/documentLink") return [source];
        if (method === "documentLink/resolve")
          return { ...params, target: "file:///C:/project/target.js" };
        return null;
      },
      { "textDocument/documentLink": { resolveProvider: true } },
    );
    const manager = makeManager(session);
    features = new DocumentFeatures(manager);

    const suggestion = await features.hyperclickProvider.getSuggestionForWord(editor, "link", {
      start: { row: 0, column: 0 },
      end: { row: 0, column: 4 },
    });
    await features.hyperclickProvider.getSuggestionForWord(editor, "link", [
      [0, 0],
      [0, 4],
    ]);

    expect(suggestion.range).toEqual([
      [0, 0],
      [0, 4],
    ]);
    expect(session.requests.map(({ method }) => method)).toEqual(["textDocument/documentLink"]);

    expect(await suggestion.callback()).toBe(true);
    expect(session.requests.map(({ method }) => method)).toEqual([
      "textDocument/documentLink",
      "documentLink/resolve",
    ]);
    expect(manager.showDocument).toHaveBeenCalledWith({
      uri: "file:///C:/project/target.js",
      takeFocus: true,
    });
  });

  for (const event of ["text", "path", "grammar", "destroy", "features"]) {
    it(`does not cache document links invalidated by ${event} while waiting for RPC`, async () => {
      const emitter = new Emitter();
      let resolve;
      let calls = 0;
      const pending = new Promise((done) => {
        resolve = done;
      });
      const source = { range: lspRange(0, 0, 4), target: "https://example.com" };
      const session = makeSession(() => (++calls === 1 ? pending : [source]));
      const manager = makeManager(session);
      editor.getBuffer = () => ({ onDidChangeText: (callback) => emitter.on("text", callback) });
      editor.onDidChangePath = (callback) => emitter.on("path", callback);
      editor.onDidChangeGrammar = (callback) => emitter.on("grammar", callback);
      editor.onDidDestroy = (callback) => emitter.on("destroy", callback);
      manager.onDidChangeFeatures = (callback) => emitter.on("features", callback);
      features = new DocumentFeatures(manager);
      try {
        const request = features.documentLinks(editor);
        await flushMicrotasks();
        emitter.emit(event);
        resolve([source]);
        expect(await request).toBeNull();
        expect(features.linkCaches.get(editor)).toBeUndefined();
        expect((await features.documentLinks(editor)).links).toEqual([source]);
        expect(calls).toBe(2);
      } finally {
        emitter.dispose();
      }
    });
  }

  it("does not follow a link after its source changes during lazy resolution", async () => {
    const emitter = new Emitter();
    let resolve;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const source = { range: lspRange(0, 0, 4), data: 7 };
    const session = makeSession(
      (method) => (method === "textDocument/documentLink" ? [source] : pending),
      { "textDocument/documentLink": { resolveProvider: true } },
    );
    const manager = makeManager(session);
    editor.getBuffer = () => ({ onDidChangeText: (callback) => emitter.on("text", callback) });
    features = new DocumentFeatures(manager);
    try {
      const suggestion = await features.documentLink(editor, [
        [0, 0],
        [0, 4],
      ]);
      const click = suggestion.callback();
      emitter.emit("text");
      resolve({ ...source, target: "file:///C:/project/target.js" });
      expect(await click).toBe(false);
      expect(manager.showDocument).not.toHaveBeenCalled();
      expect(await suggestion.callback()).toBe(false);
    } finally {
      emitter.dispose();
    }
  });

  it("declines links after destruction even if the server ignores disposal", async () => {
    let resolve;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const session = makeSession(() => pending);
    features = new DocumentFeatures(makeManager(session));
    const request = features.documentLinks(editor);
    await flushMicrotasks();
    features.destroy();
    resolve([{ range: lspRange(0, 0, 4), target: "https://example.com" }]);
    expect(await request).toBeNull();
    expect(await features.documentLinks(editor)).toBeNull();
  });

  it("does not hand an arbitrary server URI to an operating-system protocol handler", async () => {
    const session = makeSession(() => null);
    features = new DocumentFeatures(makeManager(session));
    spyOn(lumine.shell, "openExternal");

    expect(
      await features.followDocumentLink(
        session,
        { range: lspRange(0, 0, 4), target: "command:run-arbitrary-code" },
        false,
      ),
    ).toBe(false);
    expect(lumine.shell.openExternal).not.toHaveBeenCalled();
  });

  it("opens a mailto document link and reports shell failures", async () => {
    const session = makeSession(() => null);
    features = new DocumentFeatures(makeManager(session));
    const error = new Error("no mail client");
    spyOn(lumine.shell, "openExternal").and.rejectWith(error);
    spyOn(lumine.notifications, "addWarning");

    expect(
      await features.followDocumentLink(
        session,
        { range: lspRange(0, 0, 4), target: "mailto:issues@example.com" },
        false,
      ),
    ).toBe(false);
    expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
      "Unable to open the language server link.",
      { detail: error.message, dismissable: true },
    );
  });

  it("reports a failed lazy document-link resolution without rejecting the click", async () => {
    const session = makeSession(() => Promise.reject(new Error("link expired")));
    features = new DocumentFeatures(makeManager(session));
    const warning = spyOn(lumine.notifications, "addWarning");

    expect(await features.followDocumentLink(session, { data: 7 }, true)).toBe(false);
    expect(warning).toHaveBeenCalledWith("Language server request 'documentLink/resolve' failed.", {
      detail: "link expired",
      dismissable: true,
    });
  });

  it("folds every range returned by the active server", async () => {
    const session = makeSession((method) =>
      method === "textDocument/foldingRange"
        ? [
            { startLine: 1, endLine: 4 },
            { startLine: 6, startCharacter: 2, endLine: 8, endCharacter: 3 },
          ]
        : null,
    );
    features = new DocumentFeatures(makeManager(session));

    expect(await features.foldRanges(editor)).toBe(true);

    expect(editor.foldBufferRange.calls.allArgs()).toEqual([
      [
        [
          [1, Infinity],
          [4, Infinity],
        ],
      ],
      [
        [
          [6, 2],
          [8, 3],
        ],
      ],
    ]);
  });

  it("reports a command request failure without leaving an unhandled rejection", async () => {
    const session = makeSession(() => Promise.reject(new Error("server busy")));
    features = new DocumentFeatures(makeManager(session));
    const warning = spyOn(lumine.notifications, "addWarning");

    expect(await features.foldRanges(editor)).toBe(false);

    expect(warning).toHaveBeenCalledWith(
      "Language server request 'textDocument/foldingRange' failed.",
      {
        detail: "server busy",
        dismissable: true,
      },
    );
  });

  it("expands a selection to the next parent selection range", async () => {
    const session = makeSession((method) =>
      method === "textDocument/selectionRange"
        ? [
            {
              range: lspRange(0, 1, 3),
              parent: { range: lspRange(0, 0, 7) },
            },
          ]
        : null,
    );
    features = new DocumentFeatures(makeManager(session));

    expect(await features.expandSelectionRanges(editor)).toBe(true);

    expect(editor.setSelectedBufferRanges).toHaveBeenCalledWith(
      [
        [
          [0, 0],
          [0, 7],
        ],
      ],
      { autoscroll: true },
    );
  });

  it("selects every linked-editing range", async () => {
    const session = makeSession((method) =>
      method === "textDocument/linkedEditingRange"
        ? { ranges: [lspRange(0, 1, 3), lspRange(2, 4, 6)] }
        : null,
    );
    features = new DocumentFeatures(makeManager(session));

    expect(await features.selectLinkedRanges(editor)).toBe(true);

    expect(editor.setSelectedBufferRanges).toHaveBeenCalledWith(
      [C.rangeFromLsp(lspRange(0, 1, 3)), C.rangeFromLsp(lspRange(2, 4, 6))],
      { autoscroll: true },
    );
  });

  it("offers color presentations in a select list and applies the chosen edits", async () => {
    const color = { red: 1, green: 0, blue: 0, alpha: 1 };
    const info = { range: lspRange(0, 0, 4), color };
    const presentation = {
      label: "rgb(255 0 0)",
      textEdit: { range: info.range, newText: "rgb(255 0 0)" },
      additionalTextEdits: [{ range: lspRange(1, 0, 0), newText: "/* red */\n" }],
    };
    const session = makeSession((method) => {
      if (method === "textDocument/documentColor") return [info];
      if (method === "textDocument/colorPresentation") return [presentation];
      return null;
    });
    const manager = makeManager(session);
    let listOptions;
    const model = { update: jasmine.createSpy("update").and.resolveTo() };
    const host = {
      getModel: () => model,
      show: jasmine.createSpy("show"),
      destroy: jasmine.createSpy("destroy"),
    };
    spyOn(lumine.workspace, "addSelectList").and.callFake((options) => {
      listOptions = options;
      return host;
    });
    features = new DocumentFeatures(manager);

    expect(await features.colorPresentations(editor)).toBe(true);

    const item = model.update.calls.mostRecent().args[0].items[0];
    expect(item.presentation).toBe(presentation);
    expect(host.show).toHaveBeenCalled();
    await listOptions.commands["ide-client:apply-color-presentation"].didDispatch({
      detail: { item },
    });
    expect(manager.applyWorkspaceEdit).toHaveBeenCalledWith(
      {
        changes: {
          "file:///C:/project/file.js": [
            presentation.textEdit,
            ...presentation.additionalTextEdits,
          ],
        },
      },
      "Apply rgb(255 0 0)",
      session,
    );
  });
});
