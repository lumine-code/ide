const ServerSession = require("../lib/server-session");

describe("semantic RPC targets without a grammar", () => {
  let editor, grammar, session;
  const uri = "file:///semantic-target/selected.test";
  const params = () => ({ textDocument: { uri } });
  const settle = async () => {
    for (let index = 0; index < 40; index++) await Promise.resolve();
  };

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("language-text");
    await pack.resourceLoadPromise;
    editor = lumine.workspace.buildTextEditor();
    editor.setText("source");
    grammar = editor.getGrammar();
    const manager = {
      editorForDiagnosticUri: (_session, target) => (target === uri ? editor : null),
    };
    session = new ServerSession(manager, {}, "/project", {});
    session.state = "running";
    spyOn(session, "requestWithProgress").and.resolveTo({ value: "response" });
  });

  afterEach(() => {
    session.documentSync.dispose();
    session.subscriptions.dispose();
    session.emitter.dispose();
    editor.destroy();
  });

  it("refuses a known None target before source preparation and resumes for its real override", async () => {
    session.adapter.prepareRequest = jasmine.createSpy("prepare source").and.callFake(() => {
      editor.getText();
    });
    editor.setGrammar(lumine.grammars.nullGrammar);
    const read = spyOn(editor, "getText").and.callThrough();
    await expectAsync(session.request("textDocument/documentSymbol", params())).toBeRejected();
    expect(session.adapter.prepareRequest).not.toHaveBeenCalled();
    expect(session.requestWithProgress).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    editor.setGrammar(grammar);
    expect(await session.request("textDocument/documentSymbol", params())).toEqual({
      value: "response",
    });
    expect(session.requestWithProgress.calls.count()).toBe(1);
  });

  it("keeps requests for unknown or closed target URIs available", async () => {
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(
      await session.request("textDocument/documentSymbol", {
        textDocument: { uri: "file:///semantic-target/closed.test" },
      }),
    ).toEqual({ value: "response" });
    expect(session.requestWithProgress.calls.count()).toBe(1);
  });

  it("retires a target invocation during preparation even when the same grammar returns", async () => {
    let finishPrevious;
    session.adapter.prepareRequest = jasmine
      .createSpy("prepare")
      .and.returnValues(new Promise((resolve) => (finishPrevious = resolve)), undefined);
    let previousSettled = false;
    const previous = session.request("textDocument/documentSymbol", params()).then(
      (response) => {
        previousSettled = true;
        return { response };
      },
      (error) => {
        previousSettled = true;
        return { error };
      },
    );
    await settle();
    expect(session.adapter.prepareRequest.calls.count()).toBe(1);
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setGrammar(grammar);
    await settle();
    expect(previousSettled).toBeTrue();
    await session.request("textDocument/documentSymbol", params());
    finishPrevious();
    expect((await previous).error?.code).toBe("PROJECTION_STALE");
    await settle();
    expect(session.requestWithProgress.calls.count()).toBe(1);
  });

  it("does not convert an abandoned response after the target selected None", async () => {
    let finishPrevious;
    const convert = jasmine.createSpy("convert response").and.callFake((result) => result);
    session.adapter.prepareRequest = () => ({ mapResult: convert });
    session.requestWithProgress.and.returnValues(
      new Promise((resolve) => (finishPrevious = resolve)),
      Promise.resolve({ value: "fresh" }),
    );
    const previous = session
      .request("textDocument/documentSymbol", params())
      .catch((error) => error);
    await settle();
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setGrammar(grammar);
    expect(await session.request("textDocument/documentSymbol", params())).toEqual({
      value: "fresh",
    });
    finishPrevious({ value: "obsolete" });
    expect((await previous).code).toBe("PROJECTION_STALE");
    await settle();
    expect(convert.calls.count()).toBe(1);
  });
});
