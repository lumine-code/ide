const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Manager = require("../lib/language-server-manager");
const Session = require("../lib/server-session");

describe("canonical language-server rename targets", () => {
  let root, manager, session, editor, uri, targets;
  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    jasmine.useRealClock();
    root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-rename-target-"));
    const file = path.join(root, "main.js");
    fs.writeFileSync(file, "const value = 1;\n");
    uri = pathToFileURL(file).href;
    editor = await lumine.workspace.open(file);
    targets = [];
    manager = new Manager();
    session = new Session(
      manager,
      {
        id: "rename-target",
        displayName: "Rename Target",
        grammarScopes: ["source.js"],
        caseSensitiveFileNames: false,
      },
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
    for (const target of targets || []) if (!target.isDestroyed()) target.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
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

  const openTarget = async (filePath) => {
    const target = await lumine.workspace.open(filePath);
    targets.push(target);
    await session.openEditor(target);
    return target;
  };
  const holdRename = () => {
    const sent = Promise.withResolvers();
    const response = Promise.withResolvers();
    const request = session.connection.request.bind(session.connection);
    spyOn(session.connection, "request").and.callFake((method, ...args) => {
      if (method !== "textDocument/rename") return request(method, ...args);
      sent.resolve();
      return response.promise;
    });
    return { pending: rename(), sent: sent.promise, reply: response.resolve };
  };
  const changeTarget = (uri) => ({
    textDocument: { uri, version: 1 },
    edits: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "renamed",
      },
    ],
  });

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

  it("refuses a secondary target reopened at the same version under an aliased URI", async () => {
    const file = path.join(root, "secondary.js");
    const fileUri = pathToFileURL(file).href;
    fs.writeFileSync(file, "value();\n");
    const target = await openTarget(file);
    const original = session.documents.get(fileUri);
    const { pending, sent, reply } = holdRename();
    await sent;

    target.destroy();
    const replacement = await openTarget(file);
    const reopened = session.documents.get(fileUri);
    expect(reopened).not.toBe(original);
    expect(reopened.version).toBe(original.version);

    reply({ documentChanges: [changeTarget(fileUri.replace("secondary.js", "SECONDARY.js"))] });
    const result = await manager.applyWorkspaceEditDetailed(await pending, "Rename", session);
    expect(result).toEqual(
      jasmine.objectContaining({
        applied: false,
        failedChange: 0,
        failureReason: jasmine.stringMatching(/reopened or replaced/),
      }),
    );
    expect(replacement.getText()).toBe("value();\n");
  });

  it("keeps a stable secondary target valid when an unrelated document is reopened", async () => {
    const file = path.join(root, "secondary.js");
    const other = path.join(root, "unrelated.js");
    fs.writeFileSync(file, "value();\n");
    fs.writeFileSync(other, "other();\n");
    const target = await openTarget(file);
    const unrelated = await openTarget(other);
    const { pending, sent, reply } = holdRename();
    await sent;
    unrelated.destroy();
    await openTarget(other);

    reply({ documentChanges: [changeTarget(pathToFileURL(file).href)] });
    expect(
      (await manager.applyWorkspaceEditDetailed(await pending, "Rename", session)).applied,
    ).toBe(true);
    expect(target.getText()).toBe("renamed();\n");
  });

  it("checks the original document before executing a resource rename and its follow-up edit", async () => {
    const oldPath = path.join(root, "secondary.js");
    const oldUri = pathToFileURL(oldPath).href;
    const newUri = pathToFileURL(path.join(root, "moved.js")).href;
    fs.writeFileSync(oldPath, "value();\n");
    const target = await openTarget(oldPath);
    const executeNext = jasmine.createSpy("execute file rename");
    const dispose = jasmine.createSpy("dispose file rename");
    manager.setFileOperationsExecutor({
      prepare: async () => ({
        status: "ready",
        plan: { describe: () => [{ status: "apply" }], executeNext, dispose },
      }),
    });
    const { pending, sent, reply } = holdRename();
    await sent;
    target.destroy();
    const replacement = await openTarget(oldPath);

    reply({ documentChanges: [{ kind: "rename", oldUri, newUri }, changeTarget(newUri)] });
    const result = await manager.applyWorkspaceEditDetailed(await pending, "Rename", session);
    expect(result.applied).toBe(false);
    expect(result.failedChange).toBe(1);
    expect(result.failureReason).toMatch(/reopened or replaced/);
    expect(executeNext).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(replacement.getText()).toBe("value();\n");
  });
});
