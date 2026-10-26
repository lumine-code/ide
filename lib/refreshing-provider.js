const { Emitter, CompositeDisposable } = require("lumine");
const Budget = require("./document-budget");

// Providers that render cached server data share one invalidation lifetime.
// The epoch also prevents an outstanding request from restoring a result
// invalidated by a server refresh, feature change or package disposal.
module.exports = class RefreshingProvider {
  constructor(manager, capabilities, refreshKind) {
    this.manager = manager;
    manager.addCapabilityFragment(capabilities);
    this.name = "Language Server";
    this.packageName = "ide";
    this.priority = 2;
    this.epoch = 0;
    this.disposed = false;
    this.editorContexts = new WeakMap();
    this.emitter = new Emitter();
    const invalidate = () => {
      this.epoch++;
      this.emitter.emit("invalidate", {});
    };
    this.subscriptions = new CompositeDisposable(
      manager.onDidRequestRefresh(({ kind }) => {
        if (kind === refreshKind) invalidate();
      }),
      manager.onDidChangeSession(({ state }) => {
        if (state !== "starting") invalidate();
      }),
      manager.onDidChangeFeatures(invalidate),
      manager.onDidChangeCapabilities(invalidate),
    );
  }

  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }

  captureEditor(editor) {
    if (this.disposed || editor.isDestroyed?.()) return () => false;
    let context = this.editorContexts.get(editor);
    if (!context) {
      if (!Budget.editorAvailable(editor)) return () => false;
      context = { generation: 0 };
      this.editorContexts.set(editor, context);
      const watches = new CompositeDisposable();
      this.subscriptions.add(watches);
      const refresh = () => this.refreshEditorContext(editor, context);
      for (const event of ["onDidChangeGrammar", "onDidChangePath"]) {
        const subscription = editor[event]?.(refresh);
        if (subscription) watches.add(subscription);
      }
      const sizeChanges = editor.getBuffer?.()?.onDidChangeText?.(refresh);
      if (sizeChanges) watches.add(sizeChanges);
      watches.add(lumine.config.onDidChange(Budget.SETTING, refresh));
      const destroyed = editor.onDidDestroy?.(() => {
        context.generation++;
        this.invalidateEditor?.(editor);
        this.editorContexts.delete(editor);
        this.subscriptions.remove(watches);
        watches.dispose();
      });
      if (destroyed) watches.add(destroyed);
    }
    // A consumer's grammar listener may start its replacement request before
    // this provider's listener runs. Read the installed context here as well,
    // so that listener cannot invalidate the replacement a second time.
    this.refreshEditorContext(editor, context);
    const generation = context.generation;
    return () =>
      !this.disposed &&
      this.editorContexts.get(editor) === context &&
      context.generation === generation &&
      !editor.isDestroyed?.() &&
      Budget.editorAvailable(editor);
  }

  refreshEditorContext(editor, context) {
    const mode = editor.getBuffer?.()?.getLanguageMode?.();
    const grammar = editor.getGrammar?.();
    const scope = grammar?.scopeName;
    const none = grammar === lumine.grammars.nullGrammar;
    const available = Budget.editorAvailable(editor);
    const path = editor.getPath?.();
    if (
      context.ready &&
      context.mode === mode &&
      context.scope === scope &&
      context.none === none &&
      context.available === available &&
      context.path === path
    )
      return;
    const availabilityChanged = context.ready && context.available !== available;
    Object.assign(context, { ready: true, mode, scope, none, path, available });
    context.generation++;
    this.invalidateEditor?.(editor);
    if (availabilityChanged) this.emitter.emit("invalidate", { editor });
  }

  onDidInvalidate(callback) {
    return this.emitter.on("invalidate", callback);
  }

  dispose() {
    this.disposed = true;
    this.epoch++;
    this.subscriptions.dispose();
    this.editorContexts = new WeakMap();
    this.emitter.dispose();
  }
};
