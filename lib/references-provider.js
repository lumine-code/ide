const { CompositeDisposable, Point } = require("lumine");
const C = require("./converters");

const REFERENCES_CAPABILITIES = {
  textDocument: { references: { dynamicRegistration: true } },
};

module.exports = class ReferencesProvider {
  static capabilities = REFERENCES_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(REFERENCES_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide-client";
    this.abortController = null;
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  isEditorSupported(editor) {
    return !!this.manager.adapterForEditor(editor);
  }
  // Resolves to { symbolName, references: [{ path, range, name? }] }; null when
  // no session can serve references, and also when a newer request has
  // superseded this one or its source context changed. Genuine failures reject.
  async findReferences(editor, point) {
    const capturedPoint = Point.fromObject(point).copy();
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const { signal } = controller;
    const subscriptions = new CompositeDisposable();
    const cancel = () => controller.abort();
    for (const [owner, event] of [
      [editor.getBuffer?.(), "onDidChange"],
      [editor, "onDidChangePath"],
      [editor, "onDidChangeGrammar"],
      [editor, "onDidChangeCursorPosition"],
      [editor, "onDidDestroy"],
    ]) {
      const subscription = owner?.[event]?.(cancel);
      if (subscription) subscriptions.add(subscription);
    }
    try {
      const all = await this.manager.activeSessionsForEditor(editor);
      if (signal.aborted || editor.isDestroyed?.()) return null;
      const sessions = all.filter((session) => session.supports("textDocument/references", editor));
      if (!sessions.length) return null;
      // Servers that both index the file report overlapping locations, so the
      // merged list is deduplicated by position.
      const seen = new Set();
      const references = [];
      const responses = await Promise.all(
        sessions.map((session) =>
          session.request(
            "textDocument/references",
            {
              textDocument: { uri: this.manager.uriForEditor(editor) },
              position: C.pointToPosition(capturedPoint),
              context: { includeDeclaration: true },
            },
            { signal },
          ),
        ),
      );
      if (signal.aborted) return null;
      for (const location of responses.flat()) {
        if (!location) continue;
        const resolved = this.manager.resolveUri(location.uri);
        // The references consumer identifies buffers and panel rows by path.
        // Giving it an untitled result would highlight every scratch buffer at
        // the same positions, because all of them share an undefined path.
        if (!resolved || resolved.kind === "untitled") continue;
        const range = C.rangeFromLsp(location.range);
        // A cell reference lands on its notebook, with the cell number carried
        // along; ranges stay cell-relative. Two cells share row numbers, so the
        // cell is part of the dedup key.
        const path = resolved.kind === "cell" ? resolved.notebookPath : resolved.path;
        const cell = resolved.kind === "cell" ? resolved.cellIndex + 1 : undefined;
        const key = `${path}:${cell ?? ""}:${range[0][0]}:${range[0][1]}:${range[1][0]}:${range[1][1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push(
          cell === undefined
            ? { path, range, name: null }
            : { path, cell, uri: location.uri, range, name: null },
        );
      }
      return { symbolName: this.symbolNameAt(editor, capturedPoint), references };
    } catch (error) {
      // Ordinary source changes and stale replies abandon this lookup. A new
      // lookup must map its own current projection instead of reusing points
      // captured before the edit or grammar reattachment.
      if (signal.aborted || error?.code === "PROJECTION_STALE") return null;
      throw error;
    } finally {
      subscriptions.dispose();
      if (this.abortController === controller) this.abortController = null;
    }
  }
  symbolNameAt(editor, point) {
    const line = editor.getBuffer().lineForRow(point.row) || "";
    const before = /[\w$]+$/.exec(line.slice(0, point.column))?.[0] || "";
    const after = /^[\w$]+/.exec(line.slice(point.column))?.[0] || "";
    return before + after || null;
  }
};
