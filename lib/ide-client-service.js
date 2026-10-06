// A service belongs to one activation. A callback retained by a consumer after
// its edge disappears must never act on a subsequently activated manager.
module.exports = function createIdeClientService(owner) {
  const manager = owner.manager;
  const generation = owner.activationGeneration;
  const methods = {
    registerAdapter: (adapter) => {
      if (adapter?.managedServer || typeof adapter?.installServer === "function")
        owner.ensureManagedServers();
      return manager.registerAdapter(adapter);
    },
    adaptersForEditor: (editor) => manager.adaptersForEditor(editor),
    onDidChangeAdapters: (fn) => manager.onDidChangeAdapters(fn),
    sessionForEditor: (editor) => manager.sessionForEditor(editor),
    activeSessionForEditor: (editor) => manager.activeSessionForEditor(editor),
    activeSessionsForEditor: (editor) => manager.activeSessionsForEditor(editor),
    activeSessionForFeature: (editor, method, feature) =>
      manager.activeSessionForFeature(editor, method, feature),
    getSessions: () => manager.allSessions(),
    onDidChangeSession: (fn) => manager.onDidChangeSession(fn),
    onDidChangeCapabilities: (fn) => manager.onDidChangeCapabilities(fn),
    onDidPublishDiagnostics: (fn) => manager.onDidPublishDiagnostics(fn),
    createProjectDiagnostics: (adapterId, delegate) => {
      const ProjectDiagnostics = require("./project-diagnostics");
      return new ProjectDiagnostics(manager, adapterId, delegate);
    },
    onDidChangeFeatures: (fn) => manager.onDidChangeFeatures(fn),
    featureEnabled: (adapter, feature, editor) => manager.featureEnabled(adapter, feature, editor),
    onDidLog: (fn) => manager.onDidLog(fn),
    request: (editor, method, params, options) =>
      manager.sessionForEditor(editor)?.request(method, params, options),
    restart: (session) => manager.restart(session),
    stop: (session) => manager.disconnect(session),
    getLog: (adapterId) => manager.getLog(adapterId),
    // Managed servers. An adapter reaches for these to offer an install where
    // it would otherwise only report the server missing; the same calls back
    // the Manage Servers list.
    reportMissingServer: (adapterId, options) => owner.reportMissingServer(adapterId, options),
    installServer: (adapterId, options) => owner.installServer(adapterId, options),
    updateServer: (adapterId) => owner.updateServer(adapterId),
    uninstallServer: (adapterId) => owner.ensureManagedServers().uninstall(adapterId),
    managedServer: (adapterId) =>
      owner.ensureManagedServers().installFor(manager.adapters.get(adapterId)),
    serverInstallationStatus: (adapterId) =>
      owner.ensureManagedServers().installationStatus(adapterId),
    onDidChangeServerInstallation: (fn) => owner.ensureManagedServers().onDidChangeInstallation(fn),
    applyWorkspaceEdit: (edit, label, session) => manager.applyWorkspaceEdit(edit, label, session),
    willCreateFiles: (payload) => manager.willCreateFiles(payload),
    willRenameFiles: (payload) => manager.willRenameFiles(payload),
    willDeleteFiles: (payload) => manager.willDeleteFiles(payload),
    didCreateFiles: (payload) => manager.didCreateFiles(payload),
    didRenameFiles: (payload) => manager.didRenameFiles(payload),
    didDeleteFiles: (payload) => manager.didDeleteFiles(payload),
    // Notebook documents. `openNotebookDocument` is the bridge a notebook UI
    // drives — jupyter-view itself — and the rest of LSP follows:
    // sync, routing of the cell editors through every provider, and cell
    // diagnostics landing against the notebook.
    openNotebookDocument: (descriptor) => owner.ensureNotebookDocuments().open(descriptor),
    adaptersForNotebook: (filePath) => owner.notebookDocuments?.adaptersForNotebook(filePath) ?? [],
    cellUri: (notebookPath, cellId) => require("./converters").cellUri(notebookPath, cellId),
    parseCellUri: (uri) => require("./converters").parseCellUri(uri),
    openNotebook: (session, notebook, cells) => session.openNotebook(notebook, cells),
    changeNotebook: (session, notebook, change) => session.changeNotebook(notebook, change),
    saveNotebook: (session, notebook) => session.saveNotebook(notebook),
    closeNotebook: (session, notebook, cells) => session.closeNotebook(notebook, cells),
  };
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      (...args) => {
        if (
          owner.activationGeneration !== generation ||
          owner.manager !== manager ||
          manager.tearingDown
        )
          throw new DOMException("The ide-client service is no longer active", "AbortError");
        return method(...args);
      },
    ]),
  );
};
