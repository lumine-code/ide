const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Point, Range } = require("lumine");
const InlineCompletionProvider = require("../lib/inline-completion-provider");
const Manager = require("../lib/language-server-manager");
const Session = require("../lib/server-session");

const METHOD = "textDocument/inlineCompletion";
const COMMAND = { title: "Record acceptance", command: "fixture.inlineAccepted" };
const inlineRange = (start, end, endLine = 0) => ({
  start: { line: 0, character: start },
  end: { line: endLine, character: end },
});

describe("Language-server inline completion edit mapping", () => {
  let root, manager, provider, session, editor;

  beforeEach(async () => {
    jasmine.useRealClock();
    const grammar = await lumine.packages.activatePackage("language-text");
    await grammar.resourceLoadPromise;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-inline-completion-"));
    const file = path.join(root, "source.txt");
    fs.writeFileSync(file, "!!hel");
    editor = await lumine.workspace.open(file);
    manager = new Manager();
    provider = new InlineCompletionProvider(manager);
  });

  afterEach(async () => {
    provider?.dispose();
    await session?.stop();
    await manager?.deactivate();
    editor?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (root)
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    root = manager = provider = session = editor = null;
  });

  async function start(items, adapterOptions = {}) {
    session = new Session(
      manager,
      {
        id: "inline-completion-fixture",
        displayName: "Inline Completion Fixture",
        grammarScopes: ["text.plain"],
        ...adapterOptions,
      },
      root,
      {
        command: process.execPath,
        args: [
          path.join(__dirname, "fixtures", "fake-server.js"),
          JSON.stringify({
            capabilities: {
              textDocumentSync: 2,
              inlineCompletionProvider: { workDoneProgress: true },
              executeCommandProvider: { commands: [COMMAND.command] },
            },
            responses: { [METHOD]: { items } },
          }),
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        transport: "stdio",
      },
    );
    await session.start();
    await session.openEditor(editor);
    spyOn(manager, "activeSessionForFeature").and.resolveTo(session);
  }

  const request = (options) =>
    provider.getInlineCompletions({
      editor,
      bufferPosition: [0, 5],
      triggerKind: "automatic",
      ...options,
    });

  it("maps editable ranges and snippets through the original projection", async () => {
    const snippet = "hello(${1:name})$0";
    await start(
      [
        { insertText: "hello()", range: inlineRange(0, 3), filterText: "hello" },
        { insertText: { kind: "snippet", value: snippet }, range: inlineRange(0, 3) },
        { insertText: "helloDefault()" },
        { insertText: "insertAtCaret()" },
        { insertText: "multiline range", range: inlineRange(0, 0, 1) },
        { insertText: "reversed range", range: inlineRange(4, 2) },
        { insertText: "protected range", range: inlineRange(0, 4) },
      ],
      {
        getDocumentProjection(item) {
          const source = item.getText();
          const shift = (point, columns) => new Point(point.row, point.column + columns);
          const shiftRange = (range, columns) =>
            new Range(shift(range.start, columns), shift(range.end, columns));
          return {
            source,
            text: source.slice(2),
            isCurrent: () => source === item.getText(),
            ownsPosition: (point) => point.row === 0 && point.column >= 2,
            toServerPosition: (point) => shift(point, -2),
            toServerRange: (range) => shiftRange(range, -2),
            mapEdits: (edits) => {
              const [edit] = edits;
              if (edit.oldRange.end.column > 3) return null;
              return [{ oldRange: shiftRange(edit.oldRange, 2), newText: edit.newText }];
            },
          };
        },
      },
    );
    const range = new Range([0, 2], [0, 5]);
    const suggestions = await request();
    expect(suggestions.map(({ isApplicable: _isApplicable, ...item }) => item)).toEqual([
      { text: "hello()", range, filterText: "hello" },
      { text: snippet, snippet, range },
      { text: "helloDefault()", range },
      { text: "insertAtCaret()", range: new Range([0, 5], [0, 5]) },
    ]);
    expect(suggestions.every((item) => item.isApplicable())).toBeTrue();
    const wire = (await session.request("test/getReceived")).find(
      ({ method }) => method === METHOD,
    );
    expect(wire.params.position).toEqual({ line: 0, character: 3 });
    expect(wire.params.context).toEqual({ triggerKind: 2 });
    expect(wire.params.workDoneToken).toBeDefined();
    editor.setText("!!changed");
    expect(suggestions.some((item) => item.isApplicable())).toBeFalse();
  });

  it("discards the acceptance command when the owning document has reopened", async () => {
    await start([{ insertText: "hello()", range: inlineRange(2, 5), command: COMMAND }]);
    const [completion] = await request({ triggerKind: "invoked" });
    expect(completion.didAccept).toEqual(jasmine.any(Function));
    expect(completion.isApplicable()).toBeTrue();
    const uri = manager.uriForEditor(editor);
    session.closeDocument(uri);
    await session.openEditor(editor);
    expect(completion.isApplicable()).toBeFalse();
    await completion.didAccept();
    const traffic = await session.request("test/getReceived");
    expect(traffic.some(({ method }) => method === "workspace/executeCommand")).toBeFalse();
  });
});
