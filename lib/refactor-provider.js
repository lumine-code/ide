const C = require("./converters");
const { pathKey } = require("./workspace-paths");

const REFACTOR_CAPABILITIES = {
  textDocument: {
    rename: {
      dynamicRegistration: true,
      prepareSupport: true,
      prepareSupportDefaultBehavior: 1,
      honorsChangeAnnotations: false,
    },
  },
};

module.exports = class RefactorProvider {
  static capabilities = REFACTOR_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(REFACTOR_CAPABILITIES);
    this.priority = 2;
    this.packageName = "ide";
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  // Resolves to one of:
  //   null                                  this provider cannot rename here,
  //                                         so the consumer may try another
  //   { outcome: "edits", edits }            Map<absolutePath, [{ oldRange,
  //                                         newText }]> for the consumer to apply
  //   { outcome: "applied", paths }          the edit needed file create/rename/
  //                                         delete operations, so the hub applied
  //                                         all of it; the consumer only reports
  //   { outcome: "aborted" }                 applying was declined or failed;
  //                                         the consumer stops without reporting
  // Passing `dryRun` computes the edits without ever applying them, so a
  // consumer can preview a rename. Every call is a server round trip, so
  // callers must debounce previews rather than issue one per keystroke.
  async rename(editor, position, newName, { dryRun = false, ...options } = {}) {
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/rename",
      undefined,
      { signal: options.signal },
    );
    if (!session) return null;
    options.signal?.throwIfAborted();
    if (options.isCurrent?.() === false) return { outcome: "aborted" };
    const edit = await session.request(
      "textDocument/rename",
      {
        textDocument: { uri: this.manager.uriForEditor(editor) },
        position: C.pointToPosition(position),
        newName,
      },
      { editor, signal: options.signal },
    );
    if (!edit) return null;
    const workspaceEdits = this.manager.workspaceEdits;
    const changes = workspaceEdits.workspaceEditDocumentChanges(edit, session);
    const paths = new Set();
    let resourceOperations = false,
      externalTargets = false;
    for (const change of changes) {
      if (change.kind) {
        resourceOperations = true;
        const path = C.uriToPath(change.newUri || change.uri);
        if (path) paths.add(path);
        continue;
      }
      const target = this.manager.resolveUri(change.textDocument?.uri);
      if (!change.edits?.length) continue;
      if (target?.kind === "file") {
        paths.add(target.path);
      } else {
        externalTargets = true;
        if (target?.notebookPath) paths.add(target.notebookPath);
      }
    }
    if (!dryRun && (resourceOperations || externalTargets)) {
      const applied = await this.applyWorkspaceRename(
        edit,
        `Rename to ${newName}`,
        session,
        options,
      );
      return applied ? { outcome: "applied", paths: [...paths] } : { outcome: "aborted" };
    }
    if (dryRun && resourceOperations && !changes.some((change) => change.sourceProjectionContext)) {
      return {
        outcome: "edits",
        ...this.toPathEdits(changes.map((change) => ({ change, session }))),
        resourceOperations,
        externalTargets,
      };
    }

    const plan = await workspaceEdits.preflightWorkspaceEdit(changes, session, {
      ...options,
      openTextTargets: false,
    });
    const dispose = () => {
      options.signal?.removeEventListener("abort", dispose);
      workspaceEdits.disposePlan(plan);
    };
    let retained = false;
    try {
      const fileEdits = this.toPathEdits(plan.steps);
      if (dryRun) return { outcome: "edits", ...fileEdits, resourceOperations, externalTargets };
      options.signal?.throwIfAborted();
      options.signal?.addEventListener("abort", dispose, { once: true });
      retained = true;
      return {
        outcome: "edits",
        ...fileEdits,
        isCurrent: () => workspaceEdits.workspaceEditPlanIsCurrent(plan),
        dispose,
      };
    } finally {
      if (!retained) dispose();
    }
  }
  async applyWorkspaceRename(edit, label, session, options) {
    const preparation = new AbortController();
    const cancel = () => preparation.abort(options.signal.reason);
    let started = false;
    options.signal?.throwIfAborted();
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await this.manager.applyWorkspaceEdit(edit, label, session, {
        signal: preparation.signal,
        isCurrent: () => started || options.isCurrent?.() !== false,
        beforeMutation: () => {
          if (started) return;
          options.beforeMutation?.();
          started = true;
          // RenameFile may change the originating editor's path mid-commit.
          options.signal?.removeEventListener("abort", cancel);
        },
      });
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  }
  toPathEdits(steps) {
    const files = new Map();
    for (const { change, editor, sourceProjection, session } of steps) {
      const uri = change.textDocument?.uri;
      const path = C.uriToPath(uri);
      if (!path || !change.edits?.length) continue;
      const filePath = editor?.getPath() || path;
      const key = pathKey(filePath);
      let entry = files.get(key);
      if (!entry) files.set(key, (entry = { filePath, batches: [] }));
      entry.batches.push(
        change.edits.map((textEdit) => ({
          oldRange: C.rangeFromLsp(textEdit.range),
          newText:
            (!sourceProjection && editor
              ? session?.restoreDocumentText?.(textEdit.newText, editor, uri)
              : undefined) ?? textEdit.newText,
        })),
      );
    }
    const edits = new Map();
    const orderedEdits = new Map();
    for (const { filePath, batches } of files.values()) {
      if (batches.length === 1) edits.set(filePath, batches[0]);
      else orderedEdits.set(filePath, batches);
    }
    return orderedEdits.size ? { edits, orderedEdits } : { edits };
  }
  async prepareRename(editor, position, { signal } = {}) {
    // Preparation and the subsequent rename must describe the same server's
    // operation. A second server offering prepareRename cannot prepare a
    // rename that the first server will perform.
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/rename",
      undefined,
      { signal },
    );
    if (
      !session?.supports("textDocument/prepareRename", editor) ||
      !session.capabilityOptions("textDocument/rename", editor)?.prepareProvider
    )
      return null;
    const result = await session.request(
      "textDocument/prepareRename",
      {
        textDocument: { uri: this.manager.uriForEditor(editor) },
        position: C.pointToPosition(position),
      },
      { editor, signal },
    );
    if (!result) return null;
    if (result.defaultBehavior) return { range: this.wordRangeAt(editor, position) };
    if (result.start) return { range: C.rangeFromLsp(result) };
    if (result.range)
      return { range: C.rangeFromLsp(result.range), placeholder: result.placeholder };
    return null;
  }
  wordRangeAt(editor, point) {
    const line = editor.getBuffer().lineForRow(point.row) || "";
    const before = /[\w$]+$/.exec(line.slice(0, point.column))?.[0] || "";
    const after = /^[\w$]+/.exec(line.slice(point.column))?.[0] || "";
    return [
      [point.row, point.column - before.length],
      [point.row, point.column + after.length],
    ];
  }
};
