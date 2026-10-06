const { CompositeDisposable } = require("lumine");
const C = require("./converters");
const Messages = require("./linter-messages");

// One registry edge owns its delegates, presentation jobs and notebook buckets.
// Server reports stay in the manager so reconnecting can replay current state.
module.exports = class LinterBridge {
  constructor(manager, registerIndie) {
    this.manager = manager;
    this.registerIndie = registerIndie;
    this.disposed = false;
    this.delegates = new Map();
    this.delegateAdapters = new Map();
    this.notebookBuckets = new Map();
    this.pending = new Map();
    this.owners = new Map();
    this.featureRevisions = new Map();
    this.ready = new Map();
    this.presentationTimer = null;
    this.republishTimer = null;
    this.republishGeneration = 0;
    this.subscriptions = new CompositeDisposable();
    try {
      this.subscriptions.add(
        manager.onDidPublishDiagnostics((entry) => this.publish(entry)),
        manager.onDidChangeFeatures(({ adapter }) => {
          if (this.disposed || manager.adapters.get(adapter.id) !== adapter) return;
          this.featureRevisions.set(adapter, (this.featureRevisions.get(adapter) || 0) + 1);
          this.pending.delete(adapter);
          this.republish(this.republishTimer ? null : adapter);
        }),
        manager.onDidChangeDiagnosticScopes(({ keys }) => this.republish(null, keys)),
        manager.onDidChangeAdapters(({ adapter, registered }) => {
          if (this.disposed) return;
          if (registered) this.delegateFor(adapter);
          else this.removeDelegate(adapter);
        }),
      );
      // Every adapter remains available in Toggle Linter before its first report.
      for (const adapter of manager.adapters.values()) this.delegateFor(adapter);
      this.republish(null);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  removeDelegate(adapter) {
    this.pending.delete(adapter);
    this.owners.delete(adapter);
    this.featureRevisions.delete(adapter);
    for (const [key, job] of this.ready) if (job.adapter === adapter) this.ready.delete(key);
    if (!this.ready.size) {
      clearImmediate(this.presentationTimer);
      this.presentationTimer = null;
    }
    if (this.delegateAdapters.get(adapter.id) !== adapter) return;
    this.delegateAdapters.delete(adapter.id);
    const delegate = this.delegates.get(adapter.id);
    this.delegates.delete(adapter.id);
    this.notebookBuckets.delete(adapter.id);
    delegate?.dispose();
  }
  delegateFor(adapter) {
    if (this.disposed || !adapter || this.manager.adapters.get(adapter.id) !== adapter) return null;
    const previous = this.delegateAdapters.get(adapter.id);
    if (previous && previous !== adapter) this.removeDelegate(previous);
    let delegate = this.delegates.get(adapter.id);
    if (!delegate) {
      delegate = this.registerIndie({ name: adapter.displayName, markerInvalidation: "never" });
      this.delegates.set(adapter.id, delegate);
      this.delegateAdapters.set(adapter.id, adapter);
    }
    return delegate;
  }
  publish(entry) {
    const { session, uri, diagnostics } = entry;
    const adapter = session?.adapter;
    const delegate = this.delegateFor(adapter);
    if (!delegate) return;
    const manager = this.manager;
    const key = C.uriKey(uri);
    const stored = manager.diagnostics.get(session)?.get(key);
    if ((stored && stored !== entry) || (!stored && diagnostics?.length)) return;
    const resolved = manager.resolveUri(uri);
    if (resolved?.kind !== "file" && resolved?.kind !== "cell") return;
    let byOwner = this.owners.get(adapter);
    if (!byOwner) this.owners.set(adapter, (byOwner = new Map()));
    const owner = byOwner.get(key);
    // An old process's final clear cannot erase a replacement's file or cell.
    if (
      !diagnostics?.length &&
      owner &&
      owner !== session &&
      manager.diagnostics.get(owner)?.has(key)
    )
      return;
    byOwner.set(key, session);
    const releaseOwner = () => {
      if (!diagnostics?.length && byOwner.get(key) === session) byOwner.delete(key);
      if (!byOwner.size && this.owners.get(adapter) === byOwner) this.owners.delete(adapter);
    };
    if (resolved.kind === "cell") {
      this.publishCellDiagnostics({ adapter, uri, diagnostics, resolved, delegate });
      releaseOwner();
      return;
    }
    const filePath = resolved.path;
    let byUri = this.pending.get(adapter);
    if (!byUri) this.pending.set(adapter, (byUri = new Map()));
    const revision = this.featureRevisions.get(adapter);
    const job = {};
    byUri.set(key, job);
    const current = () =>
      !this.disposed &&
      manager.adapters.get(adapter.id) === adapter &&
      byUri.get(key) === job &&
      this.featureRevisions.get(adapter) === revision &&
      (manager.diagnostics.get(session)?.get(key) === entry ||
        (!diagnostics?.length && !manager.diagnostics.get(session)?.has(key)));
    const release = () => {
      if (byUri.get(key) === job) byUri.delete(key);
      if (!byUri.size && this.pending.get(adapter) === byUri) this.pending.delete(adapter);
    };
    const finish = (enabled) => {
      if (!current()) return;
      const opened = this.editorForUri(key);
      if (opened && diagnostics?.length)
        enabled = manager.featureEnabled(adapter, "diagnostics", opened);
      delegate.setMessages(
        filePath,
        enabled ? Messages.toLinterMessages(uri, diagnostics).messages : [],
      );
      releaseOwner();
      release();
    };
    // Feature switches affect presentation rather than discarding push-only data.
    const editor = this.editorForUri(key);
    const enabled = !diagnostics?.length
      ? false
      : editor
        ? manager.featureEnabled(adapter, "diagnostics", editor)
        : manager.featureEnabledForPath(adapter, "diagnostics", filePath);
    if (enabled?.then) {
      enabled
        .then(
          (enabled) => {
            if (!current()) return release();
            this.ready.set(`${adapter.id}\0${key}`, {
              adapter,
              present: () => {
                try {
                  finish(enabled);
                } catch (error) {
                  manager.log(session, `Unable to present diagnostics: ${error.message}`);
                } finally {
                  release();
                }
              },
            });
            this.schedulePresentation();
          },
          (error) => {
            if (error.name !== "AbortError" && current()) {
              manager.log(session, `Unable to resolve diagnostic grammar: ${error.message}`);
              finish(false);
            }
            release();
          },
        )
        .catch(release);
    } else finish(enabled);
  }
  editorForUri(key) {
    return lumine.workspace
      .getTextEditors()
      .find((editor) => editor.getPath() && C.uriKey(C.pathToUri(editor.getPath())) === key);
  }
  schedulePresentation() {
    if (this.presentationTimer || this.disposed) return;
    this.presentationTimer = setImmediate(() => {
      this.presentationTimer = null;
      if (this.disposed) return;
      const deadline = performance.now() + 5;
      while (this.ready.size) {
        const [key, job] = this.ready.entries().next().value;
        this.ready.delete(key);
        job.present();
        if (performance.now() >= deadline && this.ready.size) {
          this.schedulePresentation();
          return;
        }
      }
    });
  }
  republish(adapter, keys) {
    if (this.disposed) return;
    if (this.republishTimer) {
      adapter = null;
      keys = null;
    }
    clearImmediate(this.republishTimer);
    const generation = ++this.republishGeneration;
    const entries = this.manager.diagnosticEntries();
    const step = () => {
      if (this.disposed || generation !== this.republishGeneration) return;
      const deadline = performance.now() + 5;
      let next;
      while (!(next = entries.next()).done) {
        const entry = next.value;
        if (
          (!adapter || entry.session?.adapter === adapter) &&
          (!keys || keys.has(C.uriKey(entry.uri)))
        )
          this.publish(entry);
        if (performance.now() >= deadline) {
          this.republishTimer = setImmediate(step);
          return;
        }
      }
      this.republishTimer = null;
    };
    step();
  }
  // Each delegate replaces a file bucket, so cells publish one notebook batch.
  publishCellDiagnostics({ adapter, uri, diagnostics, resolved, delegate }) {
    const adapterKey = adapter.id;
    let byNotebook = this.notebookBuckets.get(adapterKey);
    if (!byNotebook) this.notebookBuckets.set(adapterKey, (byNotebook = new Map()));
    let byCell = byNotebook.get(resolved.notebookPath);
    if (!byCell) byNotebook.set(resolved.notebookPath, (byCell = new Map()));
    const cellKey = C.uriKey(uri);
    const enabled = this.manager.featureEnabled(adapter, "diagnostics", resolved.editor);
    const messages =
      enabled && resolved.cellIndex >= 0 && diagnostics?.length
        ? Messages.toNotebookLinterMessages(
            { notebookPath: resolved.notebookPath, cellIndex: resolved.cellIndex },
            diagnostics,
          ).messages
        : [];
    if (messages.length) byCell.set(cellKey, messages);
    else byCell.delete(cellKey);
    delegate.setMessages(resolved.notebookPath, [...byCell.values()].flat());
    if (!byCell.size) byNotebook.delete(resolved.notebookPath);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearImmediate(this.republishTimer);
    clearImmediate(this.presentationTimer);
    this.republishTimer = null;
    this.presentationTimer = null;
    this.republishGeneration++;
    this.subscriptions.dispose();
    for (const delegate of this.delegates.values()) delegate.dispose();
    for (const map of [
      this.delegates,
      this.delegateAdapters,
      this.notebookBuckets,
      this.pending,
      this.owners,
      this.featureRevisions,
      this.ready,
    ])
      map.clear();
    this.manager = null;
    this.registerIndie = null;
  }
};
