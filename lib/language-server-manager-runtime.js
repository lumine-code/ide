module.exports = ({
  path,
  C,
  languageIdForEditor,
  relativePath,
  PROJECT_WATCH_GRACE_MS,
  serverName,
  markdownBlocks,
  externalUrl,
  selectAdapters,
  CompositeDisposable,
}) => {
  class Runtime {
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
            if (
              !this.managedServers &&
              (adapter.managedServer || typeof adapter.installServer === "function")
            )
              this.managedServersInitializer?.();
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
    async ensureSession(adapter, rootPath, { filePath, editor } = {}) {
      const rootChanged = () =>
        editor
          ? editor.isDestroyed?.() ||
            this.rootForEditor(editor, adapter) !== rootPath ||
            !this.adapterSelected(adapter, editor)
          : filePath && this.rootForPath(filePath, adapter) !== rootPath;
      const projectRevision = this.projectRevisionFor(adapter, rootPath);
      if (
        adapter.exclusiveGroup &&
        !(await this.awaitExclusiveSelection(adapter, rootPath, editor))
      )
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
    async activeSessionsForEditor(editor, { adapterId } = {}) {
      const binding = this.workspaceDocuments.bindingFor(editor);
      const uri = this.workspaceDocuments.uriForEditor(editor);
      const key = uri ? C.uriKey(uri) : null;
      const scope = editor.getGrammar?.()?.scopeName;
      const current = () =>
        !editor.isDestroyed?.() &&
        this.workspaceDocuments.bindingFor(editor) === binding &&
        this.workspaceDocuments.uriForEditor(editor) === uri &&
        editor.getGrammar?.()?.scopeName === scope;
      const sessions = await Promise.all(
        this.sessionsForEditor(editor)
          .filter((session) => !adapterId || session.adapter.id === adapterId)
          .map(async (session) => {
            try {
              await session.ready;
            } catch {
              return null;
            }
            // A preview can close while startup is pending. Attaching that
            // dead editor would retain a URI whose didOpen was never sent.
            if (
              !current() ||
              session.state !== "running" ||
              !this.sessionsForEditor(editor).includes(session)
            )
              return null;

            // Restored editors and their language servers start independently. A
            // running session is not yet usable for text-document requests until
            // this editor's didOpen is on the wire. Joining openEditor here makes
            // every feature observe one readiness boundary instead of letting the
            // first request race the manager's background attachment.
            if (!binding) await session.openEditor(editor);

            // The editor can change path/grammar, or the session can be replaced,
            // while either readiness wait is pending. Only return a session still
            // routed to and holding the requested document.
            if (
              !current() ||
              session.state !== "running" ||
              !this.sessionsForEditor(editor).includes(session)
            ) {
              return null;
            }
            const document = key && session.documents.get(key);
            if (!document) return null;
            // Distinct buffers may spell one server file differently. A newer
            // alias request owns the wire source while this attachment waits.
            if (
              document.editor !== editor &&
              document.editor?.getBuffer?.() !== editor.getBuffer?.()
            )
              return null;
            return session;
          }),
      );
      return sessions.filter(Boolean);
    }
    publishDiagnostics(session, params, collected = false) {
      if (this.tearingDown || ["stopping", "failed", "stopped"].includes(session.state))
        return false;
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
    republishStoredDiagnostics(session, uriKeys) {
      const byUri = this.diagnostics.get(session);
      if (!byUri) return;
      for (const key of uriKeys) {
        const entry = byUri.get(key);
        if (entry) this.emitter.emit("did-publish-diagnostics", entry);
      }
    }
    registerCapabilities(session, registrations = []) {
      if (this.tearingDown || ["stopping", "failed", "stopped"].includes(session.state))
        return false;
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
      if (this.tearingDown || ["stopping", "failed", "stopped"].includes(session.state))
        return false;
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
      const picomatch = require("picomatch");
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
            resolved.editor.setSelectedBufferRange(C.rangeFromLsp(selection), { mode: "zone" });
          return { success: true };
        }
        if (resolved.kind === "untitled") {
          if (takeFocus !== false) {
            const pane = lumine.workspace.paneForItem(resolved.editor);
            pane?.activateItem(resolved.editor);
            pane?.activate();
          }
          if (selection)
            resolved.editor.setSelectedBufferRange(C.rangeFromLsp(selection), { mode: "zone" });
          return { success: true };
        }
        const editor = await lumine.workspace.open(resolved.path, {
          activateItem: takeFocus !== false,
        });
        if (selection && editor?.setSelectedBufferRange)
          editor.setSelectedBufferRange(C.rangeFromLsp(selection), { mode: "zone" });
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
    restartAdapter(adapter, { reportErrors = false } = {}) {
      if (this.tearingDown || this.adapters.get(adapter.id) !== adapter)
        return Promise.resolve(null);
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
    uriForEditor(editor) {
      return this.workspaceDocuments.uriForEditor(editor);
    }
    resolveUri(uri) {
      return this.workspaceDocuments.resolveUri(uri);
    }
    buildClientCapabilities() {
      this.capabilityInitializer?.();
      const { baseCapabilities, mergeCapabilities } = require("./capabilities");
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
        projectPaths = controller
          ? [...controller.folders]
          : [...(session?.folders || projectPaths)];
      }
      return projectPaths.map((projectPath) => this.folderOf(projectPath));
    }
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
    createController(adapter, rootPath) {
      const SessionController = require("./session-controller");
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
    foldersFor(session) {
      if (session.adapter.sessionScope !== "workspace") return [...session.folders];
      const roots = lumine.project.getPaths();
      return roots.length ? roots : [session.rootPath];
    }
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
    acceptsFolders(session) {
      const folders = session.capabilities.workspace?.workspaceFolders;
      return !!folders?.supported && !!folders.changeNotifications;
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
    reportStartFailure(adapter, rootPath, error) {
      this.log({ adapter, rootPath }, error.stack || error.message);
      lumine.notifications.addError(`Unable to start ${adapter.displayName}`, {
        detail: error.message,
        dismissable: true,
      });
    }
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
    diagnosticsFor(session, uri) {
      return this.diagnostics.get(session)?.get(C.uriKey(uri))?.diagnostics || [];
    }
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
    dynamicOptions(session, method, editor) {
      const registrations = this.dynamicCapabilities.get(session);
      if (!registrations) return undefined;
      for (const item of registrations.values()) {
        if (item.method !== method) continue;
        const selector = item.registerOptions?.documentSelector;
        if (!selector || this.selectorMatches(selector, session, editor))
          return item.registerOptions;
      }
      return undefined;
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
    async applyWorkspaceEdits(edits, label, options = {}) {
      return this.workspaceEdits.applyWorkspaceEdits(edits, label, options);
    }
    async applyWorkspaceEdit(edit, label, session = null) {
      return this.workspaceEdits.applyWorkspaceEdit(edit, label, session);
    }
    async applyWorkspaceEditDetailed(edit, label, session = null) {
      return this.workspaceEdits.applyWorkspaceEditDetailed(edit, label, session);
    }
    reportAdapterRestartFailure(adapter, error) {
      const detail = error?.errors?.map((entry) => entry.message).join("\n") || error.message;
      this.log({ adapter, rootPath: "" }, error.stack || detail);
      lumine.notifications.addError(`Unable to restart ${adapter.displayName}`, {
        detail,
        dismissable: true,
      });
    }
    sessionPhysicallyExited(session) {
      const child = session?.process;
      return (
        !child ||
        session.processExited === true ||
        child.exitCode != null ||
        child.signalCode != null
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
    restart(session, { retry = false } = {}) {
      const controller = this.controllerForSession(session);
      if (!controller || controller.cancelled) return Promise.resolve(null);
      if (controller.restartPromise && controller.restartSources.has(session)) {
        if (controller.desiredRetry && !retry)
          return controller.restart({ retry, source: session });
        return controller.restartPromise;
      }
      if (controller.session !== session) return Promise.resolve(null);
      return controller.restart({ retry, source: session });
    }
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
    async stopSession(session) {
      const controller = this.controllerForSession(session);
      if (controller) return controller.stopChild(session);
      try {
        await session.stop();
      } catch (error) {
        console.error(`ide: failed to stop ${session?.adapter?.id ?? "a language server"}`, error);
      }
    }
  }
  return Runtime.prototype;
};
