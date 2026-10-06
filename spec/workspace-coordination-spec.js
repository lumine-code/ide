const path = require("node:path");
const WorkspaceDocuments = require("../lib/workspace-documents");
const WorkspaceFileOperations = require("../lib/workspace-file-operations");
const C = require("../lib/converters");

const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => (resolve = complete));
  return { promise, resolve };
};

const editorStub = () => ({
  getPath: () => undefined,
  getGrammar: () => ({ fileTypes: ["py"] }),
  isDestroyed: () => false,
});

const bindingFor = (editor, name = "first") => {
  const filePath = path.resolve("coordination-fixture", `${name}.ipynb`);
  return {
    editor,
    uri: C.cellUri(filePath, "cell"),
    cellId: "cell",
    record: { filePath, cellIndexOf: () => 0 },
  };
};

describe("Workspace document binding ownership", () => {
  let documents;

  beforeEach(() => {
    documents = new WorkspaceDocuments({ reattachEditor: jasmine.createSpy("reattachEditor") });
  });

  afterEach(() => documents.dispose());

  it("removes the previous URI when the same editor changes document identity", () => {
    const editor = editorStub();
    const first = bindingFor(editor, "first");
    const second = bindingFor(editor, "second");
    documents.bind(editor, first);
    documents.bind(editor, second);

    expect(documents.resolveUri(first.uri)).toBeNull();
    expect(documents.bindingFor(editor)).toBe(second);
    expect(documents.resolveUri(second.uri).record).toBe(second.record);
  });

  it("preserves a newer URI binding when an older editor is unbound", () => {
    const oldEditor = editorStub();
    const newEditor = editorStub();
    const oldBinding = bindingFor(oldEditor);
    const newBinding = { ...oldBinding, editor: newEditor, record: { ...oldBinding.record } };
    documents.bind(oldEditor, oldBinding);
    documents.bind(newEditor, newBinding);
    documents.unbind(oldEditor);

    expect(documents.bindingFor(oldEditor)).toBeNull();
    expect(documents.bindingForUri(newBinding.uri)).toBe(newBinding);
    expect(documents.resolveUri(newBinding.uri).editor).toBe(newEditor);
  });

  it("keeps the primary editor's URI when a secondary view is unbound", () => {
    const primary = editorStub();
    const secondary = editorStub();
    const binding = bindingFor(primary);
    documents.bind(primary, binding);
    documents.bind(secondary, binding);
    documents.unbind(secondary);

    expect(documents.bindingFor(primary)).toBe(binding);
    expect(documents.bindingFor(secondary)).toBeNull();
    expect(documents.resolveUri(binding.uri)?.editor).toBe(primary);
  });

  it("resolves a surviving secondary view after the primary editor is unbound", () => {
    const primary = editorStub();
    const secondary = editorStub();
    const binding = bindingFor(primary);
    documents.bind(primary, binding);
    documents.bind(secondary, binding);
    documents.unbind(primary);

    expect(documents.bindingFor(primary)).toBeNull();
    expect(documents.bindingFor(secondary)).toBe(binding);
    expect(documents.resolveUri(binding.uri)?.editor).toBe(secondary);
    expect(documents.uriForEditor(secondary)).toBe(binding.uri);
  });

  it("does not let an old editorless notebook record remove its replacement", () => {
    const oldBinding = bindingFor(null);
    const newBinding = { ...oldBinding, record: { ...oldBinding.record } };
    documents.bindUri(oldBinding);
    documents.bindUri(newBinding);
    documents.unbindUri(oldBinding.uri, oldBinding.record);

    expect(documents.bindingForUri(newBinding.uri)).toBe(newBinding);
    expect(documents.resolveUri(newBinding.uri).record).toBe(newBinding.record);
  });

  it("ignores editor and URI registrations after disposal", () => {
    const editor = editorStub();
    const binding = bindingFor(editor);
    documents.dispose();
    documents.bind(editor, binding);
    documents.bindUri(bindingFor(null, "late"));

    expect(documents.bindingFor(editor)).toBeNull();
    expect(documents.resolveUri(binding.uri)).toBeNull();
    expect([...documents.externalBindings()]).toEqual([]);
  });
});

