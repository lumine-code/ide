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

  setAllMessages(messages, options) {
    if (this.disposed) return;
    this.messages = [...messages];
    this.hasSnapshot = true;
    this.publish(options);
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
    this.delegate = null;
    this.manager = null;
  }
};
