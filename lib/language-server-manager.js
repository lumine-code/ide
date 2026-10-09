const path = require("path");
const { selectAdapters } = require("./adapter-selection");
const { validateAdapter } = require("./adapter-contract");

const picomatch = require("picomatch");
const { Emitter, CompositeDisposable, Disposable } = require("lumine");
const ServerSession = require("./server-session");
const SessionController = require("./session-controller");
const ServerActivity = require("./server-activity");
const DiagnosticScopeCache = require("./diagnostic-scope-cache");
const WorkspaceDocuments = require("./workspace-documents");
const WorkspaceFileOperations = require("./workspace-file-operations");
const WorkspaceEdits = require("./workspace-edits");
const { relativePath } = require("./workspace-paths");
const { createServerResolver } = require("./server-resolver");
const C = require("./converters");
const { baseCapabilities, mergeCapabilities } = require("./capabilities");
const { languageIdForEditor } = require("./language-ids");
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
        new ServerSession(
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
    this.activity = new ServerActivity((session, error) =>
      this.log(session, error.stack || error.message || error),
    );
    // Package-owned adapters may need a small bootstrap (custom server
    // configuration is one example) before an editor is matched against them.
    // Keeping that bootstrap behind a callback lets the package defer its
    // server-management modules until an editor actually needs them.
    this.adapterInitializer = null;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    // Teardown wakes every physical-exit waiter, even when a child cannot exit.
    this.teardownPromise = new Promise((resolve) => (this.resolveTeardown = resolve));
    this.tearingDown = false;
    this.resolutionLifetime = new AbortController();
    this.serverResolver = createServerResolver({
      signal: this.resolutionLifetime.signal,
      assertActive: () => {
        if (this.tearingDown)
          throw new DOMException("The IDE resolver is no longer active", "AbortError");
      },
    });
    this.workspaceProjectRevision = 0;
    this.projectRootRevisions = new Map();
    this.reattachScheduled = false;
    // Editors whose document identity is not their file path — notebook cells.
    // The WeakMap routes an editor to its binding; the Map routes a URI a
    // server sent back to the same binding. Registered by the notebook module.
    this.notebookDocuments = null;
    this.diagnosticScopes = new DiagnosticScopeCache((filePath, options) =>
      lumine.grammars.selectGrammarAsync(filePath, options),
    );
    this.workspaceDocuments = new WorkspaceDocuments({
      reattachEditor: (editor) => this.reattachEditor(editor),
    });
    this.fileOperations = new WorkspaceFileOperations({
      documents: this.workspaceDocuments,
      host: {
        sessions: () => (this.tearingDown ? [] : this.allSessions()),
        dynamicCapabilities: () => this.dynamicCapabilities,
        foldersFor: (session) => this.foldersFor(session),
        globMatches: (...args) => this.globMatches(...args),
        invalidateScopes: (paths) => this.invalidateDiagnosticScopes(paths),
        log: (...args) => this.log(...args),
      },
    });
    this.workspaceEdits = new WorkspaceEdits({
      documents: this.workspaceDocuments,
      fileOperations: this.fileOperations,
      log: (...args) => this.log(...args),
    });
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
  uriForEditor(editor) {
    return this.workspaceDocuments.uriForEditor(editor);
  }

  // What a URI a server answered with refers to. Cell URIs resolve through the
  // bindings; file URIs to their path; anything else to null.
  resolveUri(uri) {
    return this.workspaceDocuments.resolveUri(uri);
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
      // Package deactivation is skipped on a reload, and a language server is a
      // child process that outlives the window it was started from.
      lumine.window.onWillDestroy(() => this.killAllSessions()),
    );
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
    const keys = this.diagnosticScopes.invalidate(paths);
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
  buildClientCapabilities() {
    this.capabilityInitializer?.();
    return mergeCapabilities(
      baseCapabilities({ resourceOperations: !!this.fileOperations.executor }),
      ...this.capabilityFragments,
    );
  }

  async prepareSessionServices() {
    const requests = [];
    if (!this.fileOperations.executor) {
      requests.push(lumine.packages.requestService("file-operations.executor", "^1.0.0"));
    }
    requests.push(lumine.packages.requestService("linter.registry", "^1.0.0"));
    await Promise.all(requests);
  }
  workspaceFolders(session) {
    let projectPaths = lumine.project.getPaths();
    if (session?.adapter?.sessionScope === "workspace" && session.announcedProjectRoots) {
      projectPaths = [...session.announcedProjectRoots];
    } else if (session?.adapter?.sessionScope !== "workspace") {
      const controller = this.sessionControllers.get(session);
      projectPaths = controller ? [...controller.folders] : [...(session?.folders || projectPaths)];
    }
    return projectPaths.map((projectPath) => this.folderOf(projectPath));
  }
  setBusySignal(busySignal) {
    this.activity.setBusySignal(busySignal);
  }
  beginActivity(session, token, options) {
    return this.activity.begin(session, token, options);
  }
  endActivity(session, token) {
    this.activity.end(session, token);
    session?.progressTitles?.delete(token);
  }

  setFileOperationsExecutor(executor) {
    this.fileOperations.setExecutor(executor);
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
  adaptersForEditor(editor) {
    return this.selectAdapters(this.matchingAdaptersForEditor(editor));
  }
  matchingAdaptersForEditor(editor) {
    const scope = editor.getGrammar()?.scopeName;
    return [...this.adapters.values()].filter(
      (adapter) =>
        adapter.grammarScopes.includes(scope) &&
        (!adapter.documentSelector ||
          this.selectorMatches(adapter.documentSelector, { adapter }, editor)),
    );
  }
  selectAdapters(adapters) {
    return selectAdapters(adapters, lumine.config.get("ide.preferredServers"));
  }
  adapterSelected(adapter, editor, rootPath) {
    if (!adapter.exclusiveGroup) return true;
    if (!editor && rootPath) {
      const editors = lumine.workspace
        .getTextEditors()
        .filter(
          (candidate) =>
            this.matchingAdaptersForEditor(candidate).includes(adapter) &&
            (adapter.sessionScope === "workspace" ||
              this.rootForEditor(candidate, adapter) === rootPath),
        );
      if (editors.length)
        return editors.some((candidate) => this.adapterSelected(adapter, candidate));
    }
    return (
      editor ? this.adaptersForEditor(editor) : this.selectAdapters([...this.adapters.values()])
    ).includes(adapter);
  }
  controllerSelected(controller) {
    const { adapter } = controller;
    if (this.adapters.get(adapter.id) !== adapter) return false;
    if (!adapter.exclusiveGroup) return true;
    const editors = lumine.workspace
      .getTextEditors()
      .filter(
        (editor) =>
          this.matchingAdaptersForEditor(editor).includes(adapter) &&
          (adapter.sessionScope === "workspace" ||
            controller.folders.has(this.rootForEditor(editor, adapter))),
      );
    return editors.length
      ? editors.some((editor) => this.adapterSelected(adapter, editor))
      : this.adapterSelected(adapter);
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
  editorForDiagnosticUri(session, uri) {
    const key = C.uriKey(uri);
    return (
      session.documents?.get(key)?.editor ||
      this.workspaceDocuments.resolveUri(uri)?.editor ||
      lumine.workspace
        .getTextEditors()
        .find((editor) => C.uriKey(this.workspaceDocuments.uriForEditor(editor)) === key)
    );
  }
  withdrawSelectionDiagnostics(session, uri) {
    const byUri = this.diagnostics.get(session),
      key = C.uriKey(uri);
    if (!byUri?.has(key)) return;
    byUri.delete(key);
    this.emitter.emit("did-publish-diagnostics", { session, uri, diagnostics: [] });
  }
  async awaitExclusiveSelection(adapter, rootPath, editor) {
    if (!adapter.exclusiveGroup) return true;
    this.adapterSelectionChanged();
    while (
      !this.tearingDown &&
      this.adapters.get(adapter.id) === adapter &&
      this.adapterSelected(adapter, editor, rootPath)
    ) {
      const conflicts = [];
      for (const record of this.selectionRetirements) {
        if (this.sessionPhysicallyExited(record.session)) {
          this.selectionRetirements.delete(record);
          continue;
        }
        if (
          record.adapter.exclusiveGroup === adapter.exclusiveGroup &&
          (adapter.sessionScope === "workspace" ||
            record.adapter.sessionScope === "workspace" ||
            record.folders.has(rootPath))
        )
          conflicts.push(record.session);
      }
      if (!conflicts.length) return true;
      await Promise.all(conflicts.map((session) => this.waitForSessionExit(session)));
    }
    return false;
  }
  adapterForEditor(editor) {
    return this.adaptersForEditor(editor)[0];
  }
  rootForPath(filePath, adapter) {
    const roots = lumine.project.getPaths();
    if (!filePath) return roots[0] || process.cwd();
    if (adapter.sessionScope === "workspace") return roots[0] || path.dirname(filePath);
    return (
      roots
        .filter((root) => filePath === root || filePath.startsWith(root + path.sep))
        .sort((a, b) => b.length - a.length)[0] || path.dirname(filePath)
    );
  }
  rootForEditor(editor, adapter) {
    return this.rootForPath(
      this.workspaceDocuments.bindingFor(editor)?.record.filePath ?? editor.getPath(),
      adapter,
    );
  }
  // A project-root session is identified by the root it serves. A
  // workspace-scoped one serves the whole window, so its identity must not
  // move when `roots[0]` does: it keeps whichever root it started with as its
  // `rootUri` and hears about the rest through `didChangeWorkspaceFolders`.
  keyFor(adapter, rootPath) {
    return adapter.sessionScope === "workspace" ? `${adapter.id}:` : `${adapter.id}:${rootPath}`;
  }
  scopeKey(adapter, rootPath) {
    return adapter.sessionScope === "workspace" ? "" : rootPath;
  }
  controllerMap(adapter, create = false) {
    let routes = this.controllerRoutes.get(adapter);
    if (!routes && create) {
      routes = new Map();
      this.controllerRoutes.set(adapter, routes);
    }
    return routes;
  }
  controllerForRoute(adapter, rootPath) {
    return this.controllerMap(adapter)?.get(this.scopeKey(adapter, rootPath)) || null;
  }
  projectRevisionFor(adapter, rootPath) {
    return adapter.sessionScope === "workspace"
      ? this.workspaceProjectRevision
      : this.projectRootRevisions.get(rootPath) || 0;
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
  createController(adapter, rootPath) {
    const controller = new SessionController(adapter, rootPath, this.controllerHost);
    this.controllers.add(controller);
    this.bindController(controller, rootPath);
    return controller;
  }
  bindController(controller, rootPath) {
    const { adapter } = controller;
    const routes = this.controllerMap(adapter, true);
    const scope = this.scopeKey(adapter, rootPath);
    const displaced = routes.get(scope);
    if (displaced && displaced !== controller) this.retireController(displaced);
    routes.set(scope, controller);
    controller.routeRoots.add(rootPath);
    controller.folders.add(rootPath);
    controller.rememberFolder(rootPath);
    if (controller.session) this.sessions.set(this.keyFor(adapter, rootPath), controller.session);
  }
  unbindController(controller, rootPath) {
    const { adapter, session } = controller;
    const routes = this.controllerMap(adapter);
    const scope = this.scopeKey(adapter, rootPath);
    if (routes?.get(scope) === controller) routes.delete(scope);
    controller.routeRoots.delete(rootPath);
    controller.folders.delete(rootPath);
    const key = this.keyFor(adapter, rootPath);
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }
  ownsControllerRoutes(controller) {
    if (!controller.routeRoots.size) return false;
    const routes = this.controllerMap(controller.adapter);
    return [...controller.routeRoots].every(
      (rootPath) => routes?.get(this.scopeKey(controller.adapter, rootPath)) === controller,
    );
  }

  controllerForSession(session) {
    return this.sessionControllers.get(session) || null;
  }
  controllersForAdapter(adapter) {
    return [...this.controllers].filter((controller) => controller.adapter === adapter);
  }
  sessionForRoute(adapter, rootPath) {
    return this.controllerForRoute(adapter, rootPath)?.session || null;
  }

  registerSession(controller, session) {
    if (session.adapter.sessionScope === "workspace") {
      session.announcedProjectRoots = new Set(lumine.project.getPaths());
    }
    this.sessionControllers.set(session, controller);
    this.ownedSessions.add(session);
    for (const rootPath of controller.routeRoots)
      this.sessions.set(this.keyFor(controller.adapter, rootPath), session);
    this.didChangeSession(session);
  }

  withdrawSession(session) {
    for (const key of this.keysFor(session)) this.sessions.delete(key);
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
  allSessions() {
    return [...new Set(this.sessions.values())];
  }
  // The project folders a session answers for. A workspace-scoped one answers
  // for all of them and only happens to have started at the first, so its own
  // `rootPath` says nothing about its reach.
  foldersFor(session) {
    if (session.adapter.sessionScope !== "workspace") return [...session.folders];
    const roots = lumine.project.getPaths();
    return roots.length ? roots : [session.rootPath];
  }
  // What a session covers: the window as a whole, one or more project roots,
  // or the directory of a file opened outside the project.
  scopeFor(session) {
    if (session.adapter.sessionScope === "workspace") return "workspace";
    const roots = lumine.project.getPaths();
    return [...session.folders].some((folder) => roots.includes(folder)) ? "root" : "file";
  }
  keysFor(session) {
    return [...this.sessions].filter(([, value]) => value === session).map(([key]) => key);
  }
  forget(session) {
    this.cancelRestart(session);
    const controller = this.controllerForSession(session);
    if (controller) {
      this.cancelController(controller);
      return;
    }
    for (const key of this.keysFor(session)) this.sessions.delete(key);
  }
  folderOf(rootPath) {
    return { uri: C.pathToUri(rootPath), name: path.basename(rootPath) };
  }
  // Whether a running server can take on a project folder it was not started
  // with. `supported` alone only means it read the list at initialize; adding
  // one afterwards needs the change notification as well.
  acceptsFolders(session) {
    const folders = session.capabilities.workspace?.workspaceFolders;
    return !!folders?.supported && !!folders.changeNotifications;
  }
  // A server that declares multi-root support does not need a second process
  // for a second project folder — it is told about the folder instead. The
  // capabilities say which servers those are, so no adapter has to declare it.
  async adoptFolder(adapter, rootPath) {
    if (adapter.sessionScope === "workspace") return null;
    for (const session of this.allSessions()) {
      if (session.adapter !== adapter || session.folders.has(rootPath)) continue;
      try {
        await session.ready;
      } catch {
        continue;
      }
      // Another attach for the same root won the race while we were waiting.
      const routed = this.sessionForRoute(adapter, rootPath);
      if (routed) return routed;
      if (session.state !== "running" || !this.acceptsFolders(session)) continue;
      const controller = this.controllerForSession(session);
      if (!controller) continue;
      while (
        controller.isActive() &&
        controller.session === session &&
        session.state === "running"
      ) {
        const existing = this.sessionForRoute(adapter, rootPath);
        if (existing) return existing;
        const generation = controller.requestedGeneration;
        const observed = await this.awaitProjectWatching(
          controller,
          [rootPath],
          generation,
          controller.revision,
        );
        if (observed.stale) {
          if (
            controller.isActive() &&
            controller.session === session &&
            controller.requestedGeneration === generation &&
            observed.observations.every((record) => this.projectWatchIsCurrent(record))
          )
            continue;
          break;
        }
        if (controller.session !== session || session.state !== "running") break;
        const routed = this.sessionForRoute(adapter, rootPath);
        if (routed) return routed;
        this.bindController(controller, rootPath);
        controller.structureChanged();
        session.notify("workspace/didChangeWorkspaceFolders", {
          event: { added: [this.folderOf(rootPath)], removed: [] },
        });
        this.recoverDegradedObservation(controller, session, observed.observations);
        this.didChangeSession(session);
        return session;
      }
    }
    return null;
  }
  adapterContext(adapter, rootPath, projectPaths = lumine.project.getPaths()) {
    let read = false,
      failed = false,
      installed,
      failure;
    const getManagedServer = () => {
      this.resolutionLifetime.signal.throwIfAborted();
      if (this.tearingDown || this.adapters.get(adapter.id) !== adapter)
        throw new DOMException("The managed server context is no longer active", "AbortError");
      if (!read) {
        read = true;
        try {
          installed = this.managedServers?.installFor(adapter) ?? null;
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
      if (failed) throw failure;
      return installed;
    };
    return {
      resolver: this.serverResolver,
      rootPath,
      projectPaths,
      configDirPath: lumine.getConfigDirPath(),
      managedStoragePath: path.join(lumine.getConfigDirPath(), "language-servers", adapter.id),
      // Read only when selection needs this installation. The value or failure
      // is one snapshot, so paths and versions cannot come from separate reads.
      getManagedServer,
    };
  }
  controllerHasDemand(controller) {
    if (controller.cancelled) return false;
    // A controller quarantining a child that may still be alive is retained
    // regardless of editor demand. Releasing it would let a reopen create a
    // second controller/process before the old child exits.
    if (controller.blockedByLiveStop) return true;
    if (controller.explicitDemand) return true;
    if (controller.session?.documents?.size) return true;
    const roots = lumine.project.getPaths();
    if (controller.hasStarted) {
      if (controller.adapter.sessionScope === "workspace" && roots.length) return true;
      if ([...controller.folders].some((folder) => roots.includes(folder))) return true;
    }
    if (this.notebookDocuments?.hasDemand(controller)) return true;
    return lumine.workspace.getTextEditors().some((editor) => {
      return (
        !editor.isDestroyed?.() &&
        this.adaptersForEditor(editor).includes(controller.adapter) &&
        this.controllerForRoute(
          controller.adapter,
          this.rootForEditor(editor, controller.adapter),
        ) === controller
      );
    });
  }
  pruneUndemandedControllers() {
    for (const controller of [...this.controllers]) {
      if (
        !controller.session &&
        !controller.blockedByLiveStop &&
        !this.controllerHasDemand(controller)
      )
        this.retireController(controller);
    }
  }
  workspaceFoldersForController(controller, projectPaths = lumine.project.getPaths()) {
    const folders =
      controller.adapter.sessionScope === "workspace" ? projectPaths : [...controller.folders];
    return folders.map((projectPath) => this.folderOf(projectPath));
  }

  projectRootsForFolders(folders, projectPaths = lumine.project.getPaths()) {
    return projectPaths.filter((root) =>
      folders.some(
        (folder) => relativePath(root, folder) !== null || relativePath(folder, root) !== null,
      ),
    );
  }

  projectWatchIsCurrent(record) {
    if (!lumine.project.getPaths().includes(record.root)) return false;
    if ((this.projectRootRevisions.get(record.root) || 0) !== record.rootRevision) return false;
    return !record.directory || lumine.project.getDirectories().includes(record.directory);
  }

  async awaitProjectWatching(controller, folders, generation, revision) {
    const observations = this.projectRootsForFolders(folders).map((root) => {
      const record = {
        root,
        rootRevision: this.projectRootRevisions.get(root) || 0,
        directory: lumine.project
          .getDirectories()
          .find((directory) => directory.getPath() === root),
        state: "pending",
      };
      record.ready = Promise.resolve()
        .then(() => lumine.project.getWatcherPromise(root))
        .then(
          (handle) => {
            record.state = "ready";
            return handle;
          },
          () => {
            record.state = "failed";
            return null;
          },
        );
      return record;
    });
    let timer;
    try {
      const observed = await controller.waitForChange(
        generation,
        revision,
        Promise.race([
          Promise.all(observations.map((record) => record.ready)),
          new Promise((resolve) => {
            timer = setTimeout(resolve, PROJECT_WATCH_GRACE_MS);
          }),
        ]),
      );
      if (observed.stale || !observations.every((record) => this.projectWatchIsCurrent(record)))
        return { stale: true, observations };
      return { stale: false, observations };
    } finally {
      clearTimeout(timer);
    }
  }

  recoverDegradedObservation(controller, session, observations = []) {
    const pending = observations.filter((record) => record.state === "pending");
    if (!pending.length) return;
    const generation = controller.requestedGeneration;
    if (
      controller.degradedObservation?.generation !== generation ||
      controller.degradedObservation.session !== session
    ) {
      controller.degradedObservation = { generation, session, recovered: false };
    }
    const recovery = controller.degradedObservation;
    const current = (record) =>
      !recovery.recovered &&
      controller.isActive() &&
      controller.requestedGeneration === generation &&
      controller.session === session &&
      this.projectWatchIsCurrent(record) &&
      this.projectRootsForFolders(this.foldersFor(session)).includes(record.root);
    for (const record of pending) {
      record.ready
        .then(async (handle) => {
          if (!handle || !current(record)) return;
          const wait = async (promise) => {
            let result;
            do {
              result = await controller.waitForChange(generation, controller.revision, promise);
            } while (result.stale && current(record));
            return result.stale ? null : result.value;
          };
          const activeHandle = await wait(
            Promise.resolve()
              .then(() => lumine.project.getWatcherPromise(record.root))
              .catch(() => null),
          );
          if (activeHandle !== handle || !current(record)) return;
          const started = await wait(
            Promise.resolve(session.ready).then(
              () => true,
              () => false,
            ),
          );
          if (!started || !current(record) || session.state !== "running") return;
          recovery.recovered = true;
          await this.restart(session);
        })
        .catch((error) => {
          if (controller.isActive()) this.reportAdapterRestartFailure(session.adapter, error);
        });
    }
  }

  async announceProjectFolders(controller, session) {
    if (!controller) return;
    const generation = controller.requestedGeneration;
    const revision = controller.revision;
    let observations = [];
    if (lumine.project.getPaths().some((root) => !session.announcedProjectRoots.has(root))) {
      const observed = await this.awaitProjectWatching(
        controller,
        lumine.project.getPaths(),
        generation,
        revision,
      );
      if (observed.stale) return;
      observations = observed.observations;
    }
    if (
      !controller.isActive() ||
      controller.session !== session ||
      controller.requestedGeneration !== generation ||
      controller.revision !== revision ||
      session.state !== "running"
    )
      return;
    const roots = lumine.project.getPaths();
    const added = roots
      .filter((root) => !session.announcedProjectRoots.has(root))
      .map((root) => this.folderOf(root));
    const removed = [...session.announcedProjectRoots]
      .filter((root) => !roots.includes(root))
      .map((root) => this.folderOf(root));
    if (!added.length && !removed.length) return;
    session.notify("workspace/didChangeWorkspaceFolders", { event: { added, removed } });
    session.announcedProjectRoots = new Set(roots);
    this.recoverDegradedObservation(controller, session, observations);
  }

  async prepareStartupContext(controller, generation, revision) {
    const { adapter } = controller;
    const rootPath = controller.rootPath;
    const rootUri = C.pathToUri(rootPath);
    const projectPaths = [...lumine.project.getPaths()];
    const workspaceFolders = this.workspaceFoldersForController(controller, projectPaths);
    const observation = await this.awaitProjectWatching(
      controller,
      adapter.sessionScope === "workspace" ? projectPaths : [...controller.folders],
      generation,
      revision,
    );
    if (observation.stale) return { stale: true };
    return {
      stale: false,
      rootPath,
      rootUri,
      workspaceFolders,
      observations: observation.observations,
      resolutionContext: this.adapterContext(adapter, rootPath, projectPaths),
    };
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
  watchEditor(editor) {
    if (this.editorSubscriptions.has(editor)) return;
    const subs = new CompositeDisposable(
      editor.onDidChangeGrammar(() => this.reattachEditor(editor)),
      editor.onDidChangePath(() => {
        if (this.workspaceDocuments.pathChanged(editor)) return;
        this.reattachEditor(editor);
      }),
      editor.onDidDestroy(() => {
        this.workspaceDocuments.forgetUntitled(editor);
        subs.dispose();
        this.editorSubscriptions.delete(editor);
        Promise.resolve().then(() => this.pruneUndemandedControllers());
      }),
    );
    this.editorSubscriptions.set(editor, subs);
  }
  reattachEditor(editor) {
    for (const session of this.allSessions()) session.detachEditor(editor);
    return this.attachEditor(editor);
  }
  async attachEditor(editor) {
    if (editor.isDestroyed?.() || this.workspaceDocuments.isDetached(editor)) return;
    await this.adapterInitializer?.();
    this.adapterSelectionChanged();
    await Promise.all(
      this.adaptersForEditor(editor).map((adapter) => this.attachAdapter(adapter, editor)),
    );
  }
  // Finds or starts the session for (adapter, rootPath), without attaching any
  // document to it. Throws what resolveServer throws; resolves null when the
  // adapter declined. The caller owns failure reporting.
  async ensureSession(adapter, rootPath, { filePath, editor } = {}) {
    const rootChanged = () =>
      editor
        ? editor.isDestroyed?.() ||
          this.rootForEditor(editor, adapter) !== rootPath ||
          !this.adapterSelected(adapter, editor)
        : filePath && this.rootForPath(filePath, adapter) !== rootPath;
    const projectRevision = this.projectRevisionFor(adapter, rootPath);
    if (adapter.exclusiveGroup && !(await this.awaitExclusiveSelection(adapter, rootPath, editor)))
      return null;
    if (
      this.adapterQuarantineConflicts(adapter, rootPath).length &&
      !(await this.waitForAdapterQuarantine(adapter, rootPath))
    )
      return null;
    if (this.adapters.get(adapter.id) !== adapter) return null;
    if (
      this.tearingDown ||
      projectRevision !== this.projectRevisionFor(adapter, rootPath) ||
      rootChanged()
    )
      return null;
    let session = this.sessionForRoute(adapter, rootPath);
    if (session) return session;
    session = await this.adoptFolder(adapter, rootPath);
    if (
      this.tearingDown ||
      projectRevision !== this.projectRevisionFor(adapter, rootPath) ||
      rootChanged() ||
      this.adapters.get(adapter.id) !== adapter
    ) {
      // `adoptFolder` may have added the route just before the project or
      // adapter changed. It did not exist when this call began, so dropping it
      // is safe; the reroute pass will add the current scope again if wanted.
      const adoptedController = session && this.controllerForSession(session);
      if (adoptedController?.routeRoots.has(rootPath))
        this.unbindController(adoptedController, rootPath);
      this.scheduleReattachAll();
      return null;
    }
    if (session) return session;

    let controller = this.controllerForRoute(adapter, rootPath);
    if (!controller) controller = this.createController(adapter, rootPath);
    if (!filePath && !editor) controller.explicitDemand = true;
    return controller.ensure({
      isCurrent: () => !rootChanged() && this.adapters.get(adapter.id) === adapter,
    });
  }
  async attachAdapter(adapter, editor) {
    const rootPath = this.rootForEditor(editor, adapter);
    let session;
    try {
      session = await this.ensureSession(adapter, rootPath, { editor });
    } catch {
      return;
    }
    if (!session) return;
    try {
      await session.ready;
      if (this.sessionForRoute(adapter, rootPath) !== session) return;
      if (
        editor.isDestroyed?.() ||
        this.rootForEditor(editor, adapter) !== rootPath ||
        !this.adaptersForEditor(editor).includes(adapter)
      )
        return;
      await session.openEditor(editor);
    } catch (error) {
      if (this.sessionForRoute(adapter, rootPath) === session) {
        // Every key it holds, not only this one: a session that adopted folders
        // and then failed to start would otherwise stay reachable under the
        // rest, reading "failed" in the status bar with nothing left to serve
        // it. Forgetting it also cancels the retry its exit handler scheduled —
        // a server that cannot start at all is reported once rather than
        // retried behind a notification that already said so.
        this.forget(session);
        // The start already failed; the reason the user needs is reported below,
        // and cleaning up after it must not add a rejection nobody is awaiting.
        this.stopSession(session);
        this.reportStartFailure(adapter, rootPath, error);
      }
    }
  }
  reportStartFailure(adapter, rootPath, error) {
    this.log({ adapter, rootPath }, error.stack || error.message);
    lumine.notifications.addError(`Unable to start ${adapter.displayName}`, {
      detail: error.message,
      dismissable: true,
    });
  }
  // Every session serving this editor, in adapter registration order.
  sessionsForEditor(editor) {
    const binding = this.workspaceDocuments.bindingFor(editor);
    if (editor.isDestroyed?.() || this.workspaceDocuments.isDetached(editor)) return [];
    const sessions = this.adaptersForEditor(editor)
      .map((adapter) => this.sessionForRoute(adapter, this.rootForEditor(editor, adapter)))
      .filter(Boolean);
    // For a cell, only the sessions actually holding the cell document — a
    // same-root server without notebook sync never saw the notebook and must
    // never be asked about a cell URI.
    if (binding) {
      const key = C.uriKey(binding.uri);
      return sessions.filter((session) => session.documents.has(key));
    }
    return sessions;
  }
  editorsForSession(session) {
    const editors = new Set();
    for (const document of session?.documents?.values?.() || []) {
      if (document.editor) editors.add(document.editor);
    }
    for (const editor of lumine.workspace.getTextEditors()) {
      if (this.sessionsForEditor(editor).includes(session)) editors.add(editor);
    }
    return [...editors];
  }
  editorsForAdapter(adapter) {
    return lumine.workspace
      .getTextEditors()
      .filter((editor) => this.adaptersForEditor(editor).includes(adapter));
  }
  sessionForEditor(editor) {
    return this.sessionsForEditor(editor)[0] || null;
  }
  // Resolves once each session for this editor finished starting, keeping only
  // the ones that are running.
  async activeSessionsForEditor(editor, { adapterId } = {}) {
    const binding = this.workspaceDocuments.bindingFor(editor);
    const uri = this.workspaceDocuments.uriForEditor(editor);
    const key = uri ? C.uriKey(uri) : null;
    const sessions = await Promise.all(
      this.sessionsForEditor(editor)
        .filter((session) => !adapterId || session.adapter.id === adapterId)
        .map(async (session) => {
          try {
            await session.ready;
          } catch {
            return null;
          }
          if (session.state !== "running") return null;

          // Restored editors and their language servers start independently. A
          // running session is not yet usable for text-document requests until
          // this editor's didOpen is on the wire. Joining openEditor here makes
          // every feature observe one readiness boundary instead of letting the
          // first request race the manager's background attachment.
          if (!binding) await session.openEditor(editor);

          // The editor can change path/grammar, or the session can be replaced,
          // while either readiness wait is pending. Only return a session still
          // routed to and holding the requested document.
          if (session.state !== "running" || !this.sessionsForEditor(editor).includes(session)) {
            return null;
          }
          return key && session.documents.has(key) ? session : null;
        }),
    );
    return sessions.filter(Boolean);
  }
  // The first running session that can serve `method` for this editor. Used by
  // the features where several answers cannot sensibly be combined — a single
  // rename, one formatting result, one outline. Which server that is follows
  // from the feature switches: turning the feature off for one adapter hands
  // the request to the next.
  async activeSessionForFeature(editor, method, feature) {
    const sessions = await this.activeSessionsForEditor(editor);
    return sessions.find((session) => session.supports(method, editor, feature)) || null;
  }
  async activeSessionForEditor(editor) {
    return (await this.activeSessionsForEditor(editor))[0] || null;
  }
  didChangeSession(session, error) {
    if (["stopping", "failed", "stopped"].includes(session.state)) {
      this.dynamicCapabilities.delete(session);
      this.clearDiagnosticsForSession(session);
    }
    this.emitter.emit("did-change-session", { session, state: session.state, error });
    this.sessionControllers.get(session)?.stateChanged(session);
    if (session.state === "stopped" && this.sessionPhysicallyExited(session))
      this.didExitProcess(session);
  }
  didExitProcess(session) {
    for (const record of this.selectionRetirements)
      if (record.session === session) this.selectionRetirements.delete(record);
    this.ownedSessions.delete(session);
    this.sessionExitWaiters.get(session)?.resolve();
    this.sessionExitWaiters.delete(session);
    this.sessionControllers.get(session)?.exited(session);
  }
  // Diagnostics are stored per session as well as per document: several
  // servers commonly report on the same file, and one must not erase another.
  // Keyed by `uriKey`, not by the URI as it arrived: this is where a spelling
  // the server chose has to find a document the client opened, and the two are
  // not the same string. What is emitted keeps the server's own spelling.
  publishDiagnostics(session, params, collected = false) {
    if (this.tearingDown || ["stopping", "failed", "stopped"].includes(session.state)) return false;
    const document = session.documents?.get(C.uriKey(params.uri));
    if (session.adapter?.exclusiveGroup) {
      const editor = this.editorForDiagnosticUri(session, params.uri);
      if (editor && !this.adapterSelected(session.adapter, editor)) {
        this.withdrawSelectionDiagnostics(session, params.uri);
        return false;
      }
    }
    if (document?.temporary || session.isTemporaryDocumentUri?.(params.uri)) return false;
    // versionSupport is advertised, so a versioned result belongs to exactly
    // the document snapshot that produced it. An older response must not
    // repaint markers after a newer keystroke; an impossible future version is
    // equally unsafe to apply. Unversioned diagnostics remain valid because
    // servers are not required to send the optional field. A notebook cell has
    // two defensible counters — its own text document version and the notebook
    // document's — and servers disagree on which one "the document" means
    // (ruff stamps the notebook's, basedpyright the cell's), so a cell accepts
    // either; insisting on one dropped every ruff cell publish as stale.
    if (params.version != null && document) {
      const versions = document.notebook
        ? [document.version, document.notebook.versionFor?.(session) ?? document.notebook.version]
        : [document.version];
      if (!versions.includes(params.version)) return false;
    }
    // Pushes own their own source alongside independent pull providers. Keep
    // their raw reports separate, then transform the combined list exactly once.
    if (!collected && session.publishPushedDiagnostics)
      return session.publishPushedDiagnostics(params);
    // The adapter's last word on what its server reported. This is the only
    // funnel — push notifications, pulled reports and the cleared list a closed
    // document publishes all arrive here — so what it returns is what is
    // stored, emitted, counted, and offered as a code action's context, with no
    // second copy of the raw list to drift from it.
    const entry = { session, ...params };
    if (Array.isArray(params.diagnostics))
      entry.diagnostics =
        session.transformDiagnostics?.(params.diagnostics, params.uri, document) ??
        params.diagnostics;
    const byUri = this.diagnostics.get(session) || new Map();
    byUri.set(C.uriKey(params.uri), entry);
    this.diagnostics.set(session, byUri);
    this.emitter.emit("did-publish-diagnostics", entry);
    return true;
  }
  diagnosticsFor(session, uri) {
    return this.diagnostics.get(session)?.get(C.uriKey(uri))?.diagnostics || [];
  }
  // Re-emits what is stored for these documents, unchanged. After a structural
  // notebook edit the diagnostics are the same but every consumer's idea of
  // which cell a URI names has shifted, so the projection has to run again.
  republishStoredDiagnostics(session, uriKeys) {
    const byUri = this.diagnostics.get(session);
    if (!byUri) return;
    for (const key of uriKeys) {
      const entry = byUri.get(key);
      if (entry) this.emitter.emit("did-publish-diagnostics", entry);
    }
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
  diagnosticCountFor(session) {
    let total = 0;
    let files = 0;
    for (const entry of this.diagnostics.get(session)?.values() || []) {
      if (!entry.diagnostics?.length) continue;
      total += entry.diagnostics.length;
      files++;
    }
    return { total, files };
  }
  clearDiagnosticsForSession(session) {
    const byUri = this.diagnostics.get(session);
    if (!byUri) return;
    this.diagnostics.delete(session);
    // The stored entry, not the map key: a consumer receives the URI the server
    // used, which is what it was given when the diagnostics first arrived.
    for (const entry of byUri.values())
      this.emitter.emit("did-publish-diagnostics", { session, uri: entry.uri, diagnostics: [] });
  }
  // fn({session}) — fired when a server registers or withdraws a capability
  // after it started. What a feature holding rendered state needs it for: a
  // capability that arrives late was absent when the session came up, so
  // whoever looked then concluded the server could not serve it and stopped.
  onDidChangeCapabilities(fn) {
    return this.emitter.on("did-change-capabilities", fn);
  }
  registerCapabilities(session, registrations = []) {
    if (this.tearingDown || ["stopping", "failed", "stopped"].includes(session.state)) return false;
    const map = this.dynamicCapabilities.get(session) || new Map();
    for (const item of registrations) map.set(item.id, item);
    this.dynamicCapabilities.set(session, map);
    if (registrations.length) this.emitter.emit("did-change-capabilities", { session });
    if (registrations.some((item) => item.method === "textDocument/diagnostic"))
      session.resetDiagnosticPullState?.(
        registrations
          .filter((item) => item.method === "textDocument/diagnostic")
          .map((item) => item.id),
      );
  }
  unregisterCapabilities(session, registrations = []) {
    if (this.tearingDown || ["stopping", "failed", "stopped"].includes(session.state)) return false;
    const map = this.dynamicCapabilities.get(session);
    for (const item of registrations || []) map?.delete(item.id);
    if (registrations?.length) this.emitter.emit("did-change-capabilities", { session });
    if (registrations?.some((item) => item.method === "textDocument/diagnostic"))
      session.resetDiagnosticPullState?.(
        registrations
          .filter((item) => item.method === "textDocument/diagnostic")
          .map((item) => item.id),
      );
  }
  // Returns true/false when dynamic registrations govern the method for this
  // editor, undefined when none do (static capability applies).
  dynamicSupport(session, method, editor) {
    const registrations = this.dynamicCapabilities.get(session);
    if (!registrations) return undefined;
    let found;
    for (const item of registrations.values()) {
      if (item.method !== method) continue;
      found = false;
      const selector = item.registerOptions?.documentSelector;
      if (!selector || this.selectorMatches(selector, session, editor)) return true;
    }
    return found;
  }
  // The register options of the dynamic registration governing this method for
  // this editor, or undefined when none does. Companion to `dynamicSupport`:
  // that one answers whether, this one carries what it was registered with.
  dynamicOptions(session, method, editor) {
    const registrations = this.dynamicCapabilities.get(session);
    if (!registrations) return undefined;
    for (const item of registrations.values()) {
      if (item.method !== method) continue;
      const selector = item.registerOptions?.documentSelector;
      if (!selector || this.selectorMatches(selector, session, editor)) return item.registerOptions;
    }
    return undefined;
  }
  selectorMatches(selector, session, editor) {
    if (!editor) return true;
    const binding = this.workspaceDocuments.bindingFor(editor);
    const scheme = binding ? C.CELL_SCHEME : editor.getPath?.() ? "file" : "untitled";
    // Patterns run against the file the server knows: the notebook's path for
    // a cell, the editor's own for everything else.
    const filePath = binding?.record.filePath ?? editor.getPath() ?? "";
    const languageId = languageIdForEditor(session.adapter, editor);
    return selector.some((filter) => {
      if (typeof filter === "string") return filter === languageId;
      // LSP 3.17 NotebookCellTextDocumentFilter: `notebook` names the
      // containing notebook, `language` the cell. basedpyright registers its
      // dynamic capabilities with this shape.
      if (filter.notebook !== undefined) {
        if (!binding) return false;
        if (!this.notebookFilterMatches(filter.notebook, binding.record)) return false;
        return !filter.language || filter.language === languageId;
      }
      if (filter.scheme && filter.scheme !== scheme) return false;
      if (filter.language && filter.language !== languageId) return false;
      if (filter.pattern && !this.globMatches(filter.pattern, filePath)) return false;
      return !!(filter.language || filter.pattern || filter.scheme);
    });
  }
  notebookFilterMatches(filter, record) {
    if (typeof filter === "string") return filter === record.notebookType;
    if (filter.notebookType && filter.notebookType !== record.notebookType) return false;
    // The notebook itself is a file: URI whatever its cells' scheme is.
    if (filter.scheme && filter.scheme !== "file") return false;
    if (filter.pattern && !this.globMatches(filter.pattern, record.filePath || "")) return false;
    return true;
  }
  globMatches(globPattern, filePath) {
    if (!globPattern || !filePath) return false;
    const normalized = filePath.replaceAll("\\", "/");
    // Windows paths are case-insensitive, but servers do not agree on drive
    // letter casing. vscode-eslint, for example, registers `c:/...` while
    // Electron reports the same editor as `C:\\...`; a case-sensitive glob
    // silently drops that otherwise valid dynamic capability.
    const options = { dot: true, nocase: process.platform === "win32" };
    if (typeof globPattern === "string") {
      return (
        picomatch.isMatch(normalized, globPattern, options) ||
        picomatch.isMatch(normalized, `**/${globPattern}`, options)
      );
    }
    const base = C.uriToPath(globPattern.baseUri?.uri || globPattern.baseUri);
    if (!base) return false;
    const relative = path.relative(base, filePath);
    // An absolute result means the two paths share no root at all — a different
    // Windows drive or UNC server — which `..` does not express.
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return false;
    return picomatch.isMatch(relative.replaceAll("\\", "/"), globPattern.pattern, options);
  }
  // Watched-file events are limited to paths under the project roots â€” that is
  // the scope of lumine.project.onDidChangeFiles.

  recoverFileWatching({ rootPaths, generation }) {
    if (this.tearingDown) return;
    this.invalidateDiagnosticScopes(rootPaths);
    for (const session of this.allSessions()) {
      if (
        !this.foldersFor(session).some((folder) =>
          rootPaths.some(
            (root) => relativePath(root, folder) !== null || relativePath(folder, root) !== null,
          ),
        )
      )
        continue;
      const controller = this.controllerForSession(session);
      if (!controller || controller.fileWatchRecoveryGeneration === generation) continue;
      controller.fileWatchRecoveryGeneration = generation;
      this.restart(session).catch((error) =>
        this.reportAdapterRestartFailure(session.adapter, error),
      );
    }
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

  projectPathsChanged() {
    const roots = lumine.project.getPaths();
    const previousRoots = this.knownRoots;
    const notifications = [];
    const toFolder = (root) => ({ uri: C.pathToUri(root), name: path.basename(root) });
    const addedPaths = roots.filter((root) => !this.knownRoots.includes(root));
    const added = addedPaths.map(toFolder);
    const removedPaths = this.knownRoots.filter((root) => !roots.includes(root));
    const removed = removedPaths.map(toFolder);
    if (addedPaths.length || removedPaths.length) this.workspaceProjectRevision++;
    for (const rootPath of [...addedPaths, ...removedPaths])
      this.projectRootRevisions.set(rootPath, (this.projectRootRevisions.get(rootPath) || 0) + 1);
    this.knownRoots = roots;
    // Only a workspace-scoped session answers for the project as a whole. The
    // others hear about exactly the folders they take on or lose, from
    // `adoptFolder` and `reconcileProjects`.
    if (added.length || removed.length) {
      const handled = new Set();
      for (const session of this.allSessions()) {
        if (session.adapter.sessionScope !== "workspace") continue;
        session.announcedProjectRoots ??= new Set(previousRoots);
        const controller = this.controllerForSession(session);
        if (controller) handled.add(controller);
        if (controller) controller.structureChanged();
        if (
          session.state === "running" &&
          session.capabilities.workspace?.workspaceFolders?.changeNotifications
        ) {
          notifications.push(
            this.announceProjectFolders(controller, session).catch((error) =>
              this.log(session, error.stack || error),
            ),
          );
        } else {
          if (controller && !controller.restartPromise)
            controller
              .restart({ force: true })
              .catch((error) => this.log(session, error.stack || error));
        }
      }
      for (const controller of this.controllers) {
        if (
          controller.adapter.sessionScope !== "workspace" ||
          handled.has(controller) ||
          controller.cancelled
        )
          continue;
        controller.structureChanged();
        if (!controller.restartPromise)
          controller
            .restart({ force: true })
            .catch((error) =>
              this.log(
                { adapter: controller.adapter, rootPath: controller.rootPath },
                error.stack || error,
              ),
            );
      }
    }
    this.reconcileProjects(removedPaths);
    this.rerouteEditorsToTheirRoots();
    this.pruneUndemandedControllers();
    // A notebook whose session was reclaimed with a departed root needs a
    // replacement under its new root, same as the file editors above.
    this.notebookDocuments?.reattachAll();
    return Promise.allSettled(notifications);
  }
  // Which session serves an editor follows from its root, so adding or
  // removing a project folder can move it. A file that gained a root belongs
  // to that root's session now rather than the one keyed to its own directory,
  // and a file whose root was just removed has had its server stopped from
  // under it by `reconcileProjects` and needs another.
  rerouteEditorsToTheirRoots() {
    for (const editor of lumine.workspace.getTextEditors()) {
      const uri = this.workspaceDocuments.uriForEditor(editor);
      if (!uri) continue;
      const key = C.uriKey(uri);
      const wanted = new Set(this.sessionsForEditor(editor));
      const attached = this.allSessions().filter((session) => session.documents.has(key));
      if (attached.length !== wanted.size || attached.some((session) => !wanted.has(session))) {
        this.reattachEditor(editor);
      } else if (!attached.length) {
        this.attachEditor(editor);
      }
    }
  }
  pushSettingsForAdapter(adapter) {
    for (const controller of this.controllersForAdapter(adapter))
      if (!controller.cancelled) controller.settingsChanged();
  }

  reportSettingsFailure(controller, session, revision, error) {
    this.log(session, error.stack || error);
    lumine.notifications.addError(`Unable to update ${session.adapter.displayName} settings`, {
      detail: error.message,
      dismissable: true,
    });
  }
  handleProgress(session, { token, value }) {
    if (
      !value ||
      !["string", "number"].includes(typeof token) ||
      ["stopping", "stopped", "failed"].includes(session.state) ||
      session.retiredProgressTokens?.has(token) ||
      (typeof token === "string" &&
        /^ide-(?:request|start)-/.test(token) &&
        !session.clientProgressTokens?.has(token))
    )
      return;
    const client = session.clientProgressTokens?.get(token);
    const options = {};
    for (const field of ["title", "message", "percentage", "cancellable"]) {
      if (value[field] !== undefined) options[field] = value[field];
    }
    if (client) {
      // Client-owned work cancels its request, and keeps the fallback title
      // when a server reports an empty title (as Pyright does).
      if (typeof value.title !== "string" || !value.title.trim()) delete options.title;
      if (typeof value.cancellable === "boolean") {
        options.cancellable = Boolean(client.cancellable && value.cancellable);
      }
    }
    if (value.kind === "begin") {
      if (client) {
        if (this.activity.has(session, token)) this.activity.update(session, token, options);
        else this.beginActivity(session, token, { ...client, ...options, delay: 400 });
      } else {
        const activity = this.beginActivity(session, token, {
          ...options,
          cancel: () => session.notify("window/workDoneProgress/cancel", { token }),
        });
        session.progressTitles.set(token, activity);
      }
    } else if (value.kind === "report") {
      this.activity.update(session, token, options);
    } else if (value.kind === "end") {
      this.activity.update(session, token, options);
      this.endActivity(session, token);
    } else {
      return;
    }
    this.log(session, `progress ${value.kind}: ${value.title || value.message || token}`);
  }
  clearProgress(session) {
    this.activity.clear(session);
    session.progressTitles?.clear();
  }
  log(session, message) {
    const id = session.adapter?.id || "unknown";
    const entries = this.logs.get(id) || [];
    entries.push(`[${new Date().toISOString()}] ${String(message).trim()}`);
    if (entries.length > 2000) entries.shift();
    this.logs.set(id, entries);
    this.emitter.emit("did-log", { session, message });
  }
  getLog(adapterId) {
    return (this.logs.get(adapterId) || []).join("\n");
  }
  // The headline names the server and takes the message's first line; whatever
  // follows it becomes the description, which a notification does not cap the
  // way it caps a headline. Basedpyright's workspace-enumeration warning is a
  // sentence and a four-item list, and as a headline it scrolls inside its own
  // notification -- for the five seconds a notification nobody clicks lasts,
  // which is why one long enough to have a description is dismissable.
  showMessage(type, message, session) {
    const methods = { 1: "addError", 2: "addWarning", 3: "addInfo", 4: "addInfo" };
    const [headline, ...rest] = String(message).split(/\r?\n/);
    const description = markdownBlocks(rest);
    lumine.notifications[methods[type] || "addInfo"](
      `${serverName(session)}: ${headline}`,
      description ? { description, dismissable: true } : undefined,
    );
  }
  async showMessageRequest(type, message, actions, session) {
    const buttons = actions.map((action) => action.title).concat("Cancel");
    const selected = await lumine.window.confirm({
      type: type === 1 ? "error" : type === 2 ? "warning" : "info",
      message: `${serverName(session)}: ${message}`,
      buttons,
    });
    return selected < actions.length ? actions[selected] : null;
  }
  async showDocument({ uri, selection, external, takeFocus }) {
    try {
      if (external) {
        const url = externalUrl(uri);
        if (!url) {
          lumine.notifications.addWarning(
            "The language server requested an unsupported external URL.",
            { dismissable: true },
          );
          return { success: false };
        }
        await lumine.shell.openExternal(url);
        return { success: true };
      }
      const resolved = this.workspaceDocuments.resolveUri(uri);
      if (!resolved) return { success: false };
      if (resolved.kind === "cell") {
        // The notebook's own reveal, when the bridge supplied one; the range
        // is cell-relative either way.
        if (resolved.record.show) {
          await resolved.record.show({
            cellId: resolved.cellId,
            range: selection && C.rangeFromLsp(selection),
            takeFocus: takeFocus !== false,
          });
          return { success: true };
        }
        if (selection && resolved.editor?.setSelectedBufferRange)
          resolved.editor.setSelectedBufferRange(C.rangeFromLsp(selection), { autoscroll: true });
        return { success: true };
      }
      if (resolved.kind === "untitled") {
        if (takeFocus !== false) {
          const pane = lumine.workspace.paneForItem(resolved.editor);
          pane?.activateItem(resolved.editor);
          pane?.activate();
        }
        if (selection)
          resolved.editor.setSelectedBufferRange(C.rangeFromLsp(selection), { autoscroll: true });
        return { success: true };
      }
      const editor = await lumine.workspace.open(resolved.path, {
        activateItem: takeFocus !== false,
      });
      if (selection && editor?.setSelectedBufferRange)
        editor.setSelectedBufferRange(C.rangeFromLsp(selection), { autoscroll: true });
      return { success: true };
    } catch (error) {
      if (external) {
        lumine.notifications.addWarning("Unable to open the language server URL.", {
          detail: error.message,
          dismissable: true,
        });
      }
      return { success: false };
    }
  }

  async applyWorkspaceEdits(edits, label, options = {}) {
    return this.workspaceEdits.applyWorkspaceEdits(edits, label, options);
  }
  async applyWorkspaceEdit(edit, label, session = null) {
    return this.workspaceEdits.applyWorkspaceEdit(edit, label, session);
  }

  async applyWorkspaceEditDetailed(edit, label, session = null) {
    return this.workspaceEdits.applyWorkspaceEditDetailed(edit, label, session);
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
  reportAdapterRestartFailure(adapter, error) {
    const detail = error?.errors?.map((entry) => entry.message).join("\n") || error.message;
    this.log({ adapter, rootPath: "" }, error.stack || detail);
    lumine.notifications.addError(`Unable to restart ${adapter.displayName}`, {
      detail,
      dismissable: true,
    });
  }
  // Configuration changes are coalesced per adapter. If another change lands
  // while a resolver or initialize request is pending, the drain observes the
  // newer generation and finishes on that one rather than publishing an
  // intermediate configuration.
  restartAdapter(adapter, { reportErrors = false } = {}) {
    if (this.tearingDown || this.adapters.get(adapter.id) !== adapter) return Promise.resolve(null);
    let operation = this.adapterRestartOperations.get(adapter);
    if (!operation) {
      operation = {
        generation: 0,
        cancelled: false,
        promise: null,
        reportedPromise: null,
        requests: new Map(),
      };
      this.adapterRestartOperations.set(adapter, operation);
    }
    operation.generation++;
    // Mark every controller dirty immediately, even when the adapter-level
    // drain is already awaiting it. Delaying this until the next outer loop
    // would let the current resolver publish a process with stale settings.
    operation.requests = new Map(
      this.controllersForAdapter(adapter)
        .filter((controller) => {
          if (controller.cancelled) return false;
          if (controller.blockedByLiveStop) return true;
          if (this.controllerHasDemand(controller)) return true;
          this.retireController(controller);
          return false;
        })
        .map((controller) => [controller, controller.restart({ force: true })]),
    );
    if (operation.promise) {
      this.observeAdapterRestart(adapter, operation, operation.promise, reportErrors);
      return operation.promise;
    }
    const pending = (async () => {
      while (!operation.cancelled && !this.tearingDown) {
        const generation = operation.generation;
        const settled = await Promise.allSettled(operation.requests.values());
        if (generation !== operation.generation) continue;
        const errors = settled
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, `Unable to restart ${adapter.displayName}`);
        // This is also the missing -> configured path: there may have been no
        // session (and therefore nothing above to restart) before the setting
        // changed. Only a clean round may reattach. Reattaching after a failed
        // request would immediately run the same controller again and could
        // even install a server after the caller had already received failure.
        await this.reattachAll();
        if (generation !== operation.generation) continue;
        return settled.map((result) => result.value);
      }
      return null;
    })();
    operation.promise = pending;
    this.observeAdapterRestart(adapter, operation, pending, reportErrors);
    pending.then(
      () => {
        if (operation.promise === pending) operation.promise = null;
      },
      () => {
        if (operation.promise === pending) operation.promise = null;
      },
    );
    return pending;
  }
  observeAdapterRestart(adapter, operation, promise, reportErrors) {
    if (!reportErrors || operation.reportedPromise === promise) return;
    operation.reportedPromise = promise;
    promise.then(
      () => {
        if (operation.reportedPromise === promise) operation.reportedPromise = null;
      },
      (error) => {
        if (operation.reportedPromise === promise) operation.reportedPromise = null;
        this.reportAdapterRestartFailure(adapter, error);
      },
    );
  }

  sessionPhysicallyExited(session) {
    const child = session?.process;
    return (
      !child || session.processExited === true || child.exitCode != null || child.signalCode != null
    );
  }
  waitForSessionExit(session) {
    if (this.sessionPhysicallyExited(session)) return Promise.resolve();
    let waiter = this.sessionExitWaiters.get(session);
    if (!waiter) {
      let resolve;
      const promise = new Promise((done) => (resolve = done));
      waiter = { promise, resolve };
      this.sessionExitWaiters.set(session, waiter);
    }
    return Promise.race([waiter.promise, this.teardownPromise]);
  }
  adapterQuarantineConflicts(adapter, rootPath) {
    return [...this.ownedSessions].filter(
      (session) =>
        session.adapter?.id === adapter.id &&
        !this.sessionPhysicallyExited(session) &&
        (session.adapter !== adapter ||
          (this.sessionControllers.get(session)?.cancelled &&
            this.sessionControllers.get(session).covers(session, rootPath))),
    );
  }
  async waitForAdapterQuarantine(adapter, rootPath) {
    while (!this.tearingDown) {
      const conflicts = this.adapterQuarantineConflicts(adapter, rootPath);
      if (!conflicts.length) return true;
      await Promise.all(conflicts.map((session) => this.waitForSessionExit(session)));
    }
    return false;
  }

  splitUnsupportedFolders(controller, session) {
    if (
      controller.adapter.sessionScope === "workspace" ||
      controller.folders.size < 2 ||
      session.capabilities.workspace?.workspaceFolders?.supported
    )
      return;
    const primary = controller.folders.has(controller.rootPath)
      ? controller.rootPath
      : controller.folders.values().next().value;
    controller.rootPath = primary;
    session.rootPath = primary;
    for (const rootPath of [...controller.folders]) {
      if (rootPath === primary) continue;
      this.unbindController(controller, rootPath);
      this.createController(controller.adapter, rootPath);
    }
  }
  // `retry` marks automatic restarts, which continue the failure run. A
  // restart somebody asked for starts a fresh run. Calls for the same current
  // session share the exact in-flight Promise.
  restart(session, { retry = false } = {}) {
    const controller = this.controllerForSession(session);
    if (!controller || controller.cancelled) return Promise.resolve(null);
    if (controller.restartPromise && controller.restartSources.has(session)) {
      if (controller.desiredRetry && !retry) return controller.restart({ retry, source: session });
      return controller.restartPromise;
    }
    if (controller.session !== session) return Promise.resolve(null);
    return controller.restart({ retry, source: session });
  }
  // Both take a session out of the map and shut it down; what differs is who
  // hears about a failure. `disconnect` is for a stop somebody asked for and
  // rejects, so the caller can report it. `reclaim` runs where nothing awaits
  // the result — a timer, a disposable, a project that changed under a server —
  // so a failure is logged rather than left as an unhandled rejection.
  async disconnect(session) {
    const controller = this.controllerForSession(session);
    if (!controller) {
      this.forget(session);
      await session.stop();
      return;
    }
    return controller.shutdown({ strict: true });
  }
  reclaim(session) {
    const controller = this.controllerForSession(session);
    if (!controller) {
      this.forget(session);
      return this.stopSession(session);
    }
    return controller.shutdown();
  }
  // A session outlives the editors it serves on purpose: reopening a file in a
  // project should not pay for another server start. That only holds while
  // something can still reach it — a session rooted at a project path waits for
  // the next editor there. One rooted at a lone file's directory, opened with
  // no project, can never be reached again once that editor is gone, so it is
  // shut down instead of idling for the life of the window.
  didCloseDocument(session) {
    this.controllerForSession(session)?.documentClosed(session);
  }
  stopIfUnreachable(session) {
    if (session.state === "stopped" || session.state === "stopping") return;
    if (session.documents.size > 0) return;
    const roots = lumine.project.getPaths();
    // A workspace-scoped session answers for every root, so it stays warm as
    // long as the window has one, whatever its own `rootPath` says. Any other
    // session waits for the next editor under a folder it still answers for.
    if (
      session.adapter.sessionScope === "workspace"
        ? roots.length
        : [...session.folders].some((folder) => roots.includes(folder))
    )
      return;
    const stillServesAnEditor = lumine.workspace
      .getTextEditors()
      .some((editor) => this.sessionsForEditor(editor).includes(session));
    if (stillServesAnEditor) return;
    this.reclaim(session);
  }
  cancelIdleChecks() {
    for (const controller of this.controllers) controller.cancelIdle();
  }
  // A folder that left the project takes its key with it. A session that held
  // more than one survives on the folders it has left; one that held only the
  // departed folder has nothing to answer for and stops.
  reconcileProjects(removedPaths) {
    const roots = lumine.project.getPaths();
    for (const session of this.allSessions()) {
      if (session.adapter.sessionScope === "workspace") continue;
      const gone = [...session.folders].filter((folder) =>
        removedPaths ? removedPaths.includes(folder) : !roots.includes(folder),
      );
      if (!gone.length) continue;
      if (gone.length === session.folders.size) {
        this.reclaim(session);
        continue;
      }
      const controller = this.controllerForSession(session);
      for (const folder of gone) {
        if (controller) this.unbindController(controller, folder);
        else {
          session.folders.delete(folder);
          const key = this.keyFor(session.adapter, folder);
          if (this.sessions.get(key) === session) this.sessions.delete(key);
        }
      }
      if (!session.folders.has(session.rootPath)) {
        [session.rootPath] = session.folders;
        if (controller) controller.rootPath = session.rootPath;
      }
      if (controller) controller.structureChanged();
      session.notify("workspace/didChangeWorkspaceFolders", {
        event: { added: [], removed: gone.map((folder) => this.folderOf(folder)) },
      });
    }
    // A resolver can be pending before a ServerSession exists. Removing its
    // project root still cancels that logical server; otherwise the late
    // resolver could start a process for a folder that no longer belongs to the
    // workspace.
    for (const controller of [...this.controllers]) {
      if (controller.adapter.sessionScope === "workspace" || controller.session) continue;
      const gone = [...controller.folders].filter((folder) =>
        removedPaths ? removedPaths.includes(folder) : !roots.includes(folder),
      );
      if (!gone.length) continue;
      if (gone.length === controller.folders.size) {
        this.cancelController(controller);
      } else {
        for (const folder of gone) this.unbindController(controller, folder);
        if (!controller.folders.has(controller.rootPath))
          [controller.rootPath] = controller.folders;
        controller.structureChanged();
      }
    }
  }
  // Teardown must not be abortable: one server that cannot be shut down cleanly
  // — a broken pipe, a process already gone — must not strand the servers beside
  // it or the cleanup that follows them, so the failure is reported rather than
  // thrown. See `reclaim` for which callers want this and which want to hear it.
  async stopSession(session) {
    const controller = this.controllerForSession(session);
    if (controller) return controller.stopChild(session);
    try {
      await session.stop();
    } catch (error) {
      console.error(`ide: failed to stop ${session?.adapter?.id ?? "a language server"}`, error);
    }
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
    this.tearingDown = true;
    this.managedServers?.dispose();
    this.resolutionLifetime.abort(
      new DOMException("The IDE resolver is no longer active", "AbortError"),
    );
    this.resolveTeardown();
    this.workspaceEdits.dispose();
    this.fileOperations.dispose();
    this.activity.dispose();
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
    this.workspaceDocuments.dispose();
  }
  async deactivate() {
    this.tearingDown = true;
    this.managedServers?.dispose();
    this.resolutionLifetime.abort(
      new DOMException("The IDE resolver is no longer active", "AbortError"),
    );
    this.resolveTeardown();
    this.workspaceEdits.dispose();
    this.fileOperations.dispose();
    this.diagnosticScopes.dispose();
    this.activity.dispose();
    this.cancelIdleChecks();
    this.subscriptions.dispose();
    for (const subs of this.editorSubscriptions.values()) subs.dispose();
    this.editorSubscriptions.clear();
    for (const subs of this.adapterSubscriptions.values()) subs.dispose();
    this.adapterSubscriptions.clear();
    await this.stopAllSessions();
    this.workspaceDocuments.dispose();
    this.emitter.dispose();
  }
};
