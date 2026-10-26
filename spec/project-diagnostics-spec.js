const path = require("path");
const { Emitter, TextBuffer } = require("lumine");
const ProjectDiagnostics = require("../lib/project-diagnostics");
const C = require("../lib/converters");

describe("manual project diagnostics", () => {
  let manager,
    emitter,
    delegate,
    coordinator,
    session,
    editor,
    reports,
    enabled,
    filePath,
    uri,
    grammar;
  const message = (file, cell) => ({
    severity: "warning",
    excerpt: "Unused name",
    location: {
      file,
      position: [
        [0, 0],
        [0, 1],
      ],
      ...(cell == null ? {} : { cell }),
    },
  });
  const publish = async (diagnostics = [], version = 1) => {
    const entry = { session, uri, diagnostics, version };
    reports = [entry];
    emitter.emit("diagnostics", entry);
    await Promise.resolve();
  };

  beforeEach(() => {
    filePath = path.resolve("scan-project", "main.py");
    uri = C.pathToUri(filePath);
    emitter = new Emitter();
    grammar = { scopeName: "source.python" };
    editor = {
      getPath: () => filePath,
      getGrammar: () => grammar,
      isDestroyed: () => false,
      onDidDestroy: (fn) => emitter.on("editor-destroyed", fn),
      onDidChangePath: (fn) => emitter.on("editor-path", fn),
      onDidChangeGrammar: (fn) => emitter.on("editor-grammar", fn),
    };
    const adapter = { id: "ide-scan" };
    session = {
      adapter,
      state: "running",
      documents: new Map([[C.uriKey(uri), { editor, version: 1 }]]),
    };
    reports = [];
    enabled = true;
    manager = {
      adapters: new Map([[adapter.id, adapter]]),
      allDiagnostics: () => reports,
      featureEnabled: () => enabled,
      resolveUri: (value) => ({ kind: "file", path: C.uriToPath(value) }),
      onDidPublishDiagnostics: (fn) => emitter.on("diagnostics", fn),
      onDidChangeSession: (fn) => emitter.on("session", fn),
      onDidChangeFeatures: (fn) => emitter.on("features", fn),
      onDidChangeAdapters: (fn) => emitter.on("adapters", fn),
      onDidChangeCapabilities: (fn) => emitter.on("capabilities", fn),
      onDidChangeNotebook: (fn) => emitter.on("notebook", fn),
    };
    spyOn(lumine.workspace, "observeTextEditors").and.callFake((fn) => {
      fn(editor);
      return emitter.on("editor-added", fn);
    });
    spyOn(lumine.workspace, "getTextEditors").and.returnValue([editor]);
    delegate = { setAllMessages: jasmine.createSpy("setAllMessages") };
    coordinator = new ProjectDiagnostics(manager, "ide-scan", delegate);
  });

  afterEach(() => {
    coordinator.dispose();
    emitter.dispose();
  });

  it("keeps open-file findings until the server actually publishes", () => {
    const findings = [message(filePath)];
    coordinator.setAllMessages(findings, { showProjectView: true });
    expect(delegate.setAllMessages).toHaveBeenCalledWith(findings, { showProjectView: true });
  });

  it("withdraws cached scan results for None and restores them when its grammar returns", async () => {
    const findings = [message(filePath)];
    coordinator.setAllMessages(findings);
    const previous = grammar;
    grammar = lumine.grammars.nullGrammar;
    emitter.emit("editor-grammar");
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
    grammar = previous;
    emitter.emit("editor-grammar");
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual(findings);
  });

  it("yields only the reported document, including a clean server result", async () => {
    const other = message(path.resolve("scan-project", "closed.py"));
    coordinator.setAllMessages([message(filePath), other]);
    await publish();
    expect(delegate.setAllMessages.calls.mostRecent().args).toEqual([[other], undefined]);
  });

  it("uses already published reports when a scan finishes later", async () => {
    await publish();
    coordinator.setAllMessages([message(filePath)]);
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
  });

  it("does not yield to a malformed report", () => {
    reports = [{ session, uri, version: 1 }];
    const findings = [message(filePath)];
    coordinator.setAllMessages(findings);
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual(findings);
  });

  it("matches Windows path casing when the server spells a path differently", async () => {
    if (process.platform !== "win32") return;
    await publish();
    coordinator.setAllMessages([message(filePath.toUpperCase())]);
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
  });

  it("restores the complete scan when diagnostics are disabled", async () => {
    const findings = [message(filePath)];
    coordinator.setAllMessages(findings, { showProjectView: true });
    await publish();
    enabled = false;
    emitter.emit("features", { adapter: session.adapter });
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args).toEqual([findings, undefined]);
    enabled = true;
    emitter.emit("features", { adapter: session.adapter });
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
  });

  it("restores findings when the server fails or loses its registration", async () => {
    const findings = [message(filePath)];
    coordinator.setAllMessages(findings);
    await publish();
    session.state = "failed";
    emitter.emit("session", { session });
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual(findings);
    session.state = "running";
    manager.adapters.delete(session.adapter.id);
    emitter.emit("adapters", { adapter: session.adapter });
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual(findings);
  });

  it("does not yield to another adapter or an older document version", async () => {
    const findings = [message(filePath)];
    coordinator.setAllMessages(findings);
    await publish([], 0);
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual(findings);
    session.adapter = { id: "ide-other" };
    await publish();
    coordinator.setAllMessages(findings);
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual(findings);
  });

  it("restores findings after a document closes without reopening the project panel", async () => {
    const findings = [message(filePath)];
    coordinator.setAllMessages(findings, { showProjectView: true });
    await publish();
    emitter.emit("editor-destroyed");
    session.documents.clear();
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args).toEqual([findings, undefined]);
  });

  it("yields notebook cells individually while keeping cells the server has not analyzed", async () => {
    filePath = path.resolve("scan-project", "book.ipynb");
    manager.resolveUri = () => ({ kind: "cell", notebookPath: filePath, cellIndex: 2 });
    const first = message(filePath, 1);
    const third = message(filePath, 3);
    coordinator.setAllMessages([first, third]);
    await publish();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([first]);
  });

  const notebook = (cells) => {
    filePath = path.resolve("scan-project", "book.ipynb");
    const record = { filePath, cells, cellText: (cell) => cell.text };
    manager.notebookDocuments = { records: new Set([record]) };
    return record;
  };
  const notebookSource = (cells) =>
    JSON.stringify({
      cells: cells.map((cell) => ({
        id: cell.id,
        cell_type: cell.kind === "code" ? "code" : "markdown",
        source: [cell.text],
      })),
    });

  it("rejects saved notebook findings when the open notebook already differs", () => {
    const cells = [{ id: "code-a", kind: "code", text: "missing_name" }];
    const record = notebook(cells);
    const snapshot = notebookSource(cells);
    record.cells = [{ id: "markdown", kind: "markup", text: "heading" }, ...cells];
    coordinator.setAllMessages([message(filePath, 1)], undefined, new Map([[filePath, snapshot]]));
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
  });

  it("invalidates notebook findings on reorder without needing a live server", async () => {
    const cells = [
      { id: "code-a", kind: "code", text: "missing_name" },
      { id: "markdown", kind: "markup", text: "heading" },
    ];
    const record = notebook(cells);
    coordinator.setAllMessages(
      [message(filePath, 1)],
      undefined,
      new Map([[filePath, notebookSource(cells)]]),
    );
    expect(delegate.setAllMessages.calls.mostRecent().args[0].length).toBe(1);
    record.cells = cells.toReversed();
    emitter.emit("notebook", { record });
    // A service edge can disappear in this turn, before the UI refresh runs.
    expect(coordinator.getMessages()).toEqual([]);
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
    manager.notebookDocuments.records.clear();
    enabled = false;
    emitter.emit("features", { adapter: session.adapter });
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
  });

  it("invalidates notebook findings after an unsaved cell edit", async () => {
    const cells = [{ id: "code-a", kind: "code", text: "missing_name" }];
    const record = notebook(cells);
    coordinator.setAllMessages(
      [message(filePath, 1)],
      undefined,
      new Map([[filePath, notebookSource(cells)]]),
    );
    record.cells[0].text = "fixed_name";
    emitter.emit("notebook", { record });
    await Promise.resolve();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
  });

  it("returns valid full scan findings even while the live server owns their display", async () => {
    const findings = [message(filePath)];
    coordinator.setAllMessages(findings);
    await publish();
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
    expect(coordinator.getMessages()).toEqual(findings);
  });

  it("tracks immutable giant cell sources without legacy strings or JSON signatures", () => {
    let source = TextBuffer.createTextSnapshot("x".repeat(65536));
    for (let i = 0; i < 14; i++) source = source.replace(source.length, source.length, source);
    const cell = {
      id: "large",
      kind: "code",
      textSource: source,
      get text() {
        throw new Error("Legacy cell text");
      },
    };
    const record = notebook([cell]);
    spyOn(record, "cellText").and.throwError("Full cell materialization");
    const findings = [message(filePath, 1)];
    coordinator.setAllMessages(findings);
    cell.textSource = source.replace(0, 1, "x");
    expect(coordinator.getMessages()).toEqual(findings);
    cell.textSource = source.replace(0, 1, "y");
    expect(coordinator.getMessages()).toEqual([]);
    expect(record.cellText).not.toHaveBeenCalled();
    expect(coordinator.notebookRecords.size).toBe(0);
  });

  it("invalidates a small saved cell after its mounted buffer grows beyond string limits", () => {
    const cellBuffer = new TextBuffer("small");
    let source = TextBuffer.createTextSnapshot("x".repeat(65536));
    for (let i = 0; i < 14; i++) source = source.replace(source.length, source.length, source);
    const cellEditor = {
      getBuffer: () => cellBuffer,
      getGrammar: () => grammar,
      getText: jasmine.createSpy("getText").and.throwError("Whole mounted cell"),
    };
    const cells = [{ id: "mounted", kind: "code", editor: cellEditor, text: "obsolete" }];
    const record = notebook(cells);
    spyOn(record, "cellText").and.throwError("Legacy cell getter");
    const saved = notebookSource([{ id: "mounted", kind: "code", text: "small" }]);
    try {
      coordinator.setAllMessages([message(filePath, 1)], undefined, new Map([[filePath, saved]]));
      expect(coordinator.getMessages().length).toBe(1);
      cellBuffer.setTextInRange(cellBuffer.getRange(), source);
      expect(coordinator.getMessages()).toEqual([]);
      expect(cellEditor.getText).not.toHaveBeenCalled();
      expect(record.cellText).not.toHaveBeenCalled();
      expect(coordinator.parsedNotebookSnapshots.size).toBe(0);
    } finally {
      cellBuffer.destroy();
    }
  });

  it("parses each saved JSON once and compares array sources without joining them", () => {
    const text = "a\r\n😀";
    notebook([
      { id: "a", kind: "code", textSource: TextBuffer.createTextSnapshot(text) },
      { id: "empty", kind: "markup", text: "" },
    ]);
    const saved = JSON.stringify({
      cells: [
        { id: "a", cell_type: "code", source: ["a\r", "\n", "\ud83d", "\ude00"] },
        { id: "empty", cell_type: "markdown", source: [] },
      ],
    });
    const parsed = JSON.parse(saved);
    parsed.cells[0].source.join = () => {
      throw new Error("Never join complete saved cells");
    };
    const parse = JSON.parse;
    let calls = 0;
    spyOn(JSON, "parse").and.callFake((value, ...args) => {
      if (value === saved) {
        calls++;
        return parsed;
      }
      return parse(value, ...args);
    });
    const findings = [message(filePath, 1)];
    coordinator.setAllMessages(findings, undefined, new Map([[filePath, saved]]));
    expect(coordinator.getMessages()).toEqual(findings);
    expect(coordinator.getMessages()).toEqual(findings);
    expect(calls).toBe(1);
  });

  it("keeps identity, kind, order and count in source-backed freshness checks", () => {
    const source = TextBuffer.createTextSnapshot("same");
    const original = [
      { id: "a", kind: "code", textSource: source },
      { id: "b", kind: "markup", textSource: source },
    ];
    const record = notebook(original);
    for (const changed of [
      [...original, { id: "c", kind: "code", textSource: source }],
      original.toReversed(),
      [{ ...original[0], id: "other" }, original[1]],
      [{ ...original[0], kind: "markup" }, original[1]],
    ]) {
      record.cells = original;
      coordinator.setAllMessages([message(filePath, 1)]);
      record.cells = changed;
      expect(coordinator.getMessages()).toEqual([]);
    }
  });

  it("does not stringify changed opaque sources beyond their legacy comparison budget", () => {
    const toString = jasmine.createSpy("toString").and.throwError("Opaque huge source");
    const cell = {
      id: "opaque",
      kind: "code",
      textSource: Object.freeze({ length: 1024 * 1024 * 1024, toString }),
    };
    notebook([cell]);
    const findings = [message(filePath, 1)];
    coordinator.setAllMessages(findings);
    expect(coordinator.getMessages()).toEqual(findings);
    cell.textSource = Object.freeze({ length: 1024 * 1024 * 1024, toString });
    expect(coordinator.getMessages()).toEqual([]);
    expect(toString).not.toHaveBeenCalled();
  });

  it("releases cached roots when a notebook record disappears", () => {
    const record = notebook([
      { id: "a", kind: "code", textSource: TextBuffer.createTextSnapshot("same") },
    ]);
    const findings = [message(filePath, 1)];
    coordinator.setAllMessages(findings);
    expect(coordinator.notebookRecords.has(record)).toBe(true);
    manager.notebookDocuments.records.clear();
    expect(coordinator.getMessages()).toEqual(findings);
    expect(coordinator.notebookRecords.size).toBe(0);
  });

  it("leaves the caller's delegate alive and cancels queued refreshes on disposal", async () => {
    coordinator.setAllMessages([message(filePath)]);
    emitter.emit("features", { adapter: session.adapter });
    coordinator.dispose();
    delegate.setAllMessages.calls.reset();
    await Promise.resolve();
    expect(delegate.setAllMessages).not.toHaveBeenCalled();
  });
});
