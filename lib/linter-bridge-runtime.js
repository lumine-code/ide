module.exports = ({ C, Messages }) => {
  class DiagnosticRuntime {
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
        if (
          !diagnostics?.length &&
          byOwner.get(key) === session &&
          (manager.diagnostics.get(session)?.get(key) === entry ||
            !manager.diagnostics.get(session)?.has(key))
        )
          byOwner.delete(key);
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
      byUri.get(key)?.controller?.abort();
      const job = { controller: new AbortController() };
      byUri.set(key, job);
      let sourceEditor = this.editorForUri(key);
      const sourceBuffer = sourceEditor?.getBuffer?.();
      const sourceRevision = sourceBuffer?.getTextRevision?.();
      const sourcePath = sourceBuffer?.getPath?.();
      const current = () =>
        !this.disposed &&
        !job.controller.signal.aborted &&
        manager.adapters.get(adapter.id) === adapter &&
        byUri.get(key) === job &&
        this.featureRevisions.get(adapter) === revision &&
        (manager.diagnostics.get(session)?.get(key) === entry ||
          (!diagnostics?.length && !manager.diagnostics.get(session)?.has(key)));
      const presentationCurrent = () => {
        if (!current()) return false;
        if (!sourceBuffer) return this.editorForUri(key) == null;
        if (
          sourceBuffer.isDestroyed() ||
          sourceBuffer.getTextRevision() !== sourceRevision ||
          sourceBuffer.getPath() !== sourcePath
        )
          return false;
        // A split can keep the same buffer open after the first view closes.
        // Avoid scanning every editor for every converted diagnostic.
        if (sourceEditor.isDestroyed()) sourceEditor = this.editorForUri(key);
        return sourceEditor?.getBuffer() === sourceBuffer;
      };
      const release = () => {
        if (byUri.get(key) === job) byUri.delete(key);
        if (!byUri.size && this.pending.get(adapter) === byUri) this.pending.delete(adapter);
      };
      const finish = (enabled) => {
        if (!current() || (diagnostics?.length && !presentationCurrent())) {
          release();
          return;
        }
        const opened = this.editorForUri(key);
        if (opened && diagnostics?.length)
          enabled = manager.featureEnabled(adapter, "diagnostics", opened);
        if (enabled && diagnostics?.length >= 512) {
          return (async () => {
            try {
              const converted = await Messages.toLinterMessagesAsync(uri, diagnostics, {
                signal: job.controller.signal,
                isCurrent: presentationCurrent,
              });
              if (!converted || !presentationCurrent()) return;
              if (typeof delegate.setMessagesAsync === "function") {
                await delegate.setMessagesAsync(filePath, converted.messages, {
                  signal: job.controller.signal,
                  isCurrent: presentationCurrent,
                });
              } else {
                delegate.setMessages(filePath, converted.messages);
              }
            } catch (error) {
              if (presentationCurrent() && error?.name !== "AbortError") {
                try {
                  manager.log(session, `Unable to present diagnostics: ${error.message}`);
                } catch (loggingError) {
                  console.error(
                    "Unable to report diagnostic presentation error",
                    error,
                    loggingError,
                  );
                }
              }
            } finally {
              releaseOwner();
              release();
            }
          })();
        }
        try {
          delegate.setMessages(
            filePath,
            enabled ? Messages.toLinterMessages(uri, diagnostics).messages : [],
          );
        } finally {
          releaseOwner();
          release();
        }
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
                    const pending = finish(enabled);
                    if (pending?.then) return pending;
                  } catch (error) {
                    manager.log(session, `Unable to present diagnostics: ${error.message}`);
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
      } else return finish(enabled);
    }
    editorForUri(key) {
      return lumine.workspace
        .getTextEditors()
        .find((editor) => editor.getPath() && C.uriKey(C.pathToUri(editor.getPath())) === key);
    }
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
  }
  return DiagnosticRuntime.prototype;
};
