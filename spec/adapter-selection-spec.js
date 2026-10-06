const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { selectAdapters } = require("../lib/adapter-selection");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
describe("exclusive adapter selection", () => {
  it("keeps ungrouped peers and deterministically selects by preference, priority and ID", () => {
    const a = { id: "a", exclusiveGroup: "engine" },
      b = { id: "b", exclusiveGroup: "engine", selectionPriority: 1 },
      linter = { id: "lint" },
      other = { id: "other", exclusiveGroup: "other" };
    expect(selectAdapters([a, linter, b, other])).toEqual([linter, b, other]);
    expect(selectAdapters([a, linter, b, other], ["missing", "a", "b"])).toEqual([
      a,
      linter,
      other,
    ]);
    expect(
      selectAdapters([b, a].map((item) => ({ ...item, selectionPriority: 0 }))).map(
        (item) => item.id,
      ),
    ).toEqual(["a"]);
  });
});
describe("exclusive adapter controller lifecycle", () => {
  let manager, Session, root, editor, editors, starts;
  const makeAdapter = (id, priority = 0, selector) => ({
    id,
    displayName: id,
    grammarScopes: ["source.test"],
    exclusiveGroup: "engine",
    selectionPriority: priority,
    ...(selector ? { documentSelector: [{ scheme: "file", pattern: selector }] } : {}),
    resolveServer: jasmine.createSpy(id + ".resolve").and.resolveTo({ command: id }),
  });
  beforeEach(() => {
    const Manager = require("../lib/language-server-manager");
    Session = require("../lib/server-session");
    manager = new Manager();
    root = path.resolve("exclusive-adapter-project");
    editor = {
      getPath: () => path.join(root, "main.test"),
      getGrammar: () => ({ scopeName: "source.test" }),
    };
    editors = [editor];
    spyOn(lumine.workspace, "getTextEditors").and.callFake(() => editors);
    spyOn(lumine.project, "getPaths").and.returnValue([root]);
    spyOn(manager, "reattachAll").and.resolveTo();
    starts = spyOn(Session.prototype, "start").and.callFake(async function () {
      this.state = "running";
    });
    spyOn(Session.prototype, "stop").and.callFake(async function () {
      this.state = "stopped";
      this.processExited = true;
      manager.didExitProcess(this);
    });
  });
  afterEach(async () => {
    for (const session of manager.knownSessions()) {
      session.processExited = true;
      manager.didExitProcess(session);
    }
    await manager.deactivate();
    lumine.config.unset("ide.preferredServers");
  });
  it("validates group and finite priority fields", () => {
    expect(() =>
      manager.registerAdapter({ ...makeAdapter("bad"), exclusiveGroup: " " }),
    ).toThrowError(/exclusiveGroup/);
    expect(() =>
      manager.registerAdapter({ ...makeAdapter("bad"), selectionPriority: NaN }),
    ).toThrowError(/selectionPriority/);
    expect(() =>
      manager.registerAdapter({ ...makeAdapter("bad"), prepareRequest: true }),
    ).toThrowError(/prepareRequest/);
    expect(() =>
      manager.registerAdapter({ ...makeAdapter("bad"), getDocumentationCodeBlockProjection: true }),
    ).toThrowError(/getDocumentationCodeBlockProjection/);
  });
  it("replaces the default, honors preference and falls back when the winner unregisters", async () => {
    const a = makeAdapter("a"),
      b = makeAdapter("b", 1);
    manager.registerAdapter(a);
    const first = await manager.ensureSession(a, root, { editor });
    manager.registerAdapter(b);
    const second = await manager.ensureSession(b, root, { editor });
    expect(first.state).toBe("stopped");
    expect(manager.adaptersForEditor(editor)).toEqual([b]);
    expect(await manager.ensureSession(a, root, { editor })).toBeNull();
    lumine.config.set("ide.preferredServers", ["a"]);
    manager.adapterSelectionChanged();
    const third = await manager.ensureSession(a, root, { editor });
    expect(second.state).toBe("stopped");
    expect(third.adapter).toBe(a);
    await manager.unregisterAdapter(a);
    expect(manager.adaptersForEditor(editor)).toEqual([b]);
    expect((await manager.ensureSession(b, root, { editor })).adapter).toBe(b);
  });
  it("waits for physical exit after a failed stop before resolving or starting the winner", async () => {
    const a = makeAdapter("a"),
      b = makeAdapter("b", 1);
    manager.registerAdapter(a);
    const old = await manager.ensureSession(a, root, { editor }),
      stopping = deferred();
    old.process = { exitCode: null, signalCode: null };
    old.processExited = false;
    old.stop = () => stopping.promise;
    spyOn(console, "error");
    manager.registerAdapter(b);
    const replacing = manager.ensureSession(b, root, { editor });
    await flush();
    expect(b.resolveServer).not.toHaveBeenCalled();
    expect(starts.calls.count()).toBe(1);
    old.state = "stopped";
    stopping.reject(new Error("The old child survived shutdown"));
    await flush();
    expect(b.resolveServer).not.toHaveBeenCalled();
    old.processExited = true;
    manager.didExitProcess(old);
    expect((await replacing).adapter).toBe(b);
    expect(starts.calls.count()).toBe(2);
  });
  it("cancels a superseded pending resolver without publishing or spawning it", async () => {
    const resolution = deferred(),
      a = makeAdapter("a"),
      b = makeAdapter("b", 1);
    a.resolveServer.and.returnValue(resolution.promise);
    manager.registerAdapter(a);
    const first = manager.ensureSession(a, root, { editor });
    await flush();
    expect(a.resolveServer).toHaveBeenCalled();
    manager.registerAdapter(b);
    const replacement = await manager.ensureSession(b, root, { editor });
    resolution.resolve({ command: "obsolete" });
    expect(await first).toBeNull();
    expect(replacement.adapter).toBe(b);
    expect(starts.calls.count()).toBe(1);
    expect(manager.allSessions()).toEqual([replacement]);
  });
  it("retains same-group servers for disjoint selectors and independent ungrouped peers", async () => {
    const a = makeAdapter("a", 0, "**/*.a"),
      b = makeAdapter("b", 1, "**/*.b"),
      linter = { ...makeAdapter("lint"), exclusiveGroup: undefined };
    const first = { ...editor, getPath: () => path.join(root, "main.a") },
      second = { ...editor, getPath: () => path.join(root, "main.b") };
    editors = [first, second];
    for (const adapter of [a, b, linter]) manager.registerAdapter(adapter);
    const one = await manager.ensureSession(a, root, { editor: first }),
      two = await manager.ensureSession(b, root, { editor: second });
    expect(one.state).toBe("running");
    expect(two.state).toBe("running");
    expect(manager.adaptersForEditor(first)).toEqual([a, linter]);
    expect(manager.adaptersForEditor(second)).toEqual([b, linter]);
    manager.adapterSelectionChanged();
    expect(manager.allSessions()).toEqual([one, two]);
  });
  it("does not quarantine a different project route behind a retired child", async () => {
    const a = makeAdapter("a"),
      b = makeAdapter("b", 1);
    manager.registerAdapter(a);
    const old = await manager.ensureSession(a, root, { editor });
    old.process = { exitCode: null, signalCode: null };
    old.processExited = false;
    old.stop = async () => {
      old.state = "stopped";
    };
    manager.registerAdapter(b);
    const otherRoot = path.resolve("exclusive-other-project"),
      otherEditor = { ...editor, getPath: () => path.join(otherRoot, "main.test") };
    editors = [editor, otherEditor];
    lumine.project.getPaths.and.returnValue([root, otherRoot]);
    expect((await manager.ensureSession(b, otherRoot, { editor: otherEditor })).adapter).toBe(b);
    expect(old.processExited).toBe(false);
  });
  it("detaches only a losing overlapping document and clears its diagnostics on a retained controller", async () => {
    const a = makeAdapter("a", 0, "**/*.{a,shared}"),
      b = makeAdapter("b", 1, "**/*.{b,shared}");
    const onlyA = { ...editor, getPath: () => path.join(root, "main.a") },
      shared = { ...editor, getPath: () => path.join(root, "main.shared") };
    editors = [onlyA, shared];
    manager.registerAdapter(a);
    const session = await manager.ensureSession(a, root, { editor: onlyA }),
      uri = pathToFileURL(shared.getPath()).href;
    session.documents.set(uri, { uri, editor: shared });
    session.detachEditor = jasmine.createSpy("detach").and.callFake((editor) => {
      for (const [key, doc] of session.documents)
        if (doc.editor === editor) session.documents.delete(key);
    });
    manager.publishDiagnostics(session, { uri, diagnostics: [{ message: "old engine" }] }, true);
    const reports = [],
      subscription = manager.onDidPublishDiagnostics((report) => reports.push(report));
    manager.registerAdapter(b);
    expect(session.state).toBe("running");
    expect(session.detachEditor).toHaveBeenCalledWith(shared);
    expect(manager.diagnosticsFor(session, uri)).toEqual([]);
    expect(reports.some((report) => report.uri === uri && report.diagnostics.length === 0)).toBe(
      true,
    );
    expect(
      manager.publishDiagnostics(
        session,
        { uri, diagnostics: [{ message: "late old engine" }] },
        true,
      ),
    ).toBe(false);
    expect(manager.adaptersForEditor(onlyA)).toEqual([a]);
    expect(manager.adaptersForEditor(shared)).toEqual([b]);
    subscription.dispose();
  });
});
