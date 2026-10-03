const ServerSession = require("../lib/server-session");
const IntentionsProvider = require("../lib/intentions-provider");

describe("language-server command capabilities", () => {
  it("combines static and independently registered command sets and honours removal", () => {
    const registrations = new Map([
      [
        "first",
        { method: "workspace/executeCommand", registerOptions: { commands: ["server.first"] } },
      ],
      [
        "second",
        { method: "workspace/executeCommand", registerOptions: { commands: ["server.second"] } },
      ],
    ]);
    const session = {
      capabilities: { executeCommandProvider: { commands: ["server.static"] } },
      manager: { dynamicCapabilities: new Map(), selectorMatches: () => true },
    };
    session.manager.dynamicCapabilities.set(session, registrations);
    const allowed = (command) => ServerSession.prototype.canExecuteCommand.call(session, command);
    expect(allowed("server.static")).toBe(true);
    expect(allowed("server.first")).toBe(true);
    expect(allowed("server.second")).toBe(true);
    expect(allowed("roslyn.client.fixAllCodeAction")).toBe(false);
    registrations.delete("first");
    expect(allowed("server.first")).toBe(false);
    expect(allowed("server.second")).toBe(true);
  });

  it("does not expose capabilities from a different document selector", () => {
    const session = {
      capabilities: {},
      manager: { dynamicCapabilities: new Map(), selectorMatches: () => false },
    };
    session.manager.dynamicCapabilities.set(
      session,
      new Map([
        [
          "php",
          {
            method: "workspace/executeCommand",
            registerOptions: { commands: ["server.php"], documentSelector: [{ language: "php" }] },
          },
        ],
      ]),
    );
    expect(ServerSession.prototype.canExecuteCommand.call(session, "server.php", {})).toBe(false);
  });

  it("filters client commands from actions while keeping edit-based fixes", async () => {
    const calls = [];
    const session = {
      capabilities: { executeCommandProvider: { commands: [] } },
      supports: () => true,
      request: async (method) => {
        calls.push(method);
        return [
          { title: "Fix all", command: { command: "roslyn.client.fixAllCodeAction" } },
          { title: "Fix syntax", edit: { changes: {} } },
        ];
      },
    };
    const manager = {
      addCapabilityFragment() {},
      activeSessionsForEditor: async () => [session],
      uriForEditor: () => "file:///project/example.cs",
      diagnosticsFor: () => [],
    };
    const provider = new IntentionsProvider(manager);
    const actions = await provider.getIntentions({
      textEditor: {},
      bufferPosition: { row: 0, column: 0 },
    });
    expect(actions.map(({ title }) => title)).toEqual(["Fix syntax"]);
    expect(calls).toEqual(["textDocument/codeAction"]);
  });

  it("rejects a client command discovered during resolve before applying any edit", async () => {
    const applied = [];
    const calls = [];
    const session = {
      capabilities: { executeCommandProvider: { commands: [] } },
      capabilityOptions: () => ({ resolveProvider: true }),
      request: async (method) => {
        calls.push(method);
        return { edit: { changes: {} }, command: { command: "client.only" } };
      },
    };
    const provider = new IntentionsProvider({
      addCapabilityFragment() {},
      applyWorkspaceEdit: async (edit) => {
        applied.push(edit);
        return true;
      },
    });
    spyOn(lumine.notifications, "addWarning");
    await provider.applyAction(session, { title: "Late command", data: {} });
    expect(applied).toEqual([]);
    expect(calls).toEqual(["codeAction/resolve"]);
    expect(lumine.notifications.addWarning).toHaveBeenCalled();
  });
});
