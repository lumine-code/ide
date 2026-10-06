const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Manager = require("../lib/language-server-manager");
const Session = require("../lib/server-session");

describe("adapter request and response normalization", () => {
  let root, manager, session, editor, uri;
  beforeEach(async () => {
    jasmine.useRealClock();
    root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-request-adapter-"));
    const file = path.join(root, "main.js");
    fs.writeFileSync(file, 'const text = "😀"; const value = 1;\n');
    uri = pathToFileURL(file).href;
    editor = await lumine.workspace.open(file);
    manager = new Manager();
    session = new Session(
      manager,
      { id: "request-adapter", displayName: "Request Adapter", grammarScopes: ["source.js"] },
      root,
      {
        command: process.execPath,
        args: [
          path.join(__dirname, "fixtures/fake-server.js"),
          JSON.stringify({
            capabilities: {
              textDocumentSync: { openClose: true, change: 1 },
              definitionProvider: true,
            },
            responses: {
              "textDocument/definition": {
                uri,
                range: { start: { line: 0, character: 24 }, end: { line: 0, character: 29 } },
                data: { opaque: 24 },
              },
            },
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
    const base = fs.realpathSync.native(os.tmpdir());
    if (path.dirname(root) !== base || !path.basename(root).startsWith("ide-request-adapter-"))
      throw new Error("Unsafe fixture cleanup");
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const params = () => ({ textDocument: { uri }, position: { line: 0, character: 22 } });
  const request = () => session.request("textDocument/definition", params());
  const sent = async () =>
    (await session.request("test/getReceived")).filter(
      ({ method }) => method === "textDocument/definition",
    );

  it("maps wire parameters and restores results before consumers see them without mutating callers", async () => {
    let snapshot;
    session.adapter.prepareRequest = (method, value, context) => {
      if (method !== "textDocument/definition") return;
      snapshot = context.getDocument(uri);
      return {
        params: { ...value, position: { ...value.position, character: 24 } },
        mapResult: (result) => ({
          ...result,
          range: { start: { line: 0, character: 22 }, end: { line: 0, character: 27 } },
        }),
      };
    };
    const original = params();
    const result = await session.request("textDocument/definition", original);
    expect(original.position.character).toBe(22);
    expect((await sent())[0].params.position.character).toBe(24);
    expect(result.range.start.character).toBe(22);
    expect(result.data.opaque).toBe(24);
    expect(snapshot.text).toContain("😀");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.isCurrent()).toBe(true);
  });
  it("preserves default parameters when preparation returns nothing or only a result mapper", async () => {
    session.adapter.prepareRequest = () => undefined;
    await request();
    session.adapter.prepareRequest = (method) =>
      method === "textDocument/definition" ? { mapResult: () => [] } : undefined;
    expect(await request()).toEqual([]);
    expect((await sent()).every(({ params }) => params.position.character === 22)).toBe(true);
  });
  it("refuses preparation after the captured document changes before sending a wire request", async () => {
    let release, started;
    const preparing = new Promise((resolve) => {
      started = resolve;
    });
    session.adapter.prepareRequest = async (method, _params, context) => {
      if (method !== "textDocument/definition") return;
      context.getDocument(uri);
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
      return {};
    };
    const pending = request();
    await preparing;
    editor.setText("const other = 1;\n");
    release();
    await expectAsync(pending).toBeRejected();
    expect(await sent()).toEqual([]);
  });
  it("rejects a stale asynchronous mapper before publishing edits or locations", async () => {
    let release, started;
    const mapping = new Promise((resolve) => {
      started = resolve;
    });
    session.adapter.prepareRequest = (method, _params, context) => {
      if (method !== "textDocument/definition") return;
      context.getDocument(uri);
      return {
        mapResult: async (result) => {
          started();
          await new Promise((resolve) => {
            release = resolve;
          });
          return result;
        },
      };
    };
    const pending = request();
    await mapping;
    editor.setText("const next = 2;\n");
    release();
    await expectAsync(pending).toBeRejected();
  });
  it("honours cancellation during preparation and rejects malformed adapter results", async () => {
    const controller = new AbortController();
    session.adapter.prepareRequest = (method) => {
      if (method === "textDocument/definition") controller.abort(new Error("cancelled"));
      return {};
    };
    await expectAsync(
      session.request("textDocument/definition", params(), { signal: controller.signal }),
    ).toBeRejectedWithError(/cancelled/);
    expect(await sent()).toEqual([]);
    session.adapter.prepareRequest = () => ({ mapResult: "invalid" });
    await expectAsync(request()).toBeRejectedWithError(/invalid prepared/);
  });
  it("supplies temporary wire text and releases snapshots when their document closes", async () => {
    const temporaryUri = pathToFileURL(path.join(root, "temporary.js")).href;
    let snapshot;
    session.adapter.prepareRequest = (method, _value, context) => {
      if (method === "textDocument/definition") snapshot = context.getDocument(temporaryUri);
    };
    await session.withTemporaryDocument(
      { uri: temporaryUri, languageId: "javascript", text: "const temporary = 1;\n" },
      async (uri) => {
        await session.request("textDocument/definition", {
          textDocument: { uri },
          position: { line: 0, character: 6 },
        });
        expect(snapshot.text).toBe("const temporary = 1;\n");
        expect(snapshot.isCurrent()).toBe(true);
      },
    );
    expect(snapshot.isCurrent()).toBe(false);
  });
});
