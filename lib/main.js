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
      packageName: "ide-client",
      tips: [
        "{% if keys['ide-client:servers'] %}You can see every language server that is running, and restart any of them, with {{ 'ide-client:servers' | keystroke }}{% else %}Lumine speaks the Language Server Protocol. Install an ide package for your language to get completions, diagnostics, and go-to-definition.{% endif %}",
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
    if (!this.manager) throw new Error("ide-client notebooks require an active manager");
    const NotebookDocuments = require("./notebook-documents");
    this.notebookDocuments = new NotebookDocuments(this.manager);
    this.manager.setNotebookDocuments(this.notebookDocuments);
    return this.notebookDocuments;
  },
  ensureManagedServers({ sweep = false } = {}) {
    if (this.managedServers) {
      if (sweep && !this._managedServersSwept) {
        this.managedServers.sweep();
        this._managedServersSwept = true;
      }
      return this.managedServers;
    }
    if (!this.manager) throw new Error("ide-client server management requires an active manager");
    const ManagedServers = require("./managed-servers");
    this.managedServers = new ManagedServers(this.manager);
    this.manager.setManagedServers(this.managedServers);
    if (sweep) {
      // A stage or backup left by a killed install would otherwise sit in the
      // storage directory for good; nothing has been launched from it yet.
      this.managedServers.sweep();
      this._managedServersSwept = true;
    }
    return this.managedServers;
  },
  ensureCustomServers({ signal } = {}) {
    if (this._customServersReady) return this._customServersReady;
    if (!this.manager) throw new Error("custom servers require an active manager");
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
    Promise.resolve(customServers.activate({ signal })).then(resolveReady, (error) => {
      if (this.customServers === customServers) this._customServersReady = null;
      rejectReady(error);
    });
    return this._customServersReady;
  },
  ensureProviders() {
    if (this._providersReady) return this;
    if (!this.manager) throw new Error("ide-client providers require an active manager");

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
        "ide-client:servers": {
          description: "List the language servers now running, and act on one.",
          modal: "Servers",
          didDispatch: () => this.ensureCustomServers().then(() => this.getSessionMenu().toggle()),
        },
        "ide-client:manage-servers": {
          description: "Install, update or remove the servers the editor fetches.",
          modal: "Manage Servers",
          didDispatch: () => this.ensureCustomServers().then(() => this.getManagedMenu().toggle()),
        },
        "ide-client:toggle-problems": {
          description: "Open the panel listing every diagnostic the servers report.",
          didDispatch: () => this.showProblems(),
        },
        "ide-client:restart": {
          description: "Restart the language server serving this file.",
          didDispatch: () => this.restart(),
        },
        "ide-client:format": {
          description: "Format this file with whatever its language server offers.",
          didDispatch: (event) => this.format(event),
        },
        "ide-client:show-log": {
          description: "Open the log of what this file's server has sent and received.",
          didDispatch: () => this.showLog(),
        },
        "ide-client:open-custom-servers-file": {
          description: "Open the file that declares your own server commands.",
          didDispatch: () => this.ensureCustomServers().then(() => this.customServers?.openFile()),
        },
        "ide-client:fold-server-ranges": {
          description: "Fold every range the language server reports for this file.",
          didDispatch: () => {
            const editor = lumine.workspace.getActiveTextEditor();
            if (editor) return this.ensureProviders().documentFeatures.foldRanges(editor);
          },
        },
        "ide-client:expand-selection-range": {
          description: "Expand each selection to its next language-server range.",
          didDispatch: () => {
            const editor = lumine.workspace.getActiveTextEditor();
            if (editor)
              return this.ensureProviders().documentFeatures.expandSelectionRanges(editor);
          },
        },
        "ide-client:select-linked-ranges": {
          description: "Select every range linked to the symbol under the cursor.",
          didDispatch: () => {
            const editor = lumine.workspace.getActiveTextEditor();
            if (editor) return this.ensureProviders().documentFeatures.selectLinkedRanges(editor);
          },
        },
        "ide-client:color-presentation": {
          description: "Choose a language-server spelling for the color under the cursor.",
          modal: "Color Presentations",
          didDispatch: () => {
            const editor = lumine.workspace.getActiveTextEditor();
            if (editor) return this.ensureProviders().documentFeatures.colorPresentations(editor);
          },
        },
      }),
    );
    signal?.throwIfAborted();
  },
  async deactivate() {
    this.activationGeneration++;
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
    this.completionProvider = null;
    this.contextHelpProvider = null;
    this.signatureProvider = null;
    this.codeFormatProvider = null;
    this.referencesProvider = null;
    this.refactorProvider = null;
    this.intentionsProvider = null;
    this._providerFacades?.dispose();
    this._providerFacades = null;
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
    this.indieSubscription?.dispose();
    this.indieSubscription = null;
    this.disposeIndieDelegates();
    this.manager?.setBusySignal(null);
    this.busySignal = null;
    this.busySignalRegistration = null;
    this.codeFormatRegistration?.dispose();
    this.codeFormatRegistration = null;
    this.uiSubscriptions?.dispose();
    await this.manager?.deactivate();
    this.manager = null;
    this.fileOperationsExecutor = null;
    this._providersReady = false;
  },
  provideIdeClient() {
    return {
      registerAdapter: (adapter) => {
        if (adapter?.managedServer || typeof adapter?.installServer === "function")
          this.ensureManagedServers();
        return this.manager.registerAdapter(adapter);
      },
      adaptersForEditor: (editor) => this.manager.adaptersForEditor(editor),
      onDidChangeAdapters: (fn) => this.manager.onDidChangeAdapters(fn),
      sessionForEditor: (editor) => this.manager.sessionForEditor(editor),
      activeSessionForEditor: (editor) => this.manager.activeSessionForEditor(editor),
      activeSessionsForEditor: (editor) => this.manager.activeSessionsForEditor(editor),
      activeSessionForFeature: (editor, method, feature) =>
        this.manager.activeSessionForFeature(editor, method, feature),
      getSessions: () => this.manager.allSessions(),
      onDidChangeSession: (fn) => this.manager.onDidChangeSession(fn),
      onDidChangeCapabilities: (fn) => this.manager.onDidChangeCapabilities(fn),
      onDidPublishDiagnostics: (fn) => this.manager.onDidPublishDiagnostics(fn),
      createProjectDiagnostics: (adapterId, delegate) => {
        const ProjectDiagnostics = require("./project-diagnostics");
        return new ProjectDiagnostics(this.manager, adapterId, delegate);
      },
      onDidChangeFeatures: (fn) => this.manager.onDidChangeFeatures(fn),
      featureEnabled: (adapter, feature, editor) =>
        this.manager.featureEnabled(adapter, feature, editor),
      onDidLog: (fn) => this.manager.onDidLog(fn),
      request: (editor, method, params, options) =>
        this.manager.sessionForEditor(editor)?.request(method, params, options),
      restart: (session) => this.manager.restart(session),
      stop: (session) => this.manager.disconnect(session),
      getLog: (adapterId) => this.manager.getLog(adapterId),
      // Managed servers. An adapter reaches for these to offer an install where
      // it would otherwise only report the server missing; the same calls back
      // the Manage Servers list.
      reportMissingServer: (adapterId, options) => this.reportMissingServer(adapterId, options),
      installServer: (adapterId, options) => this.installServer(adapterId, options),
      updateServer: (adapterId) => this.updateServer(adapterId),
      uninstallServer: (adapterId) => this.ensureManagedServers().uninstall(adapterId),
      managedServer: (adapterId) =>
        this.ensureManagedServers().installFor(this.manager.adapters.get(adapterId)),
      serverInstallationStatus: (adapterId) =>
        this.ensureManagedServers().installationStatus(adapterId),
      onDidChangeServerInstallation: (fn) =>
        this.ensureManagedServers().onDidChangeInstallation(fn),
      applyWorkspaceEdit: (edit, label, session) =>
        this.manager.applyWorkspaceEdit(edit, label, session),
      willCreateFiles: (payload) => this.manager.willCreateFiles(payload),
      willRenameFiles: (payload) => this.manager.willRenameFiles(payload),
      willDeleteFiles: (payload) => this.manager.willDeleteFiles(payload),
      didCreateFiles: (payload) => this.manager.didCreateFiles(payload),
      didRenameFiles: (payload) => this.manager.didRenameFiles(payload),
      didDeleteFiles: (payload) => this.manager.didDeleteFiles(payload),
      // Notebook documents. `openNotebookDocument` is the bridge a notebook UI
      // drives — jupyter-view itself — and the rest of LSP follows:
      // sync, routing of the cell editors through every provider, and cell
      // diagnostics landing against the notebook.
      openNotebookDocument: (descriptor) => this.ensureNotebookDocuments().open(descriptor),
      adaptersForNotebook: (filePath) =>
        this.notebookDocuments?.adaptersForNotebook(filePath) ?? [],
      cellUri: (notebookPath, cellId) => require("./converters").cellUri(notebookPath, cellId),
      parseCellUri: (uri) => require("./converters").parseCellUri(uri),
      openNotebook: (session, notebook, cells) => session.openNotebook(notebook, cells),
      changeNotebook: (session, notebook, change) => session.changeNotebook(notebook, change),
      saveNotebook: (session, notebook) => session.saveNotebook(notebook),
      closeNotebook: (session, notebook, cells) => session.closeNotebook(notebook, cells),
    };
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
    return new Disposable(() => this.teardownStatusBar());
  },
  // The disposable above belongs to the status-bar package and never fires on
  // our own deactivation, so both paths call this and it has to be safe twice.
  teardownStatusBar() {
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
    this.fileOperationsExecutor = executor;
    this.manager?.setFileOperationsExecutor(executor);
    return new Disposable(() => {
      if (this.fileOperationsExecutor !== executor) return;
      this.fileOperationsExecutor = null;
      this.manager?.setFileOperationsExecutor(null);
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
    this.indieSubscription?.dispose();
    this.disposeIndieDelegates();
    const manager = this.manager;
    const subscriptions = (this.indieSubscription = new CompositeDisposable());
    const delegates = (this.indieDelegates = new Map());
    const delegateAdapters = new Map();
    // Per adapter, per notebook, per cell: the whole notebook publishes in one
    // setMessages call, because the delegate replaces a file's entire bucket —
    // publishing cells one at a time would leave only the last cell standing.
    const notebookBuckets = (this.notebookBuckets = new Map());
    const isCurrent = () => this.indieSubscription === subscriptions && this.manager === manager;
    const C = require("./converters");
    const pending = new Map();
    const owners = new Map();
    const featureRevisions = new Map();
    const ready = new Map();
    let presentationTimer = null;
    let republishTimer = null;
    let republishGeneration = 0;
    subscriptions.add(
      new Disposable(() => {
        clearImmediate(republishTimer);
        clearImmediate(presentationTimer);
        pending.clear();
        owners.clear();
        ready.clear();
        republishGeneration++;
      }),
    );
    const removeDelegate = (adapter) => {
      if (delegateAdapters.get(adapter.id) !== adapter) return;
      delegateAdapters.delete(adapter.id);
      const delegate = delegates.get(adapter.id);
      delegates.delete(adapter.id);
      pending.delete(adapter);
      owners.delete(adapter);
      notebookBuckets.delete(adapter.id);
      delegate?.dispose();
    };
    const delegateFor = (adapter) => {
      // Adapter disposal precedes session reclamation. A late diagnostic or
      // its final clear must not recreate a delegate, including after another
      // adapter generation has registered under the same ID.
      if (!isCurrent() || !adapter || manager.adapters.get(adapter.id) !== adapter) return null;
      const previous = delegateAdapters.get(adapter.id);
      if (previous && previous !== adapter) removeDelegate(previous);
      let delegate = delegates.get(adapter.id);
      if (!delegate) {
        delegate = registerIndie({
          name: adapter.displayName,
          markerInvalidation: "never",
        });
        delegates.set(adapter.id, delegate);
        delegateAdapters.set(adapter.id, adapter);
      }
      return delegate;
    };
    // Diagnostics may be pushed or pulled, so the `diagnostics` switch is honoured here
    // rather than where they arrive: what the server sent stays stored, and
    // switching the feature back on republishes it. Dropping it at arrival
    // would need a server restart to get it back — LSP has no way to ask for
    // diagnostics again from a push-only server.
    const publish = (entry) => {
      const { session, uri, diagnostics } = entry;
      const adapter = session?.adapter;
      const delegate = delegateFor(adapter);
      if (!delegate) return;
      const key = C.uriKey(uri);
      const stored = manager.diagnostics.get(session)?.get(key);
      // A sliced replay may still hold an iterator into a retired session.
      // Reject that entry before it can supersede a newer presentation job.
      if ((stored && stored !== entry) || (!stored && diagnostics?.length)) return;
      const resolved = manager.resolveUri(uri);
      if (resolved?.kind === "cell") {
        return this.publishCellDiagnostics({
          adapter,
          uri,
          diagnostics,
          resolved,
          delegate,
          manager,
          notebookBuckets,
        });
      }
      if (resolved?.kind !== "file") return;
      const filePath = resolved.path;
      let byOwner = owners.get(adapter);
      if (!byOwner) owners.set(adapter, (byOwner = new Map()));
      const owner = byOwner.get(key);
      // Reclamation of an old process must not clear a replacement process's
      // report while its asynchronous presentation is being prepared.
      if (
        !diagnostics?.length &&
        owner &&
        owner !== session &&
        manager.diagnostics.get(owner)?.has(key)
      )
        return;
      byOwner.set(key, session);
      let byUri = pending.get(adapter);
      if (!byUri) pending.set(adapter, (byUri = new Map()));
      const revision = featureRevisions.get(adapter);
      const job = {};
      byUri.set(key, job);
      const current = () =>
        isCurrent() &&
        manager.adapters.get(adapter.id) === adapter &&
        byUri.get(key) === job &&
        featureRevisions.get(adapter) === revision &&
        (manager.diagnostics.get(session)?.get(key) === entry ||
          (!diagnostics?.length && !manager.diagnostics.get(session)?.has(key)));
      const finish = (enabled) => {
        if (!current()) return;
        // An editor may have opened while the closed-file read was pending.
        const opened = lumine.workspace
          .getTextEditors()
          .find(
            (candidate) =>
              candidate.getPath() && C.uriKey(C.pathToUri(candidate.getPath())) === key,
          );
        if (opened && diagnostics?.length)
          enabled = manager.featureEnabled(adapter, "diagnostics", opened);
        const messages = enabled
          ? require("./linter-messages").toLinterMessages(uri, diagnostics).messages
          : [];
        delegate.setMessages(filePath, messages);
        if (!diagnostics?.length && byOwner.get(key) === session) byOwner.delete(key);
        if (!byOwner.size && owners.get(adapter) === byOwner) owners.delete(adapter);
        if (byUri.get(key) === job) byUri.delete(key);
        if (!byUri.size && pending.get(adapter) === byUri) pending.delete(adapter);
      };
      const editor = lumine.workspace
        .getTextEditors()
        .find(
          (candidate) => candidate.getPath() && C.uriKey(C.pathToUri(candidate.getPath())) === key,
        );
      const enabled = !diagnostics?.length
        ? false
        : editor
          ? manager.featureEnabled(adapter, "diagnostics", editor)
          : manager.featureEnabledForPath(adapter, "diagnostics", filePath);
      const release = () => {
        if (byUri.get(key) === job) byUri.delete(key);
        if (!byUri.size && pending.get(adapter) === byUri) pending.delete(adapter);
      };
      if (enabled?.then)
        enabled
          .then(
            (enabled) => {
              if (!current()) return release();
              // Cached grammar answers can resolve in one microtask burst. Queue
              // the actual conversion and delegate work under the same budget.
              ready.set(`${adapter.id}\0${key}`, () => {
                try {
                  finish(enabled);
                } catch (error) {
                  manager.log(session, `Unable to present diagnostics: ${error.message}`);
                } finally {
                  release();
                }
              });
              if (presentationTimer) return;
              const step = () => {
                presentationTimer = null;
                if (!isCurrent()) return;
                const deadline = performance.now() + 5;
                while (ready.size) {
                  const [key, present] = ready.entries().next().value;
                  ready.delete(key);
                  present();
                  if (performance.now() >= deadline && ready.size) {
                    presentationTimer = setImmediate(step);
                    return;
                  }
                }
              };
              presentationTimer = setImmediate(step);
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
      else finish(enabled);
    };
    const republish = (adapter, keys) => {
      if (!isCurrent()) return;
      if (republishTimer) {
        adapter = null;
        keys = null;
      }
      clearImmediate(republishTimer);
      const generation = ++republishGeneration;
      // A second switch while a bulk replay is pending supersedes the replay,
      // so visit all adapters to include the first switch's unfinished work.
      const entries = manager.diagnosticEntries();
      const step = () => {
        if (!isCurrent() || generation !== republishGeneration) return;
        const deadline = performance.now() + 5;
        let next;
        while (!(next = entries.next()).done) {
          const entry = next.value;
          if (
            (!adapter || entry.session?.adapter === adapter) &&
            (!keys || keys.has(C.uriKey(entry.uri)))
          )
            publish(entry);
          if (performance.now() >= deadline) {
            republishTimer = setImmediate(step);
            return;
          }
        }
        republishTimer = null;
      };
      step();
    };
    subscriptions.add(
      manager.onDidPublishDiagnostics(publish),
      manager.onDidChangeFeatures(({ adapter }) => {
        featureRevisions.set(adapter, (featureRevisions.get(adapter) || 0) + 1);
        pending.delete(adapter);
        republish(republishTimer ? null : adapter);
      }),
      manager.onDidChangeDiagnosticScopes(({ keys }) => republish(null, keys)),
      manager.onDidChangeAdapters(({ adapter, registered }) => {
        if (!isCurrent()) return;
        if (registered) delegateFor(adapter);
        else removeDelegate(adapter);
      }),
    );
    // Registration belongs to the adapter's lifetime, not its first report or
    // diagnostics feature switch, so every adapter is available in Toggle Linter.
    for (const adapter of manager.adapters.values()) delegateFor(adapter);
    republish(null);
    return new Disposable(() => {
      subscriptions.dispose();
      if (this.indieSubscription !== subscriptions) return;
      this.indieSubscription = null;
      this.disposeIndieDelegates();
    });
  },
  consumeTreeViewFileOperations(service) {
    this.treeFileOperationSubscriptions?.dispose();
    const controller = new AbortController();
    const prepare = async (method, payload) => {
      if (!this.manager) return true;
      const signal = payload.signal
        ? AbortSignal.any([payload.signal, controller.signal])
        : controller.signal;
      const preparation = await this.manager[method]({ ...payload, signal });
      if (!preparation) return false;
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
        payload.updateReferences === true ? prepare("prepareRenameFiles", payload) : true,
      ),
      service.onWillDeleteFiles((payload) => prepare("prepareDeleteFiles", payload)),
      service.onDidCreateFiles((payload) => this.manager?.didCreateFiles(payload)),
      service.onDidRenameFiles((payload) => this.manager?.didRenameFiles(payload)),
      service.onDidDeleteFiles((payload) => this.manager?.didDeleteFiles(payload)),
    );
    this.treeFileOperationSubscriptions = subscriptions;
    return new Disposable(() => {
      if (this.treeFileOperationSubscriptions !== subscriptions) return;
      subscriptions.dispose();
      this.treeFileOperationSubscriptions = null;
    });
  },
  disposeIndieDelegates() {
    for (const delegate of this.indieDelegates?.values() || []) delegate.dispose();
    this.indieDelegates = null;
    this.notebookBuckets = null;
  },
  // Cell diagnostics aggregate per notebook and publish as one batch against
  // the notebook's path — the shape jupyter-view's linter adapter projects
  // onto the cells. Republishing after a structural edit flows back through
  // here, and `resolveUri` reads the cell's CURRENT index, which is what
  // re-projects the stored diagnostics onto the right cells.
  publishCellDiagnostics({
    adapter,
    uri,
    diagnostics,
    resolved,
    delegate,
    manager,
    notebookBuckets,
  }) {
    const { toNotebookLinterMessages } = require("./linter-messages");
    const C = require("./converters");
    const adapterKey = adapter.id;
    let byNotebook = notebookBuckets.get(adapterKey);
    if (!byNotebook) {
      byNotebook = new Map();
      notebookBuckets.set(adapterKey, byNotebook);
    }
    let byCell = byNotebook.get(resolved.notebookPath);
    if (!byCell) {
      byCell = new Map();
      byNotebook.set(resolved.notebookPath, byCell);
    }
    const cellKey = C.uriKey(uri);
    // A cell that vanished between the server's answer and now has no index;
    // whatever it had on screen is evicted.
    const enabled = manager.featureEnabled(adapter, "diagnostics", resolved.editor);
    const messages =
      enabled && resolved.cellIndex >= 0 && diagnostics?.length
        ? toNotebookLinterMessages(
            { notebookPath: resolved.notebookPath, cellIndex: resolved.cellIndex },
            diagnostics,
          ).messages
        : [];
    if (messages.length) byCell.set(cellKey, messages);
    else byCell.delete(cellKey);
    delegate.setMessages(resolved.notebookPath, enabled ? [...byCell.values()].flat() : []);
    if (!byCell.size) byNotebook.delete(resolved.notebookPath);
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
  active() {
    const editor = lumine.workspace.getActiveTextEditor();
    return { editor, session: editor && this.manager.sessionForEditor(editor) };
  },
  // Restarts every server serving the active editor, since more than one can
  // be attached to it.
  async restart() {
    const editor = lumine.workspace.getActiveTextEditor();
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
    this.ensureManagedServers({ sweep: true });
    return this.runManaged(adapterId, "Installing", (name, record) =>
      lumine.notifications.addSuccess(`${name} ${record.version} installed`),
    )(() => this.managedServers.install(adapterId, options));
  },
  updateServer(adapterId) {
    this.ensureManagedServers({ sweep: true });
    return this.runManaged(adapterId, "Updating", (name, record) =>
      record.upToDate
        ? lumine.notifications.addInfo(`${name} is already at ${record.version}`)
        : lumine.notifications.addSuccess(`${name} updated to ${record.version}`),
    )(() => this.managedServers.update(adapterId));
  },
  // Downloading a server takes long enough that silence reads as a hang, so the
  // work is announced while it runs — through busy-signal where that package is
  // present, and through a notification the rest of the time.
  runManaged(adapterId, verb, report) {
    this.ensureManagedServers({ sweep: true });
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
      const following = this.managedServers.onDidChangeInstallation(
        ({ adapterId: changed, status }) => {
          if (changed !== adapterId || !status) return;
          const next = `${status[0].toUpperCase()}${status.slice(1)} ${name}`;
          if (next === title) return;
          activity.update({ title: next });
          title = next;
        },
      );
      try {
        const record = await work();
        report(name, record);
        return record;
      } catch (error) {
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
    const editor =
      lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false }) ??
      lumine.workspace.getActiveTextEditor();
    if (!editor) return;
    if (!this.codeFormatExecutor) {
      lumine.notifications.addWarning("Language-server formatting requires active code-format.");
      return;
    }
    try {
      const handled = await this.codeFormatExecutor.formatEditor(editor, {
        reason: "manual",
        provider: "ide-client",
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
  async showLog() {
    const { session } = this.active();
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
