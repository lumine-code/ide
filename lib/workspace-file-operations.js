const path = require("node:path");
const picomatch = require("picomatch");
const { CompositeDisposable } = require("lumine");
const C = require("./converters");
const FileOperationPreparation = require("./file-operation-preparation");
const { pathKey, relativePath } = require("./workspace-paths");

// The executor edge owns durable file effects, watcher buffering and staging.
module.exports = class WorkspaceFileOperations {
  constructor({ documents, host }) {
    this.documents = documents;
    this.host = host;
    this.executor = null;
    this.lifecycleExecutor = null;
    this.lifecycleRegistrations = new Map();
    this.executionGates = new Map();
    this.bufferedEvents = [];
    this.completedGates = [];
    this.internalRoots = [];
    this.eventSequence = 0;
    this.executionRequests = [];
    this.executorIds = new WeakMap();
    this.nextExecutorId = 1;
    this.suppressions = new Map();
    this.preparations = new Set();
    this.disposed = false;
  }
  disposeRetiredLifecycle(executor) {
    const registration = this.lifecycleRegistrations.get(executor);
    if (!registration?.retiring) return;
    if ([...this.executionGates.values()].some((gate) => gate.executor === executor)) {
      return;
    }
    registration.subscriptions.dispose();
    this.lifecycleRegistrations.delete(executor);
  }
  retireLifecycle(executor) {
    const registration = this.lifecycleRegistrations.get(executor);
    if (!registration) return;
    registration.retiring = true;
    for (const gate of this.executionGates.values()) {
      if (gate.executor === executor && gate.request && !gate.request.error) {
        gate.request.error = new Error("File operation service became unavailable.");
      }
    }
    this.disposeRetiredLifecycle(executor);
  }
  setExecutor(executor) {
    if (this.disposed && executor)
      throw new DOMException("File operation coordinator is disposed", "AbortError");
    const previous = this.executor;
    if (previous && previous !== executor) this.retireLifecycle(previous);
    this.executor = executor;
    this.lifecycleExecutor = null;
    if (
      typeof executor?.onWillExecuteStep !== "function" ||
      typeof executor?.onDidExecuteStep !== "function"
    ) {
      return;
    }
    this.lifecycleExecutor = executor;
    let registration = this.lifecycleRegistrations.get(executor);
    if (!registration) {
      registration = {
        retiring: false,
        subscriptions: new CompositeDisposable(
          executor.onWillExecuteStep((event) => this.beginGate(event, executor)),
          executor.onDidExecuteStep((event) => this.finishGate(event, executor)),
        ),
      };
      this.lifecycleRegistrations.set(executor, registration);
    }
    registration.retiring = false;
  }
  routeEvents(events) {
    if (this.disposed) return;
    this.host.invalidateScopes((events || []).flatMap((event) => [event.path, event.oldPath]));
    const visible = [];
    for (const event of events || []) {
      if (this.eventMatchesRoots(event, this.internalRoots)) continue;
      const record = { sequence: ++this.eventSequence, event };
      if (this.executionGates.size) {
        this.bufferedEvents.push(record);
      } else {
        visible.push(event);
      }
    }
    if (visible.length) this.deliverEvents(visible);
  }
  deliverEvents(events) {
    this.notifyWatchedFiles(events);

    const fileOperationEvents = events.filter(
      (event) => !this.consumeSuppression(event.action, event.path),
    );
    for (const session of this.host.sessions()) {
      if (session.state !== "running") continue;
      const operations = session.capabilities?.workspace?.fileOperations;
      if (!operations) continue;

      const created = [];
      const deleted = [];
      for (const event of fileOperationEvents) {
        if (event.action === "created" && this.matches(operations.didCreate?.filters, event.path)) {
          created.push({ uri: C.pathToUri(event.path) });
        } else if (
          event.action === "deleted" &&
          this.matches(operations.didDelete?.filters, event.path)
        ) {
          deleted.push({ uri: C.pathToUri(event.path) });
        }
      }
      if (created.length) session.notify("workspace/didCreateFiles", { files: created });
      if (deleted.length) session.notify("workspace/didDeleteFiles", { files: deleted });
    }
  }
  notifyWatchedFiles(events) {
    const sessions = new Set([...this.host.sessions(), ...this.host.dynamicCapabilities().keys()]);
    for (const session of sessions) {
      if (session.state !== "running") continue;
      const staticWatchers = session.adapter?.fileWatchers || [];
      const watchers = [...staticWatchers];
      for (const item of this.host.dynamicCapabilities().get(session)?.values() || [])
        if (item.method === "workspace/didChangeWatchedFiles")
          watchers.push(...(item.registerOptions?.watchers || []));
      if (!watchers.length) continue;
      const changes = [];
      let lastEvent = null;
      const push = (filePath, type) => {
        if (!filePath) return;
        const kindBit = type === 1 ? 1 : type === 2 ? 2 : 4;
        const matched = watchers.some(
          (watcher) =>
            ((watcher.kind ?? 7) & kindBit) !== 0 &&
            (!staticWatchers.includes(watcher) ||
              this.host
                .foldersFor(session)
                .some((folder) => relativePath(folder, filePath) !== null)) &&
            this.host.globMatches(watcher.globPattern, filePath),
        );
        const uri = C.pathToUri(filePath),
          id = C.uriKey(uri) + ":" + type;
        const duplicate = lastEvent === id;
        lastEvent = id;
        if (matched && !duplicate) changes.push({ uri, type });
      };
      for (const event of events) {
        if (event.action === "created") push(event.path, 1);
        else if (event.action === "updated") push(event.path, 2);
        else if (event.action === "deleted") push(event.path, 3);
      }
      if (changes.length) session.notify("workspace/didChangeWatchedFiles", { changes });
    }
  }
  eventMatchesRoots(event, roots) {
    return (roots || []).some((root) => {
      if (!root?.path) return false;
      return [event?.path, event?.oldPath].some((filePath) => {
        if (!filePath) return false;
        if (pathKey(root.path) === pathKey(filePath)) return true;
        return root.recursive && relativePath(root.path, filePath) !== null;
      });
    });
  }
  rememberInternalRoots(roots) {
    const known = new Set(
      this.internalRoots.map(
        (root) => `${pathKey(root.path)}:${root.recursive ? "tree" : "entry"}`,
      ),
    );
    for (const root of roots || []) {
      if (!root?.path) continue;
      const normalized = { path: path.resolve(root.path), recursive: root.recursive === true };
      const key = `${pathKey(normalized.path)}:${normalized.recursive ? "tree" : "entry"}`;
      if (known.has(key)) continue;
      known.add(key);
      this.internalRoots.push(normalized);
    }
    if (this.internalRoots.length > 4096) {
      this.internalRoots.splice(0, this.internalRoots.length - 4096);
    }
  }
  eventsForEffects(effects) {
    const events = [];
    for (const effect of effects || []) {
      if (effect?.kind === "create" && effect.path) {
        events.push({ action: "created", path: effect.path });
      } else if (effect?.kind === "rename" && effect.oldPath && effect.newPath) {
        events.push(
          { action: "deleted", path: effect.oldPath },
          { action: "created", path: effect.newPath },
        );
      } else if (effect?.kind === "delete" && effect.path) {
        events.push({ action: "deleted", path: effect.path });
      }
    }
    return events;
  }
  eventCoveredByGate({ sequence, event }, gate) {
    if (sequence < gate.startSequence || sequence > gate.endSequence) return false;
    // A durable create/delete replaces only the root event. Keep content
    // updates and descendant events: dynamic watcher globs may be narrower
    // than the file-operation registration and still need those details.
    if (event?.action === "updated") return false;
    return (gate.coveredRoots || []).some(
      (root) =>
        root?.path &&
        [event?.path, event?.oldPath].some(
          (filePath) => filePath && pathKey(root.path) === pathKey(filePath),
        ),
    );
  }
  gateKey(executor, id) {
    if (!executor || (typeof executor !== "object" && typeof executor !== "function")) {
      return `direct:${id}`;
    }
    let executorId = this.executorIds.get(executor);
    if (!executorId) {
      executorId = this.nextExecutorId++;
      this.executorIds.set(executor, executorId);
    }
    return `${executorId}:${id}`;
  }
  beginGate({ id, operation } = {}, executor = null) {
    if (this.disposed) return;
    if (id == null) return;
    const gateKey = this.gateKey(executor, id);
    if (this.executionGates.has(gateKey)) return;
    const editorSnapshots = this.documents.snapshotsForOperation(operation);
    const pathChangeToken = {};
    this.documents.suppressPathChanges(editorSnapshots, pathChangeToken);
    const request = this.executionRequests.find(
      (candidate) => candidate.executor === executor && candidate.id == null,
    );
    if (request) request.id = id;
    this.executionGates.set(gateKey, {
      executor,
      startSequence: this.eventSequence + 1,
      editorSnapshots,
      pathChangeToken,
      request,
    });
  }
  async finishGate({ id, result, eventTrace } = {}, executor = null) {
    const gateKey = this.gateKey(executor, id);
    const gate = this.executionGates.get(gateKey);
    if (!gate) return;
    let operationError;
    let logicalEditorPaths;
    try {
      try {
        logicalEditorPaths = this.documents.pathsAfterEffects(
          result?.effects,
          gate.editorSnapshots,
        );
      } catch (error) {
        operationError = error;
      }
      logicalEditorPaths ||= new Map(
        gate.editorSnapshots.map(({ editor, path: filePath }) => [editor, filePath]),
      );
      await this.documents.stabilizePaths(logicalEditorPaths);
      if (this.disposed) return;
      this.rememberInternalRoots(eventTrace?.internalRoots);
      this.completedGates.push({
        startSequence: gate.startSequence,
        endSequence: this.eventSequence,
        coveredRoots: eventTrace?.coveredRoots || [],
      });
      try {
        this.publishEffects(result?.effects, { suppressProjectEvents: false });
        this.notifyWatchedFiles(this.eventsForEffects(result?.effects));
      } catch (error) {
        operationError ||= error;
      }
      await this.documents.reattachPaths(gate.pathChangeToken);
    } finally {
      this.documents.releasePaths(gate.pathChangeToken);
      this.executionGates.delete(gateKey);
      this.disposeRetiredLifecycle(gate.executor);
      if (!this.executionGates.size) this.flushGates();
    }
    if (operationError) {
      if (gate.request) gate.request.error = operationError;
      else console.error("ide: file-operation lifecycle coordination failed", operationError);
    }
  }
  flushGates() {
    for (const gate of this.executionGates.values()) {
      if (gate.request && !gate.request.error) {
        gate.request.error = new Error(
          "File operation lifecycle ended before coordination completed.",
        );
      }
      this.documents.releasePaths(gate.pathChangeToken);
    }
    this.executionGates.clear();
    const completedGates = this.completedGates;
    this.completedGates = [];
    const events = this.bufferedEvents
      .filter(
        (record) =>
          !this.eventMatchesRoots(record.event, this.internalRoots) &&
          !completedGates.some((gate) => this.eventCoveredByGate(record, gate)),
      )
      .map(({ event }) => event);
    // There is deliberately no TTL for logical paths. A late native event may
    // duplicate the canonical notification, but suppressing it by time could
    // discard a real external change that happened after the operation.
    this.bufferedEvents = [];
    if (events.length) this.deliverEvents(events);
  }
  matches(filters, filePath, isDirectory) {
    if (!Array.isArray(filters) || !filters.length || !filePath) return false;
    const normalized = filePath.replaceAll("\\", "/");
    return filters.some((filter) => {
      if (filter.scheme && filter.scheme !== "file") return false;
      const pattern = filter.pattern;
      if (!pattern?.glob) return false;
      if (pattern.matches === "file" && isDirectory === true) return false;
      if (pattern.matches === "folder" && isDirectory === false) return false;
      const options = { dot: true, nocase: !!pattern.options?.ignoreCase };
      return (
        picomatch.isMatch(normalized, pattern.glob, options) ||
        picomatch.isMatch(normalized, `**/${pattern.glob}`, options)
      );
    });
  }
  suppressProjectEvent(action, filePath) {
    const key = `${action}:${C.uriKey(C.pathToUri(filePath))}`;
    this.suppressions.set(key, Date.now() + 5000);
  }
  consumeSuppression(action, filePath) {
    const now = Date.now();
    for (const [key, expires] of this.suppressions)
      if (expires <= now) this.suppressions.delete(key);
    const key = `${action}:${C.uriKey(C.pathToUri(filePath))}`;
    if (!this.suppressions.has(key)) return false;
    this.suppressions.delete(key);
    return true;
  }
  fileEntries({ paths = [], entries = [] } = {}) {
    const details = new Map(entries.map((entry) => [entry.path, entry]));
    return paths.map((filePath) => ({
      path: filePath,
      isDirectory: details.get(filePath)?.isDirectory,
    }));
  }
  renameEntries({ files = [] } = {}) {
    return files.map(({ oldPath, newPath, isDirectory }) => ({ oldPath, newPath, isDirectory }));
  }
  matchingFileEntries(session, capability, entries) {
    const filters = session.capabilities?.workspace?.fileOperations?.[capability]?.filters;
    return entries.filter((entry) => this.matches(filters, entry.path, entry.isDirectory));
  }
  matchingRenameEntries(session, capability, entries) {
    const filters = session.capabilities?.workspace?.fileOperations?.[capability]?.filters;
    return entries.filter(
      (entry) =>
        this.matches(filters, entry.oldPath, entry.isDirectory) ||
        this.matches(filters, entry.newPath, entry.isDirectory),
    );
  }
  prepareOperation(method, capability, entries, paramsFor, label, options, workspaceEdits) {
    return new FileOperationPreparation(
      { fileOperations: this, workspaceEdits, documents: this.documents },
      options,
    ).collect(method, capability, entries, paramsFor, label);
  }
  async commitPreparation(preparation) {
    if (!preparation) return false;
    try {
      return await preparation.commit();
    } finally {
      preparation.dispose();
    }
  }
  willCreateFiles(payload, workspaceEdits) {
    return this.prepareCreateFiles(payload, workspaceEdits).then((preparation) =>
      this.commitPreparation(preparation),
    );
  }
  prepareCreateFiles(payload, workspaceEdits) {
    return this.prepareOperation(
      "workspace/willCreateFiles",
      "willCreate",
      this.fileEntries(payload),
      (entries) => ({ files: entries.map((entry) => ({ uri: C.pathToUri(entry.path) })) }),
      "Prepare file creation",
      { signal: payload.signal },
      workspaceEdits,
    );
  }
  willRenameFiles(payload, workspaceEdits) {
    return this.prepareRenameFiles(payload, workspaceEdits).then((preparation) =>
      this.commitPreparation(preparation),
    );
  }
  prepareRenameFiles(payload, workspaceEdits) {
    return this.prepareOperation(
      "workspace/willRenameFiles",
      "willRename",
      this.renameEntries(payload),
      (entries) => ({
        files: entries.map((entry) => ({
          oldUri: C.pathToUri(entry.oldPath),
          newUri: C.pathToUri(entry.newPath),
        })),
      }),
      "Prepare file rename",
      { signal: payload.signal },
      workspaceEdits,
    );
  }
  willDeleteFiles(payload, workspaceEdits) {
    return this.prepareDeleteFiles(payload, workspaceEdits).then((preparation) =>
      this.commitPreparation(preparation),
    );
  }
  prepareDeleteFiles(payload, workspaceEdits) {
    return this.prepareOperation(
      "workspace/willDeleteFiles",
      "willDelete",
      this.fileEntries(payload),
      (entries) => ({ files: entries.map((entry) => ({ uri: C.pathToUri(entry.path) })) }),
      "Prepare file deletion",
      { signal: payload.signal },
      workspaceEdits,
    );
  }
  didCreateFiles(payload, { excludeSession = null, suppressProjectEvents = true } = {}) {
    const entries = this.fileEntries(payload);
    if (suppressProjectEvents)
      for (const entry of entries) this.suppressProjectEvent("created", entry.path);
    this.notifyOperation(
      "workspace/didCreateFiles",
      "didCreate",
      entries,
      (matched) => ({ files: matched.map((entry) => ({ uri: C.pathToUri(entry.path) })) }),
      { excludeSession },
    );
  }
  didRenameFiles(payload, { excludeSession = null, suppressProjectEvents = true } = {}) {
    const entries = this.renameEntries(payload);
    if (suppressProjectEvents)
      for (const entry of entries) {
        this.suppressProjectEvent("deleted", entry.oldPath);
        this.suppressProjectEvent("created", entry.newPath);
      }
    this.notifyOperation(
      "workspace/didRenameFiles",
      "didRename",
      entries,
      (matched) => ({
        files: matched.map((entry) => ({
          oldUri: C.pathToUri(entry.oldPath),
          newUri: C.pathToUri(entry.newPath),
        })),
      }),
      { excludeSession },
    );
  }
  didDeleteFiles(payload, { excludeSession = null, suppressProjectEvents = true } = {}) {
    const entries = this.fileEntries(payload);
    if (suppressProjectEvents)
      for (const entry of entries) this.suppressProjectEvent("deleted", entry.path);
    this.notifyOperation(
      "workspace/didDeleteFiles",
      "didDelete",
      entries,
      (matched) => ({ files: matched.map((entry) => ({ uri: C.pathToUri(entry.path) })) }),
      { excludeSession },
    );
  }
  notifyOperation(method, capability, entries, paramsFor, { excludeSession = null } = {}) {
    for (const session of this.host.sessions()) {
      if (session === excludeSession || session.state !== "running") continue;
      const matched = capability.includes("Rename")
        ? this.matchingRenameEntries(session, capability, entries)
        : this.matchingFileEntries(session, capability, entries);
      if (matched.length) session.notify(method, paramsFor(matched));
    }
  }
  publishEffects(effects, { suppressProjectEvents = true } = {}) {
    const creates = [];
    const renames = [];
    const deletes = [];
    for (const effect of effects || []) {
      if (effect?.kind === "create" && effect.path) {
        creates.push({ path: effect.path, isDirectory: !!effect.isDirectory });
      } else if (effect?.kind === "rename" && effect.oldPath && effect.newPath) {
        renames.push({
          oldPath: effect.oldPath,
          newPath: effect.newPath,
          isDirectory: !!effect.isDirectory,
        });
      } else if (effect?.kind === "delete" && effect.path) {
        deletes.push({ path: effect.path, isDirectory: !!effect.isDirectory });
      }
    }
    const notificationOptions = suppressProjectEvents ? null : { suppressProjectEvents: false };
    if (creates.length) {
      const payload = {
        paths: creates.map(({ path: filePath }) => filePath),
        entries: creates,
      };
      if (notificationOptions) this.didCreateFiles(payload, notificationOptions);
      else this.didCreateFiles(payload);
    }
    if (renames.length) {
      if (notificationOptions) this.didRenameFiles({ files: renames }, notificationOptions);
      else this.didRenameFiles({ files: renames });
    }
    if (deletes.length) {
      const payload = {
        paths: deletes.map(({ path: filePath }) => filePath),
        entries: deletes,
      };
      if (notificationOptions) this.didDeleteFiles(payload, notificationOptions);
      else this.didDeleteFiles(payload);
    }
  }
  cleanupPaths(result) {
    const paths = Array.isArray(result?.cleanupPaths) ? result.cleanupPaths : [];
    return [...new Set(paths.filter((filePath) => typeof filePath === "string" && filePath))];
  }
  coordinationError(error, result) {
    const paths = this.cleanupPaths(result);
    const details = [error?.message || "File operation coordination failed."];
    if (result?.status === "failed" && result.reason) {
      details.push(`Filesystem result: ${result.reason}`);
    }
    if (paths.length) details.push(`Recovery paths:\n${paths.join("\n")}`);
    const coordinated = new Error(details.join("\n\n"));
    coordinated.cause = error;
    if (Number.isInteger(error?.failedChange)) coordinated.failedChange = error.failedChange;
    if (error?.name === "AbortError") coordinated.name = "AbortError";
    return coordinated;
  }
  async executeStep(plan, step, options = {}) {
    if (this.disposed)
      throw new DOMException("File operation coordinator is disposed", "AbortError");
    if (plan.fileOperationsExecutor === this.lifecycleExecutor) {
      const request = { executor: plan.fileOperationsExecutor, id: null, error: null };
      options.beforeMutation?.();
      this.executionRequests.push(request);
      try {
        const result = await plan.filePlan.executeNext({ signal: options.signal });
        if (request.error) throw this.coordinationError(request.error, result);
        return result;
      } finally {
        const index = this.executionRequests.indexOf(request);
        if (index >= 0) this.executionRequests.splice(index, 1);
      }
    }
    const editorSnapshots = this.documents.snapshotsForOperation(step.operation);
    const inspection =
      step.operation.kind === "rename"
        ? (
            await plan.fileOperationsExecutor.inspect([step.operation.oldPath], {
              signal: options.signal,
            })
          )[0]
        : null;
    options.signal?.throwIfAborted();
    const documentMove =
      step.operation.kind === "rename"
        ? lumine.workspace.beginFileMove([
            {
              ...step.operation,
              isDirectory: inspection?.status === "directory",
            },
          ])
        : null;
    const pathChangeToken = {};
    this.documents.suppressPathChanges(editorSnapshots, pathChangeToken);
    let result;
    let operationError;
    let logicalEditorPaths;
    try {
      try {
        await documentMove?.ready;
        options.beforeMutation?.();
        result = await plan.filePlan.executeNext({ signal: options.signal });
      } catch (error) {
        operationError = error;
      }
      try {
        await documentMove?.complete(
          (result?.effects || []).filter((effect) => effect.kind === "rename"),
        );
        logicalEditorPaths = this.documents.pathsAfterEffects(result?.effects, editorSnapshots);
      } catch (error) {
        operationError ||= error;
      }
    } finally {
      if (!logicalEditorPaths) {
        try {
          logicalEditorPaths = this.documents.pathsAfterEffects(result?.effects, editorSnapshots);
        } catch (error) {
          operationError ||= error;
        }
      }
      logicalEditorPaths ||= new Map(
        editorSnapshots.map(({ editor, path: filePath }) => [editor, filePath]),
      );
      try {
        if (result) this.publishEffects(result.effects);
      } catch (error) {
        operationError ||= error;
      }
      try {
        await this.documents.reattachPaths(pathChangeToken);
        await this.documents.stabilizePaths(logicalEditorPaths);
      } finally {
        this.documents.releasePaths(pathChangeToken);
      }
    }
    if (operationError) throw this.coordinationError(operationError, result);
    return result;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const preparation of [...this.preparations]) preparation.dispose();
    this.setExecutor(null);
    this.flushGates();
    for (const registration of this.lifecycleRegistrations.values())
      registration.subscriptions.dispose();
    this.lifecycleRegistrations.clear();
    this.suppressions.clear();
  }
};
