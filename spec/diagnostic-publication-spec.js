const Session = require("../lib/server-session");
const C = require("../lib/converters");
const preparation = require("../lib/prepare-diagnostics");

describe("Diagnostic report publication", () => {
  const uri = "file:///diagnostic-publication.txt";
  let session, events;
  const diagnostic = (message) => ({
    message,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    data: { nested: { value: "original" } },
  });

  beforeEach(() => {
    events = [];
    session = Object.assign(Object.create(Session.prototype), {
      documentSync: {
        items: new Map([[C.uriKey(uri), { version: 3 }]]),
        isTemporaryDocumentUri: () => false,
      },
      diagnosticReports: new Map(),
      manager: {
        publishDiagnostics(owner, event, collected) {
          events.push({ owner, event, collected });
          return true;
        },
      },
    });
  });

  const reports = (sources) => {
    session.diagnosticReports.set(C.uriKey(uri), {
      uri,
      sources: new Map(sources.map((source, index) => [String(index), source])),
    });
  };

  it("preserves duplicates and independently owns their nested data without fingerprinting one provider", () => {
    const item = diagnostic("same");
    reports([{ document: { version: 3, items: [item, item] } }]);
    const stringify = spyOn(JSON, "stringify").and.callThrough();
    const result = session.publishCollectedDiagnostics(uri, 3);
    const serializations = stringify.calls.count();
    expect(result).toBeTrue();
    expect(serializations).toBe(0);
    expect(events.length).toBe(1);
    const { owner, event, collected } = events[0];
    expect(owner).toBe(session);
    expect(collected).toBeTrue();
    expect(event.diagnostics).toEqual([item, item]);
    event.diagnostics[0].data.nested.value = "changed by adapter";
    expect(event.diagnostics[1].data.nested.value).toBe("original");
    expect(item.data.nested.value).toBe("original");
  });

  it("deduplicates between providers while preserving duplicates inside their reports", () => {
    const same = diagnostic("same"),
      other = diagnostic("other");
    reports([
      { document: { version: 3, items: [same, same] } },
      { workspace: { version: 3, items: [structuredClone(same), other, other] } },
    ]);
    session.publishCollectedDiagnostics(uri, 3);
    expect(events[0].event.diagnostics).toEqual([same, same, other, other]);
    events[0].event.diagnostics[2].range.start.line = 10;
    expect(events[0].event.diagnostics[3].range.start.line).toBe(0);
    expect(other.range.start.line).toBe(0);
  });

  it("does not fingerprint a single current report when another provider is obsolete", () => {
    const item = diagnostic("current");
    reports([
      { document: { version: 2, items: [diagnostic("stale")] } },
      { document: { version: 3, items: [] } },
      { push: { version: 3, items: [item] }, document: { version: 3, items: [] } },
    ]);
    const stringify = spyOn(JSON, "stringify").and.callThrough();
    session.publishCollectedDiagnostics(uri, 3);
    const serializations = stringify.calls.count();
    expect(serializations).toBe(0);
    expect(events[0].event.diagnostics).toEqual([item]);
  });

  it("still publishes a clearing report when no current provider remains", () => {
    reports([{ document: { version: 2, items: [diagnostic("stale")] } }]);
    session.publishCollectedDiagnostics(uri, 3);
    expect(events[0].event.diagnostics).toEqual([]);
  });

  describe("cooperative preparation", () => {
    let editor;
    const large = () =>
      Array.from({ length: preparation.ASYNC_THRESHOLD + 7 }, (_, i) => diagnostic(String(i)));
    const publish = (items, version = 3) =>
      session.publishDiagnosticReport(uri, { kind: "full", items }, version);

    beforeEach(() => {
      session.diagnosticGeneration = 0;
      session.workspaceDiagnosticStates = new Map();
      session.workspaceDiagnosticResultIds = new Map();
      session.diagnosticProviderDefinitions = new Map();
    });

    afterEach(() => {
      session.cancelDiagnosticPublications();
      editor?.destroy();
    });

    it("yields before cloning and publishes the complete independently owned report once", async () => {
      const items = large();
      items[1] = items[0];
      const pending = publish(items);
      expect(pending instanceof Promise).toBeTrue();
      expect(events.length).toBe(0);
      await Promise.resolve();
      expect(events.length).toBe(0);
      expect(await pending).toBeTrue();
      expect(events.length).toBe(1);
      expect(events[0].event.diagnostics).toEqual(items);
      events[0].event.diagnostics[0].data.nested.value = "changed";
      expect(events[0].event.diagnostics[1].data.nested.value).toBe("original");
      expect(items[0].data.nested.value).toBe("original");
      expect(session.diagnosticPublications.size).toBe(0);
    });

    it("preserves provider deduplication across slices", async () => {
      const items = large();
      const extra = diagnostic("other provider");
      reports([
        { document: { version: 3, items } },
        { document: { version: 3, items: [...structuredClone(items), extra, extra] } },
      ]);
      expect(await session.publishCollectedDiagnostics(uri, 3)).toBeTrue();
      expect(events[0].event.diagnostics).toEqual([...items, extra, extra]);
      expect(events[0].event.diagnostics.at(-1)).not.toBe(events[0].event.diagnostics.at(-2));
    });

    it("lets a synchronous clear supersede a pending large report", async () => {
      const pending = publish(large());
      expect(publish([])).toBeTrue();
      expect(await pending).toBeFalse();
      expect(events.length).toBe(1);
      expect(events[0].event.diagnostics).toEqual([]);
    });

    it("only publishes the newest large report", async () => {
      const old = publish(large());
      const items = large().map((item) => ({ ...item, message: `new ${item.message}` }));
      const next = publish(items);
      expect(await old).toBeFalse();
      expect(await next).toBeTrue();
      expect(events.length).toBe(1);
      expect(events[0].event.diagnostics).toEqual(items);
    });

    it("keeps an equal unchanged response from cancelling pending publication", async () => {
      const pending = publish(large());
      expect(
        session.cacheDiagnosticReport(uri, { kind: "unchanged" }, 3, "static", "document"),
      ).toBeTrue();
      expect(await pending).toBeTrue();
      expect(events.length).toBe(1);
    });

    it("rejects even an unversioned report after its open buffer changes", async () => {
      editor = lumine.workspace.buildTextEditor();
      const document = session.documents.get(C.uriKey(uri));
      document.editor = editor;
      const pending = publish(large(), null);
      editor.insertText("new source before the LSP version flush");
      expect(document.version).toBe(3);
      expect(await pending).toBeFalse();
      expect(events.length).toBe(0);
      expect(session.diagnosticPublications.size).toBe(0);
    });

    it("rejects pending work after the document version or owner changes", async () => {
      const document = session.documents.get(C.uriKey(uri));
      const changed = publish(large(), null);
      document.version++;
      expect(await changed).toBeFalse();
      const closed = publish(large(), null);
      session.documents.delete(C.uriKey(uri));
      expect(await closed).toBeFalse();
      session.documents.set(C.uriKey(uri), document);
      const replaced = publish(large(), null);
      session.documents.set(C.uriKey(uri), { ...document });
      expect(await replaced).toBeFalse();
      expect(events.length).toBe(0);
    });

    it("does not publish after adapter removal or session disposal", async () => {
      session.adapter = { id: "test" };
      session.manager.adapters = new Map([["test", session.adapter]]);
      const removed = publish(large());
      session.manager.adapters.delete("test");
      expect(await removed).toBeFalse();
      session.manager.adapters.set("test", session.adapter);
      const stopped = publish(large());
      session.disposeDiagnosticPullState();
      expect(await stopped).toBeFalse();
      expect(events.length).toBe(0);
    });

    it("cancels as soon as stopping begins, before asynchronous shutdown finishes", async () => {
      session.emitter = { emit() {} };
      session.manager.didChangeSession = () => {};
      const pending = publish(large());
      session.setState("stopping");
      expect(session.diagnosticPublications.size).toBe(0);
      expect(await pending).toBeFalse();
      expect(events.length).toBe(0);
    });

    it("rejects work whose notebook version or document projection changed", async () => {
      const document = session.documents.get(C.uriKey(uri));
      document.notebook = { version: 1 };
      const notebook = publish(large(), null);
      document.notebook.version++;
      expect(await notebook).toBeFalse();
      const projection = publish(large(), null);
      document.projection = {};
      expect(await projection).toBeFalse();
      expect(events.length).toBe(0);
    });

    it("cancels pending work when its cached report is cleared", async () => {
      const pending = publish(large());
      session.clearDiagnosticReportsForUri(uri);
      expect(await pending).toBeFalse();
      expect(events.length).toBe(0);
      expect(session.diagnosticPublications.size).toBe(0);
    });

    it("observes clone failure while preserving the explicit caller's rejection", async () => {
      const failure = new Error("clone failed");
      const items = large();
      Object.defineProperty(items[5], "data", {
        enumerable: true,
        get() {
          throw failure;
        },
      });
      session.manager.log = jasmine.createSpy("log").and.callFake(() => {
        throw new Error("log failed");
      });
      let caught;
      try {
        await publish(items);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(session.manager.log).toHaveBeenCalled();
      expect(events.length).toBe(0);
      expect(session.diagnosticPublications.size).toBe(0);
    });

    it("owns publication and asynchronous log failures without hiding rejection from callers", async () => {
      const failure = new Error("consumer failed");
      session.manager.publishDiagnostics = () => {
        throw failure;
      };
      session.manager.log = jasmine
        .createSpy("log")
        .and.callFake(() => Promise.reject(new Error("log failed")));
      let caught;
      try {
        await publish(large());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(session.manager.log).toHaveBeenCalled();
      expect(session.diagnosticPublications.size).toBe(0);
      await new Promise(setImmediate);
    });
  });
});
