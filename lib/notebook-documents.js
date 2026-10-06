const { CompositeDisposable } = require("lumine");
const picomatch = require("picomatch");
const C = require("./converters");
const { languageIdForEditor } = require("./language-ids");

// LSP 3.17 notebook document sync. A notebook opens once per capable session:
// the notebook document plus one text document per synced cell, each under a
// `vscode-notebook-cell:` URI. Cells are their own documents, so positions on
// both sides of the wire are cell-relative — identity, no mapping layer.
//
// Only code cells whose language matches the server's `notebookSelector` are
// synced (mirroring vscode-languageclient); markup cells stay in the bridge
// descriptor because the 1-based cell numbers diagnostics carry count the
// notebook's full cell list, but they never reach a server. A session whose
// server advertises no `notebookDocumentSync` never sees the notebook at all —
// and `sessionsForEditor` only answers with sessions holding the cell
// document, which is what keeps such servers from ever being asked about one.

const NOTEBOOK_CELL_KIND = { markup: 1, code: 2 };

// Whether these sync options cover a notebook of this type with any of these
// cell languages. Handles both published shapes: ruff's cells-only selector
// and basedpyright's notebook-plus-cells selector.
function notebookFilterMatches(filter, { notebookType, filePath }) {
  if (typeof filter === "string") return filter === "*" || filter === notebookType;
  if (!filter || typeof filter !== "object") return false;
  if (filter.notebookType && filter.notebookType !== "*" && filter.notebookType !== notebookType)
    return false;
  if (filter.scheme && filter.scheme !== "*" && filter.scheme !== "file") return false;
  if (filter.pattern) {
    if (!filePath) return false;
    const normalized = filePath.replaceAll("\\", "/");
    const options = { dot: true, nocase: process.platform === "win32" };
    if (
      !picomatch.isMatch(normalized, filter.pattern, options) &&
      !picomatch.isMatch(normalized, `**/${filter.pattern}`, options)
    )
      return false;
  }
  return true;
}

function matchingNotebookSelectors(syncOptions, context) {
  const selectors = syncOptions?.notebookSelector;
  if (!Array.isArray(selectors) || !selectors.length) return [];
  return selectors.filter(
    (entry) => entry?.notebook === undefined || notebookFilterMatches(entry.notebook, context),
  );
}

function notebookSyncMatches(syncOptions, context) {
  const entries = matchingNotebookSelectors(syncOptions, context);
  return entries.some(
    (entry) =>
      entry.cells === undefined ||
      (Array.isArray(entry.cells) &&
        entry.cells.some(
          (cell) => cell?.language === "*" || context.cellLanguageIds.includes(cell?.language),
        )),
  );
}

// The languages a selector accepts, or null for "every cell of the notebook".
function selectorLanguages(syncOptions, context) {
  const entries = matchingNotebookSelectors(syncOptions, context);
  const languages = new Set();
  for (const entry of entries) {
    if (entry.cells === undefined) return null;
    for (const cell of entry.cells || []) {
      if (cell?.language === "*") return null;
      if (cell?.language) languages.add(cell.language);
    }
  }
  return languages;
}

// One contiguous splice covering the difference between two id orders, plus
// which ids entered and left. A type flip falls out naturally: the id leaves
// one projection and enters the other.
function diffCellOrder(previousIds, nextIds) {
  const previousSet = new Set(previousIds);
  const nextSet = new Set(nextIds);
  const added = nextIds.filter((id) => !previousSet.has(id));
  const removed = previousIds.filter((id) => !nextSet.has(id));
  let start = 0;
  const shortest = Math.min(previousIds.length, nextIds.length);
  while (start < shortest && previousIds[start] === nextIds[start]) start++;
  let previousEnd = previousIds.length;
  let nextEnd = nextIds.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousIds[previousEnd - 1] === nextIds[nextEnd - 1]
  ) {
    previousEnd--;
    nextEnd--;
  }
  const changed = previousEnd > start || nextEnd > start;
  return {
    changed,
    splice: { start, deleteCount: previousEnd - start, ids: nextIds.slice(start, nextEnd) },
    added,
    removed,
  };
}

