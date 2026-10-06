const C = require("./converters");

function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  let onAbort;
  const cancelled = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}

module.exports = class FileOperationPreparation {
  constructor({ fileOperations, workspaceEdits, documents }, { signal } = {}) {
    this.fileOperations = fileOperations;
    this.workspaceEdits = workspaceEdits;
    this.documents = documents;
    this.controller = new AbortController();
    this.signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    this.snapshots = new Map();
    this.edits = [];
    this.mutations = false;
    this.disposed = false;
    this.mutationStarted = false;
    fileOperations.preparations.add(this);
    this.captureOpenDocuments();
  }

  captureEditor(editor, uri, session, document) {
    const buffer = editor?.getBuffer?.();
    if (!buffer || !uri) return;
    let snapshot = this.snapshots.get(buffer);
    if (!snapshot) {
      snapshot = {
        editor,
        buffer,
        path: editor.getPath?.(),
        keys: new Set(),
        documents: [],
        changed: false,
      };
      snapshot.subscription = buffer.onDidChangeText(() => (snapshot.changed = true));
      this.snapshots.set(buffer, snapshot);
    }
    const key = C.uriKey(uri);
    snapshot.keys.add(key);
    if (document) snapshot.documents.push({ session, document, key, version: document.version });
  }

  captureOpenDocuments() {
    for (const session of this.fileOperations.host.sessions())
      for (const document of session.documents?.values?.() || [])
        this.captureEditor(document.editor, document.uri, session, document);
    const editors = new Set([
      ...lumine.workspace.getTextEditors(),
      ...[...this.documents.externalBindings()].map((binding) => binding.editor),
    ]);
    for (const editor of editors) this.captureEditor(editor, this.documents.uriForEditor(editor));
  }

  current(isCurrent) {
    if (
      this.disposed ||
      this.signal.aborted ||
      this.fileOperations.disposed ||
      this.workspaceEdits.disposed ||
      isCurrent?.() === false
    )
      return false;
    if (this.mutationStarted) return true;
    return [...this.snapshots.values()].every(
      ({ editor, buffer, path, changed, documents }) =>
        !changed &&
        !editor.isDestroyed?.() &&
        editor.getBuffer?.() === buffer &&
        editor.getPath?.() === path &&
        documents.every(
          ({ session, document, key, version }) =>
            session.documents.get(key) === document && document.version === version,
        ),
    );
  }

  assertCurrent(isCurrent) {
    this.signal.throwIfAborted();
    if (!this.current(isCurrent))
      throw new Error("A document or file-operation guard changed while preparation was waiting.");
  }

  retainEditedDocuments() {
    const targets = new Set();
    for (const { edit, session } of this.edits) {
      for (const change of this.workspaceEdits.workspaceEditDocumentChanges(edit, session)) {
        const resource = this.workspaceEdits.fileOperationForChange(change);
        if (resource) {
          this.mutations = true;
          continue;
        }
        const uri = change?.textDocument?.uri;
        if (!uri || !Array.isArray(change.edits)) throw new Error("Invalid TextDocumentEdit");
        if (!this.documents.resolveUri(uri))
          throw new Error(`Cannot resolve workspace edit target '${uri}'`);
        if (change.edits.length) {
          this.mutations = true;
          targets.add(C.uriKey(uri));
        }
      }
    }
    for (const [buffer, snapshot] of this.snapshots) {
      if ([...snapshot.keys].some((key) => targets.has(key))) continue;
      snapshot.subscription.dispose();
      this.snapshots.delete(buffer);
    }
  }

  hasEdits() {
    return this.mutations;
  }

  async collect(method, capability, entries, paramsFor, label) {
    this.label = label;
    const configured = lumine.config.get("ide-client.fileOperationPreparationTimeout");
    const seconds =
      Number.isInteger(configured) && configured >= 1 && configured <= 3600 ? configured : 30;
    this.timer = setTimeout(() => {
      const error = new Error(
        `File operation preparation timed out after ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
      );
      error.name = "TimeoutError";
      this.controller.abort(error);
    }, seconds * 1000);
    let requestingSession;
    try {
      this.signal.throwIfAborted();
      for (const session of this.fileOperations.host.sessions()) {
        if (session.state !== "running") continue;
        const matched = capability.includes("Rename")
          ? this.fileOperations.matchingRenameEntries(session, capability, entries)
          : this.fileOperations.matchingFileEntries(session, capability, entries);
        if (!matched.length) continue;
        requestingSession = session;
        this.signal.throwIfAborted();
        const edit = await abortable(
          session.request(method, paramsFor(matched), { signal: this.signal }),
          this.signal,
        );
        this.signal.throwIfAborted();
        if (edit) this.edits.push({ edit, session });
      }
      this.retainEditedDocuments();
      this.assertCurrent();
      return this;
    } catch (error) {
      if (
        error.name !== "AbortError" &&
        (!this.signal.aborted || this.signal.reason?.name === "TimeoutError")
      ) {
        this.fileOperations.host.log(requestingSession || {}, `${method} failed: ${error.message}`);
        const name =
          requestingSession?.adapter?.displayName ||
          requestingSession?.adapter?.id ||
          "The language server";
        lumine.notifications.addWarning(`${name} could not prepare the file operation`, {
          detail: error.message,
          dismissable: true,
        });
      }
      this.dispose();
      return false;
    } finally {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  commit({ isCurrent } = {}) {
    if (this.commitPromise) return this.commitPromise;
    this.commitPromise = (async () => {
      try {
        this.assertCurrent(isCurrent);
        if (!this.edits.length) return true;
        return await this.workspaceEdits.applyWorkspaceEdits(this.edits, this.label, {
          signal: this.signal,
          isCurrent: () => this.current(isCurrent),
          beforeMutation: () => {
            this.assertCurrent(isCurrent);
            this.mutationStarted = true;
            this.releaseSnapshots();
          },
        });
      } catch (error) {
        if (!this.signal.aborted && error.name !== "AbortError")
          lumine.notifications.addWarning("The file operation could not be prepared", {
            detail: error.message,
            dismissable: true,
          });
        return false;
      }
    })().finally(() => this.dispose());
    return this.commitPromise;
  }

  releaseSnapshots() {
    for (const snapshot of this.snapshots.values()) snapshot.subscription.dispose();
    this.snapshots.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller.abort(new DOMException("File operation was cancelled.", "AbortError"));
    this.releaseSnapshots();
    this.edits = [];
    this.fileOperations.preparations.delete(this);
  }
};
