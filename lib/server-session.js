const { Emitter, CompositeDisposable, Range } = require("lumine");

function lazyModule(load) {
  let value;
  const get = () => (value ||= load());
  return new Proxy(
    {},
    {
      get(_target, property) {
        return get()[property];
      },
      has(_target, property) {
        return property in get();
      },
    },
  );
}

const ChildProcess = lazyModule(() => require("child_process"));
const net = lazyModule(() => require("net"));
const path = lazyModule(() => require("path"));
const crypto = lazyModule(() => require("crypto"));
const RpcConnection = lazyModule(() => require("./rpc-connection"));
const C = lazyModule(() => require("./converters"));
const STATIC_CAPABILITIES = lazyModule(() => require("./capabilities").STATIC_CAPABILITIES);
const METHOD_FEATURES = lazyModule(() => require("./features").METHOD_FEATURES);
const featureEnabled = (...args) => require("./features").featureEnabled(...args);
const languageIdForEditor = (...args) => require("./language-ids").languageIdForEditor(...args);
const Projections = lazyModule(() => require("./document-projections"));
const projectionUsesOriginalText = (projection) =>
  projection?.isIdentity === true &&
  typeof projection.source === "string" &&
  typeof projection.text === "string" &&
  projection.source === projection.text;

// How long a server gets to exit on its own after `exit` before it is killed.
// Kept above the one-second interceptor used by the ESLint server.
const EXIT_GRACE_MS = 2000;

// Once a hard kill has been sent, wait a bounded interval for the operating
// system to report the physical process exit. A missing event must not leave
// window teardown pending forever.
const FINAL_EXIT_TIMEOUT_MS = 1000;

// Notifications normally flush immediately, but a wedged stream writer can
// leave even fire-and-forget traffic pending. `exit` gets its own bound before
// process teardown takes over.
const EXIT_NOTIFY_TIMEOUT_MS = 1000;

// How long a server gets to answer `shutdown` before it is told to leave
// anyway. The reply is a courtesy — it means "I have stopped working", and
// `exit` follows regardless — but the request is a promise like any other, and
// a server that accepts it and never answers would hold this open with nothing
// to time it out. `stop()` runs on the unload path, where that would have meant
// a window that never reloads.
const SHUTDOWN_TIMEOUT_MS = 2000;

// Pull-diagnostic servers are asked after a short quiet period while typing.
// Opening a document and an explicit server refresh remain immediate.
const DIAGNOSTIC_DEBOUNCE_MS = 200;
const SOCKET_CONNECT_TIMEOUT_MS = 5000;
const SOCKET_RETRY_MS = 50;
const START_CANCELLED = Symbol("start-cancelled");
const DYNAMIC_SETTINGS = Symbol("dynamic-settings");

// A workspace diagnostic subscription can stay open for the whole session.
// Only finite requests get a fallback indicator; server-reported progress can
// still describe individual analysis passes on a subscription.
const REQUEST_TITLES = {
  "textDocument/completion": "Finding completions",
  "completionItem/resolve": "Resolving completion",
  "textDocument/hover": "Loading hover",
  "textDocument/signatureHelp": "Loading signature help",
  "textDocument/declaration": "Finding declaration",
  "textDocument/definition": "Finding definition",
  "textDocument/typeDefinition": "Finding type definition",
  "textDocument/implementation": "Finding implementations",
  "textDocument/references": "Finding references",
  "textDocument/documentHighlight": "Finding symbol highlights",
  "textDocument/documentSymbol": "Loading document symbols",
  "workspace/symbol": "Searching workspace symbols",
  "textDocument/formatting": "Formatting document",
  "textDocument/rangeFormatting": "Formatting selection",
  "textDocument/onTypeFormatting": "Formatting input",
  "textDocument/rename": "Renaming symbol",
  "textDocument/prepareRename": "Preparing rename",
  "textDocument/codeAction": "Loading code actions",
  "codeAction/resolve": "Resolving code action",
  "textDocument/inlayHint": "Loading inlay hints",
  "inlayHint/resolve": "Resolving inlay hint",
  "textDocument/codeLens": "Loading code lenses",
  "codeLens/resolve": "Resolving code lens",
  "textDocument/documentLink": "Loading document links",
  "documentLink/resolve": "Resolving document link",
  "textDocument/documentColor": "Finding document colors",
  "textDocument/colorPresentation": "Loading color presentations",
  "textDocument/foldingRange": "Loading folding ranges",
  "textDocument/selectionRange": "Loading selection ranges",
  "textDocument/linkedEditingRange": "Finding linked ranges",
  "textDocument/diagnostic": "Checking document",
  "textDocument/semanticTokens/full": "Highlighting document",
  "textDocument/semanticTokens/full/delta": "Updating highlighting",
  "textDocument/semanticTokens/range": "Highlighting selection",
  "textDocument/prepareCallHierarchy": "Loading call hierarchy",
  "callHierarchy/incomingCalls": "Finding incoming calls",
  "callHierarchy/outgoingCalls": "Finding outgoing calls",
  "textDocument/prepareTypeHierarchy": "Loading type hierarchy",
  "typeHierarchy/supertypes": "Finding supertypes",
  "typeHierarchy/subtypes": "Finding subtypes",
  "workspace/executeCommand": "Running command",
};
const ACTIVITY_DELAY_MS = 400;
const PROGRESS_CAPABILITIES = {
  "textDocument/prepareRename": "textDocument/rename",
  "callHierarchy/incomingCalls": "textDocument/prepareCallHierarchy",
  "callHierarchy/outgoingCalls": "textDocument/prepareCallHierarchy",
  "typeHierarchy/supertypes": "textDocument/prepareTypeHierarchy",
  "typeHierarchy/subtypes": "textDocument/prepareTypeHierarchy",
};

// Rejects if `promise` has not settled within `ms`. The timer is cleared either
// way: a pending one keeps the process alive, and every caller here is on a
// path that is trying to let something go.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Resolves true when `promise` settles within the interval and false on the
// deadline. The input used here is a process-exit signal and never rejects.
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Methods an aborted request abandons quietly, without `$/cancelRequest`.
// `$/cancelRequest` is advisory, and for these two it buys nothing: a server
// supersedes find-all-references on its own as soon as the replacement lands,
// and a command is a mutation that nobody gains from stopping half way.
//
// It also costs. Pyright answers both by first awaiting
// `window/workDoneProgress/create`; a cancellation arriving during that round
// trip leaves its `CancelAfter` holding a cancellation source it never read the
// token of, and the handler's next call to `cancel()` throws
// `this._token.cancel is not a function` — for every later request of that
// method, until the server is restarted. The policy lives here rather than at
// the call sites because every request but `initialize` and `shutdown` passes
// through, including the `request` this package hands to other packages.
const ABANDON_QUIETLY = new Set(["textDocument/references", "workspace/executeCommand"]);

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const escapeWindowsCommand = (value) => String(value).replace(CMD_META, "^$1");
const escapeWindowsArgument = (value, doubleEscapeMetaCharacters = false) => {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META, "^$1");
  return doubleEscapeMetaCharacters ? escaped.replace(CMD_META, "^$1") : escaped;
};

function prepareServerSpawn(command, args, options, platform = process.platform) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args, options };
  const normalized = path.win32.normalize(command);
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.(cmd|bat)$/i.test(normalized);
  const shellCommand = [
    escapeWindowsCommand(normalized),
    ...args.map((argument) => escapeWindowsArgument(argument, doubleEscape)),
  ].join(" ");
  return {
    command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    options: { ...options, windowsVerbatimArguments: true },
  };
}

function spawnServer(command, args, options) {
  const prepared = prepareServerSpawn(command, args, options);
  return ChildProcess.spawn(prepared.command, prepared.args, prepared.options);
}

