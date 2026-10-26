const { CompositeDisposable } = require("lumine");
const C = require("./converters");
const Projections = require("./document-projections");
const { languageIdForEditor } = require("./language-ids");
const DocumentMap = require("./document-map");
const observeEditorRequest = require("./observe-editor-request");

async function cancellableProjection(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return null;
  }
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        abort = () => resolve(null);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

// Each session generation owns its wire documents and synchronization tasks.
// Workspace routing decides which editors belong here; this component owns
// their subscriptions, protocol order, projections and retirement.
module.exports = class SessionDocuments {
  constructor(session) {
    this.session = session;
    this.items = this.documentMap();
    this.projectedDocuments = new Set();
    this.temporaryDocumentUris = new Set();
    this.temporaryDocuments = new Map();
    this.temporaryDocumentQueue = null;
    this.disposed = false;
  }
  documentMap(entries) {
    return new DocumentMap(this.session.adapter.caseSensitiveFileNames, entries);
  }
  transformDocumentText(text, editor, uri) {
    return this.session.adapter.transformDocumentText?.(text, { editor, uri }) ?? text;
  }
  needsDocumentTransform(editor) {
    return (
      !!(
        this.session.adapter.getDocumentProjection || this.session.adapter.transformDocumentText
      ) && this.session.adapter.needsDocumentTransform?.(editor) !== false
    );
  }
  async prepareDocumentProjection(document) {
    if (!this.isCurrentDocument(document)) return false;
    if (!this.needsDocumentTransform(document.editor)) {
      document.projection = null;
      this.projectedDocuments.delete(document);
      return this.isCurrentDocument(document);
    }
    if (!document.syncAbortController || document.syncAbortController.signal.aborted)
      document.syncAbortController = new AbortController();
    while (this.isCurrentDocument(document)) {
      if (!(await this.waitForDocumentGrammar(document))) return false;
      const version = document.version;
      const editor = document.editor;
      if (this.session.adapter.getDocumentProjection) {
        let projection;
        const controller = document.syncAbortController;
        const grammarSubscription = editor.onDidChangeGrammar(() => controller.abort());
        try {
          projection = await cancellableProjection(
            this.session.adapter.getDocumentProjection(editor, {
              uri: document.uri,
              signal: controller.signal,
            }),
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) {
            if (editor.getGrammar?.() === lumine.grammars.nullGrammar) return false;
            throw error;
          }
          if (editor !== document.editor || version !== document.version) continue;
          if (this.isCurrentDocument(document)) this.closeDocument(document.uri);
          throw error;
        } finally {
          grammarSubscription.dispose();
        }
        if (controller.signal.aborted) {
          if (editor.getGrammar?.() === lumine.grammars.nullGrammar) return false;
          throw controller.signal.reason;
        }
        if (!this.isCurrentDocument(document)) return false;
        if (
          !projection ||
          typeof projection.text !== "string" ||
          typeof projection.isCurrent !== "function"
        ) {
          this.closeDocument(document.uri);
          throw new Error("Language server document projection is unavailable");
        }
        if (version !== document.version || editor !== document.editor || !projection.isCurrent())
          continue;
        document.projection = projection;
        this.projectedDocuments.add(document);
      }
      if (version === document.version) return true;
    }
    return false;
  }
  documentText(document) {
    if (document.temporary) return document.text;
    if (document.projection) {
      if (!document.projection.isCurrent()) throw new Projections.StaleProjectionError();
      return document.projection.text;
    }
    return this.transformDocumentText(this.sourceText(document), document.editor, document.uri);
  }
  sourceText(document) {
    if (document.temporary) return document.text;
    if (document.editor) return document.editor.getText();
    const cell = document.notebook?.cells?.find((item) => item.id === document.cellId);
    return (cell && document.notebook.cellText?.(cell)) ?? cell?.text ?? "";
  }
  requestDocumentSnapshots() {
    const snapshots = this.documentMap();
    for (const document of [...this.items.values(), ...this.temporaryDocuments.values()]) {
      if (document.editor?.getGrammar?.() === lumine.grammars.nullGrammar) continue;
      const version = document.version;
      const editor = document.editor;
      const source = this.sourceText(document);
      const text = this.documentText(document);
      snapshots.set(
        C.uriKey(document.uri),
        Object.freeze({
          uri: document.uri,
          text,
          version,
          isCurrent: () =>
            this.isCurrentDocument(document) &&
            document.version === version &&
            document.editor === editor &&
            this.sourceText(document) === source &&
            (!document.projection || document.projection.isCurrent()),
        }),
      );
    }
    return snapshots;
  }
  async currentDocumentProjection(editor) {
    const uri = this.session.manager.uriForEditor(editor);
    const document = uri && this.items.get(C.uriKey(uri));
    if (!document) return null;
    await this.waitForDocumentSync(document);
    if (!this.isCurrentDocument(document)) return null;
    if (this.needsDocumentTransform(editor) && !document.projection?.isCurrent?.()) {
      if (!(await this.prepareDocumentProjection(document))) return null;
    }
    return document.projection ?? null;
  }
  async projectionForEdits(editor, uri) {
    if (editor.isDestroyed?.() || editor.getGrammar?.() === lumine.grammars.nullGrammar)
      throw new Projections.StaleProjectionError();
    const controller = new AbortController();
    const subscriptions = observeEditorRequest(editor, controller);
    const current = () =>
      !controller.signal.aborted &&
      !editor.isDestroyed?.() &&
      editor.getGrammar?.() !== lumine.grammars.nullGrammar;
    try {
      const needed =
        this.needsDocumentTransform(editor) && this.session.adapter.getDocumentProjection;
      if (!current()) throw new Projections.StaleProjectionError();
      if (!needed) return null;
      const document = this.items.get(C.uriKey(uri));
      let projection;
      if (document) {
        projection = await cancellableProjection(
          this.currentDocumentProjection(editor),
          controller.signal,
        );
      } else {
        const settled = await cancellableProjection(
          editor.whenGrammarSettled?.(),
          controller.signal,
        );
        if (!current()) throw new Projections.StaleProjectionError();
        if (settled === false)
          throw new Error("Language server document projection is unavailable");
        projection = await cancellableProjection(
          this.session.adapter.getDocumentProjection(editor, { uri, signal: controller.signal }),
          controller.signal,
        );
      }
      if (!current()) throw new Projections.StaleProjectionError();
      if (!projection?.isCurrent?.() || !current())
        throw new Error("Language server document projection is unavailable");
      return projection;
    } finally {
      subscriptions.dispose();
    }
  }
  async withTemporaryDocument(item, callback, { signal } = {}) {
    const previous = this.temporaryDocumentQueue;
    const queued = (async () => {
      await previous;
      return this.openTemporaryDocument(item, callback, { signal });
    })();
    const tail = queued.then(
      () => {},
      () => {},
    );
    this.temporaryDocumentQueue = tail;
    try {
      return await queued;
    } finally {
      if (this.temporaryDocumentQueue === tail) this.temporaryDocumentQueue = null;
    }
  }
  isTemporaryDocumentUri(uri) {
    return this.temporaryDocumentUris.has(this.temporaryDocumentKey(uri));
  }
  isCurrentDocument(document) {
    return (
      !!document &&
      !this.disposed &&
      this.session.state === "running" &&
      (document.temporary
        ? this.temporaryDocuments.get(this.temporaryDocumentKey(document.uri))
        : this.items.get(C.uriKey(document.uri))) === document &&
      !document.editor?.isDestroyed?.() &&
      document.editor?.getGrammar?.() !== lumine.grammars.nullGrammar &&
      !document.notebook?.disposed &&
      (!document.notebook?.cells ||
        document.notebook.cells.some((cell) => cell.id === document.cellId))
    );
  }
  restoreDocumentText(text, editor, uri) {
    return this.session.adapter.restoreDocumentText?.(text, { editor, uri }) ?? text;
  }
  textDocumentSyncOptions() {
    const declared = this.session.capabilities.textDocumentSync;
    if (typeof declared === "number") {
      return {
        openClose: declared !== 0,
        change: declared,
        save: false,
        includeText: false,
      };
    }
    const save = declared && typeof declared === "object" ? declared.save : false;
    return {
      openClose: !!declared?.openClose,
      change: declared?.change ?? 0,
      save: save === true || !!(save && typeof save === "object"),
      includeText: !!(save && typeof save === "object" && save.includeText),
    };
  }
  async openEditor(editor) {
    if (this.disposed || this.session.state !== "running" || editor.isDestroyed?.()) return;
    if (editor.getGrammar?.() === lumine.grammars.nullGrammar) return;
    // A cell editor is synced through the notebookDocument notifications; a
    // misrouted call here would double-open it as a plain text document.
    if (this.session.manager.workspaceDocuments.bindingFor(editor)) return;
    const uri = this.session.manager.uriForEditor(editor);
    if (!uri) return;
    const key = C.uriKey(uri);
    const existing = this.items.get(key);
    // A feature request can join the manager's ordinary attachment while the
    // didOpen frame is still being written. Merely seeing the document in the
    // map is not enough: requests about it must remain ordered after didOpen.
    if (existing) {
      if (this.isCurrentDocument(existing)) {
        this.retainEditor(existing, editor);
        this.useEditor(existing, editor);
        return this.waitForDocumentSync(existing);
      }
      this.closeDocument(uri, existing);
    }
    const sync = this.textDocumentSyncOptions();
    const document = {
      editor,
      uri,
      source: editor.getText(),
      version: 1,
      wireOpen: false,
      openPending: true,
      editors: new Map(),
      subscriptions: new CompositeDisposable(),
    };
    if (this.needsDocumentTransform(editor)) document.syncAbortController = new AbortController();
    this.items.set(key, document);
    this.retainEditor(document, editor);
    document.openPromise = (async () => {
      if (!(await this.prepareDocumentProjection(document))) return;
      if (!this.isCurrentDocument(document) || !sync.openClose) return;
      document.wireOpen = true;
      document.wireProjection = document.projection;
      document.wireSourceVersion = document.version;
      await this.session.connection.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdForEditor(this.session.adapter, document.editor),
          version: 1,
          text: this.documentText(document),
        },
      });
    })().finally(() => {
      document.openPending = false;
    });
    this.session.scheduleDiagnostics(document, 0);
    await document.openPromise;
  }
  retainEditor(document, editor) {
    if (document.editors.has(editor)) return;
    if (document.editor.getBuffer() !== editor.getBuffer())
      document.source = document.editor.getText();
    const sync = this.textDocumentSyncOptions();
    const subscriptions = new CompositeDisposable();
    document.editors.set(editor, subscriptions);
    document.subscriptions.add(subscriptions);
    if (sync.change !== 0)
      subscriptions.add(
        editor.getBuffer().onDidChangeText((event) => {
          // Split views share one buffer and emit the same event for every
          // editor. An alias may instead hold a distinct buffer; its edit makes
          // that editor the source and requires a complete replacement.
          if (document.editor.getBuffer() === editor.getBuffer()) {
            if (document.editor === editor) this.changeDocument(document, event);
          } else {
            this.useEditor(document, editor, true);
          }
        }),
      );
    if (sync.save)
      subscriptions.add(
        editor.onDidSave(() => {
          this.useEditor(document, editor);
          this.saveDocument(document, sync).catch((error) =>
            this.session.manager.log(
              this.session,
              `Unable to synchronize saved document: ${error.message}`,
            ),
          );
        }),
      );
    subscriptions.add(
      editor.onDidChangeGrammar(() => {
        if (editor.getGrammar?.() === lumine.grammars.nullGrammar)
          this.releaseEditor(document, editor);
      }),
      editor.onDidDestroy(() => this.releaseEditor(document, editor)),
    );
  }
  useEditor(document, editor, changed = false) {
    if (editor.getGrammar?.() === lumine.grammars.nullGrammar) return;
    if (document.editor === editor || !document.editors.has(editor) || editor.isDestroyed?.())
      return;
    const sourceChanged =
      changed ||
      (document.editor.getBuffer() !== editor.getBuffer() && document.source !== editor.getText());
    const transformed = this.needsDocumentTransform(editor) || !!document.projection;
    document.editor = editor;
    document.source = editor.getText();
    if (!sourceChanged && !transformed) return;
    document.projection = null;
    this.projectedDocuments.delete(document);
    // Ranges from a different buffer or projection cannot be applied to the
    // previous source. The new owner supplies a full synchronized snapshot.
    this.changeDocument(document, { changes: [] }, true);
  }
  editorForUri(document, uri) {
    if (!uri || !document.editors) return document.editor;
    const key = C.uriKey(uri);
    const matches = (editor) =>
      !editor.isDestroyed?.() && C.uriKey(this.session.manager.uriForEditor(editor)) === key;
    if (matches(document.editor)) return document.editor;
    return [...document.editors.keys()].find(matches) ?? document.editor;
  }
  releaseEditor(document, editor) {
    const subscriptions = document.editors?.get(editor);
    if (!subscriptions) return;
    subscriptions.dispose();
    document.subscriptions.remove(subscriptions);
    document.editors.delete(editor);
    if (!document.editors.size) {
      this.closeDocument(document.uri, document);
      return;
    }
    if (document.editor === editor) {
      const replacement = [...document.editors.keys()].find(
        (item) => !item.isDestroyed?.() && item.getGrammar?.() !== lumine.grammars.nullGrammar,
      );
      if (replacement) this.useEditor(document, replacement);
      else this.closeDocument(document.uri, document);
    }
  }
  async waitForDocumentSync(document, signal) {
    signal?.throwIfAborted();
    const synchronized = (async () => {
      await document.openPromise;
      while (this.isCurrentDocument(document)) {
        while (document.syncPromise) await document.syncPromise;
        if (document.projection?.isCurrent() !== false) break;
        this.queueProjectionRefresh(document);
      }
    })();
    if (!signal) return synchronized;
    let onAbort;
    try {
      await Promise.race([
        synchronized,
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  queueProjectionRefresh(document) {
    if (document.syncPromise) return;
    // A grammar or query generation can invalidate a projection without a
    // text edit. Refresh mappings before requests; only changed wire text
    // needs a new LSP version and a full document update.
    const pending = (async () => {
      const version = document.version;
      const previous = document.wireProjection;
      if (!(await this.prepareDocumentProjection(document)) || !this.isCurrentDocument(document))
        return;
      if (version !== document.version) return;
      if (previous?.text === document.projection?.text)
        document.wireProjection = document.projection;
      else {
        document.version++;
        document.pendingProjectionChanges = [];
        document.changePending = true;
      }
    })().finally(() => {
      if (document.syncPromise !== pending) return;
      document.syncPromise = null;
      if (document.changePending && this.isCurrentDocument(document))
        this.queueDocumentChanges(document);
    });
    document.syncPromise = pending;
  }
  detachEditor(editor) {
    // Notebook cell documents are owned by the notebook module; routing one
    // through closeDocument would emit a protocol-violating textDocument/didClose.
    for (const document of [...this.items.values()])
      if (!document.notebook) this.releaseEditor(document, editor);
  }
  closeDocument(uri, expected) {
    const doc = this.items.get(C.uriKey(uri));
    if (!doc || (expected && doc !== expected)) return;
    if (doc.notebook) return this.releaseNotebookCell(uri);
    doc.syncAbortController?.abort();
    doc.projection = null;
    doc.wireProjection = null;
    doc.pendingProjectionChanges = null;
    this.projectedDocuments.delete(doc);
    doc.subscriptions.dispose();
    doc.editors?.clear();
    const key = C.uriKey(doc.uri);
    clearTimeout(this.session.diagnosticTimers.get(key));
    this.session.diagnosticTimers.delete(key);
    // Dynamic pull providers are not reflected in ServerCapabilities. Clear
    // their last report on close just as we do for a static provider, while
    // deliberately bypassing the feature switch: a hidden stored report must
    // not survive the document that owned it.
    doc.diagnosticAbortController?.abort();
    if (this.session.supports("textDocument/diagnostic", doc.editor, null)) {
      this.session.clearDiagnosticReportsForUri(doc.uri);
      this.session.manager.publishDiagnostics(
        this.session,
        {
          uri: doc.uri,
          version: doc.version,
          diagnostics: [],
        },
        true,
      );
    }
    this.items.delete(C.uriKey(uri));
    // Closed under the spelling it was opened with, whoever asked for it.
    if (doc.wireOpen)
      this.session.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
    if (!this.items.size && this.session.state === "running")
      this.session.manager.didCloseDocument(this.session);
  }
  // NotebookDocuments owns cell notifications; adopting a cell only retains
  // its session, projection and diagnostics. The version always follows the
  // counter the notebook stamped on the wire.
  adoptNotebookCell({ record, cellId, editor, uri }) {
    if (this.disposed || this.session.state !== "running") return;
    const key = C.uriKey(uri);
    const existing = this.items.get(key);
    if (existing) {
      // Adopted before etch built the cell's editor; the arrival still counts.
      if (existing.notebook === record && editor) existing.editor = editor;
      return;
    }
    const document = {
      editor,
      uri,
      notebook: record,
      cellId,
      subscriptions: new CompositeDisposable(),
      get version() {
        return record.cellVersion(cellId);
      },
    };
    this.items.set(key, document);
  }
  releaseNotebookCell(uri) {
    const key = C.uriKey(uri);
    const document = this.items.get(key);
    if (!document?.notebook) return;
    document.syncAbortController?.abort();
    document.projection = null;
    this.projectedDocuments.delete(document);
    document.subscriptions.dispose();
    clearTimeout(this.session.diagnosticTimers.get(key));
    this.session.diagnosticTimers.delete(key);
    // Unconditionally, unlike closeDocument's pull-only clear: a push server
    // never clears a closing cell on its own, and a stale diagnostic against a
    // cell that no longer exists has no editor left to correct it.
    this.session.clearDiagnosticReportsForUri(document.uri);
    this.session.manager.publishDiagnostics(
      this.session,
      { uri: document.uri, diagnostics: [] },
      true,
    );
    this.items.delete(key);
    if (!this.items.size && this.session.state === "running")
      this.session.manager.didCloseDocument(this.session);
  }
  async openTemporaryDocument(item, callback, { signal } = {}) {
    if (this.disposed || this.session.state !== "running")
      throw new Error("Language server is not running");
    const key = this.temporaryDocumentKey(item.uri);
    if (
      this.temporaryDocuments.has(key) ||
      (key === this.items.key(item.uri) && this.items.has(key))
    )
      throw new Error("Temporary language server URI is already open");
    this.temporaryDocumentUris.add(key);
    signal?.throwIfAborted();
    const document = {
      uri: item.uri,
      text: item.text,
      version: 1,
      temporary: true,
      wireOpen: false,
      subscriptions: new CompositeDisposable(),
    };
    this.temporaryDocuments.set(key, document);
    try {
      document.openPromise = this.session.connection.notify("textDocument/didOpen", {
        textDocument: { ...item, version: 1 },
      });
      await document.openPromise;
      document.wireOpen = true;
      signal?.throwIfAborted();
      if (!this.isCurrentDocument(document))
        throw new Error("Temporary language server document is no longer open");
      return await callback(item.uri);
    } finally {
      if (this.temporaryDocuments.get(key) === document) {
        document.subscriptions.dispose();
        this.temporaryDocuments.delete(key);
        if (document.wireOpen && this.session.state === "running")
          await this.session.connection.notify("textDocument/didClose", {
            textDocument: { uri: item.uri },
          });
        if (!this.items.size && this.session.state === "running")
          this.session.manager.didCloseDocument(this.session);
      }
    }
  }
  temporaryDocumentKey(uri) {
    try {
      const parsed = new URL(uri);
      return this.items.key(uri) + parsed.search + parsed.hash;
    } catch {
      return this.items.key(uri);
    }
  }
  async waitForDocumentGrammar(document) {
    while (this.isCurrentDocument(document)) {
      const version = document.version;
      const editor = document.editor;
      let settled;
      try {
        settled = await editor.whenGrammarSettled?.({
          signal: document.syncAbortController.signal,
        });
      } catch (error) {
        if (
          this.isCurrentDocument(document) &&
          (editor !== document.editor || version !== document.version)
        )
          continue;
        throw error;
      }
      if (!this.isCurrentDocument(document)) return false;
      if (editor !== document.editor || version !== document.version) continue;
      if (settled === false) {
        // A failed parse cannot supply a trustworthy projection. Withdraw the
        // document so the next request can reopen it after grammar recovery.
        this.closeDocument(document.uri);
        return false;
      }
      if (document.version === version) return true;
    }
    return false;
  }
  changeDocument(document, event, full = false) {
    if (!this.isCurrentDocument(document) || document.notebook) return;
    if (
      document.editors &&
      [...document.editors.keys()].some(
        (editor) => editor.getBuffer() !== document.editor.getBuffer(),
      )
    )
      document.source = document.editor.getText();
    const sync = this.textDocumentSyncOptions().change;
    if (sync === 0) return;
    document.version++;
    if (
      full ||
      !document.wireOpen ||
      this.needsDocumentTransform(document.editor) ||
      document.projection
    ) {
      if (full) document.pendingProjectionChanges = [];
      else if (sync === 2) {
        document.pendingProjectionChanges ??= [];
        document.pendingProjectionChanges.push({
          version: document.version,
          changes: event.changes.toReversed().map((change) => ({
            range: C.rangeToLsp(change.oldRange),
            rangeLength: change.oldText?.length,
            text: change.newText,
          })),
        });
      }
      document.changePending = true;
      this.queueDocumentChanges(document);
      return;
    }
    const contentChanges =
      sync === 1
        ? [
            {
              text: this.transformDocumentText(
                document.editor.getText(),
                document.editor,
                document.uri,
              ),
            },
          ]
        : // TextBuffer reports every oldRange against the document before the
          // transaction, while LSP applies contentChanges sequentially. Sending
          // the highest change first keeps edits below it from shifting its
          // range. This is especially important for multi-hunk reloads after an
          // external tool rewrites a file.
          event.changes.toReversed().map((change) => ({
            range: C.rangeToLsp(change.oldRange),
            rangeLength: change.oldText?.length,
            text: change.newText,
          }));
    this.session.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges,
    });
    this.session.scheduleDiagnostics(document);
    this.session.scheduleWorkspaceDiagnostics();
  }
  // Grammar-backed transforms share a single synchronization task. Original
  // ranges remain incremental only across consecutive identity projections;
  // any transformed snapshot or transition requires full text.
  queueDocumentChanges(document) {
    if (document.syncPromise) return;
    const pending = this.synchronizeDocumentChanges(document)
      .catch((error) => {
        document.changePending = false;
        this.session.manager.log(this.session, `Unable to synchronize document: ${error.message}`);
      })
      .finally(() => {
        if (document.syncPromise !== pending) return;
        document.syncPromise = null;
        if (document.changePending && this.isCurrentDocument(document))
          this.queueDocumentChanges(document);
      });
    document.syncPromise = pending;
  }
  async synchronizeDocumentChanges(document) {
    await document.openPromise;
    while (document.changePending && this.isCurrentDocument(document)) {
      if (!(await this.prepareDocumentProjection(document))) {
        document.changePending = false;
        return;
      }
      const version = document.version;
      const projection = document.projection;
      const pending = document.pendingProjectionChanges || [];
      const unapplied = pending.filter(
        (entry) => entry.version > document.wireSourceVersion && entry.version <= version,
      );
      const useOriginalRanges =
        this.textDocumentSyncOptions().change === 2 &&
        Projections.usesOriginalText(document.wireProjection) &&
        Projections.usesOriginalText(projection) &&
        unapplied.length > 0 &&
        unapplied.length === version - document.wireSourceVersion &&
        unapplied.every((entry, index) => entry.version === document.wireSourceVersion + index + 1);
      const contentChanges = useOriginalRanges
        ? unapplied.flatMap((entry) => entry.changes)
        : [{ text: this.documentText(document) }];
      document.pendingProjectionChanges = pending.filter((entry) => entry.version > version);
      document.changePending = false;
      await this.session.connection.notify("textDocument/didChange", {
        textDocument: { uri: document.uri, version },
        contentChanges,
      });
      if (!this.isCurrentDocument(document)) return;
      document.wireProjection = projection;
      document.wireSourceVersion = version;
      this.session.scheduleDiagnostics(document);
      this.session.scheduleWorkspaceDiagnostics();
    }
  }
  async saveDocument(document, sync) {
    if (!this.isCurrentDocument(document) || document.notebook) return;
    const transformed = this.needsDocumentTransform(document.editor) || document.projection;
    if (document.openPending || document.syncPromise || transformed)
      await this.waitForDocumentSync(document);
    if (transformed) {
      if (!(await this.prepareDocumentProjection(document))) return;
    }
    if (!this.isCurrentDocument(document)) return;
    const params = { textDocument: { uri: document.uri } };
    if (sync.includeText) params.text = this.documentText(document);
    this.session.notify("textDocument/didSave", params);
  }
  dispose() {
    this.disposed = true;
    let failure;
    for (const document of [...this.items.values(), ...this.temporaryDocuments.values()]) {
      try {
        document.syncAbortController?.abort();
        document.subscriptions.dispose();
        document.editors?.clear();
      } catch (error) {
        failure ||= error;
      }
    }
    this.items.clear();
    this.temporaryDocuments.clear();
    this.temporaryDocumentUris.clear();
    this.projectedDocuments.clear();
    this.temporaryDocumentQueue = null;
    if (failure) throw failure;
  }
};
