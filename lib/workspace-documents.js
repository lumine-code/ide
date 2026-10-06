const { randomUUID } = require("node:crypto");
const C = require("./converters");
const { relativePath } = require("./workspace-paths");

// Workspace document identities and planned path transitions outlive a session.
module.exports = class WorkspaceDocuments {
  constructor({ reattachEditor }) {
    this.reattachEditor = reattachEditor;
    this.externalDocuments = new WeakMap();
    this.externalUris = new Map();
    this.bindingEditors = new WeakMap();
    this.destroySubscriptions = new Map();
    this.detachedExternalEditors = new WeakSet();
    this.untitledDocumentUris = new WeakMap();
    this.untitledDocuments = new Map();
    this.pathChangeSuppressions = new Map();
    this.disposed = false;
  }
  bindingFor(editor) {
    return this.externalDocuments.get(editor) || null;
  }
  isDetached(editor) {
    return this.detachedExternalEditors.has(editor);
  }
  *externalBindings() {
    for (const binding of this.externalUris.values())
      yield { ...binding, editor: this.editorForBinding(binding) };
  }
  bindingForUri(uri) {
    return this.externalUris.get(C.uriKey(uri)) || null;
  }
  bindUri(binding) {
    if (!this.disposed && !binding.record?.disposed)
      this.externalUris.set(C.uriKey(binding.uri), binding);
  }
  unbindUri(uri, record) {
    const binding = this.bindingForUri(uri);
    if (binding && (!record || binding.record === record)) this.externalUris.delete(C.uriKey(uri));
  }
  editorForBinding(binding) {
    const editors = this.bindingEditors.get(binding);
    if (!editors) return binding.editor;
    if (editors.has(binding.editor) && !binding.editor?.isDestroyed?.()) return binding.editor;
    return [...editors].find((editor) => !editor.isDestroyed?.()) || null;
  }
  filePathFor(editor) {
    return this.bindingFor(editor)?.record.filePath ?? editor.getPath();
  }
  pathChanged(editor) {
    const suppression = this.pathChangeSuppressions.get(editor);
    if (!suppression) return false;
    suppression.changed = true;
    return true;
  }
  bind(editor, binding) {
    if (this.disposed || editor.isDestroyed?.() || binding.record?.disposed) return;
    const previous = this.bindingFor(editor);
    if (previous) this.unbind(editor);
    this.detachedExternalEditors.delete(editor);
    this.forgetUntitled(editor);
    this.externalDocuments.set(editor, binding);
    let editors = this.bindingEditors.get(binding);
    if (!editors) this.bindingEditors.set(binding, (editors = new Set()));
    editors.add(editor);
    this.bindUri(binding);
    const subscription = editor.onDidDestroy?.(() => this.unbind(editor, binding.record));
    if (subscription) this.destroySubscriptions.set(editor, subscription);
  }
  unbind(editor, record) {
    const binding = this.externalDocuments.get(editor);
    if (!binding || (record && binding.record !== record)) return;
    this.externalDocuments.delete(editor);
    this.detachedExternalEditors.add(editor);
    this.destroySubscriptions.get(editor)?.dispose();
    this.destroySubscriptions.delete(editor);
    const editors = this.bindingEditors.get(binding);
    editors?.delete(editor);
    if (!editors?.size && this.bindingForUri(binding.uri) === binding)
      this.unbindUri(binding.uri, binding.record);
  }
  uriForEditor(editor) {
    if (this.disposed) return null;
    const binding = this.externalDocuments.get(editor);
    if (binding) return binding.uri;
    if (this.detachedExternalEditors?.has(editor)) return null;
    const filePath = editor.getPath();
    if (filePath) {
      this.forgetUntitled(editor);
      return C.pathToUri(filePath);
    }
    this.untitledDocumentUris ??= new WeakMap();
    this.untitledDocuments ??= new Map();
    const extension = editor
      .getGrammar?.()
      ?.fileTypes?.find((entry) => /^[a-z0-9][a-z0-9._+-]*$/i.test(entry));
    let document = this.untitledDocumentUris.get(editor);
    if (document?.extension !== extension) {
      this.forgetUntitled(editor);
      document = null;
    }
    if (!document) {
      // Some servers also use the URI suffix to distinguish standalone source
      // from embedded code. Keep its grammar's extension without making a file.
      const uri = `untitled:lumine-${randomUUID()}${extension ? `.${extension}` : ""}`;
      document = { uri, extension };
      this.untitledDocumentUris.set(editor, document);
      this.untitledDocuments.set(uri, editor);
    }
    return document.uri;
  }
  forgetUntitled(editor) {
    const document = this.untitledDocumentUris?.get(editor);
    if (!document) return;
    this.untitledDocumentUris.delete(editor);
    this.untitledDocuments.delete(document.uri);
  }
  resolveUri(uri) {
    if (this.disposed) return null;
    const untitled = this.untitledDocuments?.get(uri);
    if (untitled && !untitled.isDestroyed?.() && !untitled.getPath())
      return { kind: "untitled", editor: untitled };
    const binding = this.externalUris.get(C.uriKey(uri));
    if (binding) {
      return {
        kind: "cell",
        editor: this.editorForBinding(binding),
        notebookPath: binding.record.filePath,
        cellId: binding.cellId,
        cellIndex: binding.record.cellIndexOf(binding.cellId),
        record: binding.record,
      };
    }
    let filePath = null;
    try {
      filePath = C.uriToPath(uri);
    } catch {
      /* Not a URI this platform can resolve. */
    }
    return filePath ? { kind: "file", path: filePath } : null;
  }
  withinPath(filePath) {
    return lumine.workspace
      .getTextEditors()
      .filter((editor) => editor.getPath?.() && relativePath(filePath, editor.getPath()) !== null);
  }
  snapshotsForOperation(operation) {
    const roots = [];
    if (operation?.kind === "rename") roots.push(operation.oldPath, operation.newPath);
    else if (operation?.path) roots.push(operation.path);
    return lumine.workspace
      .getTextEditors()
      .map((editor) => ({ editor, path: editor.getPath?.() }))
      .filter(
        (snapshot) =>
          snapshot.path && roots.some((root) => root && relativePath(root, snapshot.path) !== null),
      );
  }
  suppressPathChanges(snapshots, token) {
    if (this.disposed) return;
    for (const { editor } of snapshots) {
      let suppression = this.pathChangeSuppressions.get(editor);
      if (!suppression) {
        suppression = { tokens: new Set(), changed: false };
        this.pathChangeSuppressions.set(editor, suppression);
      }
      suppression.tokens.add(token);
    }
  }
  async stabilizePaths(logicalPaths) {
    if (this.disposed) return;
    await Promise.allSettled(
      [...logicalPaths].map(async ([editor]) => {
        const buffer = editor.getBuffer?.();
        if (!buffer) return;
        await (buffer.getFileWatchStartPromise?.() || Promise.resolve());
      }),
    );
  }
  async reattachPaths(token) {
    if (this.disposed) return;
    const reattachments = [];
    for (const [editor, suppression] of this.pathChangeSuppressions) {
      if (suppression.tokens.has(token) && suppression.changed && !editor.isDestroyed?.()) {
        reattachments.push(Promise.resolve(this.reattachEditor(editor)));
      }
    }
    await Promise.allSettled(reattachments);
  }
  releasePaths(token) {
    for (const [editor, suppression] of this.pathChangeSuppressions) {
      if (!suppression.tokens.delete(token) || suppression.tokens.size) continue;
      this.pathChangeSuppressions.delete(editor);
    }
  }
  pathsAfterEffects(_effects, snapshots = []) {
    // Core owns document retargeting. Read the settled paths for LSP routing.
    return new Map(
      snapshots
        .filter(({ editor }) => !editor.isDestroyed?.())
        .map(({ editor }) => [editor, editor.getPath?.()]),
    );
  }
  dispose() {
    this.disposed = true;
    this.externalUris.clear();
    this.untitledDocuments.clear();
    this.pathChangeSuppressions.clear();
    for (const subscription of this.destroySubscriptions.values()) subscription.dispose();
    this.destroySubscriptions.clear();
    this.bindingEditors = new WeakMap();
    this.externalDocuments = new WeakMap();
    this.untitledDocumentUris = new WeakMap();
    this.detachedExternalEditors = new WeakSet();
  }
};
