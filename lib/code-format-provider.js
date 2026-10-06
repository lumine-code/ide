const C = require("./converters");
const { Range } = require("lumine");

const FORMAT_CAPABILITIES = {
  textDocument: {
    formatting: { dynamicRegistration: true },
    rangeFormatting: { dynamicRegistration: true },
    onTypeFormatting: { dynamicRegistration: true },
  },
};

// One shared implementation behind the four code-format services. Every
// method returns edits or a complete projection plan without changing the
// editor. A null result declines the request; an empty array handles a no-op.
module.exports = class CodeFormatProvider {
  static capabilities = FORMAT_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(FORMAT_CAPABILITIES);
  }
  providerFor(method, serviceMethod, extra = {}) {
    const self = this;
    return {
      priority: 2,
      packageName: "ide",
      get grammarScopes() {
        return self.manager.allGrammarScopes();
      },
      canFormat: (editor, request) => this.canFormat(editor, method, request),
      [serviceMethod]: (...args) => this[method](...args),
      ...extra,
    };
  }
  rangeProvider() {
    return this.providerFor("formatRange", "formatCode");
  }
  fileProvider() {
    return this.providerFor("formatFile", "formatEntireFile");
  }
  onTypeProvider() {
    return this.providerFor("formatOnType", "formatAtPosition", {
      keepCursorPosition: false,
    });
  }
  onSaveProvider() {
    return this.providerFor("formatOnSave", "formatOnSave");
  }
  async canFormat(editor, method, request) {
    const isCurrent = this.invocationGuard(editor, request);
    if (!isCurrent()) return false;
    const session = await this.sessionFor(editor, method);
    return isCurrent() && !!session;
  }
  async sessionFor(editor, method) {
    if (method === "formatOnSave") {
      const sessions = await this.manager.activeSessionsForEditor(editor);
      return (
        sessions.find((session) => this.canWaitUntilSave(session, editor)) ||
        sessions.find((session) => session.supports("textDocument/formatting", editor)) ||
        null
      );
    }
    const feature = {
      formatFile: "textDocument/formatting",
      formatRange: "textDocument/rangeFormatting",
      formatOnType: "textDocument/onTypeFormatting",
    }[method];
    return this.manager.activeSessionForFeature(editor, feature);
  }
  canWaitUntilSave(session, editor) {
    const sync = session.capabilities.textDocumentSync;
    return (
      typeof sync === "object" &&
      sync?.willSaveWaitUntil &&
      session.supports("textDocument/willSaveWaitUntil", editor)
    );
  }
  options(editor) {
    return { tabSize: editor.getTabLength(), insertSpaces: editor.getSoftTabs() };
  }
  invocationGuard(editor, request) {
    const selections = editor
      .getSelectedBufferRanges?.()
      .map((value) => Range.fromObject(value).copy());
    const originalPath = editor.getPath?.();
    const source = editor.getText?.();
    return () => {
      if (
        request?.signal?.aborted ||
        (request?.isCurrent && !request.isCurrent()) ||
        editor.isDestroyed?.() ||
        editor.getPath?.() !== originalPath ||
        editor.getText?.() !== source
      )
        return false;
      if (!selections) return true;
      const current = editor.getSelectedBufferRanges();
      return (
        current.length === selections.length &&
        current.every((value, index) => Range.fromObject(value).isEqual(selections[index]))
      );
    };
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
  async projectedFormat(session, editor, method, range, isInvocationCurrent, request) {
    if (!session.adapter?.formatProjectedDocument) return undefined;
    const projection = await session.currentDocumentProjection(editor);
    if (!isInvocationCurrent()) return null;
    if (!projection) return undefined;
    const uri = this.manager.uriForEditor(editor);
    const signals = [
      request?.signal,
      session.documents.get(C.uriKey(uri))?.syncAbortController?.signal,
    ].filter(Boolean);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const isCurrent = () => !signal?.aborted && projection.isCurrent() && isInvocationCurrent();
    if (!isCurrent()) return null;
    let edits;
    try {
      edits = await session.adapter.formatProjectedDocument(editor, projection, {
        uri,
        method,
        range,
        options: this.options(editor),
        session,
        signal,
        isInvocationCurrent: isCurrent,
      });
    } catch (error) {
      if (!isCurrent()) return null;
      throw error;
    }
    if (!isCurrent()) return null;
    if (edits && !Array.isArray(edits) && typeof edits.isCurrent === "function") {
      return { ...edits, isCurrent: () => isCurrent() && edits.isCurrent() };
    }
    return edits ?? null;
  }
  async formatRange(editor, range, request) {
    const isInvocationCurrent = this.invocationGuard(editor, request);
    if (!isInvocationCurrent()) return null;
    range = Range.fromObject(range).copy();
    const session = await this.sessionFor(editor, "formatRange");
    if (!session || !isInvocationCurrent()) return null;
    try {
      const projected = await this.projectedFormat(
        session,
        editor,
        "range",
        range,
        isInvocationCurrent,
        request,
      );
      if (projected !== undefined) return projected;
      const result = await session.request(
        "textDocument/rangeFormatting",
        {
          textDocument: { uri: this.manager.uriForEditor(editor) },
          range: C.rangeToLsp(range),
          options: this.options(editor),
        },
        { signal: request?.signal },
      );
      return isInvocationCurrent() ? this.edits(result, session, editor) : null;
    } catch (error) {
      if (!isInvocationCurrent() || error?.code === "PROJECTION_STALE") return null;
      throw error;
    }
  }
  async formatFile(editor, request) {
    return this.formatDocument(editor, "formatFile", "file", request);
  }
  async formatDocument(editor, method, projectionMethod, request) {
    const isInvocationCurrent = this.invocationGuard(editor, request);
    if (!isInvocationCurrent()) return null;
    const session = await this.sessionFor(editor, method);
    if (!session || !isInvocationCurrent()) return null;
    try {
      const projected = await this.projectedFormat(
        session,
        editor,
        projectionMethod,
        undefined,
        isInvocationCurrent,
        request,
      );
      if (projected !== undefined) return projected;
      const willSave = method === "formatOnSave" && this.canWaitUntilSave(session, editor);
      const result = await session.request(
        willSave ? "textDocument/willSaveWaitUntil" : "textDocument/formatting",
        {
          textDocument: { uri: this.manager.uriForEditor(editor) },
          ...(willSave ? { reason: 1 } : { options: this.options(editor) }),
        },
        { signal: request?.signal },
      );
      return isInvocationCurrent() ? this.edits(result, session, editor) : null;
    } catch (error) {
      if (!isInvocationCurrent() || error?.code === "PROJECTION_STALE") return null;
      throw error;
    }
  }
  async formatOnType(editor, position, character, request) {
    const isInvocationCurrent = this.invocationGuard(editor, request);
    if (!isInvocationCurrent()) return null;
    const session = await this.sessionFor(editor, "formatOnType");
    if (!session || !isInvocationCurrent()) return null;
    const provider = session.capabilityOptions("textDocument/onTypeFormatting", editor);
    const triggers = [
      provider?.firstTriggerCharacter,
      ...(provider?.moreTriggerCharacter || []),
    ].filter(Boolean);
    if (!triggers.includes(character)) return null;
    try {
      const result = await session.request(
        "textDocument/onTypeFormatting",
        {
          textDocument: { uri: this.manager.uriForEditor(editor) },
          position: C.pointToPosition(position),
          ch: character,
          options: this.options(editor),
        },
        { signal: request?.signal },
      );
      return isInvocationCurrent() ? this.edits(result, session, editor) : null;
    } catch (error) {
      if (!isInvocationCurrent() || error?.code === "PROJECTION_STALE") return null;
      throw error;
    }
  }
  // Prefers willSaveWaitUntil when the server implements it, else plain
  // document formatting.
  async formatOnSave(editor, request) {
    return this.formatDocument(editor, "formatOnSave", "save", request);
  }
};
