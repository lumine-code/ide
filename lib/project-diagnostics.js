const path = require("path");
const { CompositeDisposable } = require("lumine");
const {
  currentSource,
  savedCells: parseSavedCells,
  sameSource,
} = require("./notebook-diagnostic-source");
let converters;
const C = new Proxy({}, { get: (_target, name) => (converters ||= require("./converters"))[name] });

const pathKey = (filePath) => {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

// Manual scans cover files the server has never opened. Keep their complete
// snapshot so stopping diagnostics can restore it without another scan. A
// registered adapter alone says nothing about whether its server analyzed a
// document: only an accepted report from a running, enabled session owns it.
module.exports = class ProjectDiagnostics {
  constructor(manager, adapterId, delegate) {
    this.manager = manager;
    this.adapterId = adapterId;
    this.delegate = delegate;
    this.messages = [];
    this.notebookSnapshots = new Map();
    this.notebookRecords = new Map();
    this.parsedNotebookSnapshots = new Map();
    this.hasSnapshot = false;
    this.disposed = false;
    this.refreshPending = false;
    this.subscriptions = new CompositeDisposable();
    const changed = ({ session, adapter } = {}) => {
      if ((session?.adapter || adapter)?.id === adapterId) this.scheduleRefresh();
    };
    this.subscriptions.add(
      manager.onDidPublishDiagnostics(changed),
      manager.onDidChangeSession(changed),
      manager.onDidChangeFeatures(changed),
      manager.onDidChangeAdapters(changed),
      manager.onDidChangeCapabilities(changed),
      manager.onDidChangeNotebook(() => {
        if (this.hasSnapshot && !this.disposed) this.invalidateChangedNotebooks();
        this.scheduleRefresh();
      }),
      lumine.workspace.observeTextEditors((editor) => {
        const subscriptions = new CompositeDisposable();
        subscriptions.add(
          editor.onDidDestroy(() => {
            this.scheduleRefresh();
            this.subscriptions.remove(subscriptions);
            subscriptions.dispose();
          }),
          editor.onDidChangePath(() => this.scheduleRefresh()),
          editor.onDidChangeGrammar(() => this.scheduleRefresh()),
        );
        this.subscriptions.add(subscriptions);
      }),
    );
  }

  scheduleRefresh() {
    if (this.disposed || this.refreshPending || !this.hasSnapshot) return;
    this.refreshPending = true;
    // A close publishes its empty report before removing the synced document.
    // Refresh after that teardown, when the report can no longer hide a scan.
    Promise.resolve().then(() => {
      this.refreshPending = false;
      this.publish();
    });
  }

  setAllMessages(messages, options, notebookSnapshots = new Map()) {
    if (this.disposed) return;
    this.messages = [...messages];
    this.notebookSnapshots = new Map(
      [...notebookSnapshots].map(([filePath, source]) => [pathKey(filePath), source]),
    );
    this.notebookRecords.clear();
    this.parsedNotebookSnapshots.clear();
    this.hasSnapshot = true;
    this.publish(options);
  }

  getMessages() {
    if (this.disposed) return [];
    this.invalidateChangedNotebooks();
    return [...this.messages];
  }

  notebookSnapshotCurrent(key) {
    const registered = new Set(this.manager.notebookDocuments?.records || []);
    for (const record of this.notebookRecords.keys())
      if (record.disposed || !registered.has(record)) this.notebookRecords.delete(record);
    const records = [...registered].filter(
      (record) => !record.disposed && pathKey(record.filePath) === key,
    );
    if (
      records.some((record) =>
        record.cells.some(
          (cell) =>
            (record.primaryEditor?.(cell) ?? cell.editor)?.getGrammar?.() ===
            lumine.grammars.nullGrammar,
        ),
      )
    )
      return false;
    const source = this.notebookSnapshots.get(key);
    let savedCells;
    if (source !== undefined) {
      if (!this.parsedNotebookSnapshots.has(key))
        this.parsedNotebookSnapshots.set(key, parseSavedCells(source));
      savedCells = this.parsedNotebookSnapshots.get(key);
      if (!savedCells) return false;
    }
    for (const record of records) {
      const previous = this.notebookRecords.get(record);
      if (
        (savedCells && savedCells.length !== record.cells.length) ||
        (previous && previous.length !== record.cells.length)
      )
        return false;
      const cells = [];
      for (let index = 0; index < record.cells.length; index++) {
        const cell = record.cells[index],
          saved = savedCells?.[index],
          prior = previous?.[index];
        if (
          (saved && ((saved.id && saved.id !== cell.id) || saved.kind !== cell.kind)) ||
          (prior && (prior.id !== cell.id || prior.kind !== cell.kind))
        )
          return false;
        try {
          const textSource = currentSource(record, cell);
          if (
            typeof textSource !== "string" &&
            (!Number.isSafeInteger(textSource?.length) ||
              textSource.length < 0 ||
              typeof textSource.toString !== "function")
          )
            return false;
          if (
            (saved && !sameSource(saved.source, textSource)) ||
            (prior && !sameSource(prior.source, textSource))
          )
            return false;
          cells.push({ id: cell.id, kind: cell.kind, source: textSource });
        } catch {
          return false;
        }
      }
      this.notebookRecords.set(record, cells);
    }
    return true;
  }

  invalidateChangedNotebooks() {
    const keys = new Set(this.notebookSnapshots.keys());
    for (const message of this.messages)
      if (message.location.cell != null) keys.add(pathKey(message.location.file));
    for (const key of keys) {
      if (this.notebookSnapshotCurrent(key)) continue;
      this.messages = this.messages.filter((message) => pathKey(message.location.file) !== key);
      this.notebookSnapshots.delete(key);
      this.parsedNotebookSnapshots.delete(key);
      for (const record of this.notebookRecords.keys())
        if (pathKey(record.filePath) === key) this.notebookRecords.delete(record);
    }
  }

  coverage() {
    const covered = new Map();
    for (const entry of this.manager.allDiagnostics()) {
      const { session, uri } = entry;
      if (!Array.isArray(entry.diagnostics)) continue;
      if (session.adapter?.id !== this.adapterId || session.state !== "running") continue;
      if (this.manager.adapters.get(this.adapterId) !== session.adapter) continue;
      const document = session.documents?.get(C.uriKey(uri));
      if (!document?.editor || document.editor.isDestroyed?.()) continue;
      if (!this.manager.featureEnabled(session.adapter, "diagnostics", document.editor)) continue;
      if (entry.version != null) {
        const versions = document.notebook
          ? [document.version, document.notebook.versionFor?.(session) ?? document.notebook.version]
          : [document.version];
        if (!versions.includes(entry.version)) continue;
      }
      const resolved = this.manager.resolveUri(uri);
      const filePath = resolved?.kind === "cell" ? resolved.notebookPath : resolved?.path;
      if (!filePath) continue;
      const cell = resolved.kind === "cell" ? resolved.cellIndex + 1 : null;
      if (resolved.kind === "cell" && resolved.cellIndex < 0) continue;
      const key = pathKey(filePath);
      if (!covered.has(key)) covered.set(key, new Set());
      covered.get(key).add(cell);
    }
    return covered;
  }

  publish(options) {
    if (this.disposed || !this.hasSnapshot) return;
    this.invalidateChangedNotebooks();
    const covered = this.coverage();
    const disabled = new Set(
      lumine.workspace
        .getTextEditors()
        .filter(
          (editor) => editor.getGrammar?.() === lumine.grammars.nullGrammar && editor.getPath(),
        )
        .map((editor) => pathKey(editor.getPath())),
    );
    this.delegate.setAllMessages(
      this.messages.filter((message) => {
        const location = message.location;
        const key = pathKey(location.file);
        return !disabled.has(key) && !covered.get(key)?.has(location.cell ?? null);
      }),
      options,
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.subscriptions.dispose();
    this.messages = [];
    this.notebookSnapshots.clear();
    this.notebookRecords.clear();
    this.parsedNotebookSnapshots.clear();
    this.delegate = null;
    this.manager = null;
  }
};
