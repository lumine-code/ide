let runtime;
const getRuntime = () =>
  (runtime ||= require("./language-server-manager-runtime")({
    path,
    C,
    languageIdForEditor,
    relativePath,
    PROJECT_WATCH_GRACE_MS,
    serverName,
    markdownBlocks,
    externalUrl,
    selectAdapters: require("./adapter-selection").selectAdapters,
    CompositeDisposable,
  }));

const path = require("path");
const validateAdapter = (adapter) => require("./adapter-contract").validateAdapter(adapter);

const { Emitter, CompositeDisposable, Disposable } = require("lumine");
const { relativePath } = require("./workspace-paths");
let converters;
const C = new Proxy({}, { get: (_target, name) => (converters ||= require("./converters"))[name] });
const languageIdForEditor = (...args) => require("./language-ids").languageIdForEditor(...args);
const { featuresKeyPath, featureEnabled } = require("./features");
const EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function externalUrl(uri) {
  try {
    const url = new URL(uri);
    return EXTERNAL_URL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const PROJECT_WATCH_GRACE_MS = 5000;

// What to call a server in something the user reads. A window runs several at
// once and nothing a server sends says which one it came from, so every message
// surfaced from one is named -- and a message with no session behind it still
// reads as a language server rather than as the editor.
function serverName(session) {
  return session?.adapter?.displayName || "Language server";
}

const LIST_ITEM = /^\s*([*+-]|\d+[.)])\s/;

// A notification renders its description as markdown, which is what turns a
// server's links into links. The text arriving from a server is plain, though,
// so a line under a bullet with no blank line between them is a lazy
// continuation -- which is how the closing sentence of Basedpyright's
// workspace-enumeration warning renders inside its last bullet. Reinstate the
// break, so a server's own paragraphs survive.
function markdownBlocks(lines) {
  const out = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (previous && LIST_ITEM.test(previous) && line.trim() && !LIST_ITEM.test(line)) out.push("");
    out.push(line);
  }
  return out.join("\n").trim();
}

