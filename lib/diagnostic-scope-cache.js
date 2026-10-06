const path = require("path");
const C = require("./converters");

const abortError = () => new DOMException("Diagnostic scope invalidated", "AbortError");

// Keep only scope names, never file contents. Concurrent reports and servers
// share one read, and a large workspace cannot start thousands of reads at once.
module.exports = class DiagnosticScopeCache {
  constructor(selectGrammar, { limit = 1024, concurrency = 4, maxAge = 30000 } = {}) {
    this.selectGrammar = selectGrammar;
    this.limit = limit;
    this.concurrency = concurrency;
    this.maxAge = maxAge;
    this.cache = new Map();
    this.pending = new Map();
    this.queue = new Map();
    this.active = 0;
    this.disposed = false;
  }
  key(filePath) {
    return C.uriKey(C.pathToUri(filePath));
  }
  get(filePath) {
    if (this.disposed) return Promise.reject(abortError());
    const key = this.key(filePath);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < this.maxAge) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached.scopeName);
    }
    this.cache.delete(key);
    if (this.pending.has(key)) return this.pending.get(key).promise;
    const record = { filePath, key, controller: new AbortController() };
    record.promise = new Promise((resolve, reject) => {
      record.resolve = resolve;
      record.reject = reject;
    });
    this.pending.set(key, record);
    this.queue.set(key, record);
    this.drain();
    return record.promise;
  }
  drain() {
    while (!this.disposed && this.active < this.concurrency && this.queue.size) {
      const [key, record] = this.queue.entries().next().value;
      this.queue.delete(key);
      this.active++;
      Promise.resolve()
        .then(() => {
          if (record.controller.signal.aborted) throw abortError();
          return this.selectGrammar(record.filePath, { signal: record.controller.signal });
        })
        .then((grammar) => {
          if (record.controller.signal.aborted || this.pending.get(key) !== record) return;
          const scopeName = grammar?.scopeName;
          this.cache.set(key, { scopeName, time: Date.now() });
          while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
          record.resolve(scopeName);
        }, record.reject)
        .finally(() => {
          if (this.pending.get(key) === record) this.pending.delete(key);
          this.active--;
          this.drain();
        });
    }
  }
  invalidate(paths) {
    const invalidated = new Set();
    const roots = paths && new Set(paths.filter(Boolean).map((filePath) => this.key(filePath)));
    const matches = (key) => {
      if (!roots) return true;
      for (;;) {
        if (roots.has(key)) return true;
        const parent = path.dirname(key);
        if (parent === key) return false;
        key = parent;
      }
    };
    for (const key of this.cache.keys())
      if (matches(key)) {
        invalidated.add(key);
        this.cache.delete(key);
      }
    for (const [key, record] of this.pending) {
      if (!matches(key)) continue;
      invalidated.add(key);
      this.pending.delete(key);
      this.queue.delete(key);
      record.controller.abort();
      record.reject(abortError());
    }
    return paths ? invalidated : null;
  }
  dispose() {
    this.disposed = true;
    this.invalidate();
  }
};
