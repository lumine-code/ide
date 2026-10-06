const RefreshingProvider = require("./refreshing-provider");

// The LSP 3.17 standard names, advertised so a server knows which of its own
// classifications this client understands. What each name means visually is the
// consumer's business, not this file's.
const STANDARD_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
];
const STANDARD_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
];

const SEMANTIC_TOKENS_CAPABILITIES = {
  textDocument: {
    semanticTokens: {
      dynamicRegistration: true,
      requests: { full: { delta: true }, range: true },
      tokenTypes: STANDARD_TOKEN_TYPES,
      tokenModifiers: STANDARD_TOKEN_MODIFIERS,
      formats: ["relative"],
      augmentsSyntaxTokens: true,
      overlappingTokenSupport: false,
      multilineTokenSupport: false,
    },
  },
  workspace: { semanticTokens: { refreshSupport: true } },
};

// Serves the semantic-tokens.provider contract from textDocument/semanticTokens.
// The package that consumes it owns the rendering and the budgets; this owns
// the protocol — which session answers, whether a delta may be asked for, and
// the legend that turns packed indices into names.
module.exports = class SemanticTokensProvider extends RefreshingProvider {
  static capabilities = SEMANTIC_TOKENS_CAPABILITIES;
  constructor(manager) {
    super(manager, SEMANTIC_TOKENS_CAPABILITIES, "semanticTokens");
    // The packed result a delta would be computed against, per editor. Held
    // weakly: an entry is only worth what its editor is, and both go together.
    this.caches = new WeakMap();
    // A refresh or range request can overtake a pending full request. Only the
    // newest request for an editor may publish a whole-document delta base.
    this.requestGenerations = new WeakMap();
  }
  async semanticTokens(editor) {
    if (this.disposed) return null;
    const generation = this.beginRequest(editor);
    const context = await this.contextFor(editor);
    if (!context || this.disposed) return null;
    const { session, options, uri } = context;
    if (!options.full) return null;
    const epoch = this.epoch;
    const cached = this.caches.get(editor);
    const reusable =
      cached?.epoch === epoch && cached.session === session && cached.uri === uri ? cached : null;
    const textDocument = { uri };
    let result;
    // Not caught: a request that fails transiently — a server reindexing —
    // rejects, and the contract reads that as "leave what is on screen alone".
    if (reusable?.resultId && options.full?.delta) {
      result = await session.request("textDocument/semanticTokens/full/delta", {
        textDocument,
        previousResultId: reusable.resultId,
      });
    } else {
      result = await session.request("textDocument/semanticTokens/full", { textDocument });
    }
    const data = result?.edits ? this.applyEdits(reusable?.data, result.edits) : result?.data || [];
    if (this.disposed) return null;
    if (generation === this.requestGenerations.get(editor) && epoch === this.epoch) {
      this.caches.set(editor, {
        session,
        uri,
        data,
        resultId: result?.resultId || null,
        epoch,
      });
    }
    return this.mapTokens(this.decode(data, options.legend), session.responseProjection?.(result));
  }
  async semanticTokensInRange(editor, [startRow, endRow]) {
    if (this.disposed) return null;
    this.beginRequest(editor);
    // Asking for a range means the whole document was too much to render, so
    // neither a stored result nor an outstanding full request may restore a
    // delta base.
    this.caches.delete(editor);
    const context = await this.contextFor(editor);
    if (!context || this.disposed) return null;
    const { session, options, uri } = context;
    if (!options.range) return null;
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
    const result = await session.request("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: { start, end },
    });
    if (this.disposed) return null;
    return this.mapTokens(
      this.decode(result?.data || [], options.legend),
      session.responseProjection?.(result),
    );
  }
  mapTokens(tokens, projection) {
    if (!projection) return tokens;
    if (!projection.isCurrent()) return [];
    return tokens.flatMap((token) => {
      const mapped = projection.fromServerRange([
        [token.row, token.column],
        [token.row, token.column + token.length],
      ]);
      if (!mapped || projection.isPythonRange?.(mapped) === false) return [];
      return [
        {
          ...token,
          row: mapped.start.row,
          column: mapped.start.column,
          length: mapped.end.column - mapped.start.column,
        },
      ];
    });
  }
  beginRequest(editor) {
    const generation = (this.requestGenerations.get(editor) || 0) + 1;
    this.requestGenerations.set(editor, generation);
    return generation;
  }
  // The session that classifies this editor, with the options it registered.
  // Without a legend nothing can be named, so there is nothing to serve.
  async contextFor(editor) {
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/semanticTokens",
    );
    if (!session) return null;
    const uri = this.manager.uriForEditor(editor);
    if (!uri) return null;
    const options = session.capabilityOptions("textDocument/semanticTokens", editor);
    if (!options?.legend) return null;
    return { session, options, uri };
  }
  // Decodes the packed relative uint array
  // (deltaLine/deltaStart/length/type/modifiers) into absolute positions, and
  // resolves the legend indices to the names the contract carries.
  decode(data, legend) {
    const types = legend?.tokenTypes || [];
    const modifiers = legend?.tokenModifiers || [];
    const tokens = [];
    let row = 0;
    let column = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      if (data[i] > 0) {
        row += data[i];
        column = data[i + 1];
      } else {
        column += data[i + 1];
      }
      const bits = data[i + 4];
      const names = [];
      for (let bit = 0; bit < modifiers.length; bit++)
        if (bits & (1 << bit)) names.push(modifiers[bit]);
      tokens.push({
        row,
        column,
        length: data[i + 2],
        type: types[data[i + 3]] ?? null,
        modifiers: names,
      });
    }
    return tokens;
  }
  // Applies SemanticTokensEdits to the stored uint array. The consumer rebuilds
  // its markers from the result: reconstructing only the edited span invites
  // off-by-one drift for no measured win — correctness first.
  applyEdits(data, edits) {
    let next = Array.from(data || []);
    for (const edit of [...edits].sort((a, b) => b.start - a.start))
      next = next
        .slice(0, edit.start)
        .concat(edit.data || [], next.slice(edit.start + edit.deleteCount));
    return next;
  }
};
