const { Point, Range } = require("lumine");
const C = require("./converters");
const Budget = require("./document-budget");
const observeEditorRequest = require("./observe-editor-request");
const RefreshingProvider = require("./refreshing-provider");

const METHOD = "textDocument/inlineCompletion";
const MAX_PREFIX_LENGTH = 4096;
const CAPABILITIES = { textDocument: { inlineCompletion: { dynamicRegistration: true } } };

function replacementRange(range) {
  const { start, end } = range || {};
  if (
    !Number.isInteger(start?.line) ||
    start.line < 0 ||
    end?.line !== start.line ||
    !Number.isInteger(start.character) ||
    !Number.isInteger(end.character) ||
    start.character < 0 ||
    start.character > end.character
  )
    return null;
  return Range.fromObject(C.rangeFromLsp(range));
}

function defaultRange(editor, position) {
  const { row, column } = position;
  const startColumn = Math.max(0, column - MAX_PREFIX_LENGTH - 1);
  const prefix = editor.getTextInBufferRange([[row, startColumn], position]);
  const nonWord = editor.getNonWordCharacters(position);
  let start = prefix.length;
  while (start > 0 && !/\s/u.test(prefix[start - 1]) && !nonWord.includes(prefix[start - 1]))
    start--;
  if (prefix.length - start > MAX_PREFIX_LENGTH) return null;
  return { prefix: prefix.slice(start), range: new Range([row, startColumn + start], position) };
}

