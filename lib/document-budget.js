const { MAX_STRING_LENGTH } = require("node:buffer").constants;

const SETTING = "ide.maxDocumentSize";
const DEFAULT_MIB = 32;
const oversizedPayloads = new WeakMap();
const notebookGroups = new WeakMap();

function transportTextLimit(maxStringLength = MAX_STRING_LENGTH, envelopeUnits = 65536) {
  // A JSON string can expand each UTF-16 unit to a six-unit escape. Reserve
  // the surrounding document URI, field names and protocol envelope as well.
  return Math.max(0, Math.floor((maxStringLength - envelopeUnits) / 6));
}

function assertTransportUnits(length, maxStringLength, envelopeUnits) {
  const limit = transportTextLimit(maxStringLength, envelopeUnits);
  if (length > limit) throw unavailableError(length, limit);
}

function retainedPayloadLength(editor) {
  const payload = editor && oversizedPayloads.get(editor);
  if (!payload) return 0;
  if (
    payload.revision !== editor.getBuffer?.()?.getTextRevision?.() ||
    payload.length <= textLimit()
  ) {
    oversizedPayloads.delete(editor);
    return 0;
  }
  return payload.length;
}

function textLimit() {
  const configured = lumine.config.get(SETTING);
  const mib = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MIB;
  return Math.min(transportTextLimit(), Math.floor(mib * 1024 * 1024));
}

function editorLength(editor) {
  const buffer = editor?.getBuffer?.();
  const length = buffer?.getLength?.();
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function canSynchronizeSource(editor) {
  const buffer = editor?.getBuffer?.();
  const limit = textLimit();
  if (retainedPayloadLength(editor) > limit) return false;
  if (typeof buffer?.canMaterializeText === "function") return buffer.canMaterializeText(limit);
  const length = editorLength(editor);
  // Some external editor shims have no backing TextBuffer. Their produced
  // payload is checked separately before publication; do not read it to ask.
  return length == null || length <= limit;
}

function canSynchronizeEditor(editor) {
  return (
    canSynchronizeSource(editor) && notebookGroups.get(editor)?.transportBudget?.available !== false
  );
}

function bindNotebookGroup(editor, group) {
  notebookGroups.set(editor, group);
}
function unbindNotebookGroup(editor, group) {
  if (notebookGroups.get(editor) === group) notebookGroups.delete(editor);
}

function editorAvailable(editor) {
  return (
    !!editor &&
    !editor.isDestroyed?.() &&
    editor.getGrammar?.() !== lumine.grammars.nullGrammar &&
    canSynchronizeEditor(editor)
  );
}

function availabilityForEditor(editor) {
  const sourceLength = editorLength(editor);
  const length = retainedPayloadLength(editor) || sourceLength;
  const limit = textLimit();
  const group = editor && notebookGroups.get(editor)?.transportBudget;
  const reason =
    !editor || editor.isDestroyed?.()
      ? "closed"
      : editor.getGrammar?.() === lumine.grammars.nullGrammar
        ? "no-grammar"
        : group?.available === false
          ? "transport-limit"
          : canSynchronizeEditor(editor)
            ? null
            : "size-limit";
  return Object.freeze({
    available: reason == null,
    reason,
    length: reason === "transport-limit" ? group.length : length,
    limit: reason === "transport-limit" ? group.limit : limit,
  });
}

function unavailableError(length = null, limit = textLimit()) {
  return Object.assign(
    new Error("The document exceeds the language-server synchronization budget."),
    {
      name: "AbortError",
      code: "IDE_DOCUMENT_SIZE_LIMIT",
      length,
      limit,
    },
  );
}

function assertEditorBudget(editor) {
  if (!canSynchronizeEditor(editor)) throw unavailableError(editorLength(editor));
}

function assertTextBudget(text, editor) {
  if (typeof text !== "string")
    throw new TypeError("Language-server document text must be a string");
  if (text.length > textLimit()) {
    if (editor)
      oversizedPayloads.set(editor, {
        revision: editor.getBuffer?.()?.getTextRevision?.(),
        length: text.length,
      });
    throw unavailableError(text.length);
  }
  return text;
}

module.exports = {
  SETTING,
  textLimit,
  canSynchronizeEditor,
  canSynchronizeSource,
  editorLength,
  bindNotebookGroup,
  unbindNotebookGroup,
  editorAvailable,
  availabilityForEditor,
  assertEditorBudget,
  assertTextBudget,
  transportTextLimit,
  assertTransportUnits,
};
