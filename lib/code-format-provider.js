const C = require("./converters");

const FORMAT_CAPABILITIES = {
  textDocument: {
    formatting: { dynamicRegistration: true },
    rangeFormatting: { dynamicRegistration: true },
    onTypeFormatting: { dynamicRegistration: true },
  },
};

// One shared implementation behind the four code-format services. Every
// method resolves to an array of { oldRange, newText } edits.
module.exports = class CodeFormatProvider {
  static capabilities = FORMAT_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(FORMAT_CAPABILITIES);
  }
  providerFor(method) {
    const self = this;
    return {
      priority: 2,
      packageName: "ide-client",
      get grammarScopes() {
        return self.manager.allGrammarScopes();
      },
      ...method,
    };
  }
  rangeProvider() {
    return this.providerFor({ formatCode: (editor, range) => this.formatRange(editor, range) });
  }
  fileProvider() {
    return this.providerFor({ formatEntireFile: (editor) => this.formatFile(editor) });
  }
  onTypeProvider() {
    return this.providerFor({
      formatAtPosition: (editor, position, character) =>
        this.formatOnType(editor, position, character),
      keepCursorPosition: false,
    });
  }
  onSaveProvider() {
    return this.providerFor({ formatOnSave: (editor) => this.formatOnSave(editor) });
  }
  options(editor) {
    return { tabSize: editor.getTabLength(), insertSpaces: editor.getSoftTabs() };
  }
  edits(result, session, editor) {
    const uri = this.manager.uriForEditor(editor);
    if (session.mapTextEdits)
      return session.mapTextEdits(
        (result || []).map((edit) => ({
          oldRange: C.rangeFromLsp(edit.range),
          newText: edit.newText,
        })),
        editor,
        uri,
        session.responseProjection?.(result) ?? session.projectionForEditor(editor),
      );
    return (result || []).map((edit) => ({
      oldRange: C.rangeFromLsp(edit.range),
      newText: session.restoreDocumentText?.(edit.newText, editor, uri) ?? edit.newText,
    }));
  }
  async projectedFormat(session, editor, method, range) {
    if (!session.adapter?.formatProjectedDocument) return undefined;
    const projection = await session.currentDocumentProjection(editor);
    if (!projection) return undefined;
    const uri = this.manager.uriForEditor(editor);
    const edits = await session.adapter.formatProjectedDocument(editor, projection, {
      method,
      range,
      options: this.options(editor),
      session,
      signal: session.documents.get(C.uriKey(uri))?.syncAbortController?.signal,
    });
    return projection.isCurrent() ? edits || [] : [];
  }
  async formatRange(editor, range) {
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/rangeFormatting",
    );
    if (!session) return [];
    try {
      const projected = await this.projectedFormat(session, editor, "range", range);
      if (projected !== undefined) return projected;
      return this.edits(
        await session.request("textDocument/rangeFormatting", {
          textDocument: { uri: this.manager.uriForEditor(editor) },
          range: C.rangeToLsp(range),
          options: this.options(editor),
        }),
        session,
        editor,
      );
    } catch {
      return [];
    }
  }
  async formatFile(editor) {
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/formatting");
    if (!session) return [];
    try {
      const projected = await this.projectedFormat(session, editor, "file");
      if (projected !== undefined) return projected;
      return this.edits(
        await session.request("textDocument/formatting", {
          textDocument: { uri: this.manager.uriForEditor(editor) },
          options: this.options(editor),
        }),
        session,
        editor,
      );
    } catch {
      return [];
    }
  }
  async formatOnType(editor, position, character) {
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/onTypeFormatting",
    );
    if (!session) return [];
    const provider = session.capabilityOptions("textDocument/onTypeFormatting", editor);
    const triggers = [
      provider?.firstTriggerCharacter,
      ...(provider?.moreTriggerCharacter || []),
    ].filter(Boolean);
    if (!triggers.includes(character)) return [];
    try {
      return this.edits(
        await session.request("textDocument/onTypeFormatting", {
          textDocument: { uri: this.manager.uriForEditor(editor) },
          position: C.pointToPosition(position),
          ch: character,
          options: this.options(editor),
        }),
        session,
        editor,
      );
    } catch {
      return [];
    }
  }
  // Prefers willSaveWaitUntil when the server implements it, else plain
  // document formatting.
  async formatOnSave(editor) {
    // A server that only answers willSaveWaitUntil still formats on save, so
    // prefer whichever session offers either path. That one is read off the
    // sync capability rather than through supports(), so the format switch has
    // to be honoured here explicitly or a disabled server would still format.
    const sessions = await this.manager.activeSessionsForEditor(editor);
    const session =
      sessions.find((candidate) => {
        const sync = candidate.capabilities.textDocumentSync;
        return (
          typeof sync === "object" &&
          sync?.willSaveWaitUntil &&
          candidate.supports("textDocument/willSaveWaitUntil", editor)
        );
      }) ||
      sessions.find((candidate) => candidate.supports("textDocument/formatting", editor)) ||
      null;
    if (!session) return [];
    const sync = session.capabilities.textDocumentSync;
    try {
      const projected = await this.projectedFormat(session, editor, "save");
      if (projected !== undefined) return projected;
    } catch {
      return [];
    }
    if (typeof sync === "object" && sync?.willSaveWaitUntil) {
      try {
        return this.edits(
          await session.request("textDocument/willSaveWaitUntil", {
            textDocument: { uri: this.manager.uriForEditor(editor) },
            reason: 1,
          }),
          session,
          editor,
        );
      } catch {
        return [];
      }
    }
    return this.formatFile(editor);
  }
};
