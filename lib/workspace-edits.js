const path = require("node:path");
const { Range } = require("lumine");
const C = require("./converters");
const { pathKey, relativePath } = require("./workspace-paths");

module.exports = class WorkspaceEdits {
  constructor({ documents, fileOperations, log }) {
    this.documents = documents;
    this.fileOperations = fileOperations;
    this.log = log;
    this.disposed = false;
    this.controller = new AbortController();
    this.plans = new Set();
    this.planStates = new WeakMap();
    this.planControllers = new WeakMap();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort(new DOMException("Workspace edit service was disposed.", "AbortError"));
    for (const plan of this.plans) this.disposePlan(plan);
  }
  disposePlan(plan) {
    if (!plan || this.planStates.get(plan) === "disposed") return;
    this.planStates.set(plan, "disposed");
    this.planControllers
      .get(plan)
      ?.abort(new DOMException("Workspace edit plan was disposed.", "AbortError"));
    this.plans.delete(plan);
    this.disposeFileOperationPlan(plan.filePlan);
    this.disposeWorkspaceEditDocumentStates(plan.documentStates);
    this.disposeEditorSnapshots(plan.editorSnapshots);
    this.disposeSessionSubscriptions(plan.sessionSubscriptions);
  }
  claimPlan(plan) {
    this.assertWorkspaceEditCurrent();
    if (this.planStates.get(plan) !== "prepared")
      throw new Error("Workspace edit plan has already been consumed or disposed.");
    this.planStates.set(plan, "applying");
  }
  workspaceEditOptions(options = {}, plan = null) {
    const signals = [this.controller.signal];
    if (options.signal) signals.push(options.signal);
    const planController = this.planControllers.get(plan);
    if (planController) signals.push(planController.signal);
    return { ...options, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] };
  }
  pathForResourceOperation(uri) {
    const filePath = C.uriToPath(uri);
    if (!filePath) throw new Error(`Cannot apply a file operation to '${uri}'`);
    return filePath;
  }
  workspaceEditError(reason, failedChange) {
    const error = new Error(reason);
    if (Number.isInteger(failedChange)) error.failedChange = failedChange;
    return error;
  }
  fileOperationForChange(change) {
    if (!change || typeof change !== "object" || Array.isArray(change))
      throw new Error("Invalid documentChanges entry");
    const options = change.options ? { ...change.options } : undefined;
    if (change.kind === "create") {
      return { kind: "create", path: this.pathForResourceOperation(change.uri), options };
    }
    if (change.kind === "rename") {
      return {
        kind: "rename",
        oldPath: this.pathForResourceOperation(change.oldUri),
        newPath: this.pathForResourceOperation(change.newUri),
        options,
      };
    }
    if (change.kind === "delete") {
      return { kind: "delete", path: this.pathForResourceOperation(change.uri), options };
    }
    return null;
  }
  disposeFileOperationPlan(plan) {
    try {
      plan?.dispose?.();
    } catch (error) {
      console.error("ide: failed to dispose a file-operation plan", error);
    }
  }
  async prepareFileOperations(documentChanges, options = {}) {
    this.assertWorkspaceEditCurrent(options);
    const executor = this.fileOperations.executor;
    const indexed = [];
    for (
      let documentChangeIndex = 0;
      documentChangeIndex < documentChanges.length;
      documentChangeIndex++
    ) {
      const change = documentChanges[documentChangeIndex];
      let operation;
      try {
        operation = this.fileOperationForChange(change);
      } catch (error) {
        throw this.workspaceEditError(error.message, documentChangeIndex);
      }
      if (operation) indexed.push({ documentChangeIndex, operation });
    }
    if (!indexed.length) return { plan: null, executor, byChange: new Map() };
    if (!executor) {
      throw this.workspaceEditError(
        "File operation service is unavailable.",
        indexed[0].documentChangeIndex,
      );
    }

    let prepared;
    try {
      prepared = await executor.prepare(
        indexed.map(({ operation }) => operation),
        {
          signal: options.signal,
        },
      );
      this.assertWorkspaceEditCurrent(options);
    } catch (error) {
      this.disposeFileOperationPlan(prepared?.plan);
      throw this.workspaceEditError(error.message, indexed[0].documentChangeIndex);
    }
    if (prepared?.status === "failed") {
      this.disposeFileOperationPlan(prepared.plan);
      const failed = indexed[prepared.failedOperation] || indexed[0];
      throw this.workspaceEditError(
        prepared.reason || "File operation preflight failed.",
        failed.documentChangeIndex,
      );
    }
    if (
      prepared?.status !== "ready" ||
      typeof prepared.plan?.executeNext !== "function" ||
      typeof prepared.plan?.describe !== "function" ||
      typeof prepared.plan?.dispose !== "function"
    ) {
      this.disposeFileOperationPlan(prepared?.plan);
      throw this.workspaceEditError(
        "File operation service returned an invalid plan.",
        indexed[0].documentChangeIndex,
      );
    }
    let descriptions;
    try {
      descriptions = prepared.plan.describe();
    } catch (error) {
      this.disposeFileOperationPlan(prepared.plan);
      throw this.workspaceEditError(error.message, indexed[0].documentChangeIndex);
    }
    if (
      !Array.isArray(descriptions) ||
      descriptions.length !== indexed.length ||
      descriptions.some(
        (description) =>
          !description ||
          typeof description !== "object" ||
          (description.status !== "apply" && description.status !== "skip"),
      )
    ) {
      this.disposeFileOperationPlan(prepared.plan);
      throw this.workspaceEditError(
        "File operation service returned an invalid plan description.",
        indexed[0].documentChangeIndex,
      );
    }
    return {
      plan: prepared.plan,
      executor,
      byChange: new Map(
        indexed.map(({ documentChangeIndex, operation }, fileOperationIndex) => [
          documentChangeIndex,
          { fileOperationIndex, operation, plannedStatus: descriptions[fileOperationIndex].status },
        ]),
      ),
    };
  }
  assertWorkspaceEditCurrent({ signal, isCurrent } = {}) {
    if (this.disposed) throw new Error("Workspace edit service is no longer active.");
    signal?.throwIfAborted();
    if (isCurrent?.() === false)
      throw new Error("A file-operation guard changed while preparation was waiting.");
  }
  beforeWorkspaceEditMutation(options) {
    this.assertWorkspaceEditCurrent(options);
    options?.beforeMutation?.();
    this.assertWorkspaceEditCurrent(options);
  }
  beforePlanMutation(plan, step, options) {
    const first = step ? plan.steps.indexOf(step) : 0;
    const assertTargets = () => {
      const stale = plan.steps
        .slice(first)
        .find(
          (candidate) =>
            !this.workspaceEditTargetIsCurrent(candidate) ||
            (candidate.sourceProjection && !candidate.sourceProjection.isCurrent()),
        );
      if (stale)
        throw this.workspaceEditError(
          "A document changed while the workspace edit was waiting.",
          stale.documentChangeIndex,
        );
    };
    assertTargets();
    this.beforeWorkspaceEditMutation(options);
    assertTargets();
    if (step?.kind === "resource")
      this.assertFileOperationTargetIsClosed(step, step.documentChangeIndex);
  }
  editorSnapshot(editor, snapshots) {
    if (!editor) return null;
    if (snapshots.has(editor)) return snapshots.get(editor);
    const snapshot = {
      editor,
      buffer: editor.getBuffer?.(),
      path: editor.getPath?.(),
      changeCount: 0,
      appliedChangeCount: 0,
    };
    snapshot.subscription = snapshot.buffer?.onDidChangeText?.(() => snapshot.changeCount++);
    snapshots.set(editor, snapshot);
    return snapshot;
  }
  disposeEditorSnapshots(snapshots) {
    for (const snapshot of snapshots?.values?.() || []) snapshot.subscription?.dispose?.();
    snapshots?.clear?.();
  }
  disposeSessionSubscriptions(subscriptions) {
    for (const subscription of subscriptions || []) subscription?.dispose?.();
    if (subscriptions) subscriptions.length = 0;
  }
  advanceEditorSnapshot(plan, editor) {
    const snapshot = plan.editorSnapshots.get(editor);
    if (snapshot) snapshot.appliedChangeCount = snapshot.changeCount;
  }
  editorSnapshotIsCurrent(snapshot) {
    return (
      !snapshot ||
      (!snapshot.editor.isDestroyed?.() &&
        snapshot.editor.getBuffer?.() === snapshot.buffer &&
        snapshot.editor.getPath?.() === snapshot.path &&
        snapshot.changeCount === snapshot.appliedChangeCount)
    );
  }
  workspaceEditTargetIsCurrent(step) {
    if (step.sessionWasRunning && step.session.state !== "running") return false;
    if (!this.editorSnapshotIsCurrent(step.editorSnapshot)) return false;
    if (!this.editorSnapshotIsCurrent(step.initialEditorSnapshot)) return false;
    if (step.uriBinding) {
      const current = this.documents.resolveUri(step.change.textDocument.uri);
      if (
        current?.kind !== step.uriBinding.kind ||
        current?.editor !== step.uriBinding.editor ||
        current?.record !== step.uriBinding.record ||
        current?.cellId !== step.uriBinding.cellId
      )
        return false;
    }
    const state = step.documentState;
    return (
      !state ||
      (this.editorSnapshotIsCurrent(state.editorSnapshot) &&
        (state.retargeted ||
          state.session.documents?.get(state.key) === (state.identityDocument || state.document)))
    );
  }
  retargetWorkspaceEditSnapshots(plan, effects) {
    for (const effect of effects || []) {
      if (effect.kind !== "rename" || !effect.oldPath || !effect.newPath) continue;
      const movedSnapshots = new Set();
      for (const step of plan.steps) {
        const snapshots = [
          step.editorSnapshot,
          step.initialEditorSnapshot,
          step.documentState?.editorSnapshot,
        ];
        for (const snapshot of snapshots) {
          if (!snapshot?.path) continue;
          const relative = relativePath(effect.oldPath, snapshot.path);
          if (relative === null) continue;
          const nextPath = path.join(effect.newPath, relative);
          if (
            !snapshot.editor.getPath?.() ||
            pathKey(snapshot.editor.getPath()) !== pathKey(nextPath) ||
            snapshot.editor.getBuffer?.() !== snapshot.buffer ||
            snapshot.editor.isDestroyed?.()
          )
            continue;
          snapshot.path = snapshot.editor.getPath();
          movedSnapshots.add(snapshot);
        }
      }
      // A durable move replaces the LSP routing generation deliberately, even
      // across workspace roots. Keep the original version history on the buffer.
      for (const state of plan.documentStates.values()) {
        if (!movedSnapshots.has(state.editorSnapshot)) continue;
        const key = C.uriKey(C.pathToUri(state.editorSnapshot.path));
        const replacement = state.session.documents?.get(key);
        if (replacement?.editor === state.editorSnapshot.editor) {
          state.key = key;
          state.identityDocument = replacement;
        } else if (state.session.documents?.get(state.key) !== state.document) {
          state.retargeted = true;
        }
      }
    }
  }
  validateTextDocumentChange(change) {
    if (
      !change?.textDocument ||
      typeof change.textDocument.uri !== "string" ||
      !change.textDocument.uri ||
      !Array.isArray(change.edits) ||
      (change.textDocument.version != null && !Number.isInteger(change.textDocument.version))
    )
      throw new Error("Invalid TextDocumentEdit");
    const edits = change.edits.map((edit) => {
      const { range, newText } = edit || {};
      const validPosition = (position) =>
        Number.isInteger(position?.line) &&
        position.line >= 0 &&
        Number.isInteger(position?.character) &&
        position.character >= 0;
      if (
        typeof newText !== "string" ||
        !validPosition(range?.start) ||
        !validPosition(range?.end) ||
        this.compareLspPositions(range.start, range.end) > 0
      )
        throw new Error("Invalid workspace text edit");
      return {
        ...edit,
        range: { start: { ...range.start }, end: { ...range.end } },
      };
    });
    const ascending = edits
      .map((edit, index) => ({ ...edit, index }))
      .sort(
        (left, right) =>
          this.compareLspPositions(left.range.start, right.range.start) || left.index - right.index,
      );
    for (let index = 1; index < ascending.length; index++) {
      if (
        this.compareLspPositions(ascending[index - 1].range.end, ascending[index].range.start) > 0
      )
        throw new Error("Workspace text edits overlap");
    }
    return { ...change, textDocument: { ...change.textDocument }, edits };
  }
  descendingTextEdits(edits) {
    return edits
      .map((edit, index) => ({ edit, index }))
      .sort(
        (left, right) =>
          this.compareLspPositions(right.edit.range.start, left.edit.range.start) ||
          right.index - left.index,
      )
      .map(({ edit }) => edit);
  }
  async editorForWorkspaceEdit(uri, options = {}) {
    this.assertWorkspaceEditCurrent(options);
    const resolved = this.documents.resolveUri(uri);
    if (!resolved) throw new Error(`Cannot resolve workspace edit target '${uri}'`);
    if (resolved.kind === "cell" || resolved.kind === "untitled") {
      if (!resolved.editor || resolved.editor.isDestroyed?.())
        throw new Error(`Document '${uri}' is no longer open`);
      return resolved.editor;
    }
    const key = C.uriKey(uri);
    const editor =
      lumine.workspace
        .getTextEditors()
        .find((item) => item.getPath() && C.uriKey(C.pathToUri(item.getPath())) === key) ||
      (await lumine.workspace.open(resolved.path, { activateItem: false, pending: false }));
    this.assertWorkspaceEditCurrent(options);
    if (
      !editor ||
      editor.isDestroyed?.() ||
      !editor.getPath?.() ||
      pathKey(editor.getPath()) !== pathKey(resolved.path)
    )
      throw new Error(`Unable to open workspace edit target '${resolved.path}'`);
    return editor;
  }
  async assertWorkspaceEditPathExists(executor, filePath, uri, options = {}) {
    this.assertWorkspaceEditCurrent(options);
    if (typeof executor?.inspect !== "function") return;
    const descriptions = await executor.inspect([filePath], { signal: options.signal });
    this.assertWorkspaceEditCurrent(options);
    const description = descriptions?.[0];
    if (
      !Array.isArray(descriptions) ||
      descriptions.length !== 1 ||
      description?.path !== filePath ||
      !["file", "directory", "missing"].includes(description?.status)
    ) {
      throw new Error("File operation service returned an invalid path inspection.");
    }
    if (description.status === "missing") {
      throw new Error(`Workspace edit target '${uri}' does not exist.`);
    }
  }
  projectWorkspaceEditPath(filePath, resources) {
    let projected = path.resolve(filePath);
    for (let index = resources.length - 1; index >= 0; index--) {
      const { operation, plannedStatus } = resources[index];
      if (plannedStatus === "skip") {
        if (operation.kind === "delete" && relativePath(operation.path, projected) !== null) {
          return { status: "missing", path: projected };
        }
        continue;
      }
      if (operation.kind === "create") {
        if (relativePath(operation.path, projected) !== null) {
          return { status: "new", path: projected };
        }
        continue;
      }
      if (operation.kind === "rename") {
        const targetRelative = relativePath(operation.newPath, projected);
        if (targetRelative !== null) {
          projected = path.join(operation.oldPath, targetRelative);
          continue;
        }
        if (relativePath(operation.oldPath, projected) !== null) {
          return { status: "missing", path: projected };
        }
        continue;
      }
      if (operation.kind === "delete" && relativePath(operation.path, projected) !== null) {
        return { status: "missing", path: projected };
      }
    }
    return { status: "existing", path: projected };
  }
  assertFileOperationTargetIsClosed(resource, documentChangeIndex) {
    const { operation, plannedStatus } = resource;
    if (plannedStatus !== "apply") return;
    const target = operation.kind === "rename" ? operation.newPath : operation.path;
    if (!target || operation.kind === "delete") return;
    if (operation.kind === "rename" && pathKey(operation.oldPath) === pathKey(operation.newPath)) {
      return;
    }
    if (
      lumine.workspace
        .getPaneItems()
        .some((item) => item.getPath?.() && relativePath(target, item.getPath()) !== null)
    ) {
      throw this.workspaceEditError(
        `Cannot create or rename '${target}' while it is open in the workspace.`,
        documentChangeIndex,
      );
    }
  }
  async workspaceEditShapeError(documentChanges, session, executor, options = {}) {
    const versionStates = new Map();
    const precedingFileOperations = [];
    for (
      let documentChangeIndex = 0;
      documentChangeIndex < documentChanges.length;
      documentChangeIndex++
    ) {
      const change = documentChanges[documentChangeIndex];
      try {
        this.assertWorkspaceEditCurrent(options);
        const operation = this.fileOperationForChange(change);
        if (operation) {
          precedingFileOperations.push(operation);
          continue;
        }
        this.validateTextDocumentChange(change);
        const uri = change?.textDocument?.uri;
        if (!uri || !Array.isArray(change.edits)) throw new Error("Invalid TextDocumentEdit");
        const resolved = this.documents.resolveUri(uri);
        if (!resolved) throw new Error(`Cannot resolve workspace edit target '${uri}'`);
        const expected = change.textDocument.version;
        const sourceSession = change.sourceSession || session;
        const touchedByResourceOperation =
          resolved.kind === "file" &&
          precedingFileOperations.some((candidate) => {
            if (candidate.kind === "rename") {
              return (
                relativePath(candidate.oldPath, resolved.path) !== null ||
                relativePath(candidate.newPath, resolved.path) !== null
              );
            }
            return relativePath(candidate.path, resolved.path) !== null;
          });
        if (!touchedByResourceOperation) {
          const document = sourceSession?.documents?.get(C.uriKey(uri));
          const openEditor =
            resolved.kind === "file" &&
            lumine.workspace
              .getTextEditors()
              .some(
                (editor) =>
                  editor.getPath?.() && pathKey(editor.getPath()) === pathKey(resolved.path),
              );
          if (resolved.kind === "file" && !document && !openEditor) {
            await this.assertWorkspaceEditPathExists(executor, resolved.path, uri, options);
          }
          if (expected != null) {
            if (!document)
              throw new Error(`Cannot validate versioned workspace edit target '${uri}'`);
            const current = versionStates.has(document)
              ? versionStates.get(document)
              : document.version;
            if (current !== expected) {
              throw new Error(
                `Refusing a stale workspace edit for '${uri}': document version changed`,
              );
            }
          }
          if (document && change.edits.length) {
            const current = versionStates.has(document)
              ? versionStates.get(document)
              : document.version;
            versionStates.set(document, current + 1);
          }
        }
      } catch (error) {
        return this.workspaceEditError(error.message, documentChangeIndex);
      }
    }
    return null;
  }
  async preflightWorkspaceEdit(documentChanges, session, options = {}) {
    options = this.workspaceEditOptions(options);
    this.assertWorkspaceEditCurrent(options);
    const preparationController = new AbortController();
    const sessionSubscriptions = [];
    options = {
      ...options,
      signal: AbortSignal.any([options.signal, preparationController.signal]),
    };
    const steps = [];
    const versionStates = new Map();
    const documentStates = new Map();
    const editorSnapshots = new Map();
    const initialEditors = new Map();
    const initialDocuments = new Map();
    const initialBindings = new Map();
    const sourceSessions = new Set(
      documentChanges.map((change) => change?.sourceSession || session),
    );
    const runningSessions = new Set(
      [...sourceSessions].filter((source) => source?.state === "running"),
    );
    try {
      for (const source of runningSessions) {
        const subscription = source.onDidChangeState?.(({ state } = {}) => {
          if ((state || source.state) !== "running")
            preparationController.abort(
              new DOMException(
                "The language server stopped while the workspace edit was waiting.",
                "AbortError",
              ),
            );
        });
        if (subscription) sessionSubscriptions.push(subscription);
      }
      for (const editor of lumine.workspace.getTextEditors()) {
        const filePath = editor.getPath?.();
        if (filePath)
          initialEditors.set(
            C.uriKey(C.pathToUri(filePath)),
            this.editorSnapshot(editor, editorSnapshots),
          );
      }
      for (const source of sourceSessions) {
        if (!source) continue;
        initialDocuments.set(source, new Map(source.documents || []));
        for (const [key, document] of source.documents || [])
          if (document.editor)
            initialEditors.set(key, this.editorSnapshot(document.editor, editorSnapshots));
      }
      for (const change of documentChanges) {
        const uri = change?.textDocument?.uri;
        if (typeof uri !== "string") continue;
        const resolved = this.documents.resolveUri(uri);
        if (resolved?.editor) {
          initialEditors.set(C.uriKey(uri), this.editorSnapshot(resolved.editor, editorSnapshots));
          if (resolved.kind !== "file") initialBindings.set(C.uriKey(uri), resolved);
        }
      }
    } catch (error) {
      this.disposeEditorSnapshots(editorSnapshots);
      this.disposeSessionSubscriptions(sessionSubscriptions);
      throw error;
    }
    const editors = new Map();
    const projectedTargets = new Set();
    const precedingFileOperations = [];
    const shapeErrorPromise = this.workspaceEditShapeError(
      documentChanges,
      session,
      this.fileOperations.executor,
      options,
    );
    let shapeError;
    let filePreparation;
    try {
      [shapeError, filePreparation] = await Promise.all([
        shapeErrorPromise,
        this.prepareFileOperations(documentChanges, options),
      ]);
    } catch (error) {
      shapeError = await shapeErrorPromise;
      this.disposeEditorSnapshots(editorSnapshots);
      this.disposeSessionSubscriptions(sessionSubscriptions);
      if (
        shapeError &&
        (!Number.isInteger(error.failedChange) || shapeError.failedChange < error.failedChange)
      ) {
        throw shapeError;
      }
      throw error;
    }
    if (shapeError) {
      this.disposeFileOperationPlan(filePreparation.plan);
      this.disposeEditorSnapshots(editorSnapshots);
      this.disposeSessionSubscriptions(sessionSubscriptions);
      throw shapeError;
    }

    try {
      this.assertWorkspaceEditCurrent(options);
      for (
        let documentChangeIndex = 0;
        documentChangeIndex < documentChanges.length;
        documentChangeIndex++
      ) {
        let change = documentChanges[documentChangeIndex];
        this.assertWorkspaceEditCurrent(options);
        const sourceSession = change.sourceSession || session;
        if (runningSessions.has(sourceSession) && sourceSession.state !== "running")
          throw this.workspaceEditError(
            "The language server stopped while the workspace edit was waiting.",
            documentChangeIndex,
          );
        const resource = filePreparation.byChange.get(documentChangeIndex);
        if (resource) {
          this.assertFileOperationTargetIsClosed(resource, documentChangeIndex);
          steps.push({
            kind: "resource",
            change,
            documentChangeIndex,
            ...resource,
            session: sourceSession,
            sessionWasRunning: runningSessions.has(sourceSession),
          });
          precedingFileOperations.push(resource);
          continue;
        }

        try {
          change = this.validateTextDocumentChange(change);
          const uri = change.textDocument?.uri;
          if (!uri || !Array.isArray(change.edits)) throw new Error("Invalid TextDocumentEdit");
          if (sourceSession?.isTemporaryDocumentUri?.(uri))
            throw new Error("Temporary analysis documents cannot receive workspace edits");
          const resolved = this.documents.resolveUri(uri);
          if (!resolved) throw new Error(`Cannot resolve workspace edit target '${uri}'`);
          const projected =
            resolved.kind === "file"
              ? this.projectWorkspaceEditPath(resolved.path, precedingFileOperations)
              : { status: "existing", path: resolved.path };
          if (projected.status === "missing") {
            throw new Error(`Workspace edit target '${resolved.path}' will no longer exist.`);
          }
          const documentUri =
            resolved.kind === "file" && projected.path !== resolved.path
              ? C.pathToUri(projected.path)
              : uri;
          const expected = change.textDocument.version;
          const documentKey = C.uriKey(documentUri);
          const document = sourceSession?.documents?.get(documentKey);
          const initialDocument = initialDocuments.get(sourceSession)?.get(documentKey);
          if (initialDocument && document !== initialDocument)
            throw new Error("A document changed while the workspace edit was waiting.");
          const openEditor =
            resolved.kind === "file" &&
            lumine.workspace
              .getTextEditors()
              .find(
                (candidate) =>
                  candidate.getPath?.() && pathKey(candidate.getPath()) === pathKey(projected.path),
              );
          if (
            resolved.kind === "file" &&
            projected.status === "existing" &&
            !document &&
            !openEditor
          ) {
            await this.assertWorkspaceEditPathExists(
              filePreparation.executor,
              projected.path,
              uri,
              options,
            );
          }
          let documentState = documentStates.get(document);
          if (document && !documentState) {
            documentState = {
              document,
              identityDocument: initialDocument || document,
              session: sourceSession,
              key: documentKey,
              editorSnapshot: this.editorSnapshot(document.editor, editorSnapshots),
              initialVersion: document.version,
              changeCount: 0,
              guarded: false,
            };
            documentState.subscription = document.editor
              ?.getBuffer?.()
              .onDidChangeText(() => documentState.changeCount++);
            documentStates.set(document, documentState);
          }
          if (expected != null) {
            if (!document)
              throw new Error(`Cannot validate versioned workspace edit target '${uri}'`);
            documentState.guarded = true;
            const current = versionStates.has(document)
              ? versionStates.get(document)
              : document.version;
            if (current !== expected)
              throw new Error(
                `Refusing a stale workspace edit for '${uri}': document version changed`,
              );
            if (change.edits.length) versionStates.set(document, current + 1);
          } else if (document && change.edits.length) {
            const current = versionStates.has(document)
              ? versionStates.get(document)
              : document.version;
            versionStates.set(document, current + 1);
          }
          const key = C.uriKey(uri);
          // File-rename preparations can include every analyzed file with an
          // empty edit array. Validate those entries, but do not open them or
          // require a document projection when no text will change.
          const hasEdits = change.edits.length > 0;
          const deferred = hasEdits && resolved.kind === "file" && projected.status === "new";
          let editor = hasEdits && !deferred ? editors.get(key) : null;
          if (hasEdits && !deferred && !editor) {
            const editorUri =
              resolved.kind === "file" && projected.path !== resolved.path
                ? C.pathToUri(projected.path)
                : uri;
            editor = await this.editorForWorkspaceEdit(editorUri, options);
            this.assertWorkspaceEditCurrent(options);
            editors.set(key, editor);
          }
          let sourceProjection = null;
          if (
            hasEdits &&
            sourceSession?.adapter?.getDocumentProjection &&
            (editor
              ? sourceSession.needsDocumentTransform(editor)
              : /\.ipy$/i.test(resolved.path || ""))
          ) {
            sourceProjection = change.sourceProjectionContext?.projection;
            if (!sourceProjection?.isCurrent?.())
              throw new Error("Projected workspace edits require a current open document snapshot");
            if (projectedTargets.has(documentKey))
              throw new Error(
                "Projected workspace edits must contain one atomic edit batch per document",
              );
            projectedTargets.add(documentKey);
            const mapped = sourceSession.mapTextEdits(
              change.edits.map((edit) => ({
                oldRange: C.rangeFromLsp(edit.range),
                newText: edit.newText,
              })),
              editor,
              uri,
              sourceProjection,
            );
            change = this.validateTextDocumentChange({
              ...change,
              edits: mapped.map((edit) => ({
                range: C.rangeToLsp(Range.fromObject(edit.oldRange)),
                newText: edit.newText,
              })),
            });
            if (documentState) documentState.guarded = true;
          }
          steps.push({
            kind: "text",
            change,
            documentChangeIndex,
            editor,
            editorSnapshot: this.editorSnapshot(editor, editorSnapshots),
            initialEditorSnapshot: initialEditors.get(documentKey),
            uriBinding: resolved.kind === "file" ? null : initialBindings.get(key) || resolved,
            deferred,
            document,
            documentState,
            expectedVersion: expected,
            session: sourceSession,
            sessionWasRunning: runningSessions.has(sourceSession),
            sourceProjection,
          });
        } catch (error) {
          if (!Number.isInteger(error.failedChange)) error.failedChange = documentChangeIndex;
          throw error;
        }
      }
      const plan = {
        steps,
        documentStates,
        editorSnapshots,
        sessionSubscriptions,
        filePlan: filePreparation.plan,
        fileOperationsExecutor: filePreparation.executor,
      };
      const stale = this.staleWorkspaceEditStep(plan);
      if (stale)
        throw this.workspaceEditError(
          "A document changed while the workspace edit was waiting.",
          stale.documentChangeIndex,
        );
      const retained = new Set(
        steps.flatMap((step) => [
          step.editorSnapshot,
          step.initialEditorSnapshot,
          step.documentState?.editorSnapshot,
        ]),
      );
      for (const [editor, snapshot] of editorSnapshots) {
        if (retained.has(snapshot)) continue;
        snapshot.subscription?.dispose?.();
        editorSnapshots.delete(editor);
      }
      this.plans.add(plan);
      this.planStates.set(plan, "prepared");
      this.planControllers.set(plan, preparationController);
      return plan;
    } catch (error) {
      this.disposeFileOperationPlan(filePreparation.plan);
      this.disposeWorkspaceEditDocumentStates(documentStates);
      this.disposeEditorSnapshots(editorSnapshots);
      this.disposeSessionSubscriptions(sessionSubscriptions);
      throw error;
    }
  }
  workspaceEditPlanIsCurrent(plan) {
    return (
      !this.disposed &&
      this.planStates.get(plan) === "prepared" &&
      !this.staleWorkspaceEditStep(plan)
    );
  }
  workspaceEditLogicalVersion(state) {
    return (
      state.initialVersion +
      Math.max(state.changeCount, state.document.version - state.initialVersion)
    );
  }
  assertWorkspaceTextVersionCurrent(step) {
    if (step.expectedVersion == null) return;
    const state = step.documentState;
    if (!state || this.workspaceEditLogicalVersion(state) !== step.expectedVersion)
      throw this.workspaceEditError(
        `Refusing a stale workspace edit for '${step.change.textDocument.uri}': document version changed`,
        step.documentChangeIndex,
      );
  }
  disposeWorkspaceEditDocumentStates(documentStates) {
    for (const state of documentStates?.values?.() || []) state.subscription?.dispose?.();
    documentStates?.clear?.();
  }
  staleWorkspaceEditStep(plan) {
    const staleTarget = plan.steps.find((step) => !this.workspaceEditTargetIsCurrent(step));
    if (staleTarget) return staleTarget;
    const staleProjection = plan.steps.find(
      (step) => step.sourceProjection && !step.sourceProjection.isCurrent(),
    );
    if (staleProjection) return staleProjection;
    for (const state of plan.documentStates.values()) {
      if (!state.guarded) continue;
      if (this.workspaceEditLogicalVersion(state) === state.initialVersion) continue;
      return plan.steps.find((step) => step.documentState === state) || null;
    }
    return null;
  }
  workspaceEditDocumentChanges(edit, session) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
      throw new Error("Invalid WorkspaceEdit");
    }
    if (edit.documentChanges !== undefined) {
      if (!Array.isArray(edit.documentChanges)) throw new Error("Invalid documentChanges");
      return edit.documentChanges.map((change, index) => {
        if (!change || typeof change !== "object" || Array.isArray(change))
          throw this.workspaceEditError("Invalid documentChanges entry", index);
        const context = session?.workspaceProjectionContext?.(edit, change.textDocument?.uri);
        return context ? { ...change, sourceProjectionContext: context } : change;
      });
    }
    if (
      edit.changes !== undefined &&
      (!edit.changes || typeof edit.changes !== "object" || Array.isArray(edit.changes))
    ) {
      throw new Error("Invalid WorkspaceEdit changes");
    }
    return Object.entries(edit.changes || {}).map(([uri, edits]) => {
      const context = session?.workspaceProjectionContext?.(edit, uri);
      return {
        textDocument: { uri },
        edits,
        ...(context ? { sourceProjectionContext: context } : {}),
      };
    });
  }
  compareLspPositions(left, right) {
    return left.line - right.line || left.character - right.character;
  }
  workspaceTextEditsOverlap(left, right) {
    const leftEmpty = this.compareLspPositions(left.range.start, left.range.end) === 0;
    const rightEmpty = this.compareLspPositions(right.range.start, right.range.end) === 0;
    if (leftEmpty && rightEmpty)
      return this.compareLspPositions(left.range.start, right.range.start) === 0;
    if (leftEmpty)
      return (
        this.compareLspPositions(right.range.start, left.range.start) <= 0 &&
        this.compareLspPositions(left.range.start, right.range.end) <= 0
      );
    if (rightEmpty)
      return (
        this.compareLspPositions(left.range.start, right.range.start) <= 0 &&
        this.compareLspPositions(right.range.start, left.range.end) <= 0
      );
    return (
      this.compareLspPositions(left.range.start, right.range.end) < 0 &&
      this.compareLspPositions(right.range.start, left.range.end) < 0
    );
  }
  async applyWorkspaceEdits(edits, label, options = {}) {
    options = this.workspaceEditOptions(options);
    const changes = [];
    let plan;
    try {
      this.assertWorkspaceEditCurrent(options);
      for (const { edit, session } of edits)
        for (const change of this.workspaceEditDocumentChanges(edit, session))
          changes.push({ ...change, sourceSession: session });
      plan = await this.preflightWorkspaceEdit(changes, null, options);
    } catch (error) {
      this.log(edits[0]?.session || {}, `Invalid file-operation edit: ${error.message}`);
      if (options.signal && !options.signal.aborted && error.name !== "AbortError")
        lumine.notifications.addWarning("The file operation could not be prepared", {
          detail: error.message,
          dismissable: true,
        });
      return false;
    }
    options = this.workspaceEditOptions(options, plan);
    if (plan.steps.every((step) => step.kind === "text")) {
      try {
        this.assertWorkspaceEditCurrent(options);
        if (!this.workspaceEditPlanIsCurrent(plan)) return false;
        const byEditor = new Map();
        for (const step of plan.steps) {
          if (!step.change.edits.length) continue;
          const editor =
            step.editor ||
            (await this.editorForWorkspaceEdit(step.change.textDocument.uri, options));
          this.assertWorkspaceEditCurrent(options);
          const list = byEditor.get(editor) || [];
          for (const textEdit of step.change.edits) {
            const newText = step.sourceProjection
              ? textEdit.newText
              : (step.session?.restoreDocumentText?.(
                  textEdit.newText,
                  editor,
                  step.change.textDocument.uri,
                ) ?? textEdit.newText);
            const duplicate = list.some(
              (candidate) =>
                candidate.batch !== step &&
                JSON.stringify(candidate.range) === JSON.stringify(textEdit.range) &&
                candidate.newText === newText,
            );
            if (!duplicate) list.push({ range: textEdit.range, newText, batch: step });
          }
          byEditor.set(editor, list);
        }
        for (const editsForEditor of byEditor.values()) {
          const ascending = [...editsForEditor].sort((a, b) =>
            this.compareLspPositions(a.range.start, b.range.start),
          );
          for (let index = 1; index < ascending.length; index++)
            if (
              ascending[index - 1].batch !== ascending[index].batch &&
              this.workspaceTextEditsOverlap(ascending[index - 1], ascending[index])
            )
              throw new Error("Language servers returned overlapping file-operation edits");
        }
        if (!this.workspaceEditPlanIsCurrent(plan)) return false;
        this.claimPlan(plan);
        if (byEditor.size) this.beforePlanMutation(plan, null, options);
        for (const [editor, editsForEditor] of byEditor) {
          this.assertWorkspaceEditCurrent(options);
          if (!this.editorSnapshotIsCurrent(plan.editorSnapshots.get(editor)))
            throw new Error("A document changed while the workspace edit was waiting.");
          editor.transact(() => {
            for (const textEdit of this.descendingTextEdits(editsForEditor)) {
              this.assertWorkspaceEditCurrent(options);
              editor.setTextInBufferRange(C.rangeFromLsp(textEdit.range), textEdit.newText);
            }
          });
          this.advanceEditorSnapshot(plan, editor);
        }
        return true;
      } catch (error) {
        if (!options.signal?.aborted && error.name !== "AbortError")
          lumine.notifications.addError("Language server edit failed", {
            detail: error.message,
            dismissable: true,
          });
        return false;
      } finally {
        this.disposePlan(plan);
      }
    }
    return this.applyWorkspaceEditPlan(plan, label, options);
  }
  async applyWorkspaceEdit(edit, label, session = null) {
    return (await this.applyWorkspaceEditDetailed(edit, label, session)).applied;
  }
  workspaceEditFailureResult(error, includeFailedChange = true) {
    const result = {
      applied: false,
      failureReason: error?.message || "Language server edit failed.",
    };
    if (includeFailedChange && Number.isInteger(error?.failedChange)) {
      result.failedChange = error.failedChange;
    }
    return result;
  }
  reportWorkspaceEditFailure(result) {
    if (this.disposed) return;
    lumine.notifications.addError("Language server edit failed", {
      detail: result.failureReason,
      dismissable: true,
    });
  }
  async applyWorkspaceEditDetailed(edit, label, session = null) {
    const includeFailedChange = Array.isArray(edit?.documentChanges);
    let documentChanges;
    try {
      this.assertWorkspaceEditCurrent({ signal: this.controller.signal });
      documentChanges = this.workspaceEditDocumentChanges(edit, session);
    } catch (error) {
      const result = this.workspaceEditFailureResult(error, includeFailedChange);
      this.reportWorkspaceEditFailure(result);
      return result;
    }
    let plan;
    try {
      plan = await this.preflightWorkspaceEdit(documentChanges, session);
    } catch (error) {
      const result = this.workspaceEditFailureResult(error, includeFailedChange);
      this.reportWorkspaceEditFailure(result);
      return result;
    }
    return this.applyWorkspaceEditPlanDetailed(plan, label, { includeFailedChange });
  }
  async applyWorkspaceEditPlan(plan, label, options = {}) {
    return (await this.applyWorkspaceEditPlanDetailed(plan, label, options)).applied;
  }
  fileOperationCleanupPaths(result) {
    const paths = Array.isArray(result?.cleanupPaths) ? result.cleanupPaths : [];
    return [...new Set(paths.filter((filePath) => typeof filePath === "string" && filePath))];
  }
  reportFileOperationCleanup(paths) {
    if (!paths.length) return;
    lumine.notifications.addWarning("A file operation left recovery paths", {
      detail: paths.join("\n"),
      dismissable: true,
    });
  }
  fileOperationFailureReason(result) {
    const paths = this.fileOperationCleanupPaths(result);
    return [
      result?.reason || "File operation failed.",
      paths.length ? `Recovery paths:\n${paths.join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  async applyWorkspaceEditPlanDetailed(plan, label, options = {}) {
    options = this.workspaceEditOptions(options, plan);
    const { includeFailedChange = true } = options;
    const destructiveSteps = plan.steps.filter(
      (step) =>
        step.kind === "resource" &&
        step.plannedStatus === "apply" &&
        (step.operation.kind === "delete" ||
          step.operation.kind === "rename" ||
          (step.operation.kind === "create" && step.operation.options?.overwrite)),
    );
    let claimed = false;
    try {
      this.claimPlan(plan);
      claimed = true;
      this.assertWorkspaceEditCurrent(options);
      if (destructiveSteps.length) {
        const targets = destructiveSteps.map(({ operation }) => {
          if (operation.kind === "rename") return `${operation.oldPath} → ${operation.newPath}`;
          return operation.path;
        });
        const choice = await lumine.window.confirm({
          type: "warning",
          message: label || "The language server wants to change files",
          detail: `Review your version-control diff after applying this operation.\n\n${targets.join("\n")}`,
          buttons: ["Apply", "Cancel"],
        });
        this.assertWorkspaceEditCurrent(options);
        if (choice !== 0) {
          return { applied: false, failureReason: "Workspace edit was cancelled." };
        }
      }
      const staleStep = this.staleWorkspaceEditStep(plan);
      if (staleStep) {
        throw this.workspaceEditError(
          "A document changed while the workspace edit was waiting.",
          staleStep.documentChangeIndex,
        );
      }

      for (const step of plan.steps) {
        this.assertWorkspaceEditCurrent(options);
        if (step.kind === "text") this.assertWorkspaceTextVersionCurrent(step);
        if (!this.workspaceEditTargetIsCurrent(step))
          throw this.workspaceEditError(
            "A document changed while the workspace edit was waiting.",
            step.documentChangeIndex,
          );
        const { change } = step;
        if (step.kind === "resource") {
          if (
            !this.fileOperations.executor ||
            this.fileOperations.executor !== plan.fileOperationsExecutor
          ) {
            throw this.workspaceEditError(
              "File operation service became unavailable.",
              step.documentChangeIndex,
            );
          }
          this.assertFileOperationTargetIsClosed(step, step.documentChangeIndex);
          let result;
          try {
            result = await this.fileOperations.executeStep(plan, step, {
              ...options,
              beforeMutation: () => this.beforePlanMutation(plan, step, options),
            });
          } catch (error) {
            if (!Number.isInteger(error.failedChange)) {
              error.failedChange = step.documentChangeIndex;
            }
            throw error;
          }
          if (result?.status === "applied" || result?.status === "skipped") {
            this.retargetWorkspaceEditSnapshots(plan, result.effects);
            this.reportFileOperationCleanup(this.fileOperationCleanupPaths(result));
            continue;
          }
          throw this.workspaceEditError(
            this.fileOperationFailureReason(result),
            step.documentChangeIndex,
          );
        }
        if (step.kind !== "text") {
          throw this.workspaceEditError("Invalid workspace edit step.", step.documentChangeIndex);
        }
        try {
          if (!change.edits.length) continue;
          const editor =
            step.editor || (await this.editorForWorkspaceEdit(change.textDocument.uri, options));
          step.editorSnapshot ||= this.editorSnapshot(editor, plan.editorSnapshots);
          this.assertWorkspaceEditCurrent(options);
          if (!this.workspaceEditTargetIsCurrent(step))
            throw new Error("A document changed while the workspace edit was waiting.");
          if (step.sourceProjection && !step.sourceProjection.isCurrent())
            throw new Error("Language server projection changed before applying workspace edits");
          this.beforePlanMutation(plan, step, options);
          editor.transact(() =>
            this.descendingTextEdits(change.edits).forEach((textEdit) => {
              const newText = step.sourceProjection
                ? textEdit.newText
                : (step.session?.restoreDocumentText?.(
                    textEdit.newText,
                    editor,
                    change.textDocument?.uri,
                  ) ?? textEdit.newText);
              this.assertWorkspaceEditCurrent(options);
              editor.setTextInBufferRange(C.rangeFromLsp(textEdit.range), newText);
            }),
          );
          this.advanceEditorSnapshot(plan, editor);
        } catch (error) {
          if (!Number.isInteger(error.failedChange)) error.failedChange = step.documentChangeIndex;
          throw error;
        }
      }
      return { applied: true };
    } catch (error) {
      const result = this.workspaceEditFailureResult(error, includeFailedChange);
      if (!options.signal?.aborted && error.name !== "AbortError")
        this.reportWorkspaceEditFailure(result);
      return result;
    } finally {
      if (claimed) this.disposePlan(plan);
    }
  }
};
