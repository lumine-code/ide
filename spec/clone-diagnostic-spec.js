const clone = require("../lib/clone-diagnostic");

describe("Diagnostic snapshots", () => {
  it("copies protocol values, sparse arrays and optional fields without losing primitive distinctions", () => {
    const input = {
      message: "😀 diagnostic",
      range: { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } },
      data: {
        missing: undefined,
        empty: null,
        negativeZero: -0,
        infinity: Infinity,
        nan: NaN,
        big: 3n,
      },
      related: new Array(3),
    };
    input.related[0] = 1;
    input.related[2] = 3;
    input.related.extra = "metadata";
    const output = clone(input);
    expect(output).toEqual(structuredClone(input));
    expect(Object.is(output.data.negativeZero, -0)).toBeTrue();
    expect(1 in output.related).toBeFalse();
    expect(Object.hasOwn(output.data, "missing")).toBeTrue();
    output.range.start.line = 9;
    expect(input.range.start.line).toBe(1);
  });

  it("retains aliases and cycles within one snapshot while owning separate snapshots independently", () => {
    const shared = { value: 1 };
    const input = { first: shared, second: shared };
    input.self = input;
    shared.owner = input;
    const first = clone(input),
      second = clone(input);
    expect(first.self).toBe(first);
    expect(first.first).toBe(first.second);
    expect(first.first.owner).toBe(first);
    expect(first.first).not.toBe(second.first);
    expect(first.first).not.toBe(shared);
  });

  it("copies a __proto__ data property without changing the target prototype", () => {
    const input = Object.create(null);
    input.__proto__ = { injected: true };
    const output = clone(input);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.hasOwn(output, "__proto__")).toBeTrue();
    expect(output.__proto__).toEqual({ injected: true });
    expect(output.injected).toBeUndefined();
  });

  it("ignores non-enumerable and symbol properties just like structuredClone", () => {
    const input = { visible: 1, [Symbol("hidden")]: () => {} };
    Object.defineProperty(input, "hidden", { value: () => {} });
    expect(clone(input)).toEqual({ visible: 1 });
  });

  it("defines data properties without invoking inherited setters", () => {
    const key = "diagnosticSnapshotTestField";
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
    let writes = 0;
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      set() {
        writes++;
      },
    });
    try {
      const input = JSON.parse('{"diagnosticSnapshotTestField":{"value":1}}');
      const output = clone(input);
      expect(Object.hasOwn(output, key)).toBeTrue();
      expect(output[key]).toEqual({ value: 1 });
      expect(writes).toBe(0);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, key, previous);
      else delete Object.prototype[key];
    }
  });

  it("evaluates accessors exactly once when falling back to native cloning", () => {
    let reads = 0;
    const input = {
      first: { plain: true },
      get data() {
        reads++;
        return { value: "from getter" };
      },
    };
    expect(clone(input)).toEqual({ first: { plain: true }, data: { value: "from getter" } });
    expect(reads).toBe(1);
  });

  it("preserves non-protocol values through the native clone", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const input = {
      date: new Date(1234),
      regexp: /value/gi,
      map: new Map([["key", { value: 1 }]]),
      set: new Set([1, 2]),
      bytes,
    };
    input.regexp.lastIndex = 4;
    const output = clone(input);
    expect(output.date.getTime()).toBe(1234);
    expect(output.regexp.source).toBe("value");
    expect(output.regexp.flags).toBe("gi");
    expect(output.regexp.lastIndex).toBe(0);
    expect(output.map.get("key")).toEqual({ value: 1 });
    expect([...output.set]).toEqual([1, 2]);
    output.bytes[0] = 9;
    expect(bytes[0]).toBe(1);
  });

  it("preserves native failures for unsupported values without inspecting proxy traps", () => {
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          return [];
        },
      },
    );
    for (const value of [() => {}, Symbol("value"), { data: new WeakMap() }, proxy]) {
      let error;
      try {
        clone(value);
      } catch (failure) {
        error = failure;
      }
      expect(error?.name).toBe("DataCloneError");
    }
    expect(traps).toBe(0);
  });

  it("copies deeply nested diagnostic data without recursive traversal", () => {
    const input = {};
    let tail = input;
    for (let index = 0; index < 5000; index++) tail = tail.child = {};
    tail.value = "leaf";
    let output = clone(input);
    for (let index = 0; index < 5000; index++) output = output.child;
    expect(output.value).toBe("leaf");
  });
});
