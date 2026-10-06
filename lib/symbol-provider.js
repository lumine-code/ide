const C = require("./converters");
const path = require("path");
const { CompositeDisposable, Emitter } = require("lumine");

const SYMBOL_CAPABILITIES = {
  workspace: {
    symbol: {
      dynamicRegistration: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
  },
  textDocument: {
    documentSymbol: {
      dynamicRegistration: true,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
    declaration: { dynamicRegistration: true, linkSupport: true },
    definition: { dynamicRegistration: true, linkSupport: true },
    references: { dynamicRegistration: true },
  },
};

module.exports = class LspSymbolProvider {
  static capabilities = SYMBOL_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(SYMBOL_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide";
    this.emitter = new Emitter();
    this.pendingInvalidations = new Set();
    this.invalidationScheduled = false;
    this.destroyed = false;
    this.subscriptions = new CompositeDisposable(
      manager.onDidChangeSession(({ session }) => {
        this.invalidateWorkspaceSymbols();
        this.invalidateEditors(manager.editorsForSession(session));
      }),
      manager.onDidChangeAdapters(({ adapter }) => {
        this.invalidateEditors(manager.editorsForAdapter(adapter));
      }),
      manager.onDidChangeFeatures(({ adapter }) => {
        this.invalidateWorkspaceSymbols();
        this.invalidateEditors(manager.editorsForAdapter(adapter));
      }),
      manager.onDidChangeCapabilities(({ session }) => {
        this.invalidateWorkspaceSymbols();
        if (session.state !== "running") return;
        this.invalidateEditors(manager.editorsForSession(session));
      }),
      manager.onDidChangeNotebook(({ record }) => {
        this.invalidateWorkspaceSymbols();
        this.invalidateEditors(
          [...(record?.routedEditors?.values() || [])].flatMap((editors) => [...editors]),
        );
      }),
      lumine.project.onDidChangePaths(() => this.invalidateWorkspaceSymbols()),
    );
  }
  invalidateWorkspaceSymbols() {
    if (this.workspaceInvalidationScheduled) return;
    this.workspaceInvalidationScheduled = true;
    queueMicrotask(() => {
      this.workspaceInvalidationScheduled = false;
      if (!this.destroyed) this.emitter.emit("did-invalidate-workspace-symbols");
    });
  }
  onDidInvalidateWorkspaceSymbols(callback) {
    return this.emitter.on("did-invalidate-workspace-symbols", callback);
  }
  invalidateEditors(editors) {
    for (const editor of editors || []) this.pendingInvalidations.add(editor);
    if (!this.pendingInvalidations.size || this.invalidationScheduled) return;
    this.invalidationScheduled = true;
    queueMicrotask(() => {
      this.invalidationScheduled = false;
      if (this.destroyed) return;
      const pending = [...this.pendingInvalidations];
      this.pendingInvalidations.clear();
      for (const editor of pending) {
        this.emitter.emit("did-invalidate-document-symbols", { editor });
      }
    });
  }
  onDidInvalidateDocumentSymbols(callback) {
    return this.emitter.on("did-invalidate-document-symbols", callback);
  }
  destroy() {
    if (!this.subscriptions) return;
    this.destroyed = true;
    this.pendingInvalidations.clear();
    this.subscriptions.dispose();
    this.subscriptions = null;
    this.emitter.dispose();
  }
  async sessionFor(editor, method) {
    const sessions = await this.manager.activeSessionsForEditor(editor);
    return sessions.find((session) => session.supports(method, editor)) || null;
  }
  ownsDocumentSymbols(adapter, editor) {
    const scopes = adapter.documentSymbolScopes ?? adapter.grammarScopes;
    return scopes.includes(editor?.getGrammar?.()?.scopeName);
  }
  getDocumentSymbolSources(editor, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.destroyed || !editor || editor.isDestroyed?.()) return [];
    const sessions = this.manager.sessionsForEditor(editor);
    return this.manager
      .adaptersForEditor(editor)
      .filter((adapter) => this.ownsDocumentSymbols(adapter, editor))
      .map((adapter) => {
        const session = sessions.find((candidate) => candidate.adapter === adapter);
        let state = "unavailable";
        let message = "This language server is not running.";
        if (!this.manager.featureEnabled(adapter, "symbols", editor)) {
          message = "Document symbols are disabled for this language server.";
        } else if (session?.state === "starting") {
          state = "starting";
          message = "This language server is starting.";
        } else if (session?.state === "running") {
          if (session.supports("textDocument/documentSymbol", editor)) {
            state = "ready";
            message = undefined;
          } else {
            message = "This language server does not provide document symbols.";
          }
        }
        return {
          id: `ide:${adapter.id}`,
          name: adapter.displayName,
          shortLabel: "LS",
          score: 1,
          state,
          ...(message ? { message } : {}),
        };
      });
  }
  async canProvideDefinitions(editor) {
    return !!(await this.sessionFor(editor, "textDocument/definition"));
  }
  async withRequestOptions(options, callback) {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timer =
      options.timeoutMs > 0
        ? setTimeout(
            () => controller.abort(new Error("Symbol request timed out")),
            options.timeoutMs,
          )
        : null;
    let onAbort;
    try {
      signal.throwIfAborted();
      return await Promise.race([
        callback({ signal }),
        new Promise((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
  getDocumentSymbols(editor, options = {}) {
    return this.withRequestOptions(options, async ({ signal }) => {
      if (
        this.destroyed ||
        typeof options.sourceId !== "string" ||
        !options.sourceId.startsWith("ide:")
      )
        return null;
      const adapterId = options.sourceId.slice("ide:".length);
      if (!adapterId || !editor || editor.isDestroyed?.()) return null;
      const adapter = this.manager
        .adaptersForEditor(editor)
        .find((candidate) => candidate.id === adapterId);
      if (!adapter || !this.ownsDocumentSymbols(adapter, editor)) return null;
      const sessions = await this.manager.activeSessionsForEditor(editor, { adapterId });
      const session = sessions.find(
        (candidate) =>
          candidate.adapter === adapter &&
          candidate.supports("textDocument/documentSymbol", editor),
      );
      signal.throwIfAborted();
      if (!session || !this.ownsDocumentSymbols(adapter, editor)) return null;
      const uri = this.manager.uriForEditor(editor);
      const result = await session.request(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
        { signal },
      );
      signal.throwIfAborted();
      return this.convert(result, uri);
    });
  }
  getDefinitions(editor, options = {}) {
    const params = this.positionParams(editor, options.range);
    return this.withRequestOptions(options, async ({ signal }) => {
      const session = await this.sessionFor(editor, "textDocument/definition");
      signal.throwIfAborted();
      if (!session) return null;
      const result = await session.request("textDocument/definition", params, { signal });
      signal.throwIfAborted();
      return this.locations(result);
    });
  }
  positionParams(editor, range) {
    const point =
      range?.start ||
      (range?.[0] && { row: range[0][0], column: range[0][1] }) ||
      editor.getLastCursor().getBufferPosition();
    return {
      textDocument: { uri: this.manager.uriForEditor(editor) },
      position: C.pointToPosition(point),
    };
  }
  workspaceSessions(paths) {
    const intersects = (folder, root) => {
      const within = (parent, child) => {
        const relative = path.relative(parent, child);
        return (
          !relative ||
          (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
        );
      };
      return within(folder, root) || within(root, folder);
    };
    return this.manager.allSessions().filter((session) => {
      const folders = this.manager.foldersFor(session);
      return paths.some((root) => folders.some((folder) => intersects(folder, root)));
    });
  }
  searchWorkspaceSymbols(query, options = {}) {
    return this.withRequestOptions(options, ({ signal }) =>
      this.searchActiveWorkspaceSymbols(query, { ...options, signal }),
    );
  }
  async searchActiveWorkspaceSymbols(
    query,
    { paths = lumine.project.getPaths(), signal, onSymbols, onStatus } = {},
  ) {
    signal?.throwIfAborted();
    const relevant = this.workspaceSessions(paths).filter((session) =>
      this.manager.featureEnabledForAdapter(session.adapter, "symbols"),
    );
    const sessions = relevant.filter(
      (session) =>
        session.state === "running" && session.supports("workspace/symbol", undefined, null),
    );
    if (!sessions.length) {
      onStatus?.({
        state: relevant.some((session) => session.state === "starting")
          ? "starting"
          : "unavailable",
      });
      return [];
    }
    const batches = new Map();
    const collect = () => {
      const seen = new Set();
      return sessions
        .flatMap((session) => batches.get(session) || [])
        .filter((symbol) => {
          const uri = symbol.uri || (symbol.path && C.pathToUri(symbol.path));
          const key = JSON.stringify([
            C.uriKey(uri),
            symbol.cell,
            symbol.name,
            symbol.tag,
            symbol.position,
            symbol.context,
          ]);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const results = await Promise.allSettled(
      sessions.map(async (session) => {
        const items = session.adapter.searchWorkspaceSymbols
          ? await session.adapter.searchWorkspaceSymbols(query, { session, signal })
          : await session.request("workspace/symbol", { query }, { signal });
        signal?.throwIfAborted();
        if (session.state !== "running" || !this.manager.allSessions().includes(session))
          throw new Error("Language server session changed during symbol search");
        batches.set(session, this.convert(items));
        onSymbols?.(collect());
      }),
    );
    signal?.throwIfAborted();
    const failures = results.filter((result) => result.status === "rejected");
    for (let index = 0; index < results.length; index++)
      if (results[index].status === "rejected")
        this.manager.log(sessions[index], results[index].reason);
    onStatus?.({
      state: failures.length
        ? failures.length === sessions.length
          ? "error"
          : "partial"
        : "ready",
    });
    return collect();
  }
  // What a result URI names on this side of the wire. A cell resolves to its
  // notebook's path with a 1-based cell number; positions stay cell-relative,
  // which is what the notebook's own reveal takes.
  resolveResultUri(uri) {
    const resolved = this.manager.resolveUri(uri);
    if (resolved?.kind === "cell")
      return { path: resolved.notebookPath, cell: resolved.cellIndex + 1, uri };
    return { path: resolved?.kind === "file" ? resolved.path : null };
  }
  locations(items) {
    return (Array.isArray(items) ? items : items ? [items] : []).flatMap((item) => {
      const location = item.targetUri
        ? { uri: item.targetUri, range: item.targetSelectionRange || item.targetRange }
        : item;
      // Cross-document navigation uses file paths in the symbol consumer.
      // A pathless result would jump inside whichever editor is active.
      if (this.manager.resolveUri(location.uri)?.kind === "untitled") return [];
      const target = this.resolveResultUri(location.uri);
      if (!target.path || !location.range?.start) return [];
      return [
        {
          name: target.path?.split(/[\\/]/).pop() || "Result",
          ...target,
          position: C.positionToPoint(location.range.start),
          range: C.rangeFromLsp(location.range),
        },
      ];
    });
  }
  convert(items, defaultUri) {
    const output = [];
    const visit = (item, containerName) => {
      const navigationRange = item.selectionRange || item.location?.range || item.range;
      const structuralRange = item.range || item.location?.range || item.selectionRange;
      const location = item.location || { uri: defaultUri, range: navigationRange };
      if (!navigationRange?.start || !structuralRange?.end) return;
      if (!defaultUri && this.manager.resolveUri(location.uri)?.kind === "untitled") return;
      const target = this.resolveResultUri(location.uri);
      if (!defaultUri && !target.path) return;
      output.push({
        name: item.name,
        tag: C.symbolKind(item.kind),
        ...target,
        position: C.positionToPoint(navigationRange.start),
        range: C.rangeFromLsp(structuralRange),
        context: item.containerName || containerName,
      });
      item.children?.forEach((child) => visit(child, item.name));
    };
    (items || []).forEach((item) => visit(item));
    return output;
  }
};
