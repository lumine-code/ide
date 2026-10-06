const { Point, Range } = require("lumine");
const C = require("./converters");

const position = (value) => Point.fromObject([value.line, value.character]);
const range = (value) => Range.fromObject(C.rangeFromLsp(value));
const lspPoint = (value) => value && C.pointToPosition(Point.fromObject(value));
const lspRange = (value) => value && C.rangeToLsp(Range.fromObject(value));

class ExcludedPositionError extends Error {
  constructor() {
    super("Language server request is outside projected Python source");
    this.code = "PROJECTION_POSITION_EXCLUDED";
  }
}

class StaleProjectionError extends Error {
  constructor() {
    super("Language server projection is stale");
    this.code = "PROJECTION_STALE";
  }
}

function toServerParams(projection, params) {
  if (!projection) return params;
  if (!projection.isCurrent()) throw new StaleProjectionError();
  const next = { ...params };
  if (params.position) {
    const original = position(params.position);
    if (!projection.isPythonPosition(original)) throw new ExcludedPositionError();
    next.position = lspPoint(projection.toServerPosition(original));
    if (!next.position) throw new ExcludedPositionError();
  }
  if (params.range) {
    const original = range(params.range);
    if (original.isEmpty() && !projection.isPythonPosition(original.start))
      throw new ExcludedPositionError();
    next.range = lspRange(projection.toServerRange(original));
    if (!next.range) throw new ExcludedPositionError();
  }
  if (params.positions) {
    next.positions = params.positions.map((value) => {
      const original = position(value);
      if (!projection.isPythonPosition(original)) throw new ExcludedPositionError();
      const mapped = lspPoint(projection.toServerPosition(original));
      if (!mapped) throw new ExcludedPositionError();
      return mapped;
    });
  }
  if (params.context?.diagnostics) {
    next.context = {
      ...params.context,
      diagnostics: params.context.diagnostics.flatMap((item) => {
        const mapped = lspRange(projection.toServerRange(range(item.range)));
        return mapped ? [{ ...item, range: mapped }] : [];
      }),
    };
  }
  return next;
}

function fromServerRange(projection, value, { requirePython = true } = {}) {
  if (!projection) return value;
  const mapped = projection.fromServerRange(range(value));
  if (!mapped || (requirePython && projection.isPythonRange?.(mapped) === false)) return null;
  return lspRange(mapped);
}

function mapDiagnostics(projection, diagnostics) {
  if (!projection) return diagnostics;
  if (!projection.isCurrent()) return [];
  return diagnostics.flatMap((item) => {
    const mapped = fromServerRange(projection, item.range);
    return mapped ? [{ ...item, range: mapped }] : [];
  });
}

// Read-only geometry may span a hidden body, as a symbol's enclosing range
// does. Selection anchors and token/diagnostic spans must belong to Python.
function mapReadResult(value, projectionForUri, uri, remember) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value
      .map((item) => mapReadResult(item, projectionForUri, uri, remember))
      .filter((item) => item != null);
  const targetUri = value.uri || value.targetUri || uri;
  const projection = projectionForUri(targetUri);
  const next = { ...value };
  for (const [key, item] of Object.entries(value)) {
    if (["data", "arguments", "edit", "edits", "textEdit", "additionalTextEdits"].includes(key))
      continue;
    if (key === "position" && item?.line != null) {
      const mapped = projection ? projection.fromServerPosition(position(item)) : position(item);
      if (!mapped || projection?.isPythonPosition(mapped) === false) return null;
      next[key] = lspPoint(mapped);
    } else if (
      [
        "range",
        "selectionRange",
        "targetRange",
        "targetSelectionRange",
        "originSelectionRange",
      ].includes(key) &&
      item?.start
    ) {
      const owner = key === "originSelectionRange" ? projectionForUri(uri) : projection;
      const mapped = fromServerRange(owner, item, {
        requirePython: !["range", "targetRange"].includes(key),
      });
      if (!mapped) return null;
      next[key] = mapped;
    } else if (key === "fromRanges" && Array.isArray(item)) {
      next[key] = item.map((entry) => fromServerRange(projection, entry)).filter(Boolean);
    } else if (item && typeof item === "object") {
      next[key] = mapReadResult(item, projectionForUri, targetUri, remember);
    }
  }
  remember?.(next, value, projection);
  return next;
}

function emptyResult(method) {
  if (method.includes("semanticTokens")) return { data: [] };
  if (
    ["textDocument/hover", "textDocument/signatureHelp", "textDocument/prepareRename"].includes(
      method,
    )
  )
    return null;
  return [];
}

function usesOriginalText(projection) {
  return (
    projection?.isIdentity === true &&
    typeof projection.source === "string" &&
    typeof projection.text === "string" &&
    projection.source === projection.text
  );
}

module.exports = {
  ExcludedPositionError,
  StaleProjectionError,
  toServerParams,
  fromServerRange,
  mapDiagnostics,
  mapReadResult,
  emptyResult,
  usesOriginalText,
};
