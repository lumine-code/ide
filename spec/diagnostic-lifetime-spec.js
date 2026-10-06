const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Manager = require("../lib/language-server-manager");
const Session = require("../lib/server-session");
const C = require("../lib/converters");
const { publishSession } = require("./helpers/session-fixtures");

describe("diagnostics and capabilities during session retirement", () => {
  let manager, session, directory, uri, releaseShutdown;
  const diagnostics = [
    {
      message: "old error",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    },
  ];
  const registration = { id: "hover-provider", method: "textDocument/hover", registerOptions: {} };
  beforeEach(async () => {
    jasmine.useRealClock();
    manager = new Manager();
    directory = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "ide-diagnostic-lifetime-"),
    );
    uri = C.pathToUri(path.join(directory, "source.js"));
    const launch = {
      command: process.execPath,
      args: [path.join(__dirname, "fixtures", "fake-server.js"), "{}"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      transport: "stdio",
    };
    session = new Session(
      manager,
      {
        id: "diagnostic-lifetime",
        displayName: "Diagnostic lifetime",
        grammarScopes: ["source.js"],
        resolveServer: () => launch,
      },
      directory,
      launch,
    );
    await session.start();
    publishSession(manager, session);
  });
  afterEach(async () => {
    releaseShutdown?.();
    releaseShutdown = null;
    await session.stop();
    await manager.deactivate();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(path.resolve(directory)) !== fs.realpathSync.native(os.tmpdir()) ||
      !path.basename(directory).startsWith("ide-diagnostic-lifetime-")
    )
      throw new Error("Unsafe diagnostic fixture cleanup");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const notify = (method, params, id) =>
    session.connection.request("test/notify", {
      jsonrpc: "2.0",
      method,
      params,
      ...(id === undefined ? {} : { id }),
    });
  const deferShutdown = () => {
    const gate = new Promise((resolve) => {
      releaseShutdown = resolve;
    });
    const request = session.connection.request.bind(session.connection);
    spyOn(session.connection, "request").and.callFake(async (method, ...args) => {
      if (method === "shutdown") await gate;
      return request(method, ...args);
    });
    return session.stop();
  };
  it("withdraws existing diagnostics when logical shutdown begins", async () => {
    await notify("textDocument/publishDiagnostics", { uri, diagnostics });
    expect(manager.diagnosticsFor(session, uri).length).toBe(1);
    const cleared = jasmine.createSpy("diagnostics cleared");
    const edge = manager.onDidPublishDiagnostics(cleared);
    const stopping = deferShutdown();
    try {
      expect(session.state).toBe("stopping");
      expect(manager.diagnostics.has(session)).toBe(false);
      expect(cleared.calls.count()).toBe(1);
      const report = cleared.calls.first().args[0];
      expect(report.session).toBe(session);
      expect(report.uri).toBe(uri);
      expect(report.diagnostics).toEqual([]);
    } finally {
      edge.dispose();
      releaseShutdown();
      await stopping;
    }
  });
  it("rejects pushed diagnostics while waiting for shutdown", async () => {
    const stopping = deferShutdown();
    try {
      await notify("textDocument/publishDiagnostics", { uri, diagnostics });
      expect(manager.diagnosticsFor(session, uri)).toEqual([]);
      expect(session.diagnosticReports.size).toBe(0);
    } finally {
      releaseShutdown();
      await stopping;
    }
  });
  it("retires dynamic capabilities and ignores registration traffic during shutdown", async () => {
    await notify("client/registerCapability", { registrations: [registration] }, 7001);
    expect(manager.dynamicCapabilities.get(session)?.has(registration.id)).toBe(true);
    const changed = jasmine.createSpy("capabilities changed");
    const edge = manager.onDidChangeCapabilities(changed);
    const stopping = deferShutdown();
    try {
      expect(manager.dynamicCapabilities.has(session)).toBe(false);
      await notify("client/registerCapability", { registrations: [registration] }, 7002);
      await notify("client/unregisterCapability", { unregisterations: [registration] }, 7003);
      expect(manager.dynamicCapabilities.has(session)).toBe(false);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      edge.dispose();
      releaseShutdown();
      await stopping;
    }
  });
  it("accepts legitimate server traffic while initialized startup hooks are still pending", async () => {
    await session.stop();
    const launch = session.launch;
    let entered, resume;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const hook = new Promise((resolve) => {
      resume = resolve;
    });
    const adapter = {
      ...session.adapter,
      async getInitializedNotifications() {
        entered();
        await hook;
        return [];
      },
    };
    session = new Session(manager, adapter, directory, launch);
    const starting = session.start();
    await started;
    try {
      expect(session.state).toBe("starting");
      await notify("client/registerCapability", { registrations: [registration] }, 7004);
      await notify("textDocument/publishDiagnostics", { uri, diagnostics });
      expect(manager.dynamicCapabilities.get(session)?.has(registration.id)).toBe(true);
      expect(manager.diagnosticsFor(session, uri).length).toBe(1);
    } finally {
      resume();
      await starting;
    }
    expect(session.state).toBe("running");
  });
});
