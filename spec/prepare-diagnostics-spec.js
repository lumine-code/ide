const preparation = require("../lib/prepare-diagnostics");

describe("Cooperative diagnostic preparation", () => {
  let queued, ticks, options;
  beforeEach(() => {
    queued = new Set();
    ticks = 0;
    options = {
      budgetMs: 1,
      now: () => ticks++,
      schedule: (callback) => {
        queued.add(callback);
        return callback;
      },
      cancel: (callback) => queued.delete(callback),
    };
  });
  const next = () => {
    const callback = queued.values().next().value;
    queued.delete(callback);
    callback();
  };
  const drain = () => {
    while (queued.size) next();
  };

  it("processes only a bounded slice before giving another task a turn", async () => {
    let copies = 0;
    const items = Array.from({ length: 5 }, () => ({
      get message() {
        copies++;
        return "x";
      },
    }));
    const pending = preparation.prepare([{ items }], options);
    expect(copies).toBe(0);
    next();
    expect(copies).toBe(1);
    expect(queued.size).toBe(1);
    drain();
    expect(await pending).toEqual(Array(5).fill({ message: "x" }));
  });

  it("cancels a partially cloned report and releases its scheduled continuation", async () => {
    const controller = new AbortController();
    const pending = preparation.prepare([{ items: [{ a: 1 }, { a: 2 }] }], {
      ...options,
      signal: controller.signal,
    });
    next();
    expect(queued.size).toBe(1);
    controller.abort();
    expect(queued.size).toBe(0);
    expect(await pending).toBeNull();
  });

  it("checks ownership after every item, including reentrant cloning callbacks", async () => {
    let current = true;
    const item = {
      get message() {
        current = false;
        return "changed owner";
      },
    };
    const pending = preparation.prepare([{ items: [item, { message: "later" }] }], {
      ...options,
      isCurrent: () => current,
    });
    next();
    expect(await pending).toBeNull();
    expect(queued.size).toBe(0);
  });

  it("freezes report membership without sharing cloned diagnostics", async () => {
    const item = { data: { value: 1 } };
    const items = [item, item];
    const pending = preparation.prepare([{ items }], options);
    items.length = 0;
    drain();
    const result = await pending;
    expect(result).toEqual([item, item]);
    result[0].data.value++;
    expect(result[1].data.value).toBe(1);
    expect(item.data.value).toBe(1);
  });

  it("preserves duplicates within a provider across slice boundaries", async () => {
    const a = { message: "a" },
      b = { message: "b" };
    const pending = preparation.prepare([{ items: [a, a] }, { items: [a, b, b] }], options);
    drain();
    expect(await pending).toEqual([a, a, b, b]);
  });

  it("retains even a falsy thrown error as a rejection", async () => {
    const pending = preparation.prepare(
      [
        {
          items: [
            {
              get message() {
                throw null;
              },
            },
          ],
        },
      ],
      options,
    );
    let rejected = false;
    const observed = pending.catch((error) => {
      rejected = true;
      expect(error).toBeNull();
    });
    drain();
    await observed;
    expect(rejected).toBeTrue();
    expect(queued.size).toBe(0);
  });
});
