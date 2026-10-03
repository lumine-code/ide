const path = require("path");
const { CompositeDisposable } = require("lumine");
const C = require("./converters");

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
    this.hasSnapshot = true;
    this.publish(options);
  }

  getMessages() {
    if (this.disposed) return [];
    this.invalidateChangedNotebooks();
    return [...this.messages];
  }

  notebookSnapshotCurrent(key) {
    const source = this.notebookSnapshots.get(key);
    let savedCells;
    if (source !== undefined) {
      try {
        savedCells = JSON.parse(source).cells;
        if (!Array.isArray(savedCells)) return false;
      } catch {
        return false;
      }
    }
    for (const record of this.manager.notebookDocuments?.records || []) {
      if (record.disposed || pathKey(record.filePath) !== key) continue;
      const cells = record.cells.map((cell) => ({
        id: cell.id,
        kind: cell.kind,
        text: record.cellText(cell),
      }));
      if (savedCells) {
        if (savedCells.length !== cells.length) return false;
        for (let index = 0; index < cells.length; index++) {
          const saved = savedCells[index],
            cell = cells[index];
          const text = Array.isArray(saved.source) ? saved.source.join("") : saved.source;
          if (
            (saved.id && saved.id !== cell.id) ||
            (saved.cell_type === "code" ? "code" : "markup") !== cell.kind ||
            text !== cell.text
          )
            return false;
        }
      }
      const signature = JSON.stringify(cells);
      const previous = this.notebookRecords.get(record);
      if (previous !== undefined && previous !== signature) return false;
      this.notebookRecords.set(record, signature);
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
    this.delegate.setAllMessages(
      this.messages.filter((message) => {
        const location = message.location;
        return !covered.get(pathKey(location.file))?.has(location.cell ?? null);
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
    this.delegate = null;
    this.manager = null;
  }
};
