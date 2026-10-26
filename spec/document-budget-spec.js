const { MAX_STRING_LENGTH } = require("node:buffer").constants;
const LanguageServerManager = require("../lib/language-server-manager");
const SessionDocuments = require("../lib/session-documents");
const CompletionProvider = require("../lib/completion-provider");
const RefreshingProvider = require("../lib/refreshing-provider");
const documentRequest = require("../lib/document-request");
const Budget = require("../lib/document-budget");
const { prepareMessage, TextLength } = require("../lib/message-budget");

describe("language-server document allocation budgets", () => {
  const MIB = 1024 * 1024;
  const uri = "file:///document-budget/source.txt";
  let manager, session, documents, editor, provider;
  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const messages = (method) =>
    session.connection.notify.calls.allArgs().filter(([name]) => name === method);

  beforeEach(async () => {
    jasmine.useRealClock();
    const grammar = await lumine.packages.activatePackage("language-text");
    await grammar.resourceLoadPromise;
    lumine.config.set(Budget.SETTING, 1);
    editor = lumine.workspace.buildTextEditor();
    editor.setText("small source");
    manager = new LanguageServerManager();
    spyOn(manager, "uriForEditor").and.returnValue(uri);
    session = {
      state: "running",
      adapter: {},
      capabilities: { textDocumentSync: 2 },
      diagnosticTimers: new Map(),
      manager,
      connection: { notify: jasmine.createSpy("wire notification").and.resolveTo() },
      supports: () => false,
      scheduleDiagnostics() {},
      scheduleWorkspaceDiagnostics() {},
      clearDiagnosticReportsForUri() {},
      notify(method, params) {
        return this.connection.notify(method, params);
      },
    };
    documents = new SessionDocuments(session);
    session.documents = documents.items;
    session.detachEditor = (item) => documents.detachEditor(item);
    session.openEditor = (item) => documents.openEditor(item);
    spyOn(manager, "allSessions").and.returnValue([session]);
    spyOn(manager, "attachEditor").and.callFake((item) => documents.openEditor(item));
    manager.activate();
    manager.watchEditor(editor);
  });

  afterEach(() => {
    provider?.dispose();
    provider = null;
    manager.tearingDown = true;
    manager.subscriptions.dispose();
    manager.unloadSubscription?.dispose();
    for (const subscription of manager.editorSubscriptions.values()) subscription.dispose();
    manager.editorSubscriptions.clear();
    documents.dispose();
    manager.emitter.dispose();
    editor.destroy();
    lumine.config.set(Budget.SETTING, 32);
  });

  it("refuses oversized initial text and request snapshots before any full-text read", async () => {
    editor.setText("x".repeat(MIB + 1));
    const read = spyOn(editor, "getText").and.throwError("oversized read");
    await documents.openEditor(editor);
    expect(documents.items.size).toBe(0);
    expect(messages("textDocument/didOpen").length).toBe(0);
    expect(documents.requestDocumentSnapshots().size).toBe(0);
    expect(
      await documentRequest(manager, editor, { method: "textDocument/hover" }, () => true),
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(manager.documentAvailabilityForEditor(editor).reason).toBe("size-limit");
  });

  it("closes stale text on growth, clears cached source and automatically reopens after shrink", async () => {
    await documents.openEditor(editor);
    const document = documents.items.get(uri);
    const availability = [];
    manager.onDidChangeDocumentAvailability((event) => availability.push(event.available));
    editor.setText("x".repeat(MIB + 1));
    expect(documents.items.size).toBe(0);
    expect(messages("textDocument/didClose").length).toBe(1);
    expect(messages("textDocument/didChange").length).toBe(0);
    expect(document.source).toBeNull();
    expect(document.projection).toBeNull();
    editor.setText("recovered source");
    await settle();
    expect(messages("textDocument/didOpen").length).toBe(2);
    expect(messages("textDocument/didOpen").at(-1)[1].textDocument.text).toBe("recovered source");
    expect(availability).toEqual([false, true]);
  });

  it("reevaluates configured budgets without changing the grammar", async () => {
    lumine.config.set(Budget.SETTING, 2);
    editor.setText("x".repeat(MIB + 1));
    await documents.openEditor(editor);
    const grammar = editor.getGrammar();
    lumine.config.set(Budget.SETTING, 1);
    expect(documents.items.size).toBe(0);
    expect(messages("textDocument/didClose").length).toBe(1);
    lumine.config.set(Budget.SETTING, 2);
    await settle();
    expect(messages("textDocument/didOpen").length).toBe(2);
    expect(editor.getGrammar()).toBe(grammar);
  });

  it("does not read old changes or full-sync text after a document becomes unavailable", async () => {
    session.capabilities.textDocumentSync = 1;
    await documents.openEditor(editor);
    const document = documents.items.get(uri);
    spyOn(editor.getBuffer(), "canMaterializeText").and.returnValue(false);
    const read = spyOn(editor, "getText").and.throwError("oversized full sync");
    documents.changeDocument(document, {
      get changes() {
        throw new Error("materialized changes");
      },
    });
    expect(read).not.toHaveBeenCalled();
    expect(messages("textDocument/didChange").length).toBe(0);
    expect(messages("textDocument/didClose").length).toBe(1);
  });

  it("synchronizes dense edit batches as one complete snapshot within the budget", async () => {
    editor.setText("ab".repeat(5000));
    await documents.openEditor(editor);
    session.connection.notify.calls.reset();
    editor.getBuffer().setTextInIndependentRanges(
      Array.from({ length: 5000 }, (_, index) => ({
        range: [
          [0, index * 2],
          [0, index * 2 + 1],
        ],
        text: "z",
      })),
    );
    await settle();
    const changes = messages("textDocument/didChange");
    expect(changes.length).toBe(1);
    expect(changes[0][1].contentChanges).toEqual([{ text: "zb".repeat(5000) }]);
  });

  it("keeps the runtime string limit even when the soft budget is raised", () => {
    lumine.config.set(Budget.SETTING, 4096);
    const shim = {
      getGrammar: () => editor.getGrammar(),
      getBuffer: () => ({ getLength: () => MAX_STRING_LENGTH + 1 }),
      getText() {
        throw new Error("metadata check read text");
      },
    };
    expect(Budget.textLimit()).toBe(Budget.transportTextLimit());
    expect(Budget.textLimit()).toBeLessThan(MAX_STRING_LENGTH);
    expect(Budget.canSynchronizeEditor(shim)).toBe(false);
  });

  it("bounds worst-case control-character JSON expansion before encoding", () => {
    const runtimeLimit = 128;
    const envelope = 8;
    const limit = Budget.transportTextLimit(runtimeLimit, envelope);
    const text = "\u0000".repeat(limit);
    expect(JSON.stringify(text).length + envelope - 2).toBeLessThanOrEqual(runtimeLimit);
    expect(() => Budget.assertTransportUnits(text.length, runtimeLimit, envelope)).not.toThrow();
    let failure;
    try {
      Budget.assertTransportUnits(text.length + 1, runtimeLimit, envelope);
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe("IDE_DOCUMENT_SIZE_LIMIT");
  });

  it("preflights combined text, metadata and collections without serializing huge strings", () => {
    expect(() =>
      prepareMessage(
        { cells: [new TextLength(1000), new TextLength(1000)] },
        { maxUnits: 10000, allowTextLengths: true },
      ),
    ).toThrow();
    expect(() => prepareMessage({ metadata: "\0".repeat(1000) }, { maxUnits: 1000 })).toThrow();
    expect(() => prepareMessage(new Array(1000), { maxValues: 100 })).toThrow();
    const value = JSON.parse('{"__proto__":{"x":1},"empty":[null],"text":"\\u0000"}');
    expect(JSON.stringify(prepareMessage(value).value)).toBe(JSON.stringify(value));
  });

  it("preserves native JSON conversion for boxed primitives and function-valued toJSON", () => {
    const text = new String("original");
    text.valueOf = () => "changed";
    const bool = new Boolean(false);
    bool.valueOf = () => true;
    const callable = Object.assign(function () {}, {
      toJSON() {
        return 7;
      },
    });
    const value = { text, bool, callable };
    expect(JSON.stringify(prepareMessage(value).value)).toBe(JSON.stringify(value));
    expect(() => prepareMessage({ value: Object(1n) })).toThrowError(TypeError);
    let reads = 0;
    const custom = {
      get toJSON() {
        reads++;
        return () => ({ value: "once" });
      },
    };
    expect(JSON.stringify(prepareMessage(custom).value)).toBe('{"value":"once"}');
    expect(reads).toBe(1);
    const tagged = { [Symbol.toStringTag]: "String", value: "data" };
    expect(JSON.stringify(prepareMessage(tagged).value)).toBe(JSON.stringify(tagged));
    const number = new Number(1);
    number.valueOf = () => 1n;
    expect(() => prepareMessage(number)).toThrowError(TypeError);
  });

  it("clears settled completion source and items when size eligibility changes", async () => {
    const completionSession = {
      supports: () => true,
      capabilityOptions: () => ({}),
      request: async () => [{ label: "completion" }],
    };
    provider = new CompletionProvider({
      addCapabilityFragment() {},
      activeSessionsForEditor: async () => [completionSession],
      uriForEditor: () => uri,
    });
    await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 1 },
      prefix: "s",
      activatedManually: true,
    });
    expect(provider.cache.source).toBe("small source");
    editor.setText("x".repeat(MIB + 1));
    expect(provider.cache).toBeNull();
    expect(provider.cacheSubscription).toBeNull();
  });

  it("still keeps None unavailable after a budget increase", async () => {
    editor.setGrammar(lumine.grammars.nullGrammar);
    lumine.config.set(Budget.SETTING, 4096);
    await documents.openEditor(editor);
    expect(documents.items.size).toBe(0);
    expect(manager.documentAvailabilityForEditor(editor).reason).toBe("no-grammar");
  });

  it("retires pending projections across growth and resumes with a fresh source generation", async () => {
    documents.closeDocument(uri);
    session.connection.notify.calls.reset();
    spyOn(editor, "whenGrammarSettled").and.resolveTo(true);
    let finishOld, oldSignal;
    let calls = 0;
    session.adapter.getDocumentProjection = (_editor, { signal }) => {
      if (++calls === 1) {
        oldSignal = signal;
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      }
      return { text: editor.getText(), isCurrent: () => true };
    };
    const oldOpen = documents.openEditor(editor);
    await settle();
    expect(oldSignal).toBeDefined();
    editor.setText("x".repeat(MIB + 1));
    expect(oldSignal.aborted).toBe(true);
    await oldOpen;
    editor.setText("fresh source");
    await settle();
    finishOld({ text: "obsolete", isCurrent: () => true });
    await settle();
    const opened = messages("textDocument/didOpen");
    expect(opened.length).toBe(1);
    expect(opened[0][1].textDocument.text).toBe("fresh source");
  });

  it("rejects oversized adapter output before publishing any open frame", async () => {
    session.adapter.transformDocumentText = () => "x".repeat(MIB + 1);
    await expectAsync(documents.openEditor(editor)).toBeRejectedWith(
      jasmine.objectContaining({ code: "IDE_DOCUMENT_SIZE_LIMIT" }),
    );
    expect(documents.items.size).toBe(0);
    expect(messages("textDocument/didOpen").length).toBe(0);
    expect(messages("textDocument/didClose").length).toBe(0);
    expect(manager.documentAvailabilityForEditor(editor).reason).toBe("size-limit");
    lumine.config.set(Budget.SETTING, 2);
    await settle();
    expect(messages("textDocument/didOpen").length).toBe(1);
  });

  it("invalidates rendered provider state on budget changes without copying text", () => {
    lumine.config.set(Budget.SETTING, 2);
    editor.setText("x".repeat(MIB + 1));
    provider = new RefreshingProvider(manager, {}, "budget-test");
    provider.invalidateEditor = jasmine.createSpy("release cached rendered data");
    const invalidate = jasmine.createSpy("invalidate consumer");
    provider.onDidInvalidate(invalidate);
    const current = provider.captureEditor(editor);
    const read = spyOn(editor, "getText").and.throwError("unavailable provider copied text");
    expect(current()).toBe(true);
    lumine.config.set(Budget.SETTING, 1);
    expect(current()).toBe(false);
    expect(provider.invalidateEditor).toHaveBeenCalledWith(editor);
    expect(invalidate).toHaveBeenCalledWith({ editor });
    expect(read).not.toHaveBeenCalled();
    read.and.callThrough();
    lumine.config.set(Budget.SETTING, 2);
    expect(provider.captureEditor(editor)()).toBe(true);
  });
});
