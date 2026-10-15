const { spawnSync } = require("node:child_process");

describe("IDE startup boundaries", () => {
  it("registers managed adapters without loading session, edit or installation runtimes", () => {
    const script = `
const assert = require("node:assert/strict");
const Module = require("node:module");
const api = Module.createRequire(${JSON.stringify(require.resolve("lumine"))})("@lumine-code/event-kit");
const originalLoad = Module._load;
Module._load = function(specifier, ...args) {
  return specifier === "lumine" ? api : originalLoad.call(this, specifier, ...args);
};
const subscribe = () => new api.Disposable();
global.lumine = {
  config: { get: () => undefined, onDidChange: subscribe, onDidChangeConfiguration: subscribe },
  commands: { add: subscribe },
  grammars: { onDidAddGrammar: subscribe, onDidUpdateGrammar: subscribe, onDidRemoveGrammar: subscribe },
  project: { getPaths: () => [], onDidChangePaths: subscribe, onDidChangeFiles: subscribe, onDidInvalidateFiles: subscribe },
  workspace: { getTextEditors: () => [], observeTextEditors: subscribe },
  window: { onWillDestroy: subscribe },
};
(async () => {
  const main = require(${JSON.stringify(require.resolve("../lib/main"))});
  main.initialize();
  main.activate();
  await Promise.resolve();
  assert.equal(main.manager._fileOperations, null);
  const busySignal = {};
  main.manager.setBusySignal(busySignal);
  assert.equal(main.manager._busySignal, busySignal);
  assert.equal(main.manager._activity, null);
  main.manager.setBusySignal(null);
  const completion = main.provideAutocomplete();
  const signature = main.provideHoverSignature();
  assert.deepEqual([...completion.triggerCharacters], []);
  assert.deepEqual([...signature.triggerCharacters], []);
  assert.deepEqual([...signature.retriggerCharacters], []);
  main.manager.sessions.set("metadata", {
    state: "running",
    capabilityOptions: method => method === "textDocument/completion"
      ? { triggerCharacters: [".", ":", "."] }
      : { triggerCharacters: ["("], retriggerCharacters: [","] },
  });
  assert.deepEqual([...completion.triggerCharacters], [".", ":"]);
  assert.deepEqual([...signature.triggerCharacters], ["("]);
  assert.deepEqual([...signature.retriggerCharacters], [","]);
  main.manager.sessions.clear();
  assert.notEqual(main._providersReady, true);
  let beforeStep, afterStep;
  main.manager.setFileOperationsExecutor({
    onWillExecuteStep(callback) { beforeStep = callback; return new api.Disposable(); },
    onDidExecuteStep(callback) { afterStep = callback; return new api.Disposable(); },
  });
  assert.equal(typeof beforeStep, "function");
  assert.equal(typeof afterStep, "function");
  const service = main.provideIde();
  const adapter = {
    id: "startup-test", displayName: "Startup Test", grammarScopes: ["source.startup"],
    resolveServer: async () => null,
    managedServer: { source: "npm", packages: ["startup-test"], module: "server.js" },
  };
  const registered = service.registerAdapter(adapter);
  assert.equal(main.manager.adapters.get(adapter.id), adapter);
  assert.equal(main.managedServers, undefined);
  let delegates = 0;
  const linterConnection = main.consumeLinterRegistry(() => {
    delegates++;
    return { dispose() {} };
  });
  assert.equal(delegates, 1);
  const projectDiagnostics = service.createProjectDiagnostics("startup-test", { setAllMessages() {} });
  projectDiagnostics.setAllMessages([]);
  projectDiagnostics.dispose();
  main.manager.fileOperations.routeEvents([{ action: "updated", path: "C:/startup/test.js" }]);
  linterConnection.dispose();
  registered.dispose();
  await main.deactivate();
  assert.throws(() => completion.triggerCharacters, { name: "AbortError" });
  for (const filename of ${JSON.stringify(["server-session", "session-controller", "workspace-edits", "workspace-documents", "diagnostic-scope-cache", "server-activity", "converters", "linter-messages", "language-ids", "capabilities", "server-resolver", "managed-servers", "installation-store", "installation-controller", "installation-io", "file-operation-preparation", "workspace-file-operations-runtime", "language-server-manager-runtime", "completion-provider", "signature-provider", "documentation-code-block", "workspace-file-operations", "linter-bridge", "linter-bridge-runtime", "adapter-selection", "file-watchers", "provider-characters"].map((file) => require.resolve("../lib/" + file)))}) {
    assert.equal(require.cache[filename], undefined, filename + " loaded before an IDE operation");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    expect(result.status)
      .withContext(result.stderr || result.error?.message)
      .toBe(0);
  });
});