module.exports = class ServerSession {
  constructor(manager, adapter, rootPath, launch, startup = null) {
    this.manager = manager;
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.launch = launch;
    // A restart preflights these values while the old server is still healthy.
    // Direct starts pass no snapshot and resolve the same values here.
    this.startup = startup;
    // Every project folder this session answers for. More than one only when
    // the server declared multi-root support and adopted the rest.
    this.folders = new Set([rootPath]);
    this.documents = new Map();
    this.projectionResponses = new WeakMap();
    this.projectedDocuments = new Set();
    this.temporaryDocumentUris = new Set();
    this.temporaryDocuments = new Map();
    this.workspaceProjectionContexts = new WeakMap();
    this.progressTitles = new Map();
    this.clientProgressTokens = new Map();
    this.retiredProgressTokens = new Set();
    this.diagnosticTimers = new Map();
    this.workspaceDiagnosticTimer = null;
    this.workspaceDiagnosticPromise = null;
    this.workspaceDiagnosticQueued = false;
    this.workspaceDiagnosticResultIds = new Map();
    this.workspaceDiagnosticStates = new Map();
    this.diagnosticProviderDefinitions = new Map();
    this.diagnosticReports = new Map();
    this.diagnosticGeneration = 0;
    this.partialResults = new Map();
    this.partialResultCounter = 0;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.state = "starting";
    this.stateError = null;
    // `stop()` is single-flight. It is assigned before the first state event is
    // emitted so even a listener that calls stop reentrantly joins the same
    // teardown instead of starting a second protocol exchange.
    this.stopPromise = null;
    this.startCancelled = false;
    this.startCancellation = new Promise((resolve) => (this.resolveStartCancellation = resolve));
    this.startFailure = null;
    this.failureHandled = false;
    this.failureKillTimer = null;
    this.processExited = false;
    this.processError = null;
    this.processExitPromise = null;
    this.resolveProcessExit = null;
    this.socket = null;
    this.capabilities = {};
    // How often this server has been restarted, and how many of those restarts
    // came one after another without it ever staying up in between. A restart
    // builds a new session, so the manager carries both onto the replacement —
    // see `LanguageServerManager#scheduleRestart`, which is what keeps a server
    // that dies on every start from being restarted for ever.
    this.restartCount = 0;
    this.failureCount = 0;
    // When the handshake finished, or null while it has not. A server that
    // never reached `running` has proved nothing about its own health, and one
    // that stayed up for a while has: that is the difference between a crash
    // loop and a server that had a bad afternoon.
    this.runningSince = null;
  }
  onDidChangeState(fn) {
    return this.emitter.on("did-change-state", fn);
  }
  // Notifications this client registers no handler of its own for. The ones it
  // does handle reach their consumers through the manager instead.
  onNotification(fn) {
    return this.emitter.on("notification", fn);
  }
  setState(state, error) {
    if (state === "running") this.runningSince = Date.now();
    this.state = state;
    this.stateError = error || null;
    this.emitter.emit("did-change-state", { session: this, state, error });
    this.manager.didChangeSession(this, error);
  }
  // Everything the connection has to say about itself — traffic traces, write
  // failures, handler faults — lands in this server's log buffer.
  logger() {
    const log = (message) => this.manager.log(this, message);
    return { error: log, warn: log, info: log, log };
  }
  applyTrace() {
    if (this.state === "starting" || this.state === "running")
      this.connection?.setTrace(lumine.config.get("ide-client.trace"));
  }
  async start() {
    if (!this.continueStart()) return;
    const workDoneToken = `ide-client-start-${crypto.randomUUID()}`;
    this.clientProgressTokens.set(workDoneToken, { title: "Starting", cancellable: false });
    this.manager.beginActivity(this, workDoneToken, {
      title: "Starting",
      delay: ACTIVITY_DELAY_MS,
    });
    let finishingStartup;
    try {
      await this.awaitDuringStart(() => this.manager.prepareSessionServices());
      if (!this.continueStart()) return;
      const {
        command,
        args = [],
        cwd = this.rootPath,
        env = {},
        transport = "stdio",
      } = this.launch;
      if (!command) throw new Error(`Adapter ${this.adapter.id} returned no server command`);
      const options = { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false };
      const rpc = {
        logger: this.logger(),
        fileCancellationFolder: this.launch.fileCancellationFolder,
      };
      if (transport === "ipc") {
        this.process = ChildProcess.fork(command, args, {
          ...options,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        this.watchProcess({ logStdout: true });
        this.connection = RpcConnection.ipc(this.process, rpc);
      } else if (transport === "socket") {
        this.process = spawnServer(command, args, options);
        this.watchProcess({ logStdout: true });
        const connected = await this.awaitDuringStart(() =>
          this.connectSocket(this.launch.host || "127.0.0.1", this.launch.port),
        );
        if (!this.continueStart()) return;
        this.socket = connected;
        this.connection = RpcConnection.socket(this.socket, rpc);
      } else {
        this.process = spawnServer(command, args, {
          ...options,
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.watchProcess();
        this.connection = RpcConnection.stdio(this.process, rpc);
      }
      if (!this.continueStart()) return;
      this.installClientHandlers();
      this.applyTrace();
      this.connection.listen();
      const rootUri = C.pathToUri(this.rootPath);
      const initializationOptions = this.startup
        ? this.startup.initializationOptions
        : await this.awaitDuringStart(() =>
            this.adapter.getInitializationOptions?.({
              rootPath: this.rootPath,
              rootUri,
            }),
          );
      if (!this.continueStart()) return;
      const result = await this.awaitDuringStart(() =>
        this.connection.request("initialize", {
          processId: process.pid,
          clientInfo: { name: "Lumine", version: lumine.application.getVersion() },
          locale: navigator.language,
          rootUri,
          workspaceFolders: this.startup?.workspaceFolders ?? this.manager.workspaceFolders(this),
          capabilities: this.manager.buildClientCapabilities(),
          initializationOptions,
          workDoneToken,
        }),
      );
      if (!this.continueStart()) return;
      // The initialize token expires with its response. Continue tracking
      // client setup separately while settings and adapter hooks finish.
      this.retireProgressToken(workDoneToken);
      finishingStartup = this.manager.beginActivity(this, Symbol("startup"), {
        title: "Starting",
        delay: ACTIVITY_DELAY_MS,
      });
      this.capabilities =
        this.adapter.transformServerCapabilities?.(result.capabilities) ||
        result.capabilities ||
        {};
      const encoding = this.capabilities.positionEncoding;
      if (encoding && encoding !== "utf-16")
        throw new Error(
          `${this.adapter.displayName} chose unsupported position encoding '${encoding}'`,
        );
      this.serverInfo = result.serverInfo;
      await this.awaitDuringStart(() => this.connection.notify("initialized", {}));
      if (!this.continueStart()) return;
      await this.pushSettings(this.startup ? this.startup.settings : DYNAMIC_SETTINGS);
      if (!this.continueStart()) return;
      const initializedNotifications = await this.awaitDuringStart(() =>
        this.adapter.getInitializedNotifications?.({
          session: this,
          rootPath: this.rootPath,
          rootUri,
        }),
      );
      if (!this.continueStart()) return;
      if (initializedNotifications != null && !Array.isArray(initializedNotifications))
        throw new TypeError("getInitializedNotifications must return an array");
      for (const notification of initializedNotifications || []) {
        if (!notification || typeof notification.method !== "string")
          throw new TypeError("An initialized notification must name its method");
        await this.awaitDuringStart(() =>
          this.connection.notify(notification.method, notification.params),
        );
        if (!this.continueStart()) return;
      }
      this.startup = null;
      this.setState("running");
      this.refreshDiagnostics();
    } catch (error) {
      // Stopping a half-started session closes its connection and rejects any
      // pending initialize request. That is cancellation, not a start failure.
      if ((this.state === "stopping" || this.state === "stopped") && !this.startFailure) return;
      const failure =
        this.processError ||
        this.startFailure ||
        (this.state === "failed" ? this.stateError || error : error);
      // A failed hook, handshake, or capability check must not leave the
      // process alive until the manager notices. Manager cleanup joins this
      // same single-flight stop, so ownership remains coordinated.
      try {
        await this.stop();
      } catch (stopError) {
        this.manager.log(this, `Unable to clean up failed start: ${stopError.message}`);
      }
      throw failure;
    } finally {
      this.retireProgressToken(workDoneToken);
      finishingStartup?.dispose();
    }
  }
  awaitDuringStart(operation) {
    if (this.startCancelled) return Promise.resolve(START_CANCELLED);
    const pending = Promise.resolve().then(operation);
    return Promise.race([pending, this.startCancellation]);
  }
  cancelStart() {
    if (this.startCancelled) return;
    this.startCancelled = true;
    this.resolveStartCancellation(START_CANCELLED);
  }
  continueStart() {
    if (this.startFailure) throw this.startFailure;
    if (this.state === "starting") return true;
    if (this.state === "stopping" || this.state === "stopped") return false;
    throw (
      this.stateError ||
      new Error(`Language server cannot finish starting from state '${this.state}'`)
    );
  }
  watchProcess({ logStdout = false } = {}) {
    this.processExitPromise = new Promise((resolve) => (this.resolveProcessExit = resolve));
    this.process.stderr?.on("data", (chunk) => this.manager.log(this, chunk.toString()));
    if (logStdout)
      this.process.stdout?.on("data", (chunk) => this.manager.log(this, chunk.toString()));
    this.process.on("error", (error) => this.onProcessError(error));
    this.process.once("exit", (code, signal) => this.onProcessExit(code, signal));
  }
  async connectSocket(host, port) {
    const deadline = Date.now() + SOCKET_CONNECT_TIMEOUT_MS;
    let lastError;
    while (!this.startCancelled && !this.startFailure) {
      const socket = net.connect({ host, port });
      this.socket = socket;
      try {
        await this.awaitSocket(socket);
        return socket;
      } catch (error) {
        lastError = error;
        socket.destroy();
        if (!["ECONNREFUSED", "ENOENT"].includes(error.code) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, SOCKET_RETRY_MS));
      }
    }
    throw (
      this.startFailure || lastError || new Error("Language server socket connection cancelled")
    );
  }
  awaitSocket(socket) {
    return new Promise((resolve, reject) => {
      let connected = false;
      const cleanup = () => {
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };
      const onConnect = () => {
        connected = true;
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        if (connected) return;
        cleanup();
        reject(new Error("Language server socket closed before connecting"));
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }
  async pushSettings(settings = DYNAMIC_SETTINGS) {
    if (this.state !== "starting" && this.state !== "running") return;
    if (settings === DYNAMIC_SETTINGS) {
      settings = await this.awaitDuringStart(() => this.adapter.getSettings?.());
      if (settings === START_CANCELLED) return;
      if (settings == null)
        settings = await this.awaitDuringStart(() =>
          this.adapter.getWorkspaceConfiguration?.(undefined),
        );
      if (settings === START_CANCELLED) return;
      settings ??= {};
    }
    if (!this.connection || (this.state !== "starting" && this.state !== "running")) return;
    const sent = await this.awaitDuringStart(() =>
      this.connection.notify("workspace/didChangeConfiguration", { settings }),
    );
    if (sent === START_CANCELLED) return;
    if (this.state === "running") this.refreshDiagnostics();
  }
  transformDocumentText(text, editor, uri) {
    return this.adapter.transformDocumentText?.(text, { editor, uri }) ?? text;
  }
  needsDocumentTransform(editor) {
    return (
      !!(this.adapter.getDocumentProjection || this.adapter.transformDocumentText) &&
      this.adapter.needsDocumentTransform?.(editor) !== false
    );
  }
  projectionForEditor(editor) {
    const uri = this.manager.uriForEditor?.(editor);
    return uri ? (this.documents.get(C.uriKey(uri))?.projection ?? null) : null;
  }
  async prepareDocumentProjection(document) {
    if (!document) return false;
    if (!this.needsDocumentTransform(document.editor)) {
      document.projection = null;
      this.projectedDocuments.delete(document);
      return this.isCurrentDocument(document);
    }
    document.syncAbortController ??= new AbortController();
    while (this.isCurrentDocument(document)) {
      if (!(await this.waitForDocumentGrammar(document))) return false;
      const version = document.version;
      const editor = document.editor;
      if (this.adapter.getDocumentProjection) {
        let projection;
        try {
          projection = await this.adapter.getDocumentProjection(editor, {
            uri: document.uri,
            signal: document.syncAbortController.signal,
          });
        } catch (error) {
          if (this.isCurrentDocument(document)) this.closeDocument(document.uri);
          throw error;
        }
        if (!this.isCurrentDocument(document)) return false;
        if (
          !projection ||
          typeof projection.text !== "string" ||
          typeof projection.isCurrent !== "function"
        ) {
          this.closeDocument(document.uri);
          throw new Error("Language server document projection is unavailable");
        }
        if (version !== document.version || editor !== document.editor || !projection.isCurrent())
          continue;
        document.projection = projection;
        this.projectedDocuments.add(document);
      }
      if (version === document.version) return true;
    }
    return false;
  }
  documentText(document) {
    if (document.temporary) return document.text;
    if (document.projection) {
      if (!document.projection.isCurrent()) throw new Projections.StaleProjectionError();
      return document.projection.text;
    }
    return this.transformDocumentText(document.editor.getText(), document.editor, document.uri);
  }
  requestDocumentSnapshots() {
    const snapshots = new Map();
    for (const document of [...this.documents.values(), ...this.temporaryDocuments.values()]) {
      const version = document.version;
      const source = document.editor?.getText();
      const text = this.documentText(document);
      snapshots.set(
        C.uriKey(document.uri),
        Object.freeze({
          uri: document.uri,
          text,
          version,
          isCurrent: () =>
            document.temporary
              ? this.temporaryDocuments.get(this.temporaryDocumentKey(document.uri)) === document &&
                document.version === version
              : this.isCurrentDocument(document) &&
                document.version === version &&
                document.editor.getText() === source &&
                (!document.projection || document.projection.isCurrent()),
        }),
      );
    }
    return snapshots;
  }
  async currentDocumentProjection(editor) {
    const uri = this.manager.uriForEditor(editor);
    const document = uri && this.documents.get(C.uriKey(uri));
    if (!document) return null;
    await this.waitForDocumentSync(document);
    if (!this.isCurrentDocument(document)) return null;
    if (this.needsDocumentTransform(editor) && !document.projection?.isCurrent?.()) {
      if (!(await this.prepareDocumentProjection(document))) return null;
    }
    return document.projection ?? null;
  }
  mapTextEdits(edits, editor, uri, projection = this.projectionForEditor(editor)) {
    if (!projection)
      return edits.map((edit) => ({
        ...edit,
        newText: this.restoreDocumentText(edit.newText, editor, uri),
      }));
    const mapped = projection.mapEdits(edits);
    if (!mapped) throw new Error("Language server edits touch protected or stale document text");
    return mapped;
  }
  responseProjection(result) {
    return result && typeof result === "object"
      ? (this.projectionResponses.get(result)?.projection ?? null)
      : null;
  }
  captureWorkspaceProjectionContext(edit, contexts = this.currentProjectionContexts()) {
    if (edit && typeof edit === "object") this.workspaceProjectionContexts.set(edit, contexts);
    return edit;
  }
  currentProjectionContexts() {
    return new Map(
      [...this.documents]
        .filter(([, document]) => document.projection)
        .map(([key, document]) => [key, { document, projection: document.projection }]),
    );
  }
  workspaceProjectionContext(edit, uri) {
    return this.workspaceProjectionContexts.get(edit)?.get(C.uriKey(uri));
  }
  isResponseCurrent(result) {
    const context = result && typeof result === "object" && this.projectionResponses.get(result);
    return (
      !context ||
      (this.isCurrentDocument(context.document) && context.projection?.isCurrent?.() !== false)
    );
  }
  rememberProjectionResponse(result, original, document, projection) {
    if (result && typeof result === "object" && projection)
      this.projectionResponses.set(result, { original, document, projection });
    return result;
  }
  async projectionForEdits(editor, uri) {
    if (!this.needsDocumentTransform(editor) || !this.adapter.getDocumentProjection) return null;
    const document = this.documents.get(C.uriKey(uri));
    if (document) return this.currentDocumentProjection(editor);
    if ((await editor.whenGrammarSettled?.()) === false)
      throw new Error("Language server document projection is unavailable");
    const projection = await this.adapter.getDocumentProjection(editor, { uri });
    if (!projection?.isCurrent?.())
      throw new Error("Language server document projection is unavailable");
    return projection;
  }
  async withTemporaryDocument(item, callback, { signal } = {}) {
    const previous = this.temporaryDocumentQueue;
    const queued = (async () => {
      await previous;
      return this.openTemporaryDocument(item, callback, { signal });
    })();
    const tail = queued.then(
      () => {},
      () => {},
    );
    this.temporaryDocumentQueue = tail;
    try {
      return await queued;
    } finally {
      if (this.temporaryDocumentQueue === tail) this.temporaryDocumentQueue = null;
    }
  }
  async openTemporaryDocument(item, callback, { signal } = {}) {
    if (this.state !== "running") throw new Error("Language server is not running");
    const key = this.temporaryDocumentKey(item.uri);
    if (this.temporaryDocuments.has(key) || (key === C.uriKey(item.uri) && this.documents.has(key)))
      throw new Error("Temporary language server URI is already open");
    this.temporaryDocumentUris.add(key);
    signal?.throwIfAborted();
    const document = {
      uri: item.uri,
      text: item.text,
      version: 1,
      temporary: true,
      wireOpen: false,
      subscriptions: new CompositeDisposable(),
    };
    this.temporaryDocuments.set(key, document);
    try {
      document.openPromise = this.connection.notify("textDocument/didOpen", {
        textDocument: { ...item, version: 1 },
      });
      await document.openPromise;
      document.wireOpen = true;
      signal?.throwIfAborted();
      return await callback(item.uri);
    } finally {
      if (this.temporaryDocuments.get(key) === document) {
        document.subscriptions.dispose();
        this.temporaryDocuments.delete(key);
        if (document.wireOpen && this.state === "running")
          await this.connection.notify("textDocument/didClose", {
            textDocument: { uri: item.uri },
          });
        if (!this.documents.size && this.state === "running") this.manager.didCloseDocument(this);
      }
    }
  }
  temporaryDocumentKey(uri) {
    try {
      const parsed = new URL(uri);
      return C.uriKey(uri) + parsed.search + parsed.hash;
    } catch {
      return C.uriKey(uri);
    }
  }
  isTemporaryDocumentUri(uri) {
    return this.temporaryDocumentUris.has(this.temporaryDocumentKey(uri));
  }
  mapCompletionItem(item, editor, uri, projection, previousItem) {
    if (!projection) return item;
    if (!projection.isCurrent()) return null;
    if (previousItem) {
      const previous = this.projectionResponses.get(previousItem);
      if (!previous || previous.projection !== projection || !this.isResponseCurrent(previousItem))
        return null;
      item = {
        ...previous.original,
        ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)),
      };
    }
    const edits = [];
    const edit = item.textEdit;
    if (edit?.range) edits.push({ oldRange: C.rangeFromLsp(edit.range), newText: edit.newText });
    else if (edit?.insert || edit?.replace) {
      for (const value of [edit.insert, edit.replace].filter(Boolean))
        if (!projection.mapEdits([{ oldRange: C.rangeFromLsp(value), newText: edit.newText }]))
          return null;
    }
    for (const extra of item.additionalTextEdits || [])
      edits.push({ oldRange: C.rangeFromLsp(extra.range), newText: extra.newText });
    const mapped = projection.mapEdits(edits);
    if (!mapped) return null;
    const next = { ...item };
    let index = 0;
    if (edit?.range) {
      const primary = mapped[index++];
      next.textEdit = {
        ...edit,
        range: C.rangeToLsp(Range.fromObject(primary.oldRange)),
        newText: primary.newText,
      };
    } else if (edit?.insert || edit?.replace) {
      next.textEdit = { ...edit };
      for (const key of ["insert", "replace"])
        if (edit[key]) next.textEdit[key] = Projections.fromServerRange(projection, edit[key]);
    }
    if (item.additionalTextEdits)
      next.additionalTextEdits = mapped.slice(index).map((entry) => ({
        range: C.rangeToLsp(Range.fromObject(entry.oldRange)),
        newText: entry.newText,
      }));
    const document = this.documents.get(C.uriKey(uri));
    return this.rememberProjectionResponse(next, item, document, projection);
  }
  canRenewCompletionResponse(result, editor, uri, projection) {
    const previous = this.projectionResponses.get(result);
    const document = this.documents.get(C.uriKey(uri));
    return (
      previous?.document === document &&
      document?.editor === editor &&
      this.isCurrentDocument(document) &&
      document.projection === projection &&
      projectionUsesOriginalText(previous?.projection) &&
      projectionUsesOriginalText(projection) &&
      projection.isCurrent()
    );
  }
  rememberCompletionResponse(result, editor, uri, projection) {
    const document = this.documents.get(C.uriKey(uri));
    return document?.editor === editor && document.projection === projection
      ? this.rememberProjectionResponse(result, result, document, projection)
      : null;
  }
  renewCompletionItem(item, editor, uri, projection, position, growth) {
    if (!this.canRenewCompletionResponse(item, editor, uri, projection)) return null;
    if (!projection.isPythonPosition([position.row, position.column + growth])) return null;
    const original = this.projectionResponses.get(item).original;
    const compare = (point) => point.line - position.row || point.character - position.column;
    const shift = (point, atCursor) =>
      point.line === position.row &&
      (point.character > position.column || (atCursor && point.character === position.column))
        ? { ...point, character: point.character + growth }
        : point;
    const primaryRange = (range) => {
      if (
        range.start.line !== position.row ||
        range.end.line !== position.row ||
        compare(range.start) > 0 ||
        compare(range.end) < 0
      )
        return null;
      return { start: shift(range.start, false), end: shift(range.end, true) };
    };
    const next = { ...original };
    if (original.textEdit) {
      next.textEdit = { ...original.textEdit };
      for (const key of ["range", "insert", "replace"]) {
        if (!original.textEdit[key]) continue;
        const range = primaryRange(original.textEdit[key]);
        if (!range) return null;
        next.textEdit[key] = range;
      }
    }
    if (original.additionalTextEdits) {
      next.additionalTextEdits = [];
      for (const edit of original.additionalTextEdits) {
        // An extra edit may move with text after the caret, but may not span
        // the newly typed prefix or insert at the same point as the primary.
        if (
          compare(edit.range.start) <= 0 &&
          (compare(edit.range.end) > 0 ||
            (compare(edit.range.start) === 0 && compare(edit.range.end) === 0))
        )
          return null;
        next.additionalTextEdits.push({
          ...edit,
          range: { start: shift(edit.range.start, true), end: shift(edit.range.end, false) },
        });
      }
    }
    return this.mapCompletionItem(next, editor, uri, projection);
  }
  isCurrentDocument(document) {
    return (
      !!document &&
      this.state === "running" &&
      (document.temporary
        ? this.temporaryDocuments.get(this.temporaryDocumentKey(document.uri))
        : this.documents.get(C.uriKey(document.uri))) === document &&
      !document.editor?.isDestroyed?.()
    );
  }
  async waitForDocumentGrammar(document) {
    while (this.isCurrentDocument(document)) {
      const version = document.version;
      const settled = await document.editor.whenGrammarSettled?.({
        signal: document.syncAbortController.signal,
      });
      if (!this.isCurrentDocument(document)) return false;
      if (settled === false) {
        // A failed parse cannot supply a trustworthy projection. Withdraw the
        // document so the next request can reopen it after grammar recovery.
        this.closeDocument(document.uri);
        return false;
      }
      if (document.version === version) return true;
    }
    return false;
  }
  restoreDocumentText(text, editor, uri) {
    return this.adapter.restoreDocumentText?.(text, { editor, uri }) ?? text;
  }
  // A document is only open while an editor holds it, so a report that outlives
  // one — or names a related document nobody opened — passes the editor as
  // undefined rather than skipping the hook.
  transformDiagnostics(diagnostics, uri, document) {
    const mapped = Projections.mapDiagnostics(document?.projection, diagnostics);
    for (const diagnostic of mapped) {
      if (diagnostic.relatedInformation)
        diagnostic.relatedInformation = diagnostic.relatedInformation.flatMap((item) => {
          const owner = this.documents.get(C.uriKey(item.location.uri))?.projection;
          const range = Projections.fromServerRange(owner, item.location.range);
          return range ? [{ ...item, location: { ...item.location, range } }] : [];
        });
    }
    return (
      this.adapter.transformDiagnostics?.(mapped, {
        editor: document?.editor,
        uri,
        session: this,
      }) ?? mapped
    );
  }
  textDocumentSyncOptions() {
    const declared = this.capabilities.textDocumentSync;
    if (typeof declared === "number") {
      return {
        openClose: declared !== 0,
        change: declared,
        save: false,
        includeText: false,
      };
    }
    const save = declared && typeof declared === "object" ? declared.save : false;
    return {
      openClose: !!declared?.openClose,
      change: declared?.change ?? 0,
      save: save === true || !!(save && typeof save === "object"),
      includeText: !!(save && typeof save === "object" && save.includeText),
    };
  }
  // True when the session can serve the given request method for the editor.
  // A feature its adapter has switched off is refused before the capability is
  // consulted, so a disabled server is never asked. `feature` names it
  // explicitly for the requests that serve more than one — see METHOD_FEATURES.
  // Dynamic registrations take precedence over the static server capability.
  supports(method, editor, feature = METHOD_FEATURES[method]) {
    if (!featureEnabled(this.adapter, feature, editor)) return false;
    if (method === "workspace/diagnostic")
      return this.diagnosticProviders(editor).some(({ options }) => options.workspaceDiagnostics);
    const dynamic = this.manager.dynamicSupport(this, method, editor);
    if (dynamic === true) return true;
    const field = STATIC_CAPABILITIES[method];
    if (dynamic === false) return field ? !!this.capabilities[field] : false;
    return field ? !!this.capabilities[field] : true;
  }
  // The options a capability was declared with — a semantic-token legend, the
  // characters that trigger completion or signature help, whether a rename can
  // be prepared. `supports()` answers whether a method is served; this answers
  // how, and has to look in the same two places.
  //
  // A server that registers dynamically declares nothing statically, so reading
  // `capabilities` alone finds an empty object: Tinymist registers its semantic
  // tokens that way, and the legend was missed entirely, which left the feature
  // silently doing nothing for it.
  capabilityOptions(method, editor) {
    const dynamic = this.manager.dynamicOptions(this, method, editor);
    if (dynamic) return dynamic;
    const field = STATIC_CAPABILITIES[method];
    const declared = field ? this.capabilities[field] : undefined;
    // `true` is a valid way to say "served, with no options to speak of".
    return declared && typeof declared === "object" ? declared : undefined;
  }
  canExecuteCommand(command, editor) {
    if (!command || typeof command !== "string") return false;
    const staticCommands = this.capabilities.executeCommandProvider?.commands;
    if (Array.isArray(staticCommands) && staticCommands.includes(command)) return true;
    for (const registration of this.manager.dynamicCapabilities?.get(this)?.values() || []) {
      if (registration.method !== "workspace/executeCommand") continue;
      const options = registration.registerOptions;
      if (
        options?.documentSelector &&
        !this.manager.selectorMatches(options.documentSelector, this, editor)
      )
        continue;
      if (Array.isArray(options?.commands) && options.commands.includes(command)) return true;
    }
    return false;
  }
  installClientHandlers() {
    this.connection.onError((error) => {
      this.manager.log(this, error.stack || error.message);
      this.failSession(error);
    });
    this.subscriptions.add(this.connection.onClose(() => this.onConnectionClose()));
    this.connection.onOtherNotification((method, params) => {
      try {
        const handled = this.adapter.handleServerNotification?.(method, params, { session: this });
        handled?.catch?.((error) => this.manager.log(this, error.stack || error.message));
      } catch (error) {
        this.manager.log(this, error.stack || error.message);
      }
      this.emitter.emit("notification", { session: this, method, params });
    });
    this.connection.onNotification("textDocument/publishDiagnostics", (params) =>
      this.manager.publishDiagnostics(this, params),
    );
    this.connection.onNotification("window/logMessage", ({ message }) =>
      this.manager.log(this, message),
    );
    this.connection.onNotification("window/showMessage", ({ type, message }) =>
      this.manager.showMessage(type, message, this),
    );
    this.connection.onNotification("$/progress", (params) => {
      const partial = this.partialResults.get(params.token);
      if (partial) partial(params.value);
      else this.manager.handleProgress(this, params);
    });
    this.connection.onRequest("workspace/configuration", (params) =>
      Promise.all(
        params.items.map(
          (item) =>
            this.adapter.getWorkspaceConfiguration?.(item.section, item.scopeUri) ??
            lumine.config.get(item.section),
        ),
      ),
    );
    this.connection.onRequest("workspace/applyEdit", ({ edit, label }) =>
      this.manager.applyWorkspaceEditDetailed(
        this.captureWorkspaceProjectionContext(edit),
        label,
        this,
      ),
    );
    this.connection.onRequest("workspace/workspaceFolders", () =>
      this.manager.workspaceFolders(this),
    );
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("client/registerCapability", (params) => {
      this.manager.registerCapabilities(this, params.registrations);
      return null;
    });
    this.connection.onRequest("client/unregisterCapability", (params) => {
      this.manager.unregisterCapabilities(this, params.unregisterations || params.unregistrations);
      return null;
    });
    this.connection.onRequest("window/showMessageRequest", ({ type, message, actions = [] }) =>
      this.manager.showMessageRequest(type, message, actions, this),
    );
    this.connection.onRequest("window/showDocument", (params) => this.manager.showDocument(params));
    // Server-initiated refresh requests: acknowledge with null and let the
    // manager route them to the feature modules that hold the stale data.
    for (const [method, kind] of [
      ["workspace/codeLens/refresh", "codeLens"],
      ["workspace/semanticTokens/refresh", "semanticTokens"],
      ["workspace/inlayHint/refresh", "inlayHint"],
    ]) {
      this.connection.onRequest(method, () => {
        this.manager.requestRefresh(this, kind);
        return null;
      });
    }
    this.connection.onRequest("workspace/diagnostic/refresh", () => {
      this.refreshDiagnostics();
      return null;
    });
    if (this.adapter.handleServerRequest) {
      this.connection.onOtherRequest((method, params) =>
        this.adapter.handleServerRequest(method, params, { session: this }),
      );
    }
  }
  // Keyed by `uriKey` so a server's own spelling of the same file finds this
  // entry; `document.uri` keeps the spelling this client sends on the wire.
  async openEditor(editor) {
    if (this.state !== "running") return;
    // A cell editor is synced through the notebookDocument notifications; a
    // misrouted call here would double-open it as a plain text document.
    if (this.manager.externalDocuments?.has(editor)) return;
    const uri = this.manager.uriForEditor(editor);
    if (!uri) return;
    const key = C.uriKey(uri);
    const existing = this.documents.get(key);
    // A feature request can join the manager's ordinary attachment while the
    // didOpen frame is still being written. Merely seeing the document in the
    // map is not enough: requests about it must remain ordered after didOpen.
    if (existing) return existing.openPromise;
    const sync = this.textDocumentSyncOptions();
    const document = {
      editor,
      uri,
      version: 1,
      wireOpen: false,
      subscriptions: new CompositeDisposable(),
    };
    if (this.needsDocumentTransform(editor)) document.syncAbortController = new AbortController();
    this.documents.set(key, document);
    document.openPromise = (async () => {
      if (!(await this.prepareDocumentProjection(document))) return;
      if (!this.isCurrentDocument(document) || !sync.openClose) return;
      document.wireOpen = true;
      document.wireProjection = document.projection;
      document.wireSourceVersion = document.version;
      await this.connection.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdForEditor(this.adapter, editor),
          version: 1,
          text: this.documentText(document),
        },
      });
    })();
    this.scheduleDiagnostics(document, 0);
    if (sync.change !== 0)
      document.subscriptions.add(
        editor.getBuffer().onDidChangeText((event) => this.changeDocument(document, event)),
      );
    if (sync.save)
      document.subscriptions.add(
        editor.onDidSave(() => {
          this.saveDocument(document, sync).catch((error) =>
            this.manager.log(this, `Unable to synchronize saved document: ${error.message}`),
          );
        }),
      );
    document.subscriptions.add(editor.onDidDestroy(() => this.closeDocument(uri)));
    await document.openPromise;
  }
  changeDocument(document, event) {
    if (this.state !== "running") return;
    const sync = this.textDocumentSyncOptions().change;
    if (sync === 0) return;
    document.version++;
    if (this.needsDocumentTransform(document.editor) || document.projection) {
      if (sync === 2) {
        document.pendingProjectionChanges ??= [];
        document.pendingProjectionChanges.push({
          version: document.version,
          changes: event.changes.toReversed().map((change) => ({
            range: C.rangeToLsp(change.oldRange),
            rangeLength: change.oldText?.length,
            text: change.newText,
          })),
        });
      }
      document.changePending = true;
      this.queueDocumentChanges(document);
      return;
    }
    const contentChanges =
      sync === 1
        ? [
            {
              text: this.transformDocumentText(
                document.editor.getText(),
                document.editor,
                document.uri,
              ),
            },
          ]
        : // TextBuffer reports every oldRange against the document before the
          // transaction, while LSP applies contentChanges sequentially. Sending
          // the highest change first keeps edits below it from shifting its
          // range. This is especially important for multi-hunk reloads after an
          // external tool rewrites a file.
          event.changes.toReversed().map((change) => ({
            range: C.rangeToLsp(change.oldRange),
            rangeLength: change.oldText?.length,
            text: change.newText,
          }));
    this.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges,
    });
    this.scheduleDiagnostics(document);
    this.scheduleWorkspaceDiagnostics();
  }

  // A transform may read injected language ranges. Wait for the grammar before
  // reading its source and combine pending edits into one update. Original
  // ranges remain valid when both wire snapshots explicitly use original text;
  // any actual transform or transition needs a full update. Requests share this
  // synchronization regardless of which representation reaches the server.
  queueDocumentChanges(document) {
    if (document.syncPromise) return;
    const pending = this.synchronizeDocumentChanges(document)
      .catch((error) => {
        document.changePending = false;
        this.manager.log(this, `Unable to synchronize document: ${error.message}`);
      })
      .finally(() => {
        if (document.syncPromise !== pending) return;
        document.syncPromise = null;
        if (document.changePending && this.isCurrentDocument(document))
          this.queueDocumentChanges(document);
      });
    document.syncPromise = pending;
  }
  async synchronizeDocumentChanges(document) {
    await document.openPromise;
    while (document.changePending && this.isCurrentDocument(document)) {
      if (!(await this.prepareDocumentProjection(document))) {
        document.changePending = false;
        return;
      }
      const version = document.version;
      const projection = document.projection;
      const pending = document.pendingProjectionChanges || [];
      const unapplied = pending.filter(
        (entry) => entry.version > document.wireSourceVersion && entry.version <= version,
      );
      const useOriginalRanges =
        this.textDocumentSyncOptions().change === 2 &&
        projectionUsesOriginalText(document.wireProjection) &&
        projectionUsesOriginalText(projection) &&
        unapplied.length > 0 &&
        unapplied.length === version - document.wireSourceVersion &&
        unapplied.every((entry, index) => entry.version === document.wireSourceVersion + index + 1);
      const contentChanges = useOriginalRanges
        ? unapplied.flatMap((entry) => entry.changes)
        : [{ text: this.documentText(document) }];
      document.pendingProjectionChanges = pending.filter((entry) => entry.version > version);
      document.changePending = false;
      await this.connection.notify("textDocument/didChange", {
        textDocument: { uri: document.uri, version },
        contentChanges,
      });
      if (!this.isCurrentDocument(document)) return;
      document.wireProjection = projection;
      document.wireSourceVersion = version;
      this.scheduleDiagnostics(document);
      this.scheduleWorkspaceDiagnostics();
    }
  }
  async waitForDocumentSync(document, signal) {
    signal?.throwIfAborted();
    const synchronized = (async () => {
      await document.openPromise;
      while (document.syncPromise) await document.syncPromise;
    })();
    if (!signal) return synchronized;
    let onAbort;
    try {
      await Promise.race([
        synchronized,
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  async saveDocument(document, sync) {
    if (this.needsDocumentTransform(document.editor) || document.projection) {
      await this.waitForDocumentSync(document);
      if (!(await this.prepareDocumentProjection(document))) return;
    }
    if (!this.isCurrentDocument(document)) return;
    const params = { textDocument: { uri: document.uri } };
    if (sync.includeText) params.text = this.documentText(document);
    this.notify("textDocument/didSave", params);
  }

  scheduleDiagnostics(document, delay = DIAGNOSTIC_DEBOUNCE_MS) {
    const key = C.uriKey(document.uri);
    // Notebook cells are never pulled: their diagnostics ride the notebook
    // push channel, and a server can answer a cell pull with an empty full
    // report that contradicts its own pushes — ruff does, wiping the cell's
    // messages the moment typing pauses.
    if (
      this.state !== "running" ||
      document.notebook ||
      !this.supports("textDocument/diagnostic", document.editor)
    ) {
      clearTimeout(this.diagnosticTimers.get(key));
      this.diagnosticTimers.delete(key);
      return;
    }
    clearTimeout(this.diagnosticTimers.get(key));
    this.diagnosticTimers.set(
      key,
      setTimeout(() => {
        this.diagnosticTimers.delete(key);
        this.pullDiagnostics(document);
      }, delay),
    );
  }

  refreshDiagnostics() {
    if (this.state !== "running") return;
    for (const document of this.documents.values()) this.scheduleDiagnostics(document, 0);
    this.scheduleWorkspaceDiagnostics(0);
  }

  // Each registration owns an independent diagnostic source and result-id
  // stream. Dynamic registrations govern the method even when none matches
  // this editor. A separately advertised static source remains independent;
  // only an identical identifier and selector make it the same source.
  diagnosticProviders(editor) {
    const registrations = [...(this.manager.dynamicCapabilities?.get(this)?.values() || [])].filter(
      (item) => item.method === "textDocument/diagnostic",
    );
    const matching = registrations
      .filter(
        (item) =>
          !editor ||
          !item.registerOptions?.documentSelector ||
          this.manager.selectorMatches(item.registerOptions.documentSelector, this, editor),
      )
      .map((item) => ({
        key: `dynamic:${item.id}`,
        options: item.registerOptions || {},
        fingerprint: JSON.stringify(item.registerOptions || {}),
      }));
    const declared = this.capabilities.diagnosticProvider;
    if (!declared) return matching;
    const options = typeof declared === "object" ? declared : {};
    if (
      editor &&
      options.documentSelector &&
      !this.manager.selectorMatches(options.documentSelector, this, editor)
    )
      return matching;
    if (
      matching.some(
        ({ options: dynamic }) =>
          dynamic.identifier === options.identifier &&
          JSON.stringify(dynamic.documentSelector ?? null) ===
            JSON.stringify(options.documentSelector ?? null),
      )
    )
      return matching;
    return [...matching, { key: "static", options, fingerprint: JSON.stringify(options) }];
  }

  rememberDiagnosticProviders(providers) {
    for (const provider of providers)
      if (!this.diagnosticProviderDefinitions.has(provider.key))
        this.diagnosticProviderDefinitions.set(provider.key, provider.fingerprint);
  }

  diagnosticReportIsCurrent(uri, version) {
    const document = this.documents.get(C.uriKey(uri));
    if (document?.temporary || this.isTemporaryDocumentUri(uri)) return false;
    if (version == null || !document) return true;
    return document.notebook
      ? [
          document.version,
          document.notebook.versionFor?.(this) ?? document.notebook.version,
        ].includes(version)
      : version === document.version;
  }

  // A workspace and a document request have separate result IDs, while a
  // document report is authoritative for that provider's open document. This
  // prevents a delayed workspace report from restoring an already fixed error.
  publishCollectedDiagnostics(uri, version) {
    const record = this.diagnosticReports.get(C.uriKey(uri));
    const open = this.documents.has(C.uriKey(uri));
    const diagnostics = [];
    const seen = new Set();
    for (const source of record?.sources.values() || []) {
      const report =
        source.push ||
        (open && source.document ? source.document : source.workspace || source.document);
      if (!report || !this.diagnosticReportIsCurrent(uri, report.version)) continue;
      const sourceKeys = new Set();
      for (const item of report.items) {
        const key = JSON.stringify(item);
        if (seen.has(key)) continue;
        sourceKeys.add(key);
        // Mapping related information can replace fields in diagnostics. Raw
        // provider caches must survive another provider's unchanged response.
        diagnostics.push(structuredClone(item));
      }
      for (const key of sourceKeys) seen.add(key);
    }
    return this.manager.publishDiagnostics(this, { uri, version, diagnostics }, true);
  }

  cacheDiagnosticReport(uri, report, version, providerKey, channel) {
    if (
      !report ||
      !["full", "unchanged"].includes(report.kind) ||
      !this.diagnosticReportIsCurrent(uri, version)
    )
      return false;
    const key = C.uriKey(uri);
    const record = this.diagnosticReports.get(key) || { uri, sources: new Map() };
    const source = record.sources.get(providerKey) || {};
    if (report.kind === "unchanged") {
      if (!source[channel]) return false;
      source[channel] = { ...source[channel], version };
    } else source[channel] = { version, items: Array.isArray(report.items) ? report.items : [] };
    record.uri = uri;
    record.sources.set(providerKey, source);
    this.diagnosticReports.set(key, record);
    return true;
  }
  diagnosticReportChanges(uri, report, version, providerKey, channel) {
    if (report?.kind !== "unchanged") return true;
    const cached = this.diagnosticReports.get(C.uriKey(uri))?.sources.get(providerKey)?.[channel];
    return !cached || (cached.version ?? null) !== (version ?? null);
  }

  publishPushedDiagnostics(params) {
    if (
      !this.cacheDiagnosticReport(
        params.uri,
        { kind: "full", items: params.diagnostics },
        params.version,
        "push",
        "push",
      )
    )
      return false;
    return this.publishCollectedDiagnostics(params.uri, params.version);
  }

  // Kept as the common report entry point for direct callers. Pull batches use
  // the cache primitive and publish once after all of their providers settle.
  publishDiagnosticReport(uri, report, version, providerKey = "static", channel = "document") {
    if (!this.cacheDiagnosticReport(uri, report, version, providerKey, channel)) return false;
    return this.publishCollectedDiagnostics(uri, version);
  }

  clearDiagnosticReportsForUri(uri) {
    const key = C.uriKey(uri);
    this.diagnosticReports.delete(key);
    for (const state of this.workspaceDiagnosticStates.values()) state.resultIds.delete(key);
    this.rebuildWorkspaceDiagnosticResultIds();
  }

  // In-flight results cannot cross a registration change. Unchanged sources
  // keep their caches and IDs; replacing or withdrawing a source removes only
  // its reports and cancels its old workspace subscription.
  resetDiagnosticPullState(registrationIds = []) {
    this.diagnosticGeneration++;
    for (const timer of this.diagnosticTimers.values()) clearTimeout(timer);
    this.diagnosticTimers.clear();
    clearTimeout(this.workspaceDiagnosticTimer);
    this.workspaceDiagnosticTimer = null;
    const definitions = new Map(
      this.diagnosticProviders().map((provider) => [provider.key, provider.fingerprint]),
    );
    const removed = new Set(
      [...this.diagnosticProviderDefinitions]
        .filter(([key, value]) => definitions.get(key) !== value)
        .map(([key]) => key),
    );
    for (const id of registrationIds) removed.add(`dynamic:${id}`);
    this.diagnosticProviderDefinitions = definitions;
    const touched = [];
    for (const record of this.diagnosticReports.values()) {
      let changed = false;
      for (const key of removed) changed = record.sources.delete(key) || changed;
      if (changed) touched.push(record.uri);
    }
    for (const document of this.documents.values()) {
      document.diagnosticAbortController?.abort();
      for (const key of removed) document.diagnosticResultIds?.delete(key);
      delete document.diagnosticResultId;
    }
    for (const [key, state] of this.workspaceDiagnosticStates) {
      state.queued = false;
      state.controller?.abort();
      if (removed.has(key)) this.workspaceDiagnosticStates.delete(key);
    }
    this.rebuildWorkspaceDiagnosticResultIds();
    for (const uri of touched) this.publishCollectedDiagnostics(uri);
    this.refreshDiagnostics();
  }

  supportsWorkspaceDiagnostics() {
    return (
      this.state === "running" &&
      this.diagnosticProviders().some(({ options }) => options.workspaceDiagnostics) &&
      this.manager.featureEnabledForAdapter(this.adapter, "diagnostics")
    );
  }

  scheduleWorkspaceDiagnostics(delay = DIAGNOSTIC_DEBOUNCE_MS) {
    clearTimeout(this.workspaceDiagnosticTimer);
    this.workspaceDiagnosticTimer = null;
    if (!this.supportsWorkspaceDiagnostics()) {
      for (const state of this.workspaceDiagnosticStates.values()) {
        state.queued = false;
        state.controller?.abort();
      }
      return;
    }
    this.workspaceDiagnosticTimer = setTimeout(() => {
      this.workspaceDiagnosticTimer = null;
      this.pullWorkspaceDiagnostics();
    }, delay);
  }

  workspaceDiagnosticState(providerKey = "static") {
    let state = this.workspaceDiagnosticStates.get(providerKey);
    if (!state) {
      state = {
        key: providerKey,
        resultIds: new Map(),
        promise: null,
        queued: false,
        controller: null,
      };
      this.workspaceDiagnosticStates.set(providerKey, state);
    }
    return state;
  }

  rebuildWorkspaceDiagnosticResultIds() {
    this.workspaceDiagnosticResultIds.clear();
    for (const state of this.workspaceDiagnosticStates.values())
      for (const [uri, result] of state.resultIds)
        this.workspaceDiagnosticResultIds.set(`${state.key}:${uri}`, result);
  }

  processWorkspaceDiagnosticItems(items, providerKey = "static") {
    const state = this.workspaceDiagnosticState(providerKey);
    const touched = new Map();
    let accepted = false;
    for (const report of items || []) {
      const changed =
        report?.uri &&
        this.diagnosticReportChanges(report.uri, report, report.version, providerKey, "workspace");
      if (
        !report?.uri ||
        !this.cacheDiagnosticReport(report.uri, report, report.version, providerKey, "workspace")
      )
        continue;
      accepted = true;
      const key = C.uriKey(report.uri);
      if (report.resultId) state.resultIds.set(key, { uri: report.uri, value: report.resultId });
      else if (report.kind === "full") state.resultIds.delete(key);
      if (changed) touched.set(key, { uri: report.uri, version: report.version });
    }
    if (accepted) this.rebuildWorkspaceDiagnosticResultIds();
    for (const { uri, version } of touched.values()) this.publishCollectedDiagnostics(uri, version);
  }

  previousWorkspaceDiagnosticResultIds(providerKey) {
    return providerKey === undefined
      ? [...this.workspaceDiagnosticResultIds.values()]
      : [...(this.workspaceDiagnosticStates.get(providerKey)?.resultIds.values() || [])];
  }

  async pullWorkspaceDiagnosticProvider(provider) {
    const state = this.workspaceDiagnosticState(provider.key);
    if (state.promise) {
      state.queued = true;
      return state.promise;
    }
    const token = `ide-client-workspace-diagnostic-${++this.partialResultCounter}`;
    const generation = this.diagnosticGeneration;
    const controller = new AbortController();
    state.controller = controller;
    const params = {
      previousResultIds: this.previousWorkspaceDiagnosticResultIds(provider.key),
      partialResultToken: token,
    };
    if (provider.options.identifier !== undefined) params.identifier = provider.options.identifier;
    const current = () =>
      this.state === "running" &&
      generation === this.diagnosticGeneration &&
      this.workspaceDiagnosticStates.get(provider.key) === state &&
      !controller.signal.aborted &&
      this.supportsWorkspaceDiagnostics();
    this.partialResults.set(token, (partial) => {
      if (current()) this.processWorkspaceDiagnosticItems(partial?.items, provider.key);
    });
    const pending = (async () => {
      try {
        const report = await this.request("workspace/diagnostic", params, {
          signal: controller.signal,
          diagnosticProvider: provider.options,
        });
        if (current()) this.processWorkspaceDiagnosticItems(report?.items, provider.key);
      } catch (error) {
        if (current())
          this.manager.log(this, `Unable to pull workspace diagnostics: ${error.message}`);
      } finally {
        this.partialResults.delete(token);
      }
    })();
    state.promise = pending;
    try {
      await pending;
    } finally {
      if (state.promise === pending) {
        state.promise = null;
        state.controller = null;
      }
      if (state.queued && this.workspaceDiagnosticStates.get(provider.key) === state) {
        state.queued = false;
        this.scheduleWorkspaceDiagnostics(0);
      }
    }
  }

  async pullWorkspaceDiagnostics() {
    if (!this.supportsWorkspaceDiagnostics()) return;
    const providers = this.diagnosticProviders().filter(
      ({ options }) => options.workspaceDiagnostics,
    );
    this.rememberDiagnosticProviders(providers);
    const pending = Promise.all(
      providers.map((provider) => this.pullWorkspaceDiagnosticProvider(provider)),
    );
    this.workspaceDiagnosticPromise = pending;
    try {
      await pending;
    } finally {
      if (this.workspaceDiagnosticPromise === pending) this.workspaceDiagnosticPromise = null;
    }
  }

  async pullDiagnostics(document) {
    if (
      this.state !== "running" ||
      document.notebook ||
      !this.documents.has(C.uriKey(document.uri)) ||
      !this.supports("textDocument/diagnostic", document.editor)
    )
      return;
    const providers = this.diagnosticProviders(document.editor);
    this.rememberDiagnosticProviders(providers);
    const version = document.version;
    const generation = this.diagnosticGeneration;
    const sequence = (document.diagnosticPullSequence = (document.diagnosticPullSequence || 0) + 1);
    document.diagnosticAbortController?.abort();
    const controller = new AbortController();
    document.diagnosticAbortController = controller;
    const versions = new Map(
      [...this.documents].map(([key, owner]) => [
        key,
        { owner, version: owner.version, projection: owner.projection },
      ]),
    );
    // Full and unchanged document reports replace this immutable cache entry.
    // Capture each provider's accepted report independently: a delayed related
    // response must not overwrite a newer target report, while a pending or
    // failed target request has no accepted result to supersede it.
    const relatedReports = new Map(
      [...this.diagnosticReports].map(([key, record]) => [
        key,
        new Map([...record.sources].map(([provider, source]) => [provider, source.document])),
      ]),
    );
    const resultIds = (document.diagnosticResultIds ||= new Map());
    const results = await Promise.all(
      providers.map(async (provider) => {
        const params = { textDocument: { uri: document.uri } };
        if (provider.options.identifier !== undefined)
          params.identifier = provider.options.identifier;
        const previous = resultIds.get(provider.key);
        if (previous) params.previousResultId = previous;
        try {
          return {
            provider,
            report: await this.request("textDocument/diagnostic", params, {
              signal: controller.signal,
              diagnosticProvider: provider.options,
            }),
          };
        } catch (error) {
          if (!controller.signal.aborted && this.state === "running")
            this.manager.log(this, `Unable to pull diagnostics: ${error.message}`);
          return { provider };
        }
      }),
    );
    if (document.diagnosticAbortController === controller)
      document.diagnosticAbortController = null;
    if (
      controller.signal.aborted ||
      this.state !== "running" ||
      this.documents.get(C.uriKey(document.uri)) !== document ||
      document.version !== version ||
      this.diagnosticGeneration !== generation ||
      document.diagnosticPullSequence !== sequence
    )
      return;
    const touched = new Map();
    for (const { provider, report } of results) {
      const changed = this.diagnosticReportChanges(
        document.uri,
        report,
        version,
        provider.key,
        "document",
      );
      if (this.cacheDiagnosticReport(document.uri, report, version, provider.key, "document")) {
        if (report.resultId) resultIds.set(provider.key, report.resultId);
        else if (report.kind === "full") resultIds.delete(provider.key);
        if (changed) touched.set(C.uriKey(document.uri), { uri: document.uri, version });
      }
      for (const [uri, related] of Object.entries(report?.relatedDocuments || {})) {
        const key = C.uriKey(uri);
        const owner = this.documents.get(key);
        const snapshot = versions.get(key);
        if (
          owner !== snapshot?.owner ||
          (owner &&
            (owner.version !== snapshot.version || owner.projection !== snapshot.projection)) ||
          this.diagnosticReports.get(key)?.sources.get(provider.key)?.document !==
            relatedReports.get(key)?.get(provider.key)
        )
          continue;
        const relatedChanged = this.diagnosticReportChanges(
          uri,
          related,
          owner?.version,
          provider.key,
          "document",
        );
        if (
          this.cacheDiagnosticReport(uri, related, owner?.version, provider.key, "document") &&
          relatedChanged
        )
          touched.set(C.uriKey(uri), { uri, version: owner?.version });
      }
    }
    if (providers.length === 1) document.diagnosticResultId = resultIds.get(providers[0].key);
    else delete document.diagnosticResultId;
    for (const { uri, version: snapshot } of touched.values())
      this.publishCollectedDiagnostics(uri, snapshot);
  }

  disposeDiagnosticPullState() {
    this.diagnosticGeneration++;
    for (const document of this.documents.values()) document.diagnosticAbortController?.abort();
    for (const state of this.workspaceDiagnosticStates.values()) state.controller?.abort();
    this.workspaceDiagnosticStates.clear();
    this.diagnosticReports.clear();
    this.diagnosticProviderDefinitions.clear();
    this.workspaceDiagnosticResultIds.clear();
  }

  detachEditor(editor) {
    // Notebook cell documents are owned by the notebook module; routing one
    // through closeDocument would emit a protocol-violating textDocument/didClose.
    for (const document of [...this.documents.values()])
      if (document.editor === editor && !document.notebook) this.closeDocument(document.uri);
  }
  closeDocument(uri) {
    const doc = this.documents.get(C.uriKey(uri));
    if (!doc) return;
    doc.syncAbortController?.abort();
    doc.projection = null;
    doc.wireProjection = null;
    doc.pendingProjectionChanges = null;
    this.projectedDocuments.delete(doc);
    doc.subscriptions.dispose();
    const key = C.uriKey(doc.uri);
    clearTimeout(this.diagnosticTimers.get(key));
    this.diagnosticTimers.delete(key);
    // Dynamic pull providers are not reflected in ServerCapabilities. Clear
    // their last report on close just as we do for a static provider, while
    // deliberately bypassing the feature switch: a hidden stored report must
    // not survive the document that owned it.
    doc.diagnosticAbortController?.abort();
    if (this.supports("textDocument/diagnostic", doc.editor, null)) {
      this.clearDiagnosticReportsForUri(doc.uri);
      this.manager.publishDiagnostics(
        this,
        {
          uri: doc.uri,
          version: doc.version,
          diagnostics: [],
        },
        true,
      );
    }
    this.documents.delete(C.uriKey(uri));
    // Closed under the spelling it was opened with, whoever asked for it.
    if (doc.wireOpen) this.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
    if (!this.documents.size && this.state === "running") this.manager.didCloseDocument(this);
  }
  // An explicit `cancelOnServer` still wins, for a caller that knows better.
  async request(method, params, options) {
    if (this.state !== "running")
      return Promise.reject(new Error("Language server is not running"));
    const remembered =
      params &&
      typeof params === "object" &&
      (this.projectionResponses.get(params) || this.projectionResponses.get(params.item));
    const document = params?.textDocument?.uri
      ? (this.temporaryDocuments.size &&
          this.temporaryDocuments.get(this.temporaryDocumentKey(params.textDocument.uri))) ||
        this.documents.get(C.uriKey(params.textDocument.uri))
      : (remembered?.document ?? null);
    if (
      (this.adapter.getDocumentProjection || this.adapter.transformDocumentText) &&
      params?.textDocument?.uri &&
      !document
    )
      throw new Error("Language server document is closed");
    if (
      document &&
      !document.temporary &&
      (this.adapter.prepareRequest ||
        this.needsDocumentTransform(document.editor) ||
        document.projection)
    ) {
      await this.waitForDocumentSync(document, options?.signal);
      if (!this.isCurrentDocument(document)) throw new Error("Language server document is closed");
    }
    if (this.state !== "running") throw new Error("Language server is not running");
    const projection = remembered?.projection ?? document?.projection;
    if (remembered && !this.isResponseCurrent(params.item || params))
      throw new Projections.StaleProjectionError();
    let outbound;
    try {
      outbound = remembered
        ? params.item
          ? { ...params, item: remembered.original }
          : remembered.original
        : Projections.toServerParams(projection, params);
    } catch (error) {
      if (error.code === "PROJECTION_POSITION_EXCLUDED") return Projections.emptyResult(method);
      throw error;
    }
    if (method === "textDocument/rename" && this.adapter.resolveRenameTarget) {
      if (projection && projection.isIdentity !== true)
        throw new Error("Canonical rename targets require an identity document projection.");
      const sourceVersion = document?.version;
      const target = await this.adapter.resolveRenameTarget(
        { uri: outbound.textDocument.uri, position: outbound.position },
        { session: this, editor: document?.editor, signal: options?.signal },
      );
      if (options?.signal?.aborted)
        throw options.signal.reason || new Error("Rename target lookup was cancelled.");
      if (document && (!this.isCurrentDocument(document) || document.version !== sourceVersion))
        throw new Projections.StaleProjectionError();
      if (target === null) return null;
      if (target !== undefined) {
        if (
          typeof target.uri !== "string" ||
          !Number.isInteger(target.position?.line) ||
          target.position.line < 0 ||
          !Number.isInteger(target.position?.character) ||
          target.position.character < 0
        )
          throw new Error("The adapter returned an invalid rename target.");
        const targetDocument = this.documents.get(C.uriKey(target.uri));
        if (targetDocument?.projection && targetDocument.projection.isIdentity !== true)
          throw new Error("Canonical rename targets cannot enter a projected document.");
        outbound = {
          ...outbound,
          textDocument: { ...outbound.textDocument, uri: target.uri },
          position: target.position,
        };
      }
    }
    const workspaceContexts = [
      "textDocument/rename",
      "textDocument/codeAction",
      "codeAction/resolve",
      "workspace/willCreateFiles",
      "workspace/willRenameFiles",
      "workspace/willDeleteFiles",
    ].includes(method)
      ? this.currentProjectionContexts()
      : null;
    const crossDocumentRead = [
      "workspace/symbol",
      "textDocument/definition",
      "textDocument/declaration",
      "textDocument/typeDefinition",
      "textDocument/implementation",
      "textDocument/references",
      "callHierarchy/incomingCalls",
      "callHierarchy/outgoingCalls",
    ].includes(method);
    const readContexts =
      crossDocumentRead && this.projectedDocuments.size ? this.currentProjectionContexts() : null;
    let prepared;
    const touched = new Set();
    if (this.adapter.prepareRequest) {
      const snapshots = this.requestDocumentSnapshots();
      prepared = await this.adapter.prepareRequest(method, outbound, {
        session: this,
        editor: document?.editor,
        signal: options?.signal,
        getDocument: (uri) => {
          const snapshot = snapshots.get(C.uriKey(uri));
          if (snapshot) touched.add(snapshot);
          return snapshot ?? null;
        },
      });
      if (
        prepared != null &&
        (typeof prepared !== "object" ||
          (prepared.mapResult != null && typeof prepared.mapResult !== "function"))
      )
        throw new TypeError("The adapter returned an invalid prepared request.");
    }
    const guardPrepared = () => {
      if (options?.signal?.aborted)
        throw options.signal.reason || new Error("Request preparation was cancelled.");
      if (this.state !== "running") throw new Error("Language server is not running");
      if ([...touched].some((snapshot) => !snapshot.isCurrent()))
        throw new Projections.StaleProjectionError();
    };
    if (this.adapter.prepareRequest) guardPrepared();
    const wireParams = prepared && Object.hasOwn(prepared, "params") ? prepared.params : outbound;
    const wireResult = await this.requestWithProgress(
      method,
      wireParams,
      options,
      document?.editor,
    );
    const result = prepared?.mapResult ? await prepared.mapResult(wireResult) : wireResult;
    if (this.adapter.prepareRequest) guardPrepared();
    if (
      [
        "textDocument/rename",
        "workspace/willCreateFiles",
        "workspace/willRenameFiles",
        "workspace/willDeleteFiles",
      ].includes(method)
    )
      this.captureWorkspaceProjectionContext(result, workspaceContexts);
    if (["textDocument/codeAction", "codeAction/resolve"].includes(method))
      for (const action of Array.isArray(result) ? result : [result])
        if (action?.edit) this.captureWorkspaceProjectionContext(action.edit, workspaceContexts);
    const projectionForReadUri = (uri) => {
      if (!readContexts) return this.documents.get(C.uriKey(uri))?.projection;
      const context = readContexts.get(C.uriKey(uri));
      if (context && (!this.isCurrentDocument(context.document) || !context.projection.isCurrent()))
        throw new Projections.StaleProjectionError();
      return context?.projection;
    };
    if (!projection) {
      if (readContexts)
        return Projections.mapReadResult(
          result,
          projectionForReadUri,
          "",
          (mapped, original, owner) =>
            this.rememberProjectionResponse(
              mapped,
              original,
              this.documents.get(C.uriKey(original.uri || original.location?.uri)),
              owner,
            ),
        );
      return result;
    }
    if (!projection.isCurrent() || !this.isCurrentDocument(document))
      throw new Projections.StaleProjectionError();
    if (
      method.includes("semanticTokens") ||
      method.includes("diagnostic") ||
      [
        "textDocument/completion",
        "completionItem/resolve",
        "textDocument/rename",
        "textDocument/codeAction",
        "codeAction/resolve",
        "textDocument/formatting",
        "textDocument/rangeFormatting",
        "textDocument/onTypeFormatting",
        "textDocument/willSaveWaitUntil",
      ].includes(method)
    ) {
      return this.rememberProjectionResponse(result, result, document, projection);
    }
    return Projections.mapReadResult(
      result,
      projectionForReadUri,
      document.uri,
      (mapped, original, owner) =>
        this.rememberProjectionResponse(mapped, original, document, owner),
    );
  }
  async requestWithProgress(method, params, options, editor) {
    const title = REQUEST_TITLES[method];
    const capabilityMethod = method.startsWith("textDocument/semanticTokens/")
      ? "textDocument/semanticTokens"
      : PROGRESS_CAPABILITIES[method] || method;
    const capability =
      options?.diagnosticProvider ??
      (method === "workspace/executeCommand"
        ? this.manager.dynamicOptions(this, method, editor) ||
          this.capabilities.executeCommandProvider
        : this.capabilityOptions(capabilityMethod, editor));
    const supportsToken =
      capability?.workDoneProgress === true &&
      !method.endsWith("/resolve") &&
      method !== "textDocument/onTypeFormatting";
    const cancelOnServer = options?.cancelOnServer ?? !ABANDON_QUIETLY.has(method);
    if (!title && !supportsToken && params?.workDoneToken == null)
      return this.connection.request(method, params, { cancelOnServer, ...options });

    const token = params?.workDoneToken ?? `ide-client-request-${crypto.randomUUID()}`;
    this.retiredProgressTokens.delete(token);
    const controller = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const activity = {
      title: title || "Working",
      cancellable: cancelOnServer,
      cancel: () => controller.abort(),
    };
    this.clientProgressTokens.set(token, activity);
    if (title) this.manager.beginActivity(this, token, { ...activity, delay: ACTIVITY_DELAY_MS });
    try {
      // Clone parameters: providers and projection mappings may retain the
      // caller's object. Only methods whose capability advertises progress get
      // a new protocol token; the fallback also works with silent servers.
      const outbound =
        supportsToken && params?.workDoneToken == null
          ? { ...params, workDoneToken: token }
          : params;
      return await this.connection.request(method, outbound, {
        ...options,
        cancelOnServer,
        signal,
      });
    } finally {
      this.retireProgressToken(token, activity);
    }
  }
  retireProgressToken(token, expected) {
    if (expected && this.clientProgressTokens.get(token) !== expected) return;
    this.clientProgressTokens.delete(token);
    this.manager.endActivity(this, token);
    // An abandoned RPC can still emit progress before the server notices its
    // cancellation. It must not recreate a finished operation. Bound this
    // history because completion requests can number in the thousands.
    this.retiredProgressTokens.add(token);
    if (this.retiredProgressTokens.size > 512)
      this.retiredProgressTokens.delete(this.retiredProgressTokens.values().next().value);
  }
  notify(method, params) {
    if (this.state === "running") this.connection.notify(method, params);
  }
  openNotebook(notebookDocument, cellTextDocuments = []) {
    this.notify("notebookDocument/didOpen", { notebookDocument, cellTextDocuments });
  }
  changeNotebook(notebookDocument, change) {
    this.notify("notebookDocument/didChange", { notebookDocument, change });
  }
  saveNotebook(notebookDocument) {
    this.notify("notebookDocument/didSave", { notebookDocument });
  }
  closeNotebook(notebookDocument, cellTextDocuments = []) {
    this.notify("notebookDocument/didClose", { notebookDocument, cellTextDocuments });
  }
  // A notebook cell participates in this session as a document — keeping the
  // session alive through the idle check — but its content flows through the
  // notebookDocument notifications, so nothing here sends textDocument/didOpen
  // for it, and its diagnostics ride the notebook push channel rather than
  // pulls. The version is a getter into the notebook module's counter: the
  // staleness guard in publishDiagnostics compares against the version the
  // module stamped on the wire.
  adoptNotebookCell({ record, cellId, editor, uri }) {
    if (this.state !== "running") return;
    const key = C.uriKey(uri);
    const existing = this.documents.get(key);
    if (existing) {
      // Adopted before etch built the cell's editor; the arrival still counts.
      if (existing.notebook === record && editor) existing.editor = editor;
      return;
    }
    const document = {
      editor,
      uri,
      notebook: record,
      subscriptions: new CompositeDisposable(),
      get version() {
        return record.cellVersion(cellId);
      },
    };
    this.documents.set(key, document);
  }
  releaseNotebookCell(uri) {
    const key = C.uriKey(uri);
    const document = this.documents.get(key);
    if (!document?.notebook) return;
    document.syncAbortController?.abort();
    document.projection = null;
    this.projectedDocuments.delete(document);
    document.subscriptions.dispose();
    clearTimeout(this.diagnosticTimers.get(key));
    this.diagnosticTimers.delete(key);
    // Unconditionally, unlike closeDocument's pull-only clear: a push server
    // never clears a closing cell on its own, and a stale diagnostic against a
    // cell that no longer exists has no editor left to correct it.
    this.clearDiagnosticReportsForUri(document.uri);
    this.manager.publishDiagnostics(this, { uri: document.uri, diagnostics: [] }, true);
    this.documents.delete(key);
    if (!this.documents.size && this.state === "running") this.manager.didCloseDocument(this);
  }
  settleProcessExit() {
    clearTimeout(this.failureKillTimer);
    this.failureKillTimer = null;
    if (this.processExited) return;
    this.processExited = true;
    this.resolveProcessExit?.();
    this.manager.didExitProcess?.(this);
  }
  onProcessExit(code, signal) {
    this.settleProcessExit();
    this.failSession(new Error(`Server exited (${code ?? signal})`));
  }
  onProcessError(error) {
    this.processError ||= error;
    // A failed spawn has no process that could later emit exit. Settle its
    // waiter here; errors from an existing process still require physical exit.
    if (this.process?.pid == null) this.settleProcessExit();
    this.failSession(error);
  }
  onConnectionClose() {
    // A failed spawn closes its synthetic stdio streams as well as emitting the
    // child error. Let the more useful ENOENT/EACCES become the one terminal
    // cause rather than racing it with a generic connection message.
    if (this.process && this.process.pid == null && !this.processError) return;
    this.failSession(new Error(`${this.adapter.displayName} connection closed`));
  }
  failSession(error) {
    if (this.failureHandled || this.state === "stopping" || this.state === "stopped") return;
    this.failureHandled = true;
    this.startFailure = error;
    this.cancelStart();
    for (const cleanup of [
      () => this.manager.clearProgress(this),
      () => this.connection?.dispose(),
      () => this.socket?.destroy(),
      () => {
        const child = this.process;
        if (
          child &&
          !this.processExited &&
          child.exitCode == null &&
          child.signalCode == null &&
          !child.kill("SIGKILL")
        ) {
          // Windows can close stdio after the process has died but before Node
          // delivers its exit event. A false kill result in that interval is
          // already-exited, so give the physical-exit waiter its usual bound.
          this.failureKillTimer = setTimeout(() => {
            this.failureKillTimer = null;
            if (!this.processExited && child.exitCode == null && child.signalCode == null)
              this.manager.log(
                this,
                new Error("Language server refused SIGKILL after transport failure").stack,
              );
          }, FINAL_EXIT_TIMEOUT_MS);
          this.failureKillTimer.unref?.();
        }
      },
    ])
      try {
        cleanup();
      } catch (cleanupError) {
        this.manager.log(this, cleanupError.stack || cleanupError.message);
      }
    try {
      this.setState("failed", error);
    } catch (stateError) {
      this.manager.log(this, stateError.stack || stateError.message);
    }
    try {
      this.manager.scheduleRestart(this);
    } catch (restartError) {
      this.manager.log(this, restartError.stack || restartError.message);
    }
  }
  // `exit` asks the server to leave on its own. Killing it in the same tick
  // breaks its stdin before it has read the frame, so wait for it to go and
  // only insist once it is clear it will not.
  async awaitExit() {
    const child = this.process;
    if (!child) return;
    if (this.processError && child.pid == null) throw this.processError;
    if (this.processExited || child.exitCode != null || child.signalCode != null) return;
    try {
      child.stdin?.end();
    } catch {
      // A closed stdin only means the graceful path is unavailable; the
      // bounded kill path below still guarantees that stop settles.
    }
    if (await settlesWithin(this.processExitPromise, EXIT_GRACE_MS)) return;

    let killError;
    try {
      if (!child.kill("SIGKILL")) killError = new Error("Language server refused SIGKILL");
    } catch (error) {
      killError = error;
    }
    if (await settlesWithin(this.processExitPromise, FINAL_EXIT_TIMEOUT_MS)) return;
    throw (
      killError ||
      this.processError ||
      new Error(`Language server did not exit within ${FINAL_EXIT_TIMEOUT_MS}ms after SIGKILL`)
    );
  }
  // Immediate teardown for a window that is already going, where `stop()` is no
  // use: its `shutdown`/`exit` round trip cannot finish while the environment is
  // being taken apart. Every orderly unload reaches `deactivate` and stops its
  // servers properly, so this is the net under the ones that do not — a renderer
  // that crashed and is being reloaded. A server that does not die with its
  // stdin would otherwise be orphaned, one more for every such reload, so the
  // process is killed outright instead of asked to leave. Synchronous on
  // purpose: nothing awaits a `will-destroy` handler.
  kill() {
    clearTimeout(this.failureKillTimer);
    this.failureKillTimer = null;
    if (this.processExited) return;
    // Assigned rather than `setState`: that reports the change onward, and the
    // views it would repaint are being torn down in the same breath.
    this.state = "stopped";
    this.cancelStart();
    this.manager.clearProgress(this);
    for (const timer of this.diagnosticTimers.values()) clearTimeout(timer);
    this.diagnosticTimers.clear();
    clearTimeout(this.workspaceDiagnosticTimer);
    this.workspaceDiagnosticTimer = null;
    this.partialResults.clear();
    this.workspaceDiagnosticResultIds.clear();
    this.disposeDiagnosticPullState();
    try {
      this.connection?.dispose();
    } catch {
      /* The connection is going down with the window either way. */
    }
    try {
      this.socket?.destroy();
    } catch {
      /* The socket is going down with the window either way. */
    }
    try {
      if (!this.process || this.process.exitCode != null || this.process.signalCode != null)
        this.settleProcessExit();
      else this.process.kill("SIGKILL");
    } catch {
      /* Nothing can await or report a will-destroy fallback. */
    }
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "stopped") return (this.stopPromise = Promise.resolve());
    let resolveStop;
    let rejectStop;
    this.stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this.stopOnce().then(resolveStop, rejectStop);
    return this.stopPromise;
  }
  async stopOnce() {
    const wasRunning = this.state === "running";
    let stopError;
    const remember = (error) => {
      stopError ||= error;
    };
    try {
      try {
        this.manager.clearProgress(this);
      } catch (error) {
        remember(error);
      }
      try {
        this.setState("stopping");
      } catch (error) {
        remember(error);
      }
      this.cancelStart();
      for (const timer of this.diagnosticTimers.values()) clearTimeout(timer);
      this.diagnosticTimers.clear();
      clearTimeout(this.workspaceDiagnosticTimer);
      this.workspaceDiagnosticTimer = null;
      this.partialResults.clear();
      this.workspaceDiagnosticResultIds.clear();
      this.disposeDiagnosticPullState();
      // A socket still connecting has no JSON-RPC channel to shut down and
      // would otherwise be able to finish connecting after stop completed.
      if (!this.connection) this.socket?.destroy();
      if (wasRunning && !this.connection?.disposed && !this.processExited) {
        try {
          await withTimeout(this.connection.request("shutdown"), SHUTDOWN_TIMEOUT_MS);
        } catch {
          /* The server may already be gone, or it never answered. */
        }
      }
      // Awaited so the frame is on the wire before the process is taken down.
      if (!this.failureHandled && !this.connection?.disposed && !this.processExited) {
        try {
          await withTimeout(
            this.connection?.notify("exit") ?? Promise.resolve(),
            EXIT_NOTIFY_TIMEOUT_MS,
          );
        } catch (error) {
          // The process teardown below can still succeed. A restart may safely
          // continue once it has observed that physical exit, while an explicit
          // stop retains this failure for its caller.
          error.exitNotificationTimedOut = true;
          remember(error);
        }
      }
      try {
        await this.awaitExit();
      } catch (error) {
        remember(error);
      }
    } finally {
      clearTimeout(this.failureKillTimer);
      this.failureKillTimer = null;
      try {
        this.connection?.dispose();
      } catch (error) {
        remember(error);
      }
      try {
        this.socket?.destroy();
      } catch (error) {
        remember(error);
      }
      this.socket = null;
      try {
        this.subscriptions.dispose();
      } catch (error) {
        remember(error);
      }
      for (const doc of [...this.documents.values(), ...this.temporaryDocuments.values()]) {
        try {
          doc.syncAbortController?.abort();
          doc.subscriptions.dispose();
        } catch (error) {
          remember(error);
        }
      }
      this.documents.clear();
      this.temporaryDocuments.clear();
      this.temporaryDocumentUris.clear();
      this.projectionResponses = new WeakMap();
      this.projectedDocuments.clear();
      this.workspaceProjectionContexts = new WeakMap();
      this.startup = null;
      try {
        this.manager.clearDiagnosticsForSession(this);
      } catch (error) {
        remember(error);
      }
      try {
        this.manager.clearProgress(this);
      } catch (error) {
        remember(error);
      }
      try {
        this.setState("stopped");
      } catch (error) {
        remember(error);
      }
    }
    if (stopError) throw stopError;
  }
};

module.exports.prepareServerSpawn = prepareServerSpawn;
