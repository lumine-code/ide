const RefreshingProvider = require("./refreshing-provider");

const INLAY_HINT_CAPABILITIES = {
  textDocument: {
    inlayHint: { dynamicRegistration: true },
  },
  workspace: { inlayHint: { refreshSupport: true } },
};

// Serves the inlay-hints.provider contract from textDocument/inlayHint. The
// package that consumes it owns the rendering; this owns the protocol — which
// session answers, how a row range becomes an LSP range, and what a label is
// once its parts are joined.
module.exports = class InlayHintsProvider extends RefreshingProvider {
  static capabilities = INLAY_HINT_CAPABILITIES;
  constructor(manager) {
    super(manager, INLAY_HINT_CAPABILITIES, "inlayHint");
  }
  async inlayHints(editor, [startRow, endRow]) {
    if (this.disposed) return null;
    const epoch = this.epoch;
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/inlayHint");
    if (!session || this.disposed || epoch !== this.epoch) return null;
    const uri = this.manager.uriForEditor(editor);
    if (!uri) return null;
    // Not caught: a request that fails transiently — a server reindexing —
    // rejects, and the contract reads that as "leave what is on screen alone".
    // Blanking the labels and repainting them a moment later is worse than
    // showing them a moment stale.
    const eof =
      editor.getEndBufferPosition?.() ??
      editor.getEofBufferPosition?.() ??
      editor.getBuffer?.()?.getEndPosition?.();
    const start =
      eof && startRow > eof.row
        ? { line: eof.row, character: eof.column }
        : { line: startRow, character: 0 };
    const end =
      eof && endRow + 1 > eof.row
        ? { line: eof.row, character: eof.column }
        : { line: endRow + 1, character: 0 };
    const hints = await session.request("textDocument/inlayHint", {
      textDocument: { uri },
      range: { start, end },
    });
    return this.disposed || this.epoch !== epoch
      ? null
      : (hints || []).map((hint) => this.toHint(hint)).filter(Boolean);
  }
  toHint(lsp) {
    const position = lsp?.position;
    if (!position) return null;
    // A label arrives either as a string or as the parts a server can attach a
    // tooltip or a command to; nothing renders those, so they are joined here
    // and the extras dropped.
    const label = Array.isArray(lsp.label)
      ? lsp.label.map((part) => part?.value || "").join("")
      : lsp.label || "";
    if (!label) return null;
    return {
      position: [position.line, position.character],
      label,
      paddingLeft: !!lsp.paddingLeft,
      paddingRight: !!lsp.paddingRight,
    };
  }
};