describe("Workspace file-operation lifecycle coordination", () => {
  let operations, documents, host, session;
  const filePath = path.resolve("coordination-fixture", "main.js");

  const lifecycleExecutor = () => {
    const will = new Set();
    const did = new Set();
    return {
      will,
      did,
      onWillExecuteStep(callback) {
        will.add(callback);
        return { dispose: () => will.delete(callback) };
      },
      onDidExecuteStep(callback) {
        did.add(callback);
        return { dispose: () => did.delete(callback) };
      },
      emitWill(event) {
        for (const callback of will) callback(event);
      },
      async emitDid(event) {
        await Promise.all([...did].map((callback) => callback(event)));
      },
    };
  };

  beforeEach(() => {
    documents = {
      snapshotsForOperation: () => [],
      suppressPathChanges: jasmine.createSpy("suppressPathChanges"),
      releasePaths: jasmine.createSpy("releasePaths"),
      pathsAfterEffects: () => new Map(),
      stabilizePaths: async () => {},
      reattachPaths: jasmine.createSpy("reattachPaths").and.resolveTo(),
    };
    session = {
      state: "running",
      adapter: { fileWatchers: [{ globPattern: "**/*.js" }] },
      capabilities: {
        workspace: {
          fileOperations: { didCreate: { filters: [{ pattern: { glob: "**/*.js" } }] } },
        },
      },
      notify: jasmine.createSpy("notify"),
    };
    host = {
      sessions: () => [session],
      dynamicCapabilities: () => new Map(),
      foldersFor: () => [path.dirname(filePath)],
      globMatches: () => true,
      invalidateScopes: jasmine.createSpy("invalidateScopes"),
      log: jasmine.createSpy("log"),
    };
    operations = new WorkspaceFileOperations({ documents, host });
  });

  afterEach(() => operations.dispose());

  it("does not publish or rebuild lifecycle state after disposal during watcher stabilization", async () => {
    const stabilization = deferred();
    const entered = deferred();
    documents.stabilizePaths = async () => {
      entered.resolve();
      await stabilization.promise;
    };
    const executor = lifecycleExecutor();
    operations.setExecutor(executor);
    executor.emitWill({ id: 1, operation: { kind: "create", path: filePath } });
    const finishing = executor.emitDid({
      id: 1,
      result: { status: "applied", effects: [{ kind: "create", path: filePath }] },
      eventTrace: { internalRoots: [{ path: path.resolve("coordination-fixture", ".private") }] },
    });
    await entered.promise;
    operations.dispose();
    stabilization.resolve();
    await finishing;

    expect(session.notify).not.toHaveBeenCalled();
    expect(operations.executionGates.size).toBe(0);
    expect(operations.completedGates).toEqual([]);
    expect(operations.internalRoots).toEqual([]);
    expect(documents.reattachPaths).not.toHaveBeenCalled();
  });

  it("keeps identical step IDs from different executor generations independent", async () => {
    const first = lifecycleExecutor();
    const second = lifecycleExecutor();
    operations.setExecutor(first);
    first.emitWill({ id: 1, operation: { kind: "create", path: filePath } });
    operations.setExecutor(second);
    second.emitWill({ id: 1, operation: { kind: "create", path: filePath } });

    expect(operations.executionGates.size).toBe(2);
    expect(first.will.size).toBe(1);
    await first.emitDid({ id: 1, result: { status: "skipped", effects: [] } });

    expect(operations.executionGates.size).toBe(1);
    expect(first.will.size).toBe(0);
    expect(first.did.size).toBe(0);
    expect(second.will.size).toBe(1);
    await second.emitDid({ id: 1, result: { status: "skipped", effects: [] } });
    expect(operations.executionGates.size).toBe(0);
  });

  it("ignores a lifecycle callback captured before another listener disposes it", () => {
    const executor = lifecycleExecutor();
    operations.setExecutor(executor);
    const captured = [...executor.will][0];
    operations.dispose();
    captured({ id: 1, operation: { kind: "create", path: filePath } });

    expect(operations.executionGates.size).toBe(0);
    expect(documents.suppressPathChanges).not.toHaveBeenCalled();
  });

  it("attributes reverse-order concurrent completions to their requesting plans", async () => {
    const executor = lifecycleExecutor();
    operations.setExecutor(executor);
    const firstOperation = { kind: "create", path: filePath };
    const secondOperation = {
      kind: "create",
      path: path.resolve("coordination-fixture", "second.js"),
    };
    documents.snapshotsForOperation = (operation) => [{ operation }];
    documents.pathsAfterEffects = (_effects, snapshots) => {
      if (snapshots[0].operation === firstOperation) throw new Error("first coordination failed");
      return new Map();
    };
    const firstCompletion = deferred();
    const secondCompletion = deferred();
    const stepPlan = (id, operation, completion) => ({
      async executeNext() {
        executor.emitWill({ id, operation });
        await completion.promise;
        const result = { status: "skipped", effects: [] };
        await executor.emitDid({ id, result });
        return result;
      },
    });
    const first = operations.executeStep(
      {
        fileOperationsExecutor: executor,
        filePlan: stepPlan(1, firstOperation, firstCompletion),
      },
      { operation: firstOperation },
    );
    const second = operations.executeStep(
      {
        fileOperationsExecutor: executor,
        filePlan: stepPlan(2, secondOperation, secondCompletion),
      },
      { operation: secondOperation },
    );
    secondCompletion.resolve();
    await expectAsync(second).toBeResolvedTo({ status: "skipped", effects: [] });
    firstCompletion.resolve();
    await expectAsync(first).toBeRejectedWithError("first coordination failed");
    expect(operations.executionRequests).toEqual([]);
    expect(operations.executionGates.size).toBe(0);
  });

  it("does not associate a reentrant guard's unrelated step with the requesting plan", async () => {
    const executor = lifecycleExecutor();
    operations.setExecutor(executor);
    const ownOperation = { kind: "create", path: filePath };
    const externalOperation = {
      kind: "create",
      path: path.resolve("coordination-fixture", "other.js"),
    };
    documents.snapshotsForOperation = (operation) => [{ operation }];
    documents.pathsAfterEffects = (_effects, snapshots) => {
      if (snapshots[0].operation === externalOperation)
        throw new Error("external coordination failed");
      return new Map();
    };
    spyOn(console, "error");
    const stepPlan = (id, operation) => ({
      async executeNext() {
        executor.emitWill({ id, operation });
        const result = { status: "skipped", effects: [] };
        await executor.emitDid({ id, result });
        return result;
      },
    });
    let external;
    const own = operations.executeStep(
      { fileOperationsExecutor: executor, filePlan: stepPlan(2, ownOperation) },
      { operation: ownOperation },
      { beforeMutation: () => (external = stepPlan(1, externalOperation).executeNext()) },
    );

    await expectAsync(own).toBeResolvedTo({ status: "skipped", effects: [] });
    await external;
    expect(operations.executionRequests).toEqual([]);
    expect(operations.executionGates.size).toBe(0);
  });
});
