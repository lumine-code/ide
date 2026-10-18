const ServerSession = require("../lib/server-session");

describe("request-local LSP partial results", () => {
  let session;
  beforeEach(() => {
    session = new ServerSession({}, { id: "partial", grammarScopes: [] }, "", {});
    session.state = "running";
    session.connection = {};
  });
  afterEach(() => session.cancelPartialRequests());

  it("preserves packet order and awaits asynchronous conversion before completing", async () => {
    const order = [];
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    session.request = async (_method, params) => {
      const consume = session.partialResults.get(params.partialResultToken);
      consume(1);
      consume(2);
      return "complete";
    };
    let completed = false;
    const pending = session
      .requestWithPartialResults(
        "test",
        {},
        {
          onPartialResult: async (value) => {
            order.push(value);
            if (value === 1) await blocked;
          },
        },
      )
      .then((value) => {
        completed = true;
        return value;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1]);
    expect(completed).toBe(false);
    release();
    expect(await pending).toBe("complete");
    expect(order).toEqual([1, 2]);
    expect(session.partialResults.size).toBe(0);
    expect(session.partialRequestControllers.size).toBe(0);
  });

  const waitingRequest = (_method, _params, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  it("removes cancelled routing and refuses already queued late packets", async () => {
    session.request = waitingRequest;
    const controller = new AbortController();
    const received = [];
    const pending = session.requestWithPartialResults(
      "test",
      {},
      {
        signal: controller.signal,
        onPartialResult: (value) => received.push(value),
      },
    );
    const consume = [...session.partialResults.values()][0];
    controller.abort(new Error("superseded"));
    consume("late");
    await expectAsync(pending).toBeRejectedWithError("superseded");
    expect(received).toEqual([]);
    expect(session.partialResults.size).toBe(0);
  });

  it("aborts the outstanding RPC when packet validation fails", async () => {
    session.request = waitingRequest;
    const pending = session.requestWithPartialResults(
      "test",
      {},
      {
        onPartialResult: () => {
          throw new Error("invalid packet");
        },
      },
    );
    [...session.partialResults.values()][0]({});
    await expectAsync(pending).toBeRejectedWithError("invalid packet");
    expect(session.partialResults.size).toBe(0);
  });

  it("settles cancellation after the RPC has ended while an asynchronous packet is still pending", async () => {
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let consume;
    session.request = async (_method, params) => {
      consume = session.partialResults.get(params.partialResultToken);
      consume(1);
      consume(2);
      return "complete";
    };
    const controller = new AbortController();
    const received = [];
    const pending = session.requestWithPartialResults(
      "test",
      {},
      {
        signal: controller.signal,
        onPartialResult: async (value) => {
          received.push(value);
          await blocked;
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([1]);
    controller.abort(new Error("cancel during conversion"));
    await expectAsync(pending).toBeRejectedWithError("cancel during conversion");
    expect(session.partialResults.size).toBe(0);
    expect(session.partialRequestControllers.size).toBe(0);
    consume(3);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([1]);
  });

  it("teardown cancels waiting requests and discards queued work", async () => {
    session.request = waitingRequest;
    const consume = jasmine.createSpy("consume");
    const pending = session.requestWithPartialResults("test", {}, { onPartialResult: consume });
    [...session.partialResults.values()][0]("queued");
    session.cancelPartialRequests();
    session.state = "stopped";
    await expectAsync(pending).toBeRejectedWithError(
      "Language server session stopped during partial results",
    );
    expect(consume).not.toHaveBeenCalled();
    expect(session.partialResults.size).toBe(0);
    expect(session.partialRequestControllers.size).toBe(0);
  });

  it("retains the document-version guard while asynchronous packets drain after the RPC response", async () => {
    const uri = "file:///C:/partial.dat";
    const editor = { isDestroyed: () => false };
    const document = { uri, version: 1, editor, editors: new Set([editor]) };
    session.documents.set(uri, document);
    spyOn(session.documentSync, "waitForDocumentSync").and.resolveTo();
    spyOn(session.documentSync, "isCurrentDocument").and.callFake((value) => value === document);
    spyOn(session.documentSync, "editorForUri").and.returnValue(editor);
    spyOn(session.documentSync, "useEditor");
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const callbackEntered = new Promise((resolve) => {
      entered = resolve;
    });
    spyOn(session, "requestWithProgress").and.callFake(async (_method, params) => {
      session.partialResults.get(params.partialResultToken)("packet");
      return [];
    });
    const pending = session.request(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      {
        onPartialResult: async () => {
          entered();
          await blocked;
        },
      },
    );
    await callbackEntered;
    document.version++;
    release();
    await expectAsync(pending).toBeRejectedWithError("Language server projection is stale");
    expect(session.partialResults.size).toBe(0);
  });
});
