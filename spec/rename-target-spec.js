const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Manager = require("../lib/language-server-manager");
const Session = require("../lib/server-session");

describe("canonical language-server rename targets", () => {
  let root, manager, session, editor, uri;
  beforeEach(async () => {
    jasmine.useRealClock();
    root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-rename-target-"));
    const file = path.join(root, "main.js");
    fs.writeFileSync(file, "const value = 1;\n");
    uri = pathToFileURL(file).href;
    editor = await lumine.workspace.open(file);
    manager = new Manager();
    session = new Session(
      manager,
      { id: "rename-target", displayName: "Rename Target", grammarScopes: ["source.js"] },
      root,
      {
        command: process.execPath,
        args: [
          path.join(__dirname, "fixtures", "fake-server.js"),
          JSON.stringify({
            capabilities: {
              textDocumentSync: { openClose: true, change: 2 },
              renameProvider: true,
            },
            responses: { "textDocument/rename": { changes: {} } },
          }),
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        transport: "stdio",
      },
    );
    await session.start();
    await session.openEditor(editor);
  });
  afterEach(async () => {
    await session?.stop();
    await manager?.deactivate();
    editor?.destroy();
    const prefix = path.join(fs.realpathSync.native(os.tmpdir()), "ide-rename-target-");
    if (root?.startsWith(prefix))
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const rename = () =>
    session.request("textDocument/rename", {
      textDocument: { uri },
      position: { line: 0, character: 6 },
      newName: "next",
    });
  const requests = async () =>
    (await session.request("test/getReceived")).filter(
      ({ method }) => method === "textDocument/rename",
    );

  it("sends the canonical target without changing the caller's parameters", async () => {
    const canonical = {
      uri: pathToFileURL(path.join(root, "interface.js")).href,
      position: { line: 2, character: 8 },
    };
    session.adapter.resolveRenameTarget = async () => canonical;
    await rename();
    const [request] = await requests();
    expect(request.params.textDocument.uri).toBe(canonical.uri);
    expect(request.params.position).toEqual(canonical.position);
    expect(request.params.newName).toBe("next");
  });

  it("preserves an undefined target and declines null without a rename request", async () => {
    session.adapter.resolveRenameTarget = async () => null;
    expect(await rename()).toBeNull();
    expect(await requests()).toEqual([]);
    session.adapter.resolveRenameTarget = async () => undefined;
    await rename();
    expect((await requests())[0].params.textDocument.uri).toBe(uri);
  });

  it("refuses stale lookup results before sending a rename", async () => {
    let release, started;
    const lookupStarted = new Promise((resolve) => {
      started = resolve;
    });
    session.adapter.resolveRenameTarget = () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = rename();
    await lookupStarted;
    editor.setText("const other = 2;\n");
    release({ uri, position: { line: 0, character: 6 } });
    await expectAsync(pending).toBeRejected();
    expect(await requests()).toEqual([]);
  });

  it("rejects malformed target positions", async () => {
    session.adapter.resolveRenameTarget = async () => ({
      uri,
      position: { line: -1, character: 0 },
    });
    await expectAsync(rename()).toBeRejectedWithError(/invalid rename target/);
    expect(await requests()).toEqual([]);
  });
});
