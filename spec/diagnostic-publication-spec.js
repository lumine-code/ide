const Session = require("../lib/server-session");
const C = require("../lib/converters");

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
});
