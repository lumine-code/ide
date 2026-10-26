const { TextBuffer } = require("lumine");
const Budget = require("./document-budget");
const Snapshot = TextBuffer.createTextSnapshot().constructor;
const MAX_SNAPSHOT_UNITS = 32 * 1024 * 1024;

function currentSource(record, cell) {
  if (typeof record.cellSource === "function") return record.cellSource(cell);
  const editor = record.primaryEditor?.(cell) ?? cell.editor;
  const source = editor?.getBuffer?.()?.getTextSnapshot?.();
  if (source) return source;
  if (editor?.getText) {
    Budget.assertEditorBudget(editor);
    return Budget.assertTextBudget(editor.getText(), editor);
  }
  return cell.textSource ?? cell.text ?? "";
}

function savedCells(json) {
  if (typeof json !== "string" || json.length > MAX_SNAPSHOT_UNITS) return null;
  try {
    const cells = JSON.parse(json).cells;
    if (!Array.isArray(cells)) return null;
    const result = [];
    for (const cell of cells) {
      const parts = Array.isArray(cell.source) ? cell.source : [cell.source];
      let source = TextBuffer.createTextSnapshot();
      for (const part of parts) {
        if (typeof part !== "string") return null;
        if (part.length) source = source.replace(source.length, source.length, part);
      }
      result.push({ id: cell.id, kind: cell.cell_type === "code" ? "code" : "markup", source });
    }
    return result;
  } catch {
    return null;
  }
}

function sameSource(left, right) {
  if (left === right) return true;
  if (left == null || right == null || left.length !== right.length) return false;
  if (left instanceof Snapshot && right instanceof Snapshot) return left.equals(right);
  // The legacy source contract only exposes length/toString. Immutable
  // identity is enough above the protocol budget; changed opaque sources
  // must invalidate instead of forcing their string getter.
  if (left.length > MAX_SNAPSHOT_UNITS) return false;
  if (!(left instanceof Snapshot)) left = typeof left === "string" ? left : left.toString();
  if (!(right instanceof Snapshot)) right = typeof right === "string" ? right : right.toString();
  if (typeof left === "string" && typeof right === "string") return left === right;
  const snapshot = left instanceof Snapshot ? left : right;
  const text = left instanceof Snapshot ? right : left;
  if (typeof text !== "string" || text.length !== snapshot.length) return false;
  let offset = 0;
  for (const chunk of snapshot.chunks()) {
    if (text.slice(offset, offset + chunk.length) !== chunk) return false;
    offset += chunk.length;
  }
  return true;
}

module.exports = { currentSource, savedCells, sameSource, MAX_SNAPSHOT_UNITS };
