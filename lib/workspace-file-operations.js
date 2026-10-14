const { CompositeDisposable } = require("lumine");
const { pathKey, relativePath } = require("./workspace-paths");
let operationRuntime;
const getOperationRuntime = () =>
  (operationRuntime ||= require("./workspace-file-operations-runtime"));

// Own executor registration and empty-session watching without loading file effects.
module.exports = class WorkspaceFileOperations {
  constructor({ documents, getDocuments, host }) {
    this._documents = documents;
    this.getDocuments = getDocuments;
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
  get documents() {
    return (this._documents ||= this.getDocuments());
  }
  set documents(documents) {
    this._documents = documents;
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
  deliverEvents(...args) {
    if (this.host.hasSessions?.() === false && !this.suppressions.size) return;
    return getOperationRuntime().deliverEvents.apply(this, args);
  }
  notifyWatchedFiles(...args) {
    return getOperationRuntime().notifyWatchedFiles.apply(this, args);
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
  rememberInternalRoots(...args) {
    return getOperationRuntime().rememberInternalRoots.apply(this, args);
  }
  eventsForEffects(...args) {
    return getOperationRuntime().eventsForEffects.apply(this, args);
  }
  eventCoveredByGate(...args) {
    return getOperationRuntime().eventCoveredByGate.apply(this, args);
  }
  gateKey(...args) {
    return getOperationRuntime().gateKey.apply(this, args);
  }
  beginGate(...args) {
    return getOperationRuntime().beginGate.apply(this, args);
  }
  finishGate(...args) {
    return getOperationRuntime().finishGate.apply(this, args);
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
  matches(...args) {
    return getOperationRuntime().matches.apply(this, args);
  }
  suppressProjectEvent(...args) {
    return getOperationRuntime().suppressProjectEvent.apply(this, args);
  }
  consumeSuppression(...args) {
    return getOperationRuntime().consumeSuppression.apply(this, args);
  }
  fileEntries(...args) {
    return getOperationRuntime().fileEntries.apply(this, args);
  }
  renameEntries(...args) {
    return getOperationRuntime().renameEntries.apply(this, args);
  }
  matchingFileEntries(...args) {
    return getOperationRuntime().matchingFileEntries.apply(this, args);
  }
  matchingRenameEntries(...args) {
    return getOperationRuntime().matchingRenameEntries.apply(this, args);
  }
  prepareOperation(...args) {
    return getOperationRuntime().prepareOperation.apply(this, args);
  }
  commitPreparation(...args) {
    return getOperationRuntime().commitPreparation.apply(this, args);
  }
  willCreateFiles(...args) {
    return getOperationRuntime().willCreateFiles.apply(this, args);
  }
  prepareCreateFiles(...args) {
    return getOperationRuntime().prepareCreateFiles.apply(this, args);
  }
  willRenameFiles(...args) {
    return getOperationRuntime().willRenameFiles.apply(this, args);
  }
  prepareRenameFiles(...args) {
    return getOperationRuntime().prepareRenameFiles.apply(this, args);
  }
  willDeleteFiles(...args) {
    return getOperationRuntime().willDeleteFiles.apply(this, args);
  }
  prepareDeleteFiles(...args) {
    return getOperationRuntime().prepareDeleteFiles.apply(this, args);
  }
  didCreateFiles(...args) {
    return getOperationRuntime().didCreateFiles.apply(this, args);
  }
  didRenameFiles(...args) {
    return getOperationRuntime().didRenameFiles.apply(this, args);
  }
  didDeleteFiles(...args) {
    return getOperationRuntime().didDeleteFiles.apply(this, args);
  }
  notifyOperation(...args) {
    return getOperationRuntime().notifyOperation.apply(this, args);
  }
  publishEffects(...args) {
    return getOperationRuntime().publishEffects.apply(this, args);
  }
  cleanupPaths(...args) {
    return getOperationRuntime().cleanupPaths.apply(this, args);
  }
  coordinationError(...args) {
    return getOperationRuntime().coordinationError.apply(this, args);
  }
  executeStep(...args) {
    return getOperationRuntime().executeStep.apply(this, args);
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
