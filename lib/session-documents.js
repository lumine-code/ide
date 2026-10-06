const { CompositeDisposable } = require("lumine");
const C = require("./converters");
const Projections = require("./document-projections");
const { languageIdForEditor } = require("./language-ids");

// Each session generation owns its wire documents and synchronization tasks.
// Workspace routing decides which editors belong here; this component owns
// their subscriptions, protocol order, projections and retirement.
module.exports = class SessionDocuments {
  constructor(session) {
    this.session = session;
    this.items = new Map();
    this.projectedDocuments = new Set();
    this.temporaryDocumentUris = new Set();
    this.temporaryDocuments = new Map();
    this.temporaryDocumentQueue = null;
    this.disposed = false;
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
    document.syncAbortController ??= new AbortController();
    while (this.isCurrentDocument(document)) {
      if (!(await this.waitForDocumentGrammar(document))) return false;
      const version = document.version;
      const editor = document.editor;
      if (this.session.adapter.getDocumentProjection) {
        let projection;
        try {
          projection = await this.session.adapter.getDocumentProjection(editor, {
            uri: document.uri,
            signal: document.syncAbortController.signal,
          });
        } catch (error) {
          if (this.isCurrentDocument(document)) this.closeDocument(document.uri);
          throw error;
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
    const snapshots = new Map();
    for (const document of [...this.items.values(), ...this.temporaryDocuments.values()]) {
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
    if (!this.needsDocumentTransform(editor) || !this.session.adapter.getDocumentProjection)
      return null;
    const document = this.items.get(C.uriKey(uri));
    if (document) return this.currentDocumentProjection(editor);
    if ((await editor.whenGrammarSettled?.()) === false)
      throw new Error("Language server document projection is unavailable");
    const projection = await this.session.adapter.getDocumentProjection(editor, { uri });
    if (!projection?.isCurrent?.())
      throw new Error("Language server document projection is unavailable");
    return projection;
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
    if (this.disposed || this.session.state !== "running") return;
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
    if (existing) return existing.openPromise;
    const sync = this.textDocumentSyncOptions();
    const document = {
      editor,
      uri,
      version: 1,
      wireOpen: false,
      subscriptions: new CompositeDisposable(),
    };
    if (this.needsDocumentTransform(editor)) document.syncAbortController = new AbortController();
    this.items.set(key, document);
    document.openPromise = (async () => {
      if (!(await this.prepareDocumentProjection(document))) return;
      if (!this.isCurrentDocument(document) || !sync.openClose) return;
      document.wireOpen = true;
      document.wireProjection = document.projection;
      document.wireSourceVersion = document.version;
      await this.session.connection.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdForEditor(this.session.adapter, editor),
          version: 1,
          text: this.documentText(document),
        },
      });
    })();
    this.session.scheduleDiagnostics(document, 0);
    if (sync.change !== 0)
      document.subscriptions.add(
        editor.getBuffer().onDidChangeText((event) => this.changeDocument(document, event)),
      );
    if (sync.save)
      document.subscriptions.add(
        editor.onDidSave(() => {
          this.saveDocument(document, sync).catch((error) =>
            this.session.manager.log(
              this.session,
              `Unable to synchronize saved document: ${error.message}`,
            ),
          );
        }),
      );
    document.subscriptions.add(editor.onDidDestroy(() => this.closeDocument(uri, document)));
    await document.openPromise;
  }
  async waitForDocumentSync(document, signal) {
    signal?.throwIfAborted();
    const synchronized = (async () => {
      await document.openPromise;
      while (document.syncPromise) await document.syncPromise;
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
  detachEditor(editor) {
    // Notebook cell documents are owned by the notebook module; routing one
    // through closeDocument would emit a protocol-violating textDocument/didClose.
    for (const document of [...this.items.values()])
      if (document.editor === editor && !document.notebook) this.closeDocument(document.uri);
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
    if (this.temporaryDocuments.has(key) || (key === C.uriKey(item.uri) && this.items.has(key)))
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
      return C.uriKey(uri) + parsed.search + parsed.hash;
    } catch {
      return C.uriKey(uri);
    }
  }
  async waitForDocumentGrammar(document) {
    while (this.isCurrentDocument(document)) {
      const version = document.version;
      const settled = await document.editor.whenGrammarSettled?.({
        signal: document.syncAbortController.signal,
      });
      if (!this.isCurrentDocument(document)) return false;
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
  changeDocument(document, event) {
    if (!this.isCurrentDocument(document) || document.notebook) return;
    const sync = this.textDocumentSyncOptions().change;
    if (sync === 0) return;
    document.version++;
    if (this.needsDocumentTransform(document.editor) || document.projection) {
      if (sync === 2) {
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
    if (this.needsDocumentTransform(document.editor) || document.projection) {
      await this.waitForDocumentSync(document);
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