module.exports = class InlineCompletionProvider extends RefreshingProvider {
  static capabilities = CAPABILITIES;

  constructor(manager) {
    super(manager, CAPABILITIES, "inlineCompletion");
    this.lifetime = new AbortController();
    this.subscriptions.add(manager.onDidChangeAdapters(() => this.invalidate()));
  }

  async getInlineCompletions({ editor, bufferPosition, triggerKind, signal: callerSignal }) {
    if (
      this.disposed ||
      callerSignal?.aborted ||
      !Budget.editorAvailable(editor) ||
      editor.isReadOnly?.() ||
      !bufferPosition
    )
      return [];
    const position = Point.fromObject(bufferPosition, true);
    const buffer = editor.getBuffer();
    if (
      !Number.isInteger(position.row) ||
      !Number.isInteger(position.column) ||
      !buffer.clipPosition(position).isEqual(position)
    )
      return [];

    const controller = new AbortController();
    const signal = AbortSignal.any(
      [callerSignal, controller.signal, this.lifetime.signal].filter(Boolean),
    );
    const subscriptions = observeEditorRequest(editor, controller, { cursor: true });
    try {
      const uri = this.manager.uriForEditor(editor);
      if (!uri) return [];
      // A running inline server can answer while an unrelated server for the
      // same editor is still starting. Require the same attached buffer here.
      const ready = this.manager
        .peekSessionsForEditor(editor)
        .find(
          (session) =>
            session.state === "running" &&
            session.supports(METHOD, editor) &&
            session.documents.get(uri)?.editor?.getBuffer() === buffer,
        );
      const session =
        ready ??
        (await this.manager.activeSessionForFeature(editor, METHOD, undefined, { signal }));
      if (signal.aborted || !session) return [];
      const document = session.documents.get(uri);
      if (!document) return [];
      const epoch = this.epoch;
      const grammar = editor.getGrammar();
      const revision = buffer.getTextRevision();
      const current = () =>
        !this.disposed &&
        !this.manager.tearingDown &&
        this.epoch === epoch &&
        session.state === "running" &&
        Budget.editorAvailable(editor) &&
        !editor.isReadOnly?.() &&
        editor.getBuffer() === buffer &&
        editor.getGrammar() === grammar &&
        this.manager.uriForEditor(editor) === uri &&
        session.documents.get(uri) === document &&
        document.editor?.getBuffer() === buffer &&
        session.supports(METHOD, editor);
      if (!current()) return [];

      subscriptions.add(this.onDidInvalidate(() => controller.abort()));
      const result = await session.request(
        METHOD,
        {
          textDocument: { uri },
          position: C.pointToPosition(position),
          context: { triggerKind: triggerKind === "invoked" || triggerKind === 1 ? 1 : 2 },
        },
        { editor, signal },
      );
      if (signal.aborted || !current()) return [];
      const items = Array.isArray(result) ? result : result?.items;
      if (!Array.isArray(items)) return [];
      const projection = session.responseProjection(result);
      const isApplicable = () =>
        current() &&
        buffer.getTextRevision() === revision &&
        session.projectionForEditor(editor) === projection &&
        projection?.isCurrent() !== false;
      let fallback;
      const getDefaultRange = (filter) => {
        if (fallback === undefined) fallback = defaultRange(editor, position);
        if (!fallback) return null;
        const range = filter.startsWith(fallback.prefix)
          ? fallback.range
          : new Range(position, position);
        return projection ? projection.toServerRange(range) : range;
      };
      const completions = [];
      for (const item of items) {
        const completion = this.completionFromItem(
          item,
          editor,
          session,
          uri,
          projection,
          position,
          getDefaultRange,
        );
        if (!completion) continue;
        completion.isApplicable = isApplicable;
        const command = item.command;
        if (
          typeof command?.command === "string" &&
          (command.arguments === undefined || Array.isArray(command.arguments)) &&
          session.canExecuteCommand(command.command, editor)
        )
          completion.didAccept = this.acceptCommand(command, session, document, editor, current);
        completions.push(completion);
      }
      return completions;
    } catch (error) {
      if (signal.aborted || error?.code === "PROJECTION_STALE" || error?.code === -32800) return [];
      throw error;
    } finally {
      subscriptions.dispose();
    }
  }

  completionFromItem(item, editor, session, uri, projection, position, getDefaultRange) {
    const insertText = item?.insertText;
    const snippet = insertText?.kind === "snippet";
    const text = snippet ? insertText.value : insertText;
    if (typeof text !== "string") return null;
    const filterText = typeof item.filterText === "string" ? item.filterText : undefined;
    const wireRange =
      item.range === undefined ? getDefaultRange(filterText || text) : replacementRange(item.range);
    if (!wireRange) return null;
    const buffer = editor.getBuffer();
    if (!projection && wireRange.start.row > buffer.getLastRow()) return null;
    // LSP positions past the end of an existing line refer to its end.
    const oldRange = projection ? wireRange : buffer.clipRange(wireRange);
    let mapped;
    try {
      mapped = session.mapTextEdits([{ oldRange, newText: text }], editor, uri, projection);
    } catch {
      // A projection may reject an edit in synthetic or protected text.
      return null;
    }
    if (mapped?.length !== 1 || typeof mapped[0]?.newText !== "string") return null;
    const range = Range.fromObject(mapped[0].oldRange);
    if (
      range.start.row !== range.end.row ||
      !range.containsPoint(position) ||
      !buffer.clipRange(range).isEqual(range)
    )
      return null;
    return {
      text: mapped[0].newText,
      range,
      ...(snippet && { snippet: mapped[0].newText }),
      ...(filterText !== undefined && { filterText }),
    };
  }

  acceptCommand(command, session, document, editor, current) {
    let accepted = false;
    return async () => {
      if (accepted || !current() || !session.canExecuteCommand(command.command, editor)) return;
      accepted = true;
      // A projected document may still be synchronizing the inserted text.
      // Wait for it before sending a command about the resulting document.
      const buffer = editor.getBuffer();
      const revision = buffer.getTextRevision();
      try {
        await session.waitForDocumentSync(document, this.lifetime.signal);
        if (
          !current() ||
          buffer.getTextRevision() !== revision ||
          !session.canExecuteCommand(command.command, editor)
        )
          return;
        await session.request(
          "workspace/executeCommand",
          { command: command.command, arguments: command.arguments },
          { editor, signal: this.lifetime.signal },
        );
      } catch (error) {
        if (current())
          lumine.notifications.addWarning("Language server command failed", {
            detail: error.message,
            dismissable: true,
          });
      }
    };
  }

  dispose() {
    this.lifetime.abort();
    super.dispose();
  }
};