class NotebookRecord {
  constructor(manager, { filePath, notebookType, metadata, show }) {
    this.manager = manager;
    this.filePath = filePath;
    this.notebookType = notebookType;
    this.metadata = metadata;
    this.show = show;
    this.uri = C.pathToUri(filePath);
    this.version = 1;
    this.cells = [];
    this.cellVersions = new Map();
    this.cellUris = new Map();
    // cellId -> { editor, subscription } for the buffer driving content sync.
    this.contentSync = new Map();
    // cellId -> the editors registered for routing.
    this.routedEditors = new Map();
    // session -> { ids: Set<cellId>, save: boolean }
    this.sessionState = new Map();
    // Adapters currently serving this notebook: added when a session opens
    // it, removed when that session stops or fails. Consumers read actual
    // notebook coverage, so it must go empty when diagnostics can no longer
    // arrive through those sessions.
    this.attachedAdapters = new Set();
    this.updatePromise = null;
    this.disposed = false;
  }

  cellVersion(cellId) {
    return this.cellVersions.get(cellId) ?? 1;
  }

  // A session can see a projection of the notebook's cells, so a logical
  // change may advance one server without producing a notification for
  // another. Keep the last notebook version actually sent to each session for
  // diagnostic staleness checks; the shared counter still advances once per
  // logical change, never once per server.
  versionFor(session) {
    return this.sessionState.get(session)?.version ?? this.version;
  }

  cellIndexOf(cellId) {
    return this.cells.findIndex((cell) => cell.id === cellId);
  }

  uriForCell(cellId) {
    let uri = this.cellUris.get(cellId);
    if (!uri) {
      uri = C.cellUri(this.filePath, cellId);
      this.cellUris.set(cellId, uri);
    }
    return uri;
  }

  primaryEditor(cell) {
    return cell?.editors?.[0] ?? cell?.editor ?? null;
  }

  cellText(cell) {
    return this.primaryEditor(cell)?.getText() ?? cell.text ?? "";
  }

  languageIdOf(cell, adapter) {
    const shim = this.primaryEditor(cell) ?? {
      getGrammar: () => ({ scopeName: cell.scopeName }),
    };
    return languageIdForEditor(adapter, shim);
  }

  // The cells a session syncs: code cells whose language its selector takes.
  syncedCells(session) {
    const languages = selectorLanguages(session.capabilities.notebookDocumentSync, this);
    return this.cells.filter((cell) => {
      if (cell.kind !== "code") return false;
      if (session.needsDocumentTransform(this.primaryEditor(cell)) && !this.primaryEditor(cell))
        return false;
      if (!languages) return true;
      return languages.has(this.languageIdOf(cell, session.adapter));
    });
  }

  toTextDocumentItem(cell, session) {
    const editor = this.primaryEditor(cell);
    const uri = this.uriForCell(cell.id);
    const text = this.cellText(cell);
    return {
      uri,
      languageId: this.languageIdOf(cell, session.adapter),
      version: this.cellVersion(cell.id),
      text: editor ? session.documentText(session.documents.get(C.uriKey(uri))) : text,
    };
  }

  toNotebookCell(cell) {
    return { kind: NOTEBOOK_CELL_KIND[cell.kind] ?? 2, document: this.uriForCell(cell.id) };
  }
}

