const requestForDocument = require("../lib/document-request");

describe("synchronized document requests", () => {
  let manager, session, document, editor, active, source, filePath;
  const request = (extra = {}) =>
    requestForDocument(
      manager,
      editor,
      {
        adapterId: "selected",
        method: "workspace/executeCommand",
        params: ({ uri, version }) => ({ command: "expand", arguments: [{ uri, version }] }),
        ...extra,
      },
      () => active,
    );

  beforeEach(() => {
    active = true;
    source = "current";
    filePath = null;
    editor = {
      getText: () => source,
      getPath: () => filePath,
      getGrammar: () => ({ scopeName: "source.test" }),
      isDestroyed: () => false,
    };
    document = { editor, uri: "untitled:current", version: 4 };
    session = {
      adapter: { id: "selected" },
      state: "running",
      documents: new Map([[document.uri, document]]),
      waitForDocumentSync: jasmine.createSpy("sync").and.resolveTo(),
      isCurrentDocument: (candidate) => session.documents.get(document.uri) === candidate,
      request: jasmine.createSpy("request").and.resolveTo({ text: "expanded" }),
    };
    manager = {
      activeSessionsForEditor: jasmine.createSpy("sessions").and.resolveTo([session]),
      sessionsForEditor: () => [session],
      featureEnabled: () => true,
    };
  });

  it("selects the adapter and joins pending synchronization before sending its URI", async () => {
    let synchronized;
    session.waitForDocumentSync.and.returnValue(
      new Promise((resolve) => {
        synchronized = resolve;
      }),
    );
    const pending = request();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(session.request).not.toHaveBeenCalled();
    synchronized();
    const response = await pending;
    expect(manager.activeSessionsForEditor).toHaveBeenCalledWith(editor, { adapterId: "selected" });
    expect(session.request).toHaveBeenCalledWith(
      "workspace/executeCommand",
      {
        command: "expand",
        arguments: [{ uri: "untitled:current", version: 4 }],
      },
      { signal: undefined },
    );
    expect(response.document).toEqual({ uri: "untitled:current", version: 4, text: "current" });
    expect(response.isCurrent()).toBeTrue();
    document.version++;
    expect(response.isCurrent()).toBeFalse();
  });

  it("returns no response when the requested adapter is absent", async () => {
    manager.activeSessionsForEditor.and.resolveTo([{ adapter: { id: "other" } }]);
    expect(await request()).toBeNull();
    expect(session.request).not.toHaveBeenCalled();
  });

  it("rejects a source or path replacement while startup is pending", async () => {
    manager.activeSessionsForEditor.and.callFake(async () => {
      filePath = "replacement.dat";
      return [session];
    });
    await expectAsync(request()).toBeRejectedWith(
      jasmine.objectContaining({ code: "IDE_DOCUMENT_CHANGED" }),
    );
    expect(session.request).not.toHaveBeenCalled();
  });

  it("rejects a document generation change even when its text is restored", async () => {
    session.request.and.callFake(async () => {
      document.version++;
      return {};
    });
    await expectAsync(request()).toBeRejectedWith(
      jasmine.objectContaining({ code: "IDE_DOCUMENT_CHANGED" }),
    );
  });

  it("rejects a stopped route and results from a disposed service generation", async () => {
    session.request.and.callFake(async () => {
      active = false;
      return {};
    });
    await expectAsync(request()).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    active = true;
    session.request.and.callFake(async () => {
      session.state = "stopped";
      return {};
    });
    await expectAsync(request()).toBeRejectedWith(
      jasmine.objectContaining({ code: "IDE_DOCUMENT_CHANGED" }),
    );
  });

  it("cancels startup without waiting for an unavailable server", async () => {
    manager.activeSessionsForEditor.and.returnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = request({ signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expectAsync(pending).toBeRejectedWithError("cancelled");
    expect(session.request).not.toHaveBeenCalled();
  });

  it("enforces feature switches and revalidates domain preconditions after sync", async () => {
    manager.featureEnabled = () => false;
    await expectAsync(request({ feature: "diagnostics" })).toBeRejectedWith(
      jasmine.objectContaining({ code: "IDE_FEATURE_DISABLED" }),
    );
    manager.featureEnabled = () => true;
    expect(await request({ validate: () => false })).toBeNull();
    expect(session.request).not.toHaveBeenCalled();
  });

  it("rechecks feature changes during synchronization before sending a command", async () => {
    session.waitForDocumentSync.and.callFake(async () => {
      manager.featureEnabled = () => false;
    });
    await expectAsync(request({ feature: "diagnostics" })).toBeRejectedWith(
      jasmine.objectContaining({ code: "IDE_FEATURE_DISABLED" }),
    );
    expect(session.request).not.toHaveBeenCalled();
  });

  it("rejects a replaced projection even when source and version are unchanged", async () => {
    document.projection = { isCurrent: () => true };
    session.request.and.callFake(async () => {
      document.projection = { isCurrent: () => true };
      return {};
    });
    await expectAsync(request()).toBeRejectedWith(
      jasmine.objectContaining({ code: "IDE_DOCUMENT_CHANGED" }),
    );
  });

  it("cancels an asynchronous parameter builder without sending its command", async () => {
    const controller = new AbortController();
    await expectAsync(
      request({
        signal: controller.signal,
        params: () => {
          controller.abort(new Error("cancelled builder"));
          return new Promise(() => {});
        },
      }),
    ).toBeRejectedWithError("cancelled builder");
    expect(session.request).not.toHaveBeenCalled();
  });
});
