const { setImmediate, clearImmediate } = require("node:timers");
const cloneDiagnostic = require("./clone-diagnostic");

const ASYNC_THRESHOLD = 512;
const SLICE_MS = 4;

class Collector {
  constructor(reports) {
    this.reports = reports;
    this.reportIndex = 0;
    this.itemIndex = 0;
    this.diagnostics = [];
    this.seen = reports.length > 1 ? new Map() : null;
  }

  step() {
    while (this.reportIndex < this.reports.length) {
      const items = this.reports[this.reportIndex].items;
      if (this.itemIndex >= items.length) {
        this.reportIndex++;
        this.itemIndex = 0;
        continue;
      }
      const item = items[this.itemIndex++];
      if (this.seen) {
        const key = JSON.stringify(item);
        const provider = this.seen.get(key);
        // Preserve duplicates inside a provider, but not between providers.
        if (provider !== undefined && provider !== this.reportIndex) return true;
        if (provider === undefined) this.seen.set(key, this.reportIndex);
      }
      // Repeated references must also have independent adapter-owned data.
      this.diagnostics.push(cloneDiagnostic(item));
      return true;
    }
    return false;
  }
}

function collect(reports) {
  const collector = new Collector(reports);
  while (collector.step());
  return collector.diagnostics;
}

// Yield between diagnostics, including before the first slice. One diagnostic
// remains atomic: native structured cloning cannot be interrupted mid-item.
function prepare(
  reports,
  {
    signal,
    isCurrent = () => true,
    budgetMs = SLICE_MS,
    now = () => performance.now(),
    schedule = setImmediate,
    cancel = clearImmediate,
  } = {},
) {
  const collector = new Collector(reports.map(({ items }) => ({ items: items.slice() })));
  return new Promise((resolve, reject) => {
    let timer,
      finished = false;
    const finish = (value, failed = false) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) cancel(timer);
      signal?.removeEventListener("abort", abort);
      if (failed) reject(value);
      else resolve(value);
    };
    const abort = () => finish(null);
    const step = () => {
      timer = undefined;
      try {
        if (signal?.aborted || !isCurrent()) return finish(null);
        const deadline = now() + budgetMs;
        do {
          if (!collector.step()) return finish(collector.diagnostics);
          if (signal?.aborted || !isCurrent()) return finish(null);
        } while (now() < deadline);
        timer = schedule(step);
      } catch (error) {
        finish(error, true);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else {
      try {
        timer = schedule(step);
      } catch (error) {
        finish(error, true);
      }
    }
  });
}

module.exports = { ASYNC_THRESHOLD, SLICE_MS, collect, prepare };
