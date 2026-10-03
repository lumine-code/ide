const path = require("path");
const { Emitter } = require("lumine");
const ProjectDiagnostics = require("../lib/project-diagnostics");
const C = require("../lib/converters");

describe("manual project diagnostics", () => {
  let manager, emitter, delegate, coordinator, session, editor, reports, enabled, filePath, uri;
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
    editor = {
      isDestroyed: () => false,
      onDidDestroy: (fn) => emitter.on("editor-destroyed", fn),
      onDidChangePath: (fn) => emitter.on("editor-path", fn),
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
    };
    spyOn(lumine.workspace, "observeTextEditors").and.callFake((fn) => {
      fn(editor);
      return emitter.on("editor-added", fn);
    });
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

  it("leaves the caller's delegate alive and cancels queued refreshes on disposal", async () => {
    coordinator.setAllMessages([message(filePath)]);
    emitter.emit("features", { adapter: session.adapter });
    coordinator.dispose();
    delegate.setAllMessages.calls.reset();
    await Promise.resolve();
    expect(delegate.setAllMessages).not.toHaveBeenCalled();
  });
});
