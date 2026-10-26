const path = require("node:path");
const { TextEditor } = require("lumine");
const C = require("../lib/converters");
const Messages = require("../lib/linter-messages");
const runtime = require("../lib/linter-bridge-runtime")({ C, Messages });

describe("Cooperative diagnostic presentation", () => {
  let editor, manager, bridge, delegate, session, uri, entry, finishConversion, pending;
  const diagnostics = (count = 512) =>
    Array.from({ length: count }, (_, index) => ({
      message: `diagnostic ${index}`,
      severity: 2,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }));
  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    pending = [];
    editor = new TextEditor({ text: "value\n" });
    editor.setGrammar(lumine.grammars.grammarForScopeName("text.plain"));
    editor.getBuffer().setPath(path.resolve("cooperative-diagnostics.py"));
    uri = C.pathToUri(editor.getPath());
    const adapter = { id: "test:cooperative" };
    session = { adapter };
    delegate = {
      setMessages: jasmine.createSpy("setMessages"),
      setMessagesAsync: jasmine.createSpy("setMessagesAsync").and.resolveTo(true),
    };
    manager = {
      adapters: new Map([[adapter.id, adapter]]),
      diagnostics: new Map(),
      resolveUri: () => ({ kind: "file", path: editor.getPath() }),
      featureEnabled: () => true,
      featureEnabledForPath: () => true,
      log: jasmine.createSpy("log"),
    };
    bridge = {
      manager,
      disposed: false,
      owners: new Map(),
      pending: new Map(),
      featureRevisions: new Map(),
      delegateFor: () => delegate,
      editorForUri: () => (editor.isDestroyed() ? null : editor),
    };
    entry = { session, uri, diagnostics: diagnostics() };
    manager.diagnostics.set(session, new Map([[C.uriKey(uri), entry]]));
    pending = [];
  });
  afterEach(async () => {
    finishConversion?.({ messages: [] });
    await Promise.allSettled(pending || []);
    if (editor && !editor.isDestroyed()) editor.destroy();
    finishConversion = null;
  });
  function pauseConversion() {
    spyOn(Messages, "toLinterMessagesAsync").and.callFake(
      () =>
        new Promise((resolve) => {
          finishConversion = resolve;
        }),
    );
    const result = runtime.publish.call(bridge, entry);
    pending.push(result);
    return result;
  }
  it("prepares a complete report asynchronously and passes cancellation to capable delegates", async () => {
    const result = runtime.publish.call(bridge, entry);
    pending.push(result);
    expect(delegate.setMessagesAsync).not.toHaveBeenCalled();
    await result;
    expect(delegate.setMessages).not.toHaveBeenCalled();
    expect(delegate.setMessagesAsync.calls.count()).toBe(1);
    const [file, messages, options] = delegate.setMessagesAsync.calls.mostRecent().args;
    expect(file).toBe(editor.getPath());
    expect(messages).toEqual(Messages.toLinterMessages(uri, entry.diagnostics).messages);
    expect(options.signal.aborted).toBe(false);
    expect(bridge.pending.size).toBe(0);
  });
  it("keeps small reports synchronous", () => {
    entry.diagnostics = diagnostics(2);
    runtime.publish.call(bridge, entry);
    expect(delegate.setMessages.calls.count()).toBe(1);
    expect(delegate.setMessagesAsync).not.toHaveBeenCalled();
  });
  it("supports registry implementations exposing only the synchronous service", async () => {
    delete delegate.setMessagesAsync;
    await runtime.publish.call(bridge, entry);
    expect(delegate.setMessages.calls.mostRecent().args[1].length).toBe(512);
  });
  for (const invalidate of ["edit", "close", "feature", "replacement"]) {
    it(`does not publish a prepared report after ${invalidate}`, async () => {
      const result = pauseConversion();
      if (invalidate === "edit") editor.insertText("x");
      if (invalidate === "close") editor.destroy();
      if (invalidate === "feature") bridge.featureRevisions.set(session.adapter, 1);
      if (invalidate === "replacement")
        manager.diagnostics.get(session).set(C.uriKey(uri), { ...entry });
      finishConversion(Messages.toLinterMessages(uri, entry.diagnostics));
      await result;
      expect(delegate.setMessages).not.toHaveBeenCalled();
      expect(delegate.setMessagesAsync).not.toHaveBeenCalled();
      expect(bridge.pending.size).toBe(0);
    });
  }
  it("a clearing report immediately wins over pending conversion", async () => {
    const result = pauseConversion();
    const clear = { ...entry, diagnostics: [] };
    manager.diagnostics.get(session).set(C.uriKey(uri), clear);
    runtime.publish.call(bridge, clear);
    finishConversion(Messages.toLinterMessages(uri, entry.diagnostics));
    await result;
    expect(delegate.setMessages.calls.count()).toBe(1);
    expect(delegate.setMessages.calls.mostRecent().args[1]).toEqual([]);
    expect(delegate.setMessagesAsync).not.toHaveBeenCalled();
  });
  it("retires a closed-file preparation when an editor opens before conversion finishes", async () => {
    bridge.editorForUri = () => null;
    const result = pauseConversion();
    bridge.editorForUri = () => editor;
    editor.insertText("new source");
    finishConversion(Messages.toLinterMessages(uri, entry.diagnostics));
    await result;
    expect(delegate.setMessagesAsync).not.toHaveBeenCalled();
    expect(delegate.setMessages).not.toHaveBeenCalled();
  });
  it("releases a synchronous publication when a consumer throws", () => {
    entry.diagnostics = diagnostics(1);
    delegate.setMessages.and.throwError("consumer failed");
    expect(() => runtime.publish.call(bridge, entry)).toThrowError("consumer failed");
    expect(bridge.pending.size).toBe(0);
  });
  it("an older clear cannot remove ownership acquired by a reentrant report", () => {
    const clear = { ...entry, diagnostics: [] };
    const fresh = { ...entry, diagnostics: diagnostics(1) };
    manager.diagnostics.get(session).set(C.uriKey(uri), clear);
    delegate.setMessages.and.callFake((_file, messages) => {
      if (messages.length) return;
      manager.diagnostics.get(session).set(C.uriKey(uri), fresh);
      runtime.publish.call(bridge, fresh);
    });
    runtime.publish.call(bridge, clear);
    expect(bridge.owners.get(session.adapter).get(C.uriKey(uri))).toBe(session);
  });
  it("owns asynchronous delegate errors and releases the job", async () => {
    delegate.setMessagesAsync.and.rejectWith(new Error("delegate failed"));
    await runtime.publish.call(bridge, entry);
    expect(manager.log).toHaveBeenCalledWith(
      session,
      "Unable to present diagnostics: delegate failed",
    );
    expect(bridge.pending.size).toBe(0);
  });
  it("does not reject a background job when its error logger also throws", async () => {
    delegate.setMessagesAsync.and.rejectWith(new Error("delegate failed"));
    manager.log.and.throwError("logger failed");
    spyOn(console, "error");
    await runtime.publish.call(bridge, entry);
    expect(console.error).toHaveBeenCalled();
    expect(bridge.pending.size).toBe(0);
  });
  it("allows a split view to retain the same buffer after the original view closes", async () => {
    const copy = editor.copy();
    const buffer = copy.getBuffer();
    bridge.editorForUri = () => (editor.isDestroyed() ? copy : editor);
    const result = pauseConversion();
    editor.destroy();
    expect(buffer.isDestroyed()).toBe(false);
    finishConversion(Messages.toLinterMessages(uri, entry.diagnostics));
    try {
      await result;
      expect(delegate.setMessagesAsync.calls.count()).toBe(1);
    } finally {
      copy.destroy();
    }
  });
});