module.exports = class LanguageServerManager {
  constructor() {
    this.adapters = new Map();
    this.adapterSubscriptions = new Map();
    this.sessions = new Map();
    // A route is owned by the adapter object, not merely by its public id. An
    // adapter package can deactivate and register a fresh object with the same
    // id while the old shutdown is still finishing; the two must never share a
    // process or let the old cleanup remove the new route. `sessions` remains a
    // flat mirror for views and existing enumeration code, while these maps are
    // the lifecycle source of truth.
    this.controllerRoutes = new WeakMap();
    this.controllers = new Set();
    this.selectionRetirements = new Set();
    this.sessionControllers = new WeakMap();
    // Includes replacements between construction and publication. A renderer
    // teardown has to reach those too, not only what is currently routable.
    this.ownedSessions = new Set();
    this.sessionExitWaiters = new WeakMap();
    this.controllerHost = {
      isActive: (controller) =>
        !this.tearingDown &&
        this.controllers.has(controller) &&
        this.ownsControllerRoutes(controller),
      prepareContext: (...args) => this.prepareStartupContext(...args),
      beginStartup: (controller) =>
        this.beginActivity(controller, Symbol("server preparation"), {
          title: "Preparing server",
          delay: 400,
        }),
      controllerHasDemand: (controller) => this.controllerHasDemand(controller),
      createSession: (controller, prepared) =>
        new (require("./server-session"))(
          this,
          controller.adapter,
          prepared.rootPath,
          prepared.launch,
          prepared.startup,
        ),
      registerSession: (...args) => this.registerSession(...args),
      withdrawSession: (session) => this.withdrawSession(session),
      recoverDegradedObservation: (...args) => this.recoverDegradedObservation(...args),
      splitUnsupportedFolders: (...args) => this.splitUnsupportedFolders(...args),
      reattachAll: () => this.reattachAll(),
      scheduleReattachAll: () => this.scheduleReattachAll(),
      retireController: (controller) => this.retireController(controller),
      cancelController: (controller) => this.cancelController(controller),
      reportStartFailure: (...args) => this.reportStartFailure(...args),
      reportSettingsFailure: (...args) => this.reportSettingsFailure(...args),
      physicallyExited: (session) => this.sessionPhysicallyExited(session),
      didExitProcess: (session) => this.didExitProcess(session),
      waitForSessionExit: (session) => this.waitForSessionExit(session),
      restartLimit: () => lumine.config.get("ide.restartLimit"),
      exhausted: (session) => this.emitter.emit("did-exhaust-restarts", { session }),
      log: (...args) => this.log(...args),
      stopFailure: (session, error) =>
        console.error(`ide: failed to stop ${session?.adapter?.id ?? "a language server"}`, error),
      stopIfUnreachable: (session) => this.stopIfUnreachable(session),
    };
    this.adapterRestartOperations = new WeakMap();
    this.dynamicCapabilities = new Map();
    this.capabilityFragments = [];
    // The package supplies feature providers lazily. Calling this hook before
    // building the first client-capabilities object keeps the handshake
    // identical to the eager implementation without loading provider modules
    // while the package is only being activated.
    this.capabilityInitializer = null;
    this.diagnostics = new Map();
    this.logs = new Map();
    this.editorSubscriptions = new Map();
    this._activity = null;
    this._busySignal = null;
    // Package-owned adapters may need a small bootstrap (custom server
    // configuration is one example) before an editor is matched against them.
    // Keeping that bootstrap behind a callback lets the package defer its
    // server-management modules until an editor actually needs them.
    this.adapterInitializer = null;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.unloadSubscription = null;
    // Teardown wakes every physical-exit waiter, even when a child cannot exit.
    this.teardownPromise = new Promise((resolve) => (this.resolveTeardown = resolve));
    this.tearingDown = false;
    this.resolutionLifetime = new AbortController();
    this._serverResolver = null;
    this.managedServersInitializer = null;
    this.workspaceProjectRevision = 0;
    this.projectRootRevisions = new Map();
    this.reattachScheduled = false;
    // Editors whose document identity is not their file path — notebook cells.
    // The WeakMap routes an editor to its binding; the Map routes a URI a
    // server sent back to the same binding. Registered by the notebook module.
    this.notebookDocuments = null;
    this._diagnosticScopes = null;
    this._workspaceDocuments = null;
    this._workspaceEdits = null;
    this._fileOperations = null;
  }
  get fileOperations() {
    if (this._fileOperations) return this._fileOperations;
    const { WorkspaceFileOperations } = require("./registration-services");
    this._fileOperations = new WorkspaceFileOperations({
      getDocuments: () => this.workspaceDocuments,
      host: {
        sessions: () => (this.tearingDown ? [] : this.allSessions()),
        hasSessions: () =>
          (!this.tearingDown && this.allSessions().length > 0) || this.dynamicCapabilities.size > 0,
        dynamicCapabilities: () => this.dynamicCapabilities,
        foldersFor: (session) => this.foldersFor(session),
        globMatches: (...args) => this.globMatches(...args),
        invalidateScopes: (paths) => this.invalidateDiagnosticScopes(paths),
        log: (...args) => this.log(...args),
      },
    });
    if (this.tearingDown) this._fileOperations.dispose();
    return this._fileOperations;
  }
  set fileOperations(operations) {
    this._fileOperations = operations;
  }
  get activity() {
    if (!this._activity) {
      const ServerActivity = require("./server-activity");
      this._activity = new ServerActivity((session, error) =>
        this.log(session, error.stack || error.message || error),
      );
      this._activity.setBusySignal(this._busySignal);
      if (this.tearingDown) this._activity.dispose();
    }
    return this._activity;
  }
  set activity(activity) {
    this._activity = activity;
  }
  get diagnosticScopes() {
    if (!this._diagnosticScopes) {
      const DiagnosticScopeCache = require("./diagnostic-scope-cache");
      this._diagnosticScopes = new DiagnosticScopeCache((filePath, options) =>
        lumine.grammars.selectGrammarAsync(filePath, options),
      );
      if (this.tearingDown) this._diagnosticScopes.dispose();
    }
    return this._diagnosticScopes;
  }
  set diagnosticScopes(scopes) {
    this._diagnosticScopes = scopes;
  }
  get workspaceDocuments() {
    if (!this._workspaceDocuments) {
      const WorkspaceDocuments = require("./workspace-documents");
      this._workspaceDocuments = new WorkspaceDocuments({
        reattachEditor: (editor) => this.reattachEditor(editor),
      });
      if (this.tearingDown) this._workspaceDocuments.dispose();
    }
    return this._workspaceDocuments;
  }
  set workspaceDocuments(documents) {
    this._workspaceDocuments = documents;
  }
  get serverResolver() {
    return (this._serverResolver ||= require("./server-resolver").createServerResolver({
      signal: this.resolutionLifetime.signal,
      assertActive: () => {
        if (this.tearingDown)
          throw new DOMException("The IDE resolver is no longer active", "AbortError");
      },
    }));
  }
  set serverResolver(resolver) {
    this._serverResolver = resolver;
  }
  get workspaceEdits() {
    if (!this._workspaceEdits) {
      const WorkspaceEdits = require("./workspace-edits");
      this._workspaceEdits = new WorkspaceEdits({
        documents: this.workspaceDocuments,
        fileOperations: this.fileOperations,
        log: (...args) => this.log(...args),
      });
      if (this.tearingDown) this._workspaceEdits.dispose();
    }
    return this._workspaceEdits;
  }
  set workspaceEdits(edits) {
    this._workspaceEdits = edits;
  }
  setManagedServersInitializer(initializer) {
    this.managedServersInitializer = typeof initializer === "function" ? initializer : null;
  }
  setNotebookDocuments(notebookDocuments) {
    this.notebookDocuments = notebookDocuments;
  }
  setAdapterInitializer(initializer) {
    this.adapterInitializer = typeof initializer === "function" ? initializer : null;
  }
  // binding: { editor, uri, cellId, record } — record carries the notebook's
  // filePath, its uri, cellIndexOf(cellId), and an optional show() callback.

  // The document URI requests about this editor carry. For a bound editor that
  // is its cell URI; ordinary scratch buffers get a stable untitled URI until
  // they are saved. No temporary file is created for a language server.
  uriForEditor(...args) {
    return getRuntime().uriForEditor.apply(this, args);
  }

  // What a URI a server answered with refers to. Cell URIs resolve through the
  // bindings; file URIs to their path; anything else to null.
  resolveUri(...args) {
    return getRuntime().resolveUri.apply(this, args);
  }
  activate() {
    this.knownRoots = lumine.project.getPaths();
    for (const event of ["onDidAddGrammar", "onDidUpdateGrammar", "onDidRemoveGrammar"])
      this.subscriptions.add(lumine.grammars[event](() => this.invalidateDiagnosticScopes()));
    this.subscriptions.add(
      lumine.config.onDidChange("core.customFileTypes", () => this.invalidateDiagnosticScopes()),
      lumine.workspace.observeTextEditors((editor) => {
        this.watchEditor(editor);
        this.attachEditor(editor);
      }),
      lumine.project.onDidChangePaths(() => this.projectPathsChanged()),
      lumine.project.onDidChangeFiles((events) => this.fileOperations.routeEvents(events)),
      lumine.project.onDidInvalidateFiles((event) => this.recoverFileWatching(event)),
      lumine.config.onDidChange("ide.trace", () => {
        for (const session of this.allSessions()) session.applyTrace();
      }),
      lumine.config.onDidChange("ide.preferredServers", () => {
        this.adapterSelectionChanged();
        for (const adapter of this.adapters.values())
          if (adapter.exclusiveGroup)
            this.emitter.emit("did-change-adapters", {
              adapter,
              registered: true,
              selectionChanged: true,
            });
        this.scheduleReattachAll();
      }),
    );
    // Keep the last-chance kill separate from the regular subscriptions:
    // window teardown can abandon a graceful stop that exceeds its deadline.
    this.unloadSubscription = lumine.window.onWillDestroy(() => this.killAllSessions());
  }
  onDidChangeSession(fn) {
    return this.emitter.on("did-change-session", fn);
  }
  // fn({adapter, registered}) — fired when an adapter is registered or
  // unregistered. What a package outside the hub needs it for: a linter that
  // shells out to the same tool a server already serves stands down while that
  // adapter covers an editor, and has to hear when the coverage changes.
  onDidChangeAdapters(fn) {
    return this.emitter.on("did-change-adapters", fn);
  }
  onDidPublishDiagnostics(fn) {
    return this.emitter.on("did-publish-diagnostics", fn);
  }
  onDidChangeNotebook(fn) {
    return this.emitter.on("did-change-notebook", fn);
  }
  // fn({adapter}) — fired when one of an adapter's feature switches changes.
  // What is already on screen was produced under the old answer, so whoever
  // holds it re-reads: the feature modules refetch, and diagnostics — which are
  // pushed and cannot be re-requested — are republished from what is stored.
  onDidChangeFeatures(fn) {
    return this.emitter.on("did-change-features", fn);
  }
  featureEnabled(adapter, feature, editor) {
    return featureEnabled(adapter, feature, editor);
  }
  featureEnabledForAdapter(adapter, feature) {
    const scopes = adapter?.grammarScopes || [];
    if (!scopes.length) return featureEnabled(adapter, feature);
    return scopes.some((scopeName) =>
      featureEnabled(adapter, feature, {
        getRootScopeDescriptor: () => [scopeName],
      }),
    );
  }
  featureEnabledForPath(adapter, feature, filePath) {
    // Without a config namespace there can be no grammar-scoped override.
    if (!featuresKeyPath(adapter) && !adapter?.isFeatureAvailable)
      return featureEnabled(adapter, feature);
    return this.diagnosticScopes.get(filePath).then((scopeName) => {
      if (!scopeName) return this.featureEnabledForAdapter(adapter, feature);
      return featureEnabled(adapter, feature, {
        getRootScopeDescriptor: () => [scopeName],
      });
    });
  }
  invalidateDiagnosticScopes(paths) {
    const keys = this._diagnosticScopes?.invalidate(paths) ?? (paths ? new Set() : null);
    if (!keys || keys.size) this.emitter.emit("did-change-diagnostic-scopes", { keys });
  }
  onDidChangeDiagnosticScopes(fn) {
    return this.emitter.on("did-change-diagnostic-scopes", fn);
  }
  onDidLog(fn) {
    return this.emitter.on("did-log", fn);
  }
  // fn({session, kind: "codeLens" | "semanticTokens" | "inlayHint"}) — fired
  // when a server asks the client to re-fetch that feature's data.
  onDidRequestRefresh(fn) {
    return this.emitter.on("did-request-refresh", fn);
  }
  requestRefresh(session, kind) {
    this.emitter.emit("did-request-refresh", { session, kind });
  }
  // Feature modules contribute client-capability fragments before any session
  // starts; the merged result is sent with every initialize request.
  addCapabilityFragment(fragment) {
    if (fragment) this.capabilityFragments.push(fragment);
  }
  setCapabilityInitializer(initializer) {
    this.capabilityInitializer = typeof initializer === "function" ? initializer : null;
  }
  buildClientCapabilities(...args) {
    return getRuntime().buildClientCapabilities.apply(this, args);
  }

  prepareSessionServices(...args) {
    return getRuntime().prepareSessionServices.apply(this, args);
  }
  workspaceFolders(...args) {
    return getRuntime().workspaceFolders.apply(this, args);
  }
  setBusySignal(busySignal) {
    this._busySignal = this.tearingDown ? null : busySignal;
    this._activity?.setBusySignal(busySignal);
  }
  beginActivity(session, token, options) {
    return this.activity.begin(session, token, options);
  }
  endActivity(session, token) {
    this.activity.end(session, token);
    session?.progressTitles?.delete(token);
  }

  setFileOperationsExecutor(executor) {
    if (executor || this._fileOperations) this.fileOperations.setExecutor(executor);
  }
  allGrammarScopes() {
    const scopes = new Set();
    for (const adapter of this.adapters.values())
      for (const scope of adapter.grammarScopes) scopes.add(scope);
    return [...scopes];
  }
  registerAdapter(adapter) {
    validateAdapter(adapter);
    if (this.adapters.has(adapter.id))
      throw new Error(`Language-server adapter '${adapter.id}' is already registered`);
    this.adapters.set(adapter.id, adapter);
    this.adapterRestartOperations.delete(adapter);
    const subs = new CompositeDisposable();
    const settingsKeyPaths = adapter.settingsKeyPaths || [];
    const restartKeyPaths = adapter.restartKeyPaths || [];
    if (settingsKeyPaths.length || restartKeyPaths.length)
      subs.add(
        lumine.config.onDidChangeConfiguration((event) => {
          const restart = restartKeyPaths.some((keyPath) => event.affectsConfiguration(keyPath));
          if (restart) {
            this.restartAdapter(adapter, { reportErrors: true });
          } else if (settingsKeyPaths.some((keyPath) => event.affectsConfiguration(keyPath))) {
            this.pushSettingsForAdapter(adapter);
          }
        }),
      );
    const features = featuresKeyPath(adapter);
    if (features)
      subs.add(
        lumine.config.onDidChangeConfiguration((event) => {
          if (event.affectsConfiguration(features)) {
            this.emitter.emit("did-change-features", { adapter });
            if (event.affectsConfiguration(`${features}.diagnostics`))
              for (const session of this.allSessions())
                if (session.adapter === adapter) session.refreshDiagnostics?.();
          }
        }),
      );
    this.adapterSubscriptions.set(adapter, subs);
    this.adapterSelectionChanged();
    this.emitter.emit("did-change-adapters", { adapter, registered: true });
    this.reattachAll();
    return new Disposable(() => this.unregisterAdapter(adapter));
  }
  async unregisterAdapter(adapter) {
    if (this.adapters.get(adapter.id) !== adapter) return;
    this.adapters.delete(adapter.id);
    this.adapterSubscriptions.get(adapter)?.dispose();
    this.adapterSubscriptions.delete(adapter);
    const restartOperation = this.adapterRestartOperations.get(adapter);
    if (restartOperation) {
      restartOperation.cancelled = true;
      restartOperation.generation++;
    }
    // Announced before the sessions are reclaimed: the adapter is already out
    // of `adaptersForEditor`, which is what a subscriber re-reads.
    this.emitter.emit("did-change-adapters", { adapter, registered: false });
    const owned = new Set(
      [...this.knownSessions()].filter((session) => session.adapter === adapter),
    );
    for (const session of owned) this.rememberSelectionRetirement(session);
    for (const controller of this.controllersForAdapter(adapter)) this.cancelController(controller);
    // Reclaimed rather than disconnected: this runs from the disposable an
    // adapter package drops on its own deactivation, and nothing awaits that.
    await Promise.all([...owned].map((session) => this.reclaim(session)));
    if (adapter.exclusiveGroup) {
      this.adapterSelectionChanged();
      this.scheduleReattachAll();
    }
  }
  // Every adapter that serves this editor. More than one is normal and
  // intended: a type checker and a linter/formatter commonly cover the same
  // grammar, and both run.
  adaptersForEditor(...args) {
    return getRuntime().adaptersForEditor.apply(this, args);
  }
  matchingAdaptersForEditor(...args) {
    return getRuntime().matchingAdaptersForEditor.apply(this, args);
  }
  selectAdapters(...args) {
    return getRuntime().selectAdapters.apply(this, args);
  }
  adapterSelected(...args) {
    return getRuntime().adapterSelected.apply(this, args);
  }
  controllerSelected(...args) {
    return getRuntime().controllerSelected.apply(this, args);
  }
  rememberSelectionRetirement(session) {
    if (!session?.adapter?.exclusiveGroup || this.sessionPhysicallyExited(session)) return;
    if ([...this.selectionRetirements].some((record) => record.session === session)) return;
    this.selectionRetirements.add({
      session,
      adapter: session.adapter,
      folders: new Set(session.folders || [session.rootPath]),
    });
  }
  adapterSelectionChanged() {
    for (const controller of [...this.controllers]) {
      if (!controller.adapter.exclusiveGroup) continue;
      if (this.controllerSelected(controller)) {
        for (const session of this.knownSessions()) {
          if (this.sessionControllers.get(session) !== controller) continue;
          for (const document of [...(session.documents?.values() || [])])
            if (document.editor && !this.adapterSelected(controller.adapter, document.editor))
              session.detachEditor(document.editor);
          for (const entry of this.diagnostics.get(session)?.values() || []) {
            const editor = this.editorForDiagnosticUri(session, entry.uri);
            if (editor && !this.adapterSelected(controller.adapter, editor))
              this.withdrawSelectionDiagnostics(session, entry.uri);
          }
        }
        continue;
      }
      for (const session of this.knownSessions())
        if (this.sessionControllers.get(session) === controller)
          this.rememberSelectionRetirement(session);
      this.retireController(controller);
    }
  }
  editorForDiagnosticUri(...args) {
    return getRuntime().editorForDiagnosticUri.apply(this, args);
  }
  withdrawSelectionDiagnostics(...args) {
    return getRuntime().withdrawSelectionDiagnostics.apply(this, args);
  }
  awaitExclusiveSelection(...args) {
    return getRuntime().awaitExclusiveSelection.apply(this, args);
  }
  adapterForEditor(...args) {
    return getRuntime().adapterForEditor.apply(this, args);
  }
  rootForPath(...args) {
    return getRuntime().rootForPath.apply(this, args);
  }
  rootForEditor(...args) {
    return getRuntime().rootForEditor.apply(this, args);
  }
  // A project-root session is identified by the root it serves. A
  // workspace-scoped one serves the whole window, so its identity must not
  // move when `roots[0]` does: it keeps whichever root it started with as its
  // `rootUri` and hears about the rest through `didChangeWorkspaceFolders`.
  keyFor(...args) {
    return getRuntime().keyFor.apply(this, args);
  }
  scopeKey(...args) {
    return getRuntime().scopeKey.apply(this, args);
  }
  controllerMap(...args) {
    return getRuntime().controllerMap.apply(this, args);
  }
  controllerForRoute(...args) {
    return getRuntime().controllerForRoute.apply(this, args);
  }
  projectRevisionFor(...args) {
    return getRuntime().projectRevisionFor.apply(this, args);
  }
  scheduleReattachAll() {
    if (this.tearingDown || this.reattachScheduled) return;
    this.reattachScheduled = true;
    Promise.resolve().then(async () => {
      this.reattachScheduled = false;
      if (this.tearingDown) return;
      try {
        await this.reattachAll();
      } catch (error) {
        console.error("ide: failed to reattach language servers", error);
      }
    });
  }
  createController(...args) {
    return getRuntime().createController.apply(this, args);
  }
  bindController(...args) {
    return getRuntime().bindController.apply(this, args);
  }
  unbindController(...args) {
    return getRuntime().unbindController.apply(this, args);
  }
  ownsControllerRoutes(...args) {
    return getRuntime().ownsControllerRoutes.apply(this, args);
  }

  controllerForSession(...args) {
    return getRuntime().controllerForSession.apply(this, args);
  }
  controllersForAdapter(adapter) {
    return [...this.controllers].filter((controller) => controller.adapter === adapter);
  }
  sessionForRoute(...args) {
    return getRuntime().sessionForRoute.apply(this, args);
  }

  registerSession(...args) {
    return getRuntime().registerSession.apply(this, args);
  }

  withdrawSession(...args) {
    return getRuntime().withdrawSession.apply(this, args);
  }
  knownSessions() {
    return new Set([...this.ownedSessions, ...this.sessions.values()]);
  }
  cancelController(controller) {
    if (!controller || controller.cancelled) return;
    controller.cancel();
    controller.withdraw(controller.session);
    for (const rootPath of [...controller.routeRoots]) this.unbindController(controller, rootPath);
    this.controllers.delete(controller);
  }
  retireController(controller) {
    return controller?.shutdown() ?? Promise.resolve();
  }
  // A session that adopted folders is reachable under one key per folder, so
  // anything walking the sessions themselves has to go through here.
  // Presentation reads only an already-initialized routing graph. In
  // particular, an empty catalogue must not construct workspace documents or
  // initialize the manager runtime just to discover that there is no server.
  peekSessionsForEditor(editor) {
    if (
      !runtime ||
      !this._workspaceDocuments ||
      this.tearingDown ||
      !editor ||
      editor.isDestroyed?.()
    )
      return [];
    return runtime.sessionsForEditor.call(this, editor);
  }

  allSessions() {
    return [...new Set(this.sessions.values())];
  }
  // The project folders a session answers for. A workspace-scoped one answers
  // for all of them and only happens to have started at the first, so its own
  // `rootPath` says nothing about its reach.
  foldersFor(...args) {
    return getRuntime().foldersFor.apply(this, args);
  }
  // What a session covers: the window as a whole, one or more project roots,
  // or the directory of a file opened outside the project.
  scopeFor(...args) {
    return getRuntime().scopeFor.apply(this, args);
  }
  keysFor(...args) {
    return getRuntime().keysFor.apply(this, args);
  }
  forget(...args) {
    return getRuntime().forget.apply(this, args);
  }
  folderOf(...args) {
    return getRuntime().folderOf.apply(this, args);
  }
  // Whether a running server can take on a project folder it was not started
  // with. `supported` alone only means it read the list at initialize; adding
  // one afterwards needs the change notification as well.
  acceptsFolders(...args) {
    return getRuntime().acceptsFolders.apply(this, args);
  }
  // A server that declares multi-root support does not need a second process
  // for a second project folder — it is told about the folder instead. The
  // capabilities say which servers those are, so no adapter has to declare it.
  adoptFolder(...args) {
    return getRuntime().adoptFolder.apply(this, args);
  }
  adapterContext(...args) {
    return getRuntime().adapterContext.apply(this, args);
  }
  controllerHasDemand(...args) {
    return getRuntime().controllerHasDemand.apply(this, args);
  }
  pruneUndemandedControllers(...args) {
    return getRuntime().pruneUndemandedControllers.apply(this, args);
  }
  workspaceFoldersForController(...args) {
    return getRuntime().workspaceFoldersForController.apply(this, args);
  }

  projectRootsForFolders(...args) {
    return getRuntime().projectRootsForFolders.apply(this, args);
  }

  projectWatchIsCurrent(...args) {
    return getRuntime().projectWatchIsCurrent.apply(this, args);
  }

  awaitProjectWatching(...args) {
    return getRuntime().awaitProjectWatching.apply(this, args);
  }

  recoverDegradedObservation(...args) {
    return getRuntime().recoverDegradedObservation.apply(this, args);
  }

  announceProjectFolders(...args) {
    return getRuntime().announceProjectFolders.apply(this, args);
  }

  prepareStartupContext(...args) {
    return getRuntime().prepareStartupContext.apply(this, args);
  }
  setManagedServers(managedServers) {
    if (this.managedServers && this.managedServers !== managedServers)
      this.managedServers.dispose();
    this.managedServers = managedServers;
  }
  // Re-runs attachment for every open editor. Registering an adapter does this
  // so an already-open file finds its new server; installing or removing a
  // managed server does it so the next launch reads the new resolution.
  async reattachAll() {
    for (const editor of lumine.workspace.getTextEditors()) await this.attachEditor(editor);
    // Notebooks attach through their own module: an adapter registered after a
    // notebook opened, or a restarted server, gets its notebookDocument/didOpen
    // from here.
    await this.notebookDocuments?.reattachAll();
  }
  watchEditor(...args) {
    return getRuntime().watchEditor.apply(this, args);
  }
  reattachEditor(...args) {
    return getRuntime().reattachEditor.apply(this, args);
  }
  attachEditor(...args) {
    return getRuntime().attachEditor.apply(this, args);
  }
  // Finds or starts the session for (adapter, rootPath), without attaching any
  // document to it. Throws what resolveServer throws; resolves null when the
  // adapter declined. The caller owns failure reporting.
  ensureSession(...args) {
    return getRuntime().ensureSession.apply(this, args);
  }
  attachAdapter(...args) {
    return getRuntime().attachAdapter.apply(this, args);
  }
  reportStartFailure(...args) {
    return getRuntime().reportStartFailure.apply(this, args);
  }
  // Every session serving this editor, in adapter registration order.
  sessionsForEditor(...args) {
    return getRuntime().sessionsForEditor.apply(this, args);
  }
  editorsForSession(...args) {
    return getRuntime().editorsForSession.apply(this, args);
  }
  editorsForAdapter(...args) {
    return getRuntime().editorsForAdapter.apply(this, args);
  }
  sessionForEditor(...args) {
    return getRuntime().sessionForEditor.apply(this, args);
  }
  // Resolves once each session for this editor finished starting, keeping only
  // the ones that are running.
  activeSessionsForEditor(...args) {
    return getRuntime().activeSessionsForEditor.apply(this, args);
  }
  // The first running session that can serve `method` for this editor. Used by
  // the features where several answers cannot sensibly be combined — a single
  // rename, one formatting result, one outline. Which server that is follows
  // from the feature switches: turning the feature off for one adapter hands
  // the request to the next.
  activeSessionForFeature(...args) {
    return getRuntime().activeSessionForFeature.apply(this, args);
  }
  activeSessionForEditor(...args) {
    return getRuntime().activeSessionForEditor.apply(this, args);
  }
  didChangeSession(...args) {
    return getRuntime().didChangeSession.apply(this, args);
  }
  didExitProcess(...args) {
    return getRuntime().didExitProcess.apply(this, args);
  }
  // Diagnostics are stored per session as well as per document: several
  // servers commonly report on the same file, and one must not erase another.
  // Keyed by `uriKey`, not by the URI as it arrived: this is where a spelling
  // the server chose has to find a document the client opened, and the two are
  // not the same string. What is emitted keeps the server's own spelling.
  publishDiagnostics(...args) {
    return getRuntime().publishDiagnostics.apply(this, args);
  }
  diagnosticsFor(...args) {
    return getRuntime().diagnosticsFor.apply(this, args);
  }
  // Re-emits what is stored for these documents, unchanged. After a structural
  // notebook edit the diagnostics are the same but every consumer's idea of
  // which cell a URI names has shifted, so the projection has to run again.
  republishStoredDiagnostics(...args) {
    return getRuntime().republishStoredDiagnostics.apply(this, args);
  }
  allDiagnostics() {
    return [...this.diagnosticEntries()];
  }
  *diagnosticEntries() {
    for (const byUri of this.diagnostics.values()) yield* byUri.values();
  }
  // What one session has reported, for the UIs that summarize a server rather
  // than a file. Files with nothing left to say are not counted: a cleared
  // document keeps its entry with an empty list.
  diagnosticCountFor(...args) {
    return getRuntime().diagnosticCountFor.apply(this, args);
  }
  clearDiagnosticsForSession(...args) {
    return getRuntime().clearDiagnosticsForSession.apply(this, args);
  }
  // fn({session}) — fired when a server registers or withdraws a capability
  // after it started. What a feature holding rendered state needs it for: a
  // capability that arrives late was absent when the session came up, so
  // whoever looked then concluded the server could not serve it and stopped.
  onDidChangeCapabilities(fn) {
    return this.emitter.on("did-change-capabilities", fn);
  }
  registerCapabilities(...args) {
    return getRuntime().registerCapabilities.apply(this, args);
  }
  unregisterCapabilities(...args) {
    return getRuntime().unregisterCapabilities.apply(this, args);
  }
  // Returns true/false when dynamic registrations govern the method for this
  // editor, undefined when none do (static capability applies).
  dynamicSupport(...args) {
    return getRuntime().dynamicSupport.apply(this, args);
  }
  // The register options of the dynamic registration governing this method for
  // this editor, or undefined when none does. Companion to `dynamicSupport`:
  // that one answers whether, this one carries what it was registered with.
  dynamicOptions(...args) {
    return getRuntime().dynamicOptions.apply(this, args);
  }
  selectorMatches(...args) {
    return getRuntime().selectorMatches.apply(this, args);
  }
  notebookFilterMatches(...args) {
    return getRuntime().notebookFilterMatches.apply(this, args);
  }
  globMatches(...args) {
    return getRuntime().globMatches.apply(this, args);
  }
  // Watched-file events are limited to paths under the project roots â€” that is
  // the scope of lumine.project.onDidChangeFiles.

  recoverFileWatching(...args) {
    return getRuntime().recoverFileWatching.apply(this, args);
  }

  willCreateFiles(payload) {
    return this.fileOperations.willCreateFiles(payload, this.workspaceEdits);
  }
  prepareCreateFiles(payload) {
    return this.fileOperations.prepareCreateFiles(payload, this.workspaceEdits);
  }
  willRenameFiles(payload) {
    return this.fileOperations.willRenameFiles(payload, this.workspaceEdits);
  }
  prepareRenameFiles(payload) {
    return this.fileOperations.prepareRenameFiles(payload, this.workspaceEdits);
  }
  willDeleteFiles(payload) {
    return this.fileOperations.willDeleteFiles(payload, this.workspaceEdits);
  }
  prepareDeleteFiles(payload) {
    return this.fileOperations.prepareDeleteFiles(payload, this.workspaceEdits);
  }
  didCreateFiles(payload, options) {
    return this.fileOperations.didCreateFiles(payload, options);
  }
  didRenameFiles(payload, options) {
    return this.fileOperations.didRenameFiles(payload, options);
  }
  didDeleteFiles(payload, options) {
    return this.fileOperations.didDeleteFiles(payload, options);
  }

  projectPathsChanged(...args) {
    return getRuntime().projectPathsChanged.apply(this, args);
  }
  // Which session serves an editor follows from its root, so adding or
  // removing a project folder can move it. A file that gained a root belongs
  // to that root's session now rather than the one keyed to its own directory,
  // and a file whose root was just removed has had its server stopped from
  // under it by `reconcileProjects` and needs another.
  rerouteEditorsToTheirRoots(...args) {
    return getRuntime().rerouteEditorsToTheirRoots.apply(this, args);
  }
  pushSettingsForAdapter(...args) {
    return getRuntime().pushSettingsForAdapter.apply(this, args);
  }

  reportSettingsFailure(...args) {
    return getRuntime().reportSettingsFailure.apply(this, args);
  }
  handleProgress(...args) {
    return getRuntime().handleProgress.apply(this, args);
  }
  clearProgress(session) {
    this.activity.clear(session);
    session.progressTitles?.clear();
  }
  log(...args) {
    return getRuntime().log.apply(this, args);
  }
  getLog(...args) {
    return getRuntime().getLog.apply(this, args);
  }
  // The headline names the server and takes the message's first line; whatever
  // follows it becomes the description, which a notification does not cap the
  // way it caps a headline. Basedpyright's workspace-enumeration warning is a
  // sentence and a four-item list, and as a headline it scrolls inside its own
  // notification -- for the five seconds a notification nobody clicks lasts,
  // which is why one long enough to have a description is dismissable.
  showMessage(...args) {
    return getRuntime().showMessage.apply(this, args);
  }
  showMessageRequest(...args) {
    return getRuntime().showMessageRequest.apply(this, args);
  }
  showDocument(...args) {
    return getRuntime().showDocument.apply(this, args);
  }

  applyWorkspaceEdits(...args) {
    return getRuntime().applyWorkspaceEdits.apply(this, args);
  }
  applyWorkspaceEdit(...args) {
    return getRuntime().applyWorkspaceEdit.apply(this, args);
  }

  applyWorkspaceEditDetailed(...args) {
    return getRuntime().applyWorkspaceEditDetailed.apply(this, args);
  }

  // fn({session}) — fired once when a server has exited more times than it may
  // be restarted. Nothing is going to happen after this, so it is the last
  // chance to say so: the reason a server keeps dying is in its log, and until
  // this the only sign was a status item quietly reading "failed".
  onDidExhaustRestarts(fn) {
    return this.emitter.on("did-exhaust-restarts", fn);
  }
  // A crashed server is restarted on a timer, and how many times depends on how
  // long it managed to stay up rather than on how many exits this window has
  // seen. A restart replaces the session, so the failure run has to be carried
  // across the replacements or it is never longer than one: that is what left a
  // server dying on every start restarting for ever, reading "failed" in the
  // status bar and "restarted 1×" in its details, and never reaching the limit
  // that would have told the user to go and read its log.
  scheduleRestart(session) {
    this.controllerForSession(session)?.scheduleRetry(session);
  }
  cancelRestart(session) {
    this.controllerForSession(session)?.cancelRetry(session);
  }
  cancelRestarts() {
    for (const controller of this.controllers) controller.cancelRetry();
  }
  reportAdapterRestartFailure(...args) {
    return getRuntime().reportAdapterRestartFailure.apply(this, args);
  }
  // Configuration changes are coalesced per adapter. If another change lands
  // while a resolver or initialize request is pending, the drain observes the
  // newer generation and finishes on that one rather than publishing an
  // intermediate configuration.
  restartAdapter(...args) {
    return getRuntime().restartAdapter.apply(this, args);
  }
  observeAdapterRestart(...args) {
    return getRuntime().observeAdapterRestart.apply(this, args);
  }

  sessionPhysicallyExited(...args) {
    return getRuntime().sessionPhysicallyExited.apply(this, args);
  }
  waitForSessionExit(...args) {
    return getRuntime().waitForSessionExit.apply(this, args);
  }
  adapterQuarantineConflicts(...args) {
    return getRuntime().adapterQuarantineConflicts.apply(this, args);
  }
  waitForAdapterQuarantine(...args) {
    return getRuntime().waitForAdapterQuarantine.apply(this, args);
  }

  splitUnsupportedFolders(...args) {
    return getRuntime().splitUnsupportedFolders.apply(this, args);
  }
  // `retry` marks automatic restarts, which continue the failure run. A
  // restart somebody asked for starts a fresh run. Calls for the same current
  // session share the exact in-flight Promise.
  restart(...args) {
    return getRuntime().restart.apply(this, args);
  }
  // Both take a session out of the map and shut it down; what differs is who
  // hears about a failure. `disconnect` is for a stop somebody asked for and
  // rejects, so the caller can report it. `reclaim` runs where nothing awaits
  // the result — a timer, a disposable, a project that changed under a server —
  // so a failure is logged rather than left as an unhandled rejection.
  disconnect(...args) {
    return getRuntime().disconnect.apply(this, args);
  }
  reclaim(...args) {
    return getRuntime().reclaim.apply(this, args);
  }
  // A session outlives the editors it serves on purpose: reopening a file in a
  // project should not pay for another server start. That only holds while
  // something can still reach it — a session rooted at a project path waits for
  // the next editor there. One rooted at a lone file's directory, opened with
  // no project, can never be reached again once that editor is gone, so it is
  // shut down instead of idling for the life of the window.
  didCloseDocument(...args) {
    return getRuntime().didCloseDocument.apply(this, args);
  }
  stopIfUnreachable(...args) {
    return getRuntime().stopIfUnreachable.apply(this, args);
  }
  cancelIdleChecks() {
    for (const controller of this.controllers) controller.cancelIdle();
  }
  // A folder that left the project takes its key with it. A session that held
  // more than one survives on the folders it has left; one that held only the
  // departed folder has nothing to answer for and stops.
  reconcileProjects(...args) {
    return getRuntime().reconcileProjects.apply(this, args);
  }
  // Teardown must not be abortable: one server that cannot be shut down cleanly
  // — a broken pipe, a process already gone — must not strand the servers beside
  // it or the cleanup that follows them, so the failure is reported rather than
  // thrown. See `reclaim` for which callers want this and which want to hear it.
  stopSession(...args) {
    return getRuntime().stopSession.apply(this, args);
  }
  async stopAllSessions() {
    this.tearingDown = true;
    this.managedServers?.dispose();
    this.resolutionLifetime.abort(
      new DOMException("The IDE resolver is no longer active", "AbortError"),
    );
    this.resolveTeardown();
    this.cancelRestarts();
    const sessions = [...this.knownSessions()];
    for (const controller of [...this.controllers]) this.cancelController(controller);
    await Promise.all(sessions.map((session) => this.stopSession(session)));
    // A stop may reach the logical terminal state yet fail to terminate its
    // child (for example, a failed SIGKILL). Keep ownership and make one final
    // synchronous kill attempt before deactivation completes;
    // `didExitProcess` releases ownership on the real exit event.
    for (const session of sessions) {
      if (this.sessionPhysicallyExited(session) || typeof session.kill !== "function") continue;
      try {
        session.kill();
      } catch (error) {
        console.error(`ide: failed to kill ${session?.adapter?.id ?? "a language server"}`, error);
      }
    }
    this.sessions.clear();
    this.controllers.clear();
    this.dynamicCapabilities.clear();
  }
  // The net under a teardown that never reached `deactivate` — a crashed
  // renderer being reloaded. Every orderly unload stops its sessions properly
  // first, which empties the map and leaves this a no-op. See
  // `ServerSession#kill` for why what is left is killed rather than asked to
  // shut down.
  killAllSessions() {
    this.unloadSubscription?.dispose();
    this.unloadSubscription = null;
    this.tearingDown = true;
    this.managedServers?.dispose();
    this.resolutionLifetime.abort(
      new DOMException("The IDE resolver is no longer active", "AbortError"),
    );
    this.resolveTeardown();
    this._workspaceEdits?.dispose();
    this._fileOperations?.dispose();
    this._activity?.dispose();
    this._busySignal = null;
    this.cancelRestarts();
    const sessions = [...this.knownSessions()];
    for (const controller of [...this.controllers]) this.cancelController(controller);
    for (const session of sessions) {
      try {
        session.kill();
      } catch (error) {
        console.error(`ide: failed to kill ${session?.adapter?.id ?? "a language server"}`, error);
      }
    }
    this.sessions.clear();
    this.controllers.clear();
    this.dynamicCapabilities.clear();
    this._workspaceDocuments?.dispose();
  }
  async deactivate() {
    this.tearingDown = true;
    this.managedServers?.dispose();
    this.resolutionLifetime.abort(
      new DOMException("The IDE resolver is no longer active", "AbortError"),
    );
    this.resolveTeardown();
    this._workspaceEdits?.dispose();
    this._fileOperations?.dispose();
    this._diagnosticScopes?.dispose();
    this._activity?.dispose();
    this._busySignal = null;
    this.cancelIdleChecks();
    this.subscriptions.dispose();
    for (const subs of this.editorSubscriptions.values()) subs.dispose();
    this.editorSubscriptions.clear();
    for (const subs of this.adapterSubscriptions.values()) subs.dispose();
    this.adapterSubscriptions.clear();
    try {
      await this.stopAllSessions();
    } finally {
      this.unloadSubscription?.dispose();
      this.unloadSubscription = null;
    }
    this._workspaceDocuments?.dispose();
    this.emitter.dispose();
  }
};