module.exports = class NotebookDocuments {
  constructor(manager) {
    this.manager = manager;
    this.records = new Set();
    this.subscriptions = new CompositeDisposable(
      manager.onDidChangeSession(({ session, state }) => {
        if (state !== "stopped" && state !== "failed") return;
        for (const record of this.records) {
          // A dead session's diagnostics are gone with it, so the adapter no
          // longer serves the notebook and a stood-down CLI route must come
          // back. A restart re-opens the notebook through the reattach hook,
          // which re-adds the adapter as soon as it is really serving again.
          if (record.sessionState.delete(session)) {
            record.attachedAdapters.delete(session.adapter);
          }
        }
      }),
    );
  }

  // Opens a notebook for language servers. Returns a bridge, or null for a
  // notebook that has no path yet — an untitled notebook attaches on first
  // save, by being opened again. The bridge is path-immutable: a save-as is a
  // dispose and a fresh open, matching how servers treat a renamed notebook.
  open({ filePath, notebookType = "jupyter-notebook", cells = [], metadata, show }) {
    if (!filePath) return null;
    const record = new NotebookRecord(this.manager, { filePath, notebookType, metadata, show });
    this.records.add(record);
    this.applyCells(record, cells).catch(() => {});
    const attach = this.ensureAttached(record);
    attach.catch(() => {});
    return {
      notebookUri: record.uri,
      uriForCell: (cellId) => record.uriForCell(cellId),
      attached: attach,
      updateCells: (nextCells) => this.updateCells(record, nextCells),
      didSave: () => this.didSave(record),
      dispose: () => this.disposeRecord(record),
    };
  }

  async reattachAll() {
    for (const record of [...this.records]) {
      await this.ensureAttached(record).catch(() => {});
    }
  }

  hasDemand(controller) {
    for (const record of this.records) {
      if (record.disposed) continue;
      const rootPath = this.manager.rootForPath(record.filePath, controller.adapter);
      if (this.manager.controllerForRoute(controller.adapter, rootPath) !== controller) continue;
      for (const cell of record.cells) {
        if (cell.kind !== "code") continue;
        const editor = record.primaryEditor(cell);
        if (editor && this.manager.adaptersForEditor(editor).includes(controller.adapter))
          return true;
      }
    }
    return false;
  }

  // The adapters whose sessions serve an open notebook. Empty when no bridge
  // is open for the path, which is also the answer when nothing bridges
  // notebooks.
  adaptersForNotebook(filePath) {
    for (const record of this.records) {
      if (record.filePath === filePath) return [...record.attachedAdapters];
    }
    return [];
  }

  dispose() {
    for (const record of [...this.records]) this.disposeRecord(record);
    this.subscriptions.dispose();
  }

  // Reconciles the record to a new ordered cell list: routing registrations,
  // content-sync subscriptions, and the per-session structure deltas.
  async applyCells(record, nextCells) {
    if (record.disposed) return;
    const previous = record.cells;
    const previousById = new Map(previous.map((cell) => [cell.id, cell]));
    record.cells = nextCells.map((cell) => ({ ...cell }));
    this.manager.emitter.emit("did-change-notebook", { record });
    const nextById = new Map(record.cells.map((cell) => [cell.id, cell]));

    // Routing: every live editor of a code cell answers to the cell URI. The
    // first editor is the binding's face — the buffer edits apply to.
    for (const [cellId, editors] of [...record.routedEditors]) {
      const cell = nextById.get(cellId);
      const keep = cell?.kind === "code" ? new Set(this.editorsOf(cell)) : new Set();
      for (const editor of editors) {
        if (!keep.has(editor)) this.manager.workspaceDocuments.unbind(editor, record);
      }
      if (!keep.size) record.routedEditors.delete(cellId);
    }
    // An editor-less cell's binding lives only in the URI map — no editor to
    // unregister through — so its removal has to clear that entry itself.
    for (const cell of previous) {
      if (nextById.get(cell.id)?.kind === "code") continue;
      const uri = record.uriForCell(cell.id);
      const binding = this.manager.workspaceDocuments.bindingForUri(uri);
      if (binding?.record === record && !binding.editor)
        this.manager.workspaceDocuments.unbindUri(uri, record);
    }
    for (const cell of record.cells) {
      if (cell.kind !== "code") continue;
      const editors = this.editorsOf(cell);
      const binding = {
        editor: editors[0] ?? null,
        uri: record.uriForCell(cell.id),
        cellId: cell.id,
        record,
      };
      for (const editor of editors) this.manager.workspaceDocuments.bind(editor, binding);
      if (!editors.length) this.manager.workspaceDocuments.bindUri(binding);
      record.routedEditors.set(cell.id, editors);
      if (!record.cellVersions.has(cell.id)) record.cellVersions.set(cell.id, 1);
    }

    // Content sync follows the primary editor's buffer. A cell whose editor
    // just appeared (or changed identity) gets one full-text change so the
    // server's copy is grounded in the buffer before increments resume.
    for (const [cellId, entry] of [...record.contentSync]) {
      const cell = nextById.get(cellId);
      const editor = cell?.kind === "code" ? record.primaryEditor(cell) : null;
      if (entry.editor !== editor) {
        entry.subscription.dispose();
        record.contentSync.delete(cellId);
      }
    }
    const grounding = [];
    for (const cell of record.cells) {
      if (cell.kind !== "code") continue;
      const editor = record.primaryEditor(cell);
      if (!editor || record.contentSync.has(cell.id)) continue;
      const subscription = editor.getBuffer().onDidChangeText((event) => {
        this.cellContentDidChange(record, cell.id, event);
      });
      record.contentSync.set(cell.id, { editor, subscription });
      // Ground the server's copy, unless the cell is brand new — its didOpen
      // below carries this very text.
      if (previousById.has(cell.id)) grounding.push({ cellId: cell.id, editor });
      // A cell adopted before etch built its editor holds editor: null in each
      // session's document map; the arrival has to reach those documents too.
      for (const [session, state] of record.sessionState) {
        if (!state.ids.has(cell.id)) continue;
        const document = session.documents.get(C.uriKey(record.uriForCell(cell.id)));
        if (document?.notebook === record) document.editor = editor;
      }
    }

    // Structure deltas, per session over its own projection. Compute every
    // projection first, then advance the logical notebook exactly once: the
    // number and iteration order of attached servers must not change its
    // version.
    const sessionChanges = [];
    for (const [session, state] of record.sessionState) {
      const synced = record.syncedCells(session);
      const nextIds = synced.map((cell) => cell.id);
      const diff = diffCellOrder([...state.ids], nextIds);
      const languages = new Map(
        synced.map((cell) => [cell.id, record.languageIdOf(cell, session.adapter)]),
      );
      const reopened = nextIds.filter(
        (id) => state.ids.has(id) && state.languages?.get(id) !== languages.get(id),
      );
      if (reopened.length) {
        const indexes = reopened.map((id) => nextIds.indexOf(id));
        let start = Math.min(...indexes);
        let end = Math.max(...indexes) + 1;
        let deleteCount = end - start;
        // Reopening a language-changed cell replaces its array entry as well
        // as its text document. Widen an existing splice rather than losing
        // simultaneous insertions, removals or moves outside that entry.
        if (diff.changed) {
          const previousEnd = diff.splice.start + diff.splice.deleteCount;
          const nextEnd = diff.splice.start + diff.splice.ids.length;
          start = Math.min(start, diff.splice.start);
          end = Math.max(end, nextEnd);
          deleteCount = previousEnd + end - nextEnd - start;
        }
        diff.changed = true;
        diff.splice = { start, deleteCount, ids: nextIds.slice(start, end) };
      }
      if (!diff.changed && !diff.added.length && !diff.removed.length && !reopened.length) continue;
      const syncedById = new Map(synced.map((cell) => [cell.id, cell]));
      sessionChanges.push({
        session,
        state,
        nextIds,
        diff,
        languages,
        reopened,
        syncedById,
      });
    }
    if (!sessionChanges.length) {
      for (const { cellId, editor } of grounding) this.sendFullCellText(record, cellId, editor);
      return;
    }
    const version = ++record.version;
    let finishStructure;
    const structural = new Promise((resolve) => (finishStructure = resolve));
    record.structurePromise = structural;
    try {
      await this.synchronizeStructure(record, sessionChanges, version);
      for (const { cellId, editor } of grounding) this.sendFullCellText(record, cellId, editor);
    } finally {
      if (record.structurePromise === structural) record.structurePromise = null;
      finishStructure();
    }
  }

  async synchronizeStructure(record, sessionChanges, version) {
    for (const {
      session,
      state,
      nextIds,
      diff,
      languages,
      reopened,
      syncedById,
    } of sessionChanges) {
      const opening = [...diff.added, ...reopened].map((id) => syncedById.get(id));
      if (!(await this.prepareCells(record, session, state, opening))) continue;
      session.changeNotebook(
        { uri: record.uri, version },
        {
          cells: {
            structure: {
              array: {
                start: diff.splice.start,
                deleteCount: diff.splice.deleteCount,
                cells: diff.splice.ids.map((id) => record.toNotebookCell(syncedById.get(id))),
              },
              didOpen: [...diff.added, ...reopened].map((id) =>
                record.toTextDocumentItem(syncedById.get(id), session),
              ),
              didClose: [...diff.removed, ...reopened].map((id) => ({
                uri: record.uriForCell(id),
              })),
            },
          },
        },
      );
      for (const id of diff.removed) this.releaseCell(record, session, state, id);
      state.ids = new Set(nextIds);
      state.languages = languages;
      state.version = version;
      // The same stored diagnostics name different cells now; re-project them.
      this.manager.republishStoredDiagnostics(
        session,
        nextIds.map((id) => C.uriKey(record.uriForCell(id))),
      );
    }
  }

  editorsOf(cell) {
    if (Array.isArray(cell.editors)) return cell.editors.filter(Boolean);
    return cell.editor ? [cell.editor] : [];
  }

  async updateCells(record, nextCells) {
    if (record.disposed) return;
    const cells = nextCells.map((cell) => ({ ...cell }));
    return this.enqueueUpdate(record, async () => {
      // A structural update cannot overtake the initial open. Serializing
      // mutations also keeps every diff based on the last structure sent,
      // rather than abandoning an older update after it adopted documents.
      await Promise.all([...record.sessionState.values()].map((state) => state.openPromise));
      await this.waitForCellSync(record);
      if (record.disposed) return;
      await this.applyCells(record, cells);
      await this.ensureAttached(record);
    });
  }

  enqueueUpdate(record, update) {
    const pending = (record.updatePromise || Promise.resolve()).then(() => {
      if (!record.disposed) return update();
    });
    // A failed projection does not poison subsequent edits or saves. Keep the
    // caller's rejection while the queue itself remains ready for new work.
    record.updatePromise = pending.catch(() => {});
    return pending;
  }

  waitForCellSync(record) {
    return Promise.all(
      [...record.sessionState.keys()].flatMap((session) =>
        [...session.documents.values()]
          .filter((document) => document.notebook === record)
          .map((document) => document.syncPromise),
      ),
    );
  }

  sessionCurrent(record, session, state) {
    return (
      !record.disposed && session.state === "running" && record.sessionState.get(session) === state
    );
  }

  releaseCell(record, session, state, id) {
    if (!state.adoptedIds.delete(id)) return;
    const uri = record.uriForCell(id);
    if (session.documents.get(C.uriKey(uri))?.notebook === record) session.releaseNotebookCell(uri);
  }

  async prepareCells(record, session, state, cells) {
    if (!this.sessionCurrent(record, session, state)) return false;
    const added = cells.filter((cell) => !state.adoptedIds.has(cell.id));
    try {
      for (const cell of cells) {
        state.adoptedIds.add(cell.id);
        session.adoptNotebookCell({
          record,
          cellId: cell.id,
          editor: record.primaryEditor(cell),
          uri: record.uriForCell(cell.id),
        });
        const document = session.documents.get(C.uriKey(record.uriForCell(cell.id)));
        if (document && added.includes(cell) && record.updatePromise)
          document.openPromise = record.updatePromise;
      }
      const prepared = await Promise.all(
        cells.map((cell) =>
          session.prepareDocumentProjection(
            session.documents.get(C.uriKey(record.uriForCell(cell.id))),
          ),
        ),
      );
      if (this.sessionCurrent(record, session, state) && prepared.every(Boolean)) return true;
    } catch (error) {
      for (const cell of added) this.releaseCell(record, session, state, cell.id);
      throw error;
    }
    for (const cell of added) this.releaseCell(record, session, state, cell.id);
    return false;
  }

  cellContentDidChange(record, cellId, event) {
    if (record.disposed) return;
    this.manager.emitter.emit("did-change-notebook", { record });
    record.cellVersions.set(cellId, record.cellVersion(cellId) + 1);
    record.version++;
    const uri = record.uriForCell(cellId);
    const contentChanges = event.changes.toReversed().map((change) => ({
      range: C.rangeToLsp(change.oldRange),
      rangeLength: change.oldText?.length,
      text: change.newText,
    }));
    const cell = record.cells.find((candidate) => candidate.id === cellId);
    this.sendCellChange(record, cellId, uri, contentChanges, record.primaryEditor(cell));
  }

  sendFullCellText(record, cellId, editor) {
    record.cellVersions.set(cellId, record.cellVersion(cellId) + 1);
    record.version++;
    this.sendCellChange(
      record,
      cellId,
      record.uriForCell(cellId),
      [{ text: editor.getText() }],
      editor,
    );
  }

  sendCellChange(record, cellId, uri, contentChanges, editor) {
    const version = record.version;
    const cellVersion = record.cellVersion(cellId);
    for (const [session, state] of record.sessionState) {
      // The opening frame takes the latest cell text and versions. An edit
      // while its projection is being prepared is already included there;
      // sending its increment now would precede the document it changes.
      if (!state.wireOpen || !state.ids.has(cellId)) continue;
      if (session.needsDocumentTransform(editor)) {
        if (!editor) continue;
        this.queueProjectedCellChange(record, session, state, cellId, editor);
        continue;
      }
      const send = () => {
        if (!this.sessionCurrent(record, session, state) || !state.ids.has(cellId)) return;
        state.version = version;
        session.changeNotebook(
          { uri: record.uri, version },
          {
            cells: {
              textContent: [{ document: { uri, version: cellVersion }, changes: contentChanges }],
            },
          },
        );
      };
      if (record.structurePromise) record.structurePromise.then(send);
      else send();
    }
  }
  queueProjectedCellChange(record, session, state, cellId, editor) {
    const uri = record.uriForCell(cellId);
    const document = session.documents.get(C.uriKey(uri));
    if (!document) return;
    document.editor = editor;
    document.changePending = true;
    if (document.syncPromise) return;
    const pending = (async () => {
      await record.structurePromise;
      await state.openPromise;
      while (
        document.changePending &&
        !record.disposed &&
        state.ids.has(cellId) &&
        session.isCurrentDocument(document)
      ) {
        if (!(await session.prepareDocumentProjection(document))) return;
        document.changePending = false;
        state.version = record.version;
        session.changeNotebook(
          { uri: record.uri, version: record.version },
          {
            cells: {
              textContent: [
                {
                  document: { uri, version: record.cellVersion(cellId) },
                  changes: [{ text: session.documentText(document) }],
                },
              ],
            },
          },
        );
      }
    })()
      .catch((error) =>
        this.manager.log(session, `Unable to synchronize notebook projection: ${error.message}`),
      )
      .finally(() => {
        if (document.syncPromise === pending) document.syncPromise = null;
      });
    document.syncPromise = pending;
  }

  // Finds or starts a capable session per adapter covering the notebook's
  // cells, and opens the notebook on each one that has not seen it yet.
  async ensureAttached(record) {
    if (record.disposed) return;
    const adapters = new Map();
    for (const cell of record.cells) {
      if (cell.kind !== "code") continue;
      const editor = record.primaryEditor(cell);
      if (!editor) continue;
      for (const adapter of this.manager.adaptersForEditor(editor))
        adapters.set(adapter.id, adapter);
    }
    for (const adapter of adapters.values()) {
      const rootPath = this.manager.rootForPath(record.filePath, adapter);
      let session;
      try {
        session = await this.manager.ensureSession(adapter, rootPath, {
          filePath: record.filePath,
        });
      } catch {
        continue;
      }
      if (!session) continue;
      try {
        await session.ready;
      } catch (error) {
        // The text-editor attach path removes an initial session that failed to
        // start; notebook-only sessions need the same ownership cleanup. Do it
        // only while this exact generation still owns the route, so a late
        // rejection cannot remove a replacement that already won the race.
        if (this.manager.sessionForRoute(adapter, rootPath) === session) {
          this.manager.forget(session);
          await this.manager.stopSession(session);
          this.manager.reportStartFailure(adapter, rootPath, error);
        }
        continue;
      }
      if (record.disposed) return;
      if (this.manager.sessions.get(this.manager.keyFor(adapter, rootPath)) !== session) continue;
      if (record.sessionState.has(session)) continue;
      const syncOptions = session.capabilities.notebookDocumentSync;
      const cellLanguageIds = record.cells
        .filter((cell) => cell.kind === "code")
        .map((cell) => record.languageIdOf(cell, adapter));
      if (
        !notebookSyncMatches(syncOptions, {
          notebookType: record.notebookType,
          filePath: record.filePath,
          cellLanguageIds,
        })
      )
        continue;
      await this.openNotebookOn(record, session, syncOptions);
    }
  }

  openNotebookOn(record, session, syncOptions) {
    const synced = record.syncedCells(session);
    const state = {
      ids: new Set(synced.map((cell) => cell.id)),
      languages: new Map(
        synced.map((cell) => [cell.id, record.languageIdOf(cell, session.adapter)]),
      ),
      save: !!syncOptions.save,
      version: record.version,
      adoptedIds: new Set(),
      wireOpen: false,
    };
    record.sessionState.set(session, state);
    state.openPromise = (async () => {
      if (!(await this.prepareCells(record, session, state, synced))) return;
      session.openNotebook(
        {
          uri: record.uri,
          notebookType: record.notebookType,
          version: record.version,
          ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
          cells: synced.map((cell) => record.toNotebookCell(cell)),
        },
        synced.map((cell) => record.toTextDocumentItem(cell, session)),
      );
      state.wireOpen = true;
      state.version = record.version;
      record.attachedAdapters.add(session.adapter);
    })().finally(() => {
      if (state.wireOpen || record.sessionState.get(session) !== state) return;
      for (const id of [...state.adoptedIds]) this.releaseCell(record, session, state, id);
      record.sessionState.delete(session);
      record.attachedAdapters.delete(session.adapter);
    });
    for (const cell of synced) {
      const document = session.documents.get(C.uriKey(record.uriForCell(cell.id)));
      if (document) document.openPromise = state.openPromise;
    }
    return state.openPromise;
  }

  didSave(record) {
    if (record.disposed) return;
    const saved = this.enqueueUpdate(record, async () => {
      await this.waitForCellSync(record);
      for (const [session, state] of record.sessionState) {
        await state.openPromise;
        if (state.save && state.wireOpen && this.sessionCurrent(record, session, state))
          session.saveNotebook({ uri: record.uri });
      }
    });
    saved.catch(() => {});
    return saved;
  }

  disposeRecord(record) {
    if (record.disposed) return;
    record.disposed = true;
    for (const [session, state] of record.sessionState) {
      if (state.wireOpen)
        session.closeNotebook(
          { uri: record.uri },
          [...state.ids].map((id) => ({ uri: record.uriForCell(id) })),
        );
      // Releasing publishes empty diagnostics per cell, which is what evicts
      // the notebook's messages from the linter.
      for (const id of [...state.adoptedIds]) this.releaseCell(record, session, state, id);
    }
    record.sessionState.clear();
    for (const entry of record.contentSync.values()) entry.subscription.dispose();
    record.contentSync.clear();
    for (const editors of record.routedEditors.values()) {
      for (const editor of editors) this.manager.workspaceDocuments.unbind(editor, record);
    }
    for (const uri of record.cellUris.values()) {
      this.manager.workspaceDocuments.unbindUri(uri, record);
    }
    record.routedEditors.clear();
    this.records.delete(record);
    this.manager.pruneUndemandedControllers();
  }
};

module.exports.notebookSyncMatches = notebookSyncMatches;
module.exports.selectorLanguages = selectorLanguages;
module.exports.diffCellOrder = diffCellOrder;
