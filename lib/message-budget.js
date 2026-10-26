const { MAX_STRING_LENGTH } = require("node:buffer").constants;
const { types } = require("node:util");
const MAX_VALUES = 100000;

class TextLength {
  constructor(length) {
    this.length = length;
  }
}

// Normalize one JSON value while bounding its worst-case encoded size. Text
// roots can be represented by lengths during notebook eligibility checks;
// actual outgoing messages contain strings. No document-sized string is made.
function prepareMessage(
  value,
  { maxUnits = MAX_STRING_LENGTH, maxValues = MAX_VALUES, allowTextLengths = false } = {},
) {
  let units = 0,
    values = 0;
  const active = new Set();
  const add = (amount) => {
    units += amount;
    if (units > maxUnits || ++values > maxValues) {
      throw Object.assign(
        new Error("The language-server message exceeds the transport allocation budget."),
        {
          code: "IDE_MESSAGE_SIZE_LIMIT",
          length: units,
          limit: maxUnits,
        },
      );
    }
  };
  const visit = (item, key = "", depth = 0) => {
    if (depth > 256)
      throw Object.assign(
        new Error("Language-server message nesting exceeds the transport budget."),
        { code: "IDE_MESSAGE_SIZE_LIMIT", length: units, limit: maxUnits },
      );
    if (item instanceof TextLength) {
      if (!allowTextLengths) throw new TypeError("Synthetic text lengths cannot be transmitted");
      add(item.length * 6 + 2);
      return "";
    }
    if (
      item != null &&
      (typeof item === "object" || typeof item === "function" || typeof item === "bigint")
    ) {
      const toJSON = item.toJSON;
      if (typeof toJSON === "function") item = toJSON.call(item, key);
    }
    if (item === undefined || typeof item === "function" || typeof item === "symbol")
      return undefined;
    if (item === null) {
      add(4);
      return null;
    }
    if (typeof item === "object") {
      // Match JSON's boxed primitive conversion, including overridden primitive
      // conversion hooks. Boolean ignores valueOf; boxed BigInt still rejects.
      if (types.isStringObject(item)) item = String(item);
      else if (types.isNumberObject(item)) item = +item;
      else if (types.isBooleanObject(item)) item = Boolean.prototype.valueOf.call(item);
      else if (types.isBigIntObject(item))
        throw new TypeError("Language-server messages cannot contain BigInt values");
    }
    if (typeof item === "string") {
      add(item.length * 6 + 2);
      return item;
    }
    if (typeof item === "boolean") {
      add(5);
      return item;
    }
    if (typeof item === "number") {
      add(25);
      return Number.isFinite(item) ? item : null;
    }
    if (typeof item === "bigint")
      throw new TypeError("Language-server messages cannot contain BigInt values");
    if (typeof item !== "object") return undefined;
    if (active.has(item))
      throw new TypeError("Language-server messages cannot contain circular values");
    active.add(item);
    add(2);
    let result;
    if (Array.isArray(item)) {
      if (item.length > maxValues - values) add(maxUnits + 1);
      result = [];
      for (let index = 0; index < item.length; index++) {
        add(1);
        const child = visit(item[index], String(index), depth + 1);
        if (child === undefined) add(4);
        result.push(child ?? null);
      }
    } else {
      result = {};
      for (const property of Object.keys(item)) {
        const child = item[property];
        if (["undefined", "symbol"].includes(typeof child)) continue;
        add(property.length * 6 + 4);
        const normalized = visit(child, property, depth + 1);
        if (normalized !== undefined)
          Object.defineProperty(result, property, {
            value: normalized,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      }
    }
    active.delete(item);
    return result;
  };
  return { value: visit(value), units };
}

module.exports = { prepareMessage, TextLength, MAX_VALUES, MAX_MESSAGE_UNITS: MAX_STRING_LENGTH };
