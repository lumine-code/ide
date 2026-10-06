const path = require("path");
const DiagnosticScopeCache = require("../lib/diagnostic-scope-cache");

describe("closed-file diagnostic scopes", () => {
  let cache;
  const file = (name) => path.resolve("diagnostic-scopes", name);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  afterEach(() => cache?.dispose());

  it("shares concurrent reads and limits the number of active files", async () => {
    const resolve = new Map();
    const select = jasmine
      .createSpy("select grammar")
      .and.callFake((filePath) => new Promise((done) => resolve.set(filePath, done)));
    cache = new DiagnosticScopeCache(select, { concurrency: 2 });
    const first = cache.get(file("a.js"));
    expect(cache.get(file("a.js"))).toBe(first);
    const second = cache.get(file("b.js"));
    const third = cache.get(file("c.py"));
    await tick();
    expect(select.calls.count()).toBe(2);
    resolve.get(file("a.js"))({ scopeName: "source.js" });
    expect(await first).toBe("source.js");
    await tick();
    expect(select.calls.count()).toBe(3);
    resolve.get(file("b.js"))({ scopeName: "source.js" });
    resolve.get(file("c.py"))({ scopeName: "source.python" });
    await Promise.all([second, third]);
    expect(await cache.get(file("a.js"))).toBe("source.js");
    expect(select.calls.count()).toBe(3);
  });

  it("evicts the least recently used scope without caching file contents", async () => {
    const select = jasmine.createSpy("select grammar").and.resolveTo({ scopeName: "source.js" });
    cache = new DiagnosticScopeCache(select, { limit: 2 });
    await cache.get(file("a.js"));
    await cache.get(file("b.js"));
    await cache.get(file("a.js"));
    await cache.get(file("c.js"));
    await cache.get(file("a.js"));
    expect(select.calls.count()).toBe(3);
    await cache.get(file("b.js"));
    expect(select.calls.count()).toBe(4);
    expect(cache.cache.size).toBe(2);
  });

  it("invalidates a directory and its pending reads without touching a similarly named sibling", async () => {
    let complete;
    const select = jasmine.createSpy("select grammar").and.callFake((filePath) =>
      filePath === file("dir/pending.js")
        ? new Promise((done) => {
            complete = done;
          })
        : Promise.resolve({ scopeName: "source.js" }),
    );
    cache = new DiagnosticScopeCache(select);
    await cache.get(file("dir/a.js"));
    await cache.get(file("directory/b.js"));
    const pending = cache.get(file("dir/pending.js")).catch((error) => error.name);
    await tick();
    const invalidated = cache.invalidate([file("dir")]);
    expect(invalidated.size).toBe(2);
    expect(await pending).toBe("AbortError");
    const signal = select.calls.mostRecent().args[1].signal;
    expect(signal.aborted).toBe(true);
    complete({ scopeName: "obsolete.scope" });
    await tick();
    expect(cache.cache.has(cache.key(file("dir/pending.js")))).toBe(false);
    await cache.get(file("directory/b.js"));
    expect(select.calls.count()).toBe(3);
  });

  it("cancels queued work and cannot start another read after disposal", async () => {
    let complete;
    const select = jasmine.createSpy("select grammar").and.callFake(
      () =>
        new Promise((done) => {
          complete = done;
        }),
    );
    cache = new DiagnosticScopeCache(select, { concurrency: 1 });
    const first = cache.get(file("a.js")).catch((error) => error.name);
    const queued = cache.get(file("b.js")).catch((error) => error.name);
    await tick();
    cache.dispose();
    expect(await first).toBe("AbortError");
    expect(await queued).toBe("AbortError");
    complete({ scopeName: "source.js" });
    await tick();
    expect(select.calls.count()).toBe(1);
    expect(await cache.get(file("c.js")).catch((error) => error.name)).toBe("AbortError");
  });
});
