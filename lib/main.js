const { CompositeDisposable, Disposable } = require("lumine");

// Keep the package entry point cheap. These modules own protocol adapters,
// child-process management, and UI views; loading them while the package is
// merely being discovered made every cold activation pay for all of them.
// `ensureProviderFacades()` publishes the synchronous service surface; the
// feature graph itself crosses the `ensureProviders()` boundary only for a
// language-server handshake or an actual operation.

let LanguageServerManager = null;

function getLanguageServerManager() {
  return (LanguageServerManager ||= require("./language-server-manager"));
}

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "ide",
      tips: [
        "{% if keys['ide:servers'] %}You can see every language server that is running, and restart any of them, with {{ 'ide:servers' | keystroke }}{% else %}Lumine speaks the Language Server Protocol. Install an ide package for your language to get completions, diagnostics, and go-to-definition.{% endif %}",
      ],
    };
  },

  activationGeneration: 0,
  // Loading the manager's protocol and capability graph is pure module setup;
  // warm it during the package initialization phase so activation only has to
  // construct the already-loaded manager. The manager still starts observing
  // editors and projects from activate(), preserving the lifecycle boundary.
  initialize() {
    getLanguageServerManager();
  },
  ensureProviderFacades() {
    if (!this._providerFacades) {
      const ProviderFacades = require("./provider-facades");
      this._providerFacades = new ProviderFacades(this);
    }
    if (this._providersReady && !this._providerFacades.connections)
      this._providerFacades.connect(this);
    return this._providerFacades;
  },
  ensureNotebookDocuments() {
    if (this.notebookDocuments) return this.notebookDocuments;
    if (!this.manager) throw new Error("ide notebooks require an active manager");
    const NotebookDocuments = require("./notebook-documents");
    this.notebookDocuments = new NotebookDocuments(this.manager);
    this.manager.setNotebookDocuments(this.notebookDocuments);
    return this.notebookDocuments;
  },
  ensureManagedServers({ sweep = false } = {}) {
    if (this.managedServers) {
      if (sweep && !this._managedServersSwept) {
        this.sweepManagedServers(this.managedServers);
        this._managedServersSwept = true;
      }
      return this.managedServers;
    }
    if (!this.manager) throw new Error("ide server management requires an active manager");
    const ManagedServers = require("./managed-servers");
    this.managedServers = new ManagedServers(this.manager);
    this.manager.setManagedServers(this.managedServers);
    if (sweep) {
      // A stage or backup left by a killed install would otherwise sit in the
      // storage directory for good; nothing has been launched from it yet.
      this.sweepManagedServers(this.managedServers);
      this._managedServersSwept = true;
    }
    return this.managedServers;
  },
  sweepManagedServers(managed) {
    managed.sweep().catch((error) => {
      if (!managed.disposed && error?.name !== "AbortError")
        lumine.notifications.addError("Could not recover language server installations", {
          detail: error.message,
          dismissable: true,
        });
    });
  },
  ensureCustomServers({ signal } = {}) {
    if (this._customServersReady) return this._customServersReady;
    if (!this.manager) throw new Error("custom servers require an active manager");
    const manager = this.manager;
    const generation = this.activationGeneration;
    const controller = (this._customServersController = new AbortController());
    const bootstrapSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const CustomServers = require("./custom-servers");
    const customServers = (this.customServers = new CustomServers(this.manager));
    // Publish the promise before calling activate(): load() registers adapters
    // synchronously, and that registration can schedule a reattach which asks
    // for the same bootstrap again.
    let resolveReady;
    let rejectReady;
    this._customServersReady = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    Promise.resolve(customServers.activate({ signal: bootstrapSignal })).then(
      () => {
        if (
          this.activationGeneration !== generation ||
          this.manager !== manager ||
          customServers.disposed
        )
          rejectReady(new DOMException("Language server bootstrap was cancelled", "AbortError"));
        else resolveReady();
      },
      (error) => {
        if (this.customServers === customServers) {
          customServers.dispose();
          this.customServers = null;
          this._customServersReady = null;
          this._customServersController = null;
        }
        rejectReady(error);
      },
    );
    return this._customServersReady;
  },
  async withCustomServers(action) {
    const generation = this.activationGeneration;
    try {
      await this.ensureCustomServers();
      if (generation === this.activationGeneration) return action();
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  },
  ensureProviders() {
    if (this._providersReady) return this;
    if (!this.manager) throw new Error("ide providers require an active manager");

    // Keep these requires together so the first language-server handshake can
    // load the complete capability set in one deterministic step. Individual
    // services still receive stable provider objects afterwards; callers do not
    // need to know whether this boundary was crossed by a command, a service,
    // or a server session.
    const CompletionProvider = require("./completion-provider");
    const SymbolProvider = require("./symbol-provider");
    const ContextHelpProvider = require("./context-help-provider");
    const SignatureProvider = require("./signature-provider");
    const CodeFormatProvider = require("./code-format-provider");
    const ReferencesProvider = require("./references-provider");
    const RefactorProvider = require("./refactor-provider");
    const IntentionsProvider = require("./intentions-provider");
    const CodeLensProvider = require("./code-lens-provider");
    const InlayHintsProvider = require("./inlay-hints-provider");
    const SemanticTokensProvider = require("./semantic-tokens-provider");
    const DocumentFeatures = require("./document-features");

    this.completionProvider = new CompletionProvider(this.manager);
    this.symbolProvider = new SymbolProvider(this.manager);
    this.contextHelpProvider = new ContextHelpProvider(this.manager);
    this.signatureProvider = new SignatureProvider(this.manager);
    this.codeFormatProvider = new CodeFormatProvider(this.manager);
    this.referencesProvider = new ReferencesProvider(this.manager);
    this.refactorProvider = new RefactorProvider(this.manager);
    this.intentionsProvider = new IntentionsProvider(this.manager);
    this.codeLensProvider = new CodeLensProvider(this.manager);
    this.inlayHintsProvider = new InlayHintsProvider(this.manager);
    this.semanticTokensProvider = new SemanticTokensProvider(this.manager);
    this.documentFeatures = new DocumentFeatures(this.manager);
    this._providersReady = true;
    if (this._providerFacades) this._providerFacades.connect(this);
    return this;
  },
  activate(_state, { signal } = {}) {
    const generation = ++this.activationGeneration;
    signal?.throwIfAborted();
    const manager = (this.manager = new (getLanguageServerManager())());
    manager.setFileOperationsExecutor(this.fileOperationsExecutor || null);
    manager.setCapabilityInitializer(() => this.ensureProviders());
    manager.setAdapterInitializer(() => this.ensureCustomServers());
    // The manager's activation observes every open editor and project root.
    // Constructing it is part of the synchronous service contract, but the
    // observer sweep can wait until the current package batch has completed.
    queueMicrotask(() => {
      if (generation !== this.activationGeneration || this.manager !== manager) return;
      manager.activate();
    });
    this.uiSubscriptions = new CompositeDisposable();
    this.uiSubscriptions.add(
      this.manager.onDidExhaustRestarts(({ session }) => this.reportServerGaveUp(session)),
      // A session exists only because resolveServer found something, so this is
      // the signal that the server is no longer missing. Re-arming the notice
      // means a later removal is reported once more instead of staying silent.
      this.manager.onDidChangeSession(({ session }) =>
        this.missingReported?.delete(session.adapter.id),
      ),
      lumine.commands.add("lumine-workspace", {
        "ide:servers": {
          description: "List the language servers now running, and act on one.",
          modal: "Servers",
          didDispatch: () => this.withCustomServers(() => this.getSessionMenu().toggle()),
        },
        "ide:manage-servers": {
          description: "Install, update or remove the servers the editor fetches.",
          modal: "Manage Servers",
          didDispatch: () => this.withCustomServers(() => this.getManagedMenu().toggle()),
        },
        "ide:toggle-problems": {
          description: "Open the panel listing every diagnostic the servers report.",
          didDispatch: () => this.showProblems(),
        },
        "ide:restart": {
          description: "Restart the language server serving this file.",
          didDispatch: (event) => this.restart(event),
        },
        "ide:format": {
          description: "Format this file with whatever its language server offers.",
          didDispatch: (event) => this.format(event),
        },
        "ide:show-log": {
          description: "Open the log of what this file's server has sent and received.",
          didDispatch: (event) => this.showLog(event),
        },
        "ide:open-custom-servers-file": {
          description: "Open the file that declares your own server commands.",
          didDispatch: () => this.withCustomServers(() => this.customServers?.openFile()),
        },
        "ide:fold-server-ranges": {
          description: "Fold every range the language server reports for this file.",
          didDispatch: (event) => {
            const editor = this.editorForCommand(event);
            if (editor) return this.ensureProviders().documentFeatures.foldRanges(editor);
          },
        },
        "ide:expand-selection-range": {
          description: "Expand each selection to its next language-server range.",
          didDispatch: (event) => {
            const editor = this.editorForCommand(event);
            if (editor)
              return this.ensureProviders().documentFeatures.expandSelectionRanges(editor);
          },
        },
        "ide:select-linked-ranges": {
          description: "Select every range linked to the symbol under the cursor.",
          didDispatch: (event) => {
            const editor = this.editorForCommand(event);
            if (editor) return this.ensureProviders().documentFeatures.selectLinkedRanges(editor);
          },
        },
        "ide:color-presentation": {
          description: "Choose a language-server spelling for the color under the cursor.",
          modal: "Color Presentations",
          didDispatch: (event) => {
            const editor = this.editorForCommand(event);
            if (editor) return this.ensureProviders().documentFeatures.colorPresentations(editor);
          },
        },
      }),
    );
    signal?.throwIfAborted();
  },
  async deactivate() {
    this.activationGeneration++;
    this.managedServers?.dispose();
    this._ideService = null;
    this.manager?.setAdapterInitializer(null);
    // Before the manager stops the sessions: closing notebooks sends the
    // didClose notifications while the connections still exist.
    this.notebookDocuments?.dispose();
    this.notebookDocuments = null;
    this.treeFileOperationSubscriptions?.dispose();
    this.treeFileOperationSubscriptions = null;
    this.symbolProvider?.destroy();
    this.symbolProvider = null;
    this.codeLensProvider?.dispose();
    this.codeLensProvider = null;
    this.inlayHintsProvider?.dispose();
    this.inlayHintsProvider = null;
    this.semanticTokensProvider?.dispose();
    this.semanticTokensProvider = null;
    this.documentFeatures?.destroy();
    this.documentFeatures = null;
    this.completionProvider?.dispose();
    this.completionProvider = null;
    this.contextHelpProvider = null;
    this.signatureProvider = null;
    this.codeFormatProvider = null;
    this.referencesProvider?.dispose();
    this.referencesProvider = null;
    this.refactorProvider = null;
    this.intentionsProvider = null;
    this._providerFacades?.dispose();
    this._providerFacades = null;
    this._customServersController?.abort();
    this._customServersController = null;
    this.customServers?.dispose();
    this.customServers = null;
    this._customServersReady = null;
    this._sessionMenu?.destroy();
    this._sessionMenu = null;
    this._managedMenu?.destroy();
    this._managedMenu = null;
    this.managedServers = null;
    this._managedServersSwept = false;
    // The module object outlives a deactivate/activate cycle, so a Set left
    // here would silence the notice for the rest of the process — a reload
    // would look like the opt-out had been pressed.
    this.missingReported = null;
    // Before the manager stops every session: each stop reports a state change
    // the status item would render into a detached element.
    this.teardownStatusBar();
    this.linterBridge?.dispose();
    this.linterBridge = null;
    this.manager?.setBusySignal(null);
    this.busySignal = null;
    this.busySignalRegistration = null;
    this.fileOperationsRegistration = null;
    this.codeFormatRegistration?.dispose();
    this.codeFormatRegistration = null;
    this.uiSubscriptions?.dispose();
    await this.manager?.deactivate();
    this.manager = null;
    this.fileOperationsExecutor = null;
    this._providersReady = false;
  },
  provideIde() {
    return (this._ideService ||= require("./ide-service")(this));
  },
  provideAutocomplete() {
    return this.ensureProviderFacades().autocomplete;
  },
  provideDocumentSymbolProvider() {
    return this.ensureProviderFacades().documentSymbols;
  },
  provideWorkspaceSymbolProvider() {
    return this.ensureProviderFacades().workspaceSymbols;
  },
  provideDefinitionProvider() {
    return this.ensureProviderFacades().definitions;
  },
  provideContextHelp() {
    return this.ensureProviderFacades().contextHelp;
  },
  provideHoverSignature() {
    return this.ensureProviderFacades().signature;
  },
  provideCodeFormatRange() {
    return this.ensureProviderFacades().codeFormatRange;
  },
  provideCodeFormatFile() {
    return this.ensureProviderFacades().codeFormatFile;
  },
  provideCodeFormatOnType() {
    return this.ensureProviderFacades().codeFormatOnType;
  },
  provideCodeFormatOnSave() {
    return this.ensureProviderFacades().codeFormatOnSave;
  },
  provideFindReferences() {
    return this.ensureProviderFacades().references;
  },
  provideRefactor() {
    return this.ensureProviderFacades().refactor;
  },
  provideIntentionsList() {
    return this.ensureProviderFacades().intentions;
  },
  provideCodeLens() {
    return this.ensureProviderFacades().codeLens;
  },
  provideInlayHints() {
    return this.ensureProviderFacades().inlayHints;
  },
  provideSemanticTokens() {
    return this.ensureProviderFacades().semanticTokens;
  },
  provideHyperclick() {
    return this.ensureProviderFacades().hyperclick;
  },
  get sessionMenu() {
    return this.getSessionMenu();
  },
  getSessionMenu() {
    if (!this._sessionMenu) {
      const SessionMenuView = require("./session-menu-view");
      this._sessionMenu = new SessionMenuView(this);
    }
    return this._sessionMenu;
  },
  getManagedMenu() {
    this.ensureManagedServers({ sweep: true });
    if (!this._managedMenu) {
      const ManagedServersView = require("./managed-servers-view");
      this._managedMenu = new ManagedServersView(this);
    }
    return this._managedMenu;
  },
  consumeStatusBar(statusBar) {
    const ServerStatusView = require("./server-status-view");
    // status-bar can be reactivated while this package stays up, which calls
    // the consumer again; tear the previous item down rather than orphan it.
    this.teardownStatusBar();
    this.serverStatus = new ServerStatusView({
      manager: this.manager,
      onDidClick: () => this.getSessionMenu().toggle(),
    });
    // Code-intelligence band, outside source control, see the priority
    // convention in packages/status-bar/README.md.
    this.serverStatusTile = statusBar.addRightTile({
      item: this.serverStatus.element,
      priority: 250,
    });
    const registration = (this.statusBarRegistration = {});
    return new Disposable(() => {
      if (this.statusBarRegistration === registration) this.teardownStatusBar();
    });
  },
  // The disposable above belongs to the status-bar package and never fires on
  // our own deactivation, so both paths call this and it has to be safe twice.
  teardownStatusBar() {
    this.statusBarRegistration = null;
    this.serverStatusTile?.destroy();
    this.serverStatusTile = null;
    this.serverStatus?.destroy();
    this.serverStatus = null;
  },
  // The manager owns transient operations, including work-done progress and
  // delayed request activity. Running servers have a status item of their own.
  consumeBusySignal(busySignal) {
    const manager = this.manager;
    const registration = {};
    this.busySignalRegistration = registration;
    this.busySignal = busySignal;
    manager.setBusySignal(busySignal);
    return new Disposable(() => {
      if (this.busySignalRegistration !== registration) return;
      manager.setBusySignal(null);
      this.busySignal = null;
      this.busySignalRegistration = null;
    });
  },
  consumeFileOperationsExecutor(executor) {
    const manager = this.manager;
    const registration = (this.fileOperationsRegistration = {});
    this.fileOperationsExecutor = executor;
    manager?.setFileOperationsExecutor(executor);
    return new Disposable(() => {
      if (this.fileOperationsRegistration !== registration) return;
      this.fileOperationsRegistration = null;
      this.fileOperationsExecutor = null;
      manager?.setFileOperationsExecutor(null);
    });
  },
  consumeCodeFormatExecutor(executor) {
    this.codeFormatRegistration?.dispose();
    this.codeFormatExecutor = executor;
    const registration = new Disposable(() => {
      if (this.codeFormatRegistration !== registration) return;
      this.codeFormatExecutor = null;
      this.codeFormatRegistration = null;
    });
    this.codeFormatRegistration = registration;
    return registration;
  },
  consumeLinterRegistry(registerIndie) {
    this.linterBridge?.dispose();
    const LinterBridge = require("./linter-bridge");
    const bridge = new LinterBridge(this.manager, registerIndie);
    this.linterBridge = bridge;
    return new Disposable(() => {
      bridge.dispose();
      if (this.linterBridge === bridge) this.linterBridge = null;
    });
  },
  consumeTreeViewFileOperations(service) {
    this.treeFileOperationSubscriptions?.dispose();
    const manager = this.manager;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && this.manager === manager;
    const prepare = async (method, payload) => {
      if (!current() || !manager) return false;
      const signal = payload.signal
        ? AbortSignal.any([payload.signal, controller.signal])
        : controller.signal;
      const preparation = await manager[method]({ ...payload, signal });
      if (!preparation) return false;
      if (!current() || signal.aborted) {
        preparation.dispose();
        return false;
      }
      if (!preparation.hasEdits()) {
        preparation.dispose();
        return true;
      }
      if (service.supportsStagedPreparations?.() === true) return preparation;
      preparation.dispose();
      lumine.notifications.addWarning("Update Tree View before preparing file references", {
        detail: "This Tree View version cannot safely defer reference edits until its guards pass.",
        dismissable: true,
      });
      return false;
    };
    const subscriptions = new CompositeDisposable(
      new Disposable(() => controller.abort()),
      service.onWillCreateFiles((payload) => prepare("prepareCreateFiles", payload)),
      service.onWillRenameFiles((payload) =>
        !current()
          ? false
          : payload.updateReferences === true
            ? prepare("prepareRenameFiles", payload)
            : true,
      ),
      service.onWillDeleteFiles((payload) => prepare("prepareDeleteFiles", payload)),
      service.onDidCreateFiles((payload) => current() && manager?.didCreateFiles(payload)),
      service.onDidRenameFiles((payload) => current() && manager?.didRenameFiles(payload)),
      service.onDidDeleteFiles((payload) => current() && manager?.didDeleteFiles(payload)),
    );
    this.treeFileOperationSubscriptions = subscriptions;
    return new Disposable(() => {
      if (this.treeFileOperationSubscriptions !== subscriptions) return;
      subscriptions.dispose();
      this.treeFileOperationSubscriptions = null;
    });
  },
  // Diagnostics render through the linter package; this only opens the panel
  // that lists them. That panel is its own package, so holding a linter
  // delegate says nothing about whether one is installed — ask for the command.
  showProblems() {
    const view = lumine.views.getView(lumine.workspace);
    const opensPanel = lumine.commands
      .findCommands({ target: view })
      .some((command) => command.name === "linter-panel:toggle");
    if (opensPanel) {
      lumine.commands.dispatch(view, "linter-panel:toggle");
    } else {
      lumine.notifications.addInfo(
        "Install the linter-panel package to browse language-server problems.",
      );
    }
  },
  editorForCommand(event) {
    return (
      lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false }) ??
      lumine.workspace.getActiveTextEditor()
    );
  },
  active(event) {
    const editor = this.editorForCommand(event);
    return { editor, session: editor && this.manager.sessionForEditor(editor) };
  },
  // Restarts every server serving the active editor, since more than one can
  // be attached to it.
  async restart(event) {
    const editor = this.editorForCommand(event);
    if (!editor) return;
    const sessions = this.manager.sessionsForEditor(editor);
    await Promise.all(sessions.map((session) => this.manager.restart(session)));
  },
  // Says once, per window, that an adapter could not find its server.
  //
  // A warning rather than an error: the package is not broken, it simply has
  // nothing to run, and a red banner for an optional tool the user may never
  // have wanted is the loudest possible way to say something minor. Every
  // adapter routes through here so the wording, the dedupe and the opt-out are
  // one implementation instead of one per package — four of them said this in
  // four separate copies before.
  reportMissingServer(adapterId, { description } = {}) {
    const adapter = this.manager.adapters.get(adapterId);
    if (!adapter) return null;
    const manages = adapter.managedServer || typeof adapter.installServer === "function";
    // Undeclared reads as undefined, which must not silence the notice — only
    // an explicit `false`, which is what Never Ask Again writes.
    if (lumine.config.get(`${adapterId}.notifyWhenMissing`) === false) return null;
    const ManagedServers = manages ? require("./managed-servers") : null;
    if (manages) this.ensureManagedServers();
    this.missingReported ??= new Set();
    if (this.missingReported.has(adapterId)) return null;
    this.missingReported.add(adapterId);

    const name =
      adapter.managedServer?.displayName || adapter.managedServerDisplayName || adapter.displayName;
    // A notification button dismisses nothing on its own — `notification-element`
    // calls `onDidClick` and leaves the banner where it is — so every answer here
    // closes it. Both buttons are terminal: the install reports its own progress
    // in a notification of its own, and the opt-out has nothing further to say,
    // so a banner still asking the question is the only thing on screen saying
    // whether the click registered.
    let notification;
    const answer = (act) => () => {
      notification?.dismiss();
      act();
    };
    const buttons = [];
    if (ManagedServers?.manages(adapter)) {
      buttons.push({
        text: `Install ${name}`,
        // Progress and failure are reported by the install itself.
        onDidClick: answer(() => this.installServer(adapterId).catch(() => {})),
      });
    }
    buttons.push({
      text: "Never Ask Again",
      // Written to the package's own settings rather than kept in memory, so it
      // survives a reload and can be undone on the page it belongs to.
      onDidClick: answer(() => lumine.config.set(`${adapterId}.notifyWhenMissing`, false)),
    });
    notification = lumine.notifications.addWarning(`Unable to find ${name}`, {
      description,
      dismissable: true,
      buttons,
    });
    return notification;
  },
  installServer(adapterId, options) {
    const managed = this.ensureManagedServers({ sweep: true });
    return this.runManaged(adapterId, "Installing", (name, record) =>
      lumine.notifications.addSuccess(`${name} ${record.version} installed`),
    )(() => managed.install(adapterId, options));
  },
  updateServer(adapterId, options) {
    const managed = this.ensureManagedServers({ sweep: true });
    return this.runManaged(adapterId, "Updating", (name, record) =>
      record.upToDate
        ? lumine.notifications.addInfo(`${name} is already at ${record.version}`)
        : lumine.notifications.addSuccess(`${name} updated to ${record.version}`),
    )(() => managed.update(adapterId, options));
  },
  uninstallServer(adapterId, options) {
    return this.ensureManagedServers({ sweep: true }).uninstall(adapterId, options);
  },
  // Downloading a server takes long enough that silence reads as a hang, so the
  // work is announced while it runs — through busy-signal where that package is
  // present, and through a notification the rest of the time.
  runManaged(adapterId, verb, report) {
    const managed = this.ensureManagedServers({ sweep: true });
    const manager = this.manager;
    const generation = this.activationGeneration;
    const current = () =>
      this.manager === manager && this.activationGeneration === generation && !managed.disposed;
    return async (work) => {
      const adapter = this.manager.adapters.get(adapterId);
      const name =
        adapter?.managedServer?.displayName ||
        adapter?.managedServerDisplayName ||
        adapter?.displayName ||
        adapterId;
      let title = `${verb} ${name}`;
      const activity = this.manager.beginActivity(null, Symbol("server installation"), { title });
      const pending = this.busySignal ? null : lumine.notifications.addInfo(`${title}…`);
      // The same status the Manage Servers row shows, so the status bar says
      // which part is slow rather than one label for the whole thing. The
      // payload's own `adapterId` is renamed on the way in: shadowing the one
      // this was called with would make the guard compare a value to itself.
      const following = managed.onDidChangeInstallation(({ adapterId: changed, status }) => {
        if (changed !== adapterId || !status) return;
        const next = `${status[0].toUpperCase()}${status.slice(1)} ${name}`;
        if (next === title) return;
        activity.update({ title: next });
        title = next;
      });
      try {
        const record = await work();
        if (!current()) throw new DOMException("Server installation was cancelled", "AbortError");
        report(name, record);
        return record;
      } catch (error) {
        if (current() && error?.name !== "AbortError")
          lumine.notifications.addError(`${verb} ${name} failed`, {
            detail: error.message,
            dismissable: true,
          });
        throw error;
      } finally {
        following.dispose();
        activity.dispose();
        pending?.dismiss();
      }
    };
  },
  async format(event) {
    const editor = this.editorForCommand(event);
    if (!editor) return;
    if (!this.codeFormatExecutor) {
      lumine.notifications.addWarning("Language-server formatting requires active code-format.");
      return;
    }
    try {
      const handled = await this.codeFormatExecutor.formatEditor(editor, {
        reason: "manual",
        provider: "ide",
        range: editor.getBuffer().getRange(),
      });
      if (handled === false)
        lumine.notifications.addWarning("No language-server formatter available for this file.");
    } catch (error) {
      lumine.notifications.addError("Language-server formatting failed.", {
        detail: error.message,
        dismissable: true,
      });
    }
  },
  async showLog(event) {
    const { session } = this.active(event);
    if (!session) return;
    return this.showLogForAdapter(session.adapter.id);
  },
  // A server that keeps dying leaves its reason in the log and nowhere else — a
  // panic, a missing dependency, a rejected option. Without this the only sign
  // was a status item reading "failed", which does not say to go and look.
  reportServerGaveUp(session) {
    const { adapter, failureCount } = session;
    const notification = lumine.notifications.addError(
      `${adapter.displayName} stopped unexpectedly`,
      {
        description: failureCount
          ? `It was restarted ${failureCount} ${failureCount === 1 ? "time" : "times"} and exited again each time, so it will not be restarted any more. Its log says why.`
          : "Automatic restarts are turned off, so it will not be started again. Its log says why it stopped.",
        dismissable: true,
        // Restarting it again is the session menu's job; this is about saying why.
        buttons: [
          {
            text: "Open Log",
            // A notification button dismisses nothing on its own, and this one
            // sits over the workspace center the log opens into — so it closes
            // once the log is on screen, which is the moment the banner has
            // said everything it had to say. Only then: an open that declines
            // leaves the notification as the one record of what happened.
            onDidClick: async () => {
              if (await this.showLogForAdapter(adapter.id)) notification.dismiss();
            },
          },
        ],
      },
    );
  },
  // Returns the editor the log went into, or nothing when the open declined —
  // the notification's Open Log button reads that to decide whether it may go.
  async showLogForAdapter(adapterId) {
    const editor = await lumine.workspace.open();
    // An open can decline, e.g. when the workspace center is full.
    if (!editor) return;
    editor.setText(this.manager.getLog(adapterId));
    if (!lumine.grammars.assignLanguageMode(editor, "text.plain")) {
      lumine.grammars.assignLanguageMode(editor, null);
    }
    return editor;
  },
};
