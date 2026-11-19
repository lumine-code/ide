const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");

const FIXTURE = path.join(__dirname, "fixtures", "fake-server.js");
const INLINE_METHOD = "textDocument/inlineCompletion";
const REQUEST = "autocomplete:request-inline-completion";
const ACCEPT = "autocomplete:accept-inline-completion";
const NEXT = "autocomplete:next-inline-completion";
const GHOST = [
  ".autocomplete-inline-ghost-after",
  ".autocomplete-inline-ghost-before",
  ".autocomplete-inline-ghost-end",
  ".autocomplete-inline-ghost-empty",
].join(", ");
const position = (character) => ({ line: 0, character });
const range = { start: position(0), end: position(3) };
const inlineItem = { insertText: "helloInline()", range };

async function waitFor(read, label) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("LSP inline completion through the editor", () => {
  let root, file, editor, element, service, registration, autocomplete;
  let originalTimeout;

  beforeAll(() => {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 15000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const grammar = await lumine.packages.activatePackage("language-text");
    await grammar.resourceLoadPromise;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-inline-completion-"));
    file = path.join(root, "inline.txt");
    fs.writeFileSync(file, "hel");
    lumine.project.setPaths([root]);
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.enableBuiltinProvider", false);
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
    lumine.config.set("autocomplete.inlineCompletions", true);
    autocomplete = (await lumine.packages.activatePackage("autocomplete")).mainModule;
    service = (await lumine.packages.activatePackage("ide")).mainModule.provideIde();
    editor = await lumine.workspace.open(file);
    editor.setCursorBufferPosition([0, 3]);
    await editor.whenGrammarSettled();
    element = editor.getElement();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    element.focus();
  });

  afterEach(async () => {
    editor?.destroy();
    registration?.dispose();
    await lumine.packages.deactivatePackage("ide");
    await lumine.packages.deactivatePackage("autocomplete");
    if (lumine.packages.isPackageActive("snippets")) {
      await lumine.packages.deactivatePackage("snippets");
    }
    lumine.project.setPaths([]);
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = file = editor = element = service = registration = autocomplete = null;
  });

  async function start({ capabilities = { inlineCompletionProvider: {} }, ...config } = {}) {
    const adapter = {
      id: "inline-fixture",
      displayName: "Inline Completion Fixture",
      grammarScopes: ["text.plain"],
      resolveServer: async ({ rootPath }) => ({
        command: process.execPath,
        args: [
          FIXTURE,
          JSON.stringify({
            ...config,
            capabilities: { textDocumentSync: 2, ...capabilities },
          }),
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        transport: "stdio",
        cwd: rootPath,
      }),
    };
    registration = service.registerAdapter(adapter);
    const session = await waitFor(
      () =>
        service
          .getSessions()
          .find((entry) => entry.adapter === adapter && entry.state === "running"),
      "the fixture to initialize",
    );
    expect(await service.activeSessionForEditor(editor)).toBe(session);
    return session;
  }

  const received = (session) => session.request("test/getReceived");
  const message = async (session, method) =>
    (await received(session)).find((entry) => entry.method === method);
  const ghost = () => element.querySelector(GHOST);
  const ghostText = () => {
    const span = ghost();
    if (!span) return null;
    const before = span.matches(
      ".autocomplete-inline-ghost-before, .autocomplete-inline-ghost-empty",
    );
    return getComputedStyle(span, before ? "::before" : "::after").content;
  };
  const request = () => lumine.commands.dispatch(element, REQUEST);
  const key = (name) =>
    lumine.keymaps.handleKeyboardEvent(
      lumine.keymaps.constructor.buildKeydownEvent(name, { target: element }),
    );
  async function serverRequest(session, id, method, params) {
    await session.request("test/notify", { jsonrpc: "2.0", id, method, params });
    const reply = await waitFor(
      async () => (await received(session)).find((entry) => entry.id === id && !entry.method),
      `${method} acknowledgement`,
    );
    expect(reply.error).toBeUndefined();
  }

  it("previews a negotiated list, accepts one undoable edit, and executes its command after the edit", async () => {
    const command = {
      title: "Record the inline acceptance",
      command: "fixture.inlineAccepted",
      arguments: ["value"],
    };
    const session = await start({
      capabilities: {
        inlineCompletionProvider: {},
        executeCommandProvider: { commands: [command.command] },
      },
      responses: { [INLINE_METHOD]: { items: [{ ...inlineItem, command }] } },
    });
    const initialize = await message(session, "initialize");
    expect(initialize.params.capabilities.textDocument.inlineCompletion).toEqual({
      dynamicRegistration: true,
    });

    request();
    expect(await waitFor(ghostText, "the inline preview")).toContain("loInline()");
    expect(editor.getText()).toBe("hel");
    expect(await message(session, "workspace/executeCommand")).toBeUndefined();
    const inline = await message(session, INLINE_METHOD);
    expect(inline.params).toEqual(
      jasmine.objectContaining({
        textDocument: { uri: pathToFileURL(editor.getPath()).href },
        position: position(3),
        context: { triggerKind: 1 },
      }),
    );

    expect(lumine.commands.canDispatch(element, ACCEPT)).toBeTrue();
    key("tab");
    await waitFor(() => editor.getText() === "helloInline()", "the accepted inline edit");
    const execute = await waitFor(
      () => message(session, "workspace/executeCommand"),
      "the accepted item's server command",
    );
    expect(execute.params).toEqual({ command: command.command, arguments: command.arguments });
    await waitFor(() => !ghost(), "preview removal after accepting");
    const wire = await received(session);
    const changeIndex = wire.findIndex(({ method }) => method === "textDocument/didChange");
    expect(changeIndex).toBeGreaterThan(-1);
    expect(wire.findIndex(({ id }) => id === execute.id)).toBeGreaterThan(changeIndex);
    editor.undo();
    expect(editor.getText()).toBe("hel");
    expect(
      (await received(session)).filter(({ method }) => method === "workspace/executeCommand")
        .length,
    ).toBe(1);
  });

  it("starts and stops routing after matching dynamic registration changes", async () => {
    const session = await start({ capabilities: {}, responses: { [INLINE_METHOD]: [inlineItem] } });
    const advertise = (id, pattern) =>
      serverRequest(session, `register-${id}`, "client/registerCapability", {
        registrations: [
          {
            id,
            method: INLINE_METHOD,
            registerOptions: {
              documentSelector: [{ language: "plaintext", scheme: "file", pattern }],
            },
          },
        ],
      });
    await advertise("other", "**/*.other");
    expect(session.supports(INLINE_METHOD, editor)).toBeFalse();
    expect(lumine.commands.canDispatch(element, REQUEST)).toBeFalse();
    request();
    expect(await message(session, INLINE_METHOD)).toBeUndefined();

    await advertise("matching", "**/*.txt");
    await waitFor(() => session.supports(INLINE_METHOD, editor), "matching inline registration");
    request();
    await waitFor(ghost, "dynamically registered inline preview");
    await serverRequest(session, "unregister-matching", "client/unregisterCapability", {
      unregisterations: [{ id: "matching", method: INLINE_METHOD }],
    });
    await waitFor(() => !session.supports(INLINE_METHOD, editor), "inline registration removal");
    await waitFor(() => !ghost(), "the unregistered inline preview to clear");
    expect(editor.getText()).toBe("hel");
    const count = (await received(session)).filter(({ method }) => method === INLINE_METHOD).length;
    expect(lumine.commands.canDispatch(element, REQUEST)).toBeFalse();
    request();
    expect((await received(session)).filter(({ method }) => method === INLINE_METHOD).length).toBe(
      count,
    );
  });

  it("dismisses the inline preview with Escape without editing", async () => {
    await start({ responses: { [INLINE_METHOD]: [inlineItem] } });
    request();
    await waitFor(ghost, "the inline preview before Escape");
    key("escape");
    await waitFor(() => !ghost(), "the preview to close on Escape");
    expect(editor.getText()).toBe("hel");
    expect(lumine.commands.canDispatch(element, ACCEPT)).toBeFalse();
  });

  it("requests an automatic preview after user input settles and clears it when disabled", async () => {
    const item = { ...inlineItem, range: { start: position(0), end: position(4) } };
    const session = await start({ responses: { [INLINE_METHOD]: [item] } });
    await editor.dispatchTextInput({ kind: "insert", text: "l" }, () => editor.insertText("l"));
    await waitFor(() => ghostText()?.includes("oInline()"), "the automatic inline preview");
    const inbound = await message(session, INLINE_METHOD);
    expect(inbound.params.position).toEqual(position(4));
    expect(inbound.params.context).toEqual({ triggerKind: 2 });
    expect(editor.getText()).toBe("hell");

    lumine.config.set("autocomplete.inlineCompletions", false);
    await waitFor(() => !ghost(), "inline preview removal after disabling the setting");
    expect(lumine.commands.canDispatch(element, REQUEST)).toBeFalse();
    expect(editor.getText()).toBe("hell");
  });

  it("cancels an automatic request with Escape before the server replies", async () => {
    const session = await start({ hang: [INLINE_METHOD] });
    await editor.dispatchTextInput({ kind: "insert", text: "l" }, () => editor.insertText("l"));
    const pending = await waitFor(
      () => message(session, INLINE_METHOD),
      "the automatic inline request",
    );
    expect(pending.params.context).toEqual({ triggerKind: 2 });
    key("escape");
    await waitFor(
      async () =>
        (await received(session)).some(
          (entry) => entry.method === "$/cancelRequest" && entry.params.id === pending.id,
        ),
      "cancellation on the wire",
    );
    expect(ghost()).toBeNull();
    expect(editor.getText()).toBe("hell");
  });

  it("discards a delayed inline reply after its caret moves", async () => {
    const session = await start({ hang: [INLINE_METHOD] });
    request();
    const pending = await waitFor(
      () => message(session, INLINE_METHOD),
      "the first inline request",
    );
    editor.setCursorBufferPosition([0, 1]);
    await waitFor(
      async () =>
        (await received(session)).find(
          (entry) => entry.method === "$/cancelRequest" && entry.params.id === pending.id,
        ),
      "inline request cancellation on the wire",
    );
    await session.request("test/notify", { jsonrpc: "2.0", id: pending.id, result: [inlineItem] });
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    expect(ghost()).toBeNull();
    expect(editor.getText()).toBe("hel");
    expect(lumine.commands.canDispatch(element, ACCEPT)).toBeFalse();
  });

  it("keeps the ordinary suggestion list usable after an inline preview opens", async () => {
    const session = await start({
      capabilities: { inlineCompletionProvider: {}, completionProvider: {} },
      responses: {
        [INLINE_METHOD]: [inlineItem],
        "textDocument/completion": [{ label: "helloList" }],
      },
    });
    request();
    await waitFor(ghost, "the inline preview before opening the list");
    lumine.commands.dispatch(element, "autocomplete:activate");
    await waitFor(
      () =>
        autocomplete.autocompleteManager.suggestionList.items?.find(
          ({ text }) => text === "helloList",
        ),
      "the ordinary completion list",
    );
    expect(await message(session, "textDocument/completion")).toBeDefined();
    await waitFor(() => !ghost(), "the ordinary list to replace the inline preview");
    expect(editor.getText()).toBe("hel");

    key("tab");
    await waitFor(() => editor.getText() === "helloList", "the confirmed ordinary completion");
    await waitFor(() => !ghost(), "the stale inline preview to clear");
  });

  it("cycles to a multiline preview and inserts its lines only on acceptance", async () => {
    const multiline = "helloAgain()\n  onTheNextLine()";
    await start({ responses: { [INLINE_METHOD]: [inlineItem, { insertText: multiline, range }] } });
    request();
    await waitFor(() => ghostText()?.includes("loInline()"), "the first inline candidate");
    lumine.commands.dispatch(element, NEXT);
    await waitFor(() => ghostText()?.includes("loAgain()"), "the alternate inline candidate");
    const continuation = await waitFor(
      () => element.querySelector(".autocomplete-inline-continuation"),
      "the multiline continuation to render",
    );
    expect(continuation.textContent).toBe("  onTheNextLine()");
    expect(editor.getText()).toBe("hel");
    lumine.commands.dispatch(element, ACCEPT);
    await waitFor(() => editor.getText() === multiline, "the multiline edit");
    editor.undo();
    expect(editor.getText()).toBe("hel");
  });

  it("previews LSP snippet defaults and accepts the snippet with its tab stops", async () => {
    await lumine.packages.activatePackage("snippets");
    const item = {
      ...inlineItem,
      insertText: { kind: "snippet", value: "helloInline(${1:arg})$0" },
    };
    await start({ responses: { [INLINE_METHOD]: [item] } });
    request();
    await waitFor(() => ghostText()?.includes("loInline(arg)"), "rendered snippet defaults");
    expect(editor.getText()).toBe("hel");

    lumine.commands.dispatch(element, ACCEPT);
    await waitFor(() => editor.getText() === "helloInline(arg)", "snippet acceptance");
    expect(editor.getSelectedText()).toBe("arg");
    lumine.commands.dispatch(element, "snippets:next-tab-stop");
    expect(editor.getCursorBufferPosition().toArray()).toEqual([0, "helloInline(arg)".length]);
    editor.undo();
    expect(editor.getText()).toBe("hel");
  });
});
