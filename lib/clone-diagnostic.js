const { isProxy } = require("node:util").types;

const nativeCloneRequired = Symbol("native clone required");

// Wire diagnostics are plain records and arrays. Copy those graphs directly
// instead of invoking the host serializer once per diagnostic. Keep aliases
// and cycles within an item, but never share its copy with another item.
// Accessors and non-protocol values retain structuredClone's behavior.
module.exports = function cloneDiagnostic(value) {
  const copies = new Map();
  const pending = [];
  const allocate = (source) => {
    if (typeof source === "function" || typeof source === "symbol") throw nativeCloneRequired;
    if (source === null || typeof source !== "object") return source;
    if (copies.has(source)) return copies.get(source);
    if (isProxy(source)) throw nativeCloneRequired;
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
      throw nativeCloneRequired;
    const target = Array.isArray(source) ? new Array(source.length) : {};
    copies.set(source, target);
    pending.push([source, target]);
    return target;
  };
  try {
    const result = allocate(value);
    while (pending.length) {
      const [source, target] = pending.pop();
      for (const key of Object.keys(source)) {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        // Inspect the descriptor without invoking a getter. If we fall back,
        // the native clone remains the only operation that evaluates it.
        if (!Object.hasOwn(descriptor, "value")) throw nativeCloneRequired;
        const copy = allocate(descriptor.value);
        if (key in target) {
          Object.defineProperty(target, key, {
            value: copy,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        } else target[key] = copy;
      }
    }
    return result;
  } catch (error) {
    if (error !== nativeCloneRequired) throw error;
    return structuredClone(value);
  }
};
