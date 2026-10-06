const RefreshingProvider = require("./refreshing-provider");
const C = require("./converters");
const { canExecute } = require("./server-commands");

const CODE_LENS_CAPABILITIES = {
  textDocument: { codeLens: { dynamicRegistration: true } },
  workspace: { codeLens: { refreshSupport: true } },
};

// Serves the code-lens.provider contract from textDocument/codeLens. The
// package that consumes it owns the rendering; this owns the protocol — which
// session answers, how a lens is resolved, and what a click executes.
module.exports = class CodeLensProvider extends RefreshingProvider {
  static capabilities = CODE_LENS_CAPABILITIES;
  constructor(manager) {
    super(manager, CODE_LENS_CAPABILITIES, "codeLens");
    // The LSP payload behind each lens handed out, so a resolve can send back
    // the object the server produced rather than a translation of it.
    this.sources = new WeakMap();
    // What was last served for an editor, so a request that fails transiently
    // leaves the lenses on screen instead of blanking them.
    this.lastResults = new WeakMap();
    this.requests = new WeakMap();
  }
  async codeLenses(editor) {
    if (this.disposed) return null;
    const request = {};
    const epoch = this.epoch;
    this.requests.set(editor, request);
    const isCurrent = () =>
      !this.disposed && this.epoch === epoch && this.requests.get(editor) === request;
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/codeLens");
    if (!isCurrent()) return null;
    if (!session) {
      this.lastResults.delete(editor);
      return null;
    }
    const uri = this.manager.uriForEditor(editor);
    if (!uri) return null;
    const cached = this.lastResults.get(editor);
    let lenses;
    try {
      lenses = await session.request("textDocument/codeLens", { textDocument: { uri } });
    } catch {
      // A server reindexing rejects with ContentModified often enough that
      // clearing the row on every failure would read as flicker.
      return isCurrent() &&
        cached?.session === session &&
        cached.uri === uri &&
        cached.epoch === epoch
        ? cached.result
        : null;
    }
    if (!isCurrent()) return null;
    const canResolve = !!session.capabilityOptions("textDocument/codeLens", editor)
      ?.resolveProvider;
    const result = (lenses || [])
      .map((lens) => this.toCodeLens(lens, session, canResolve))
      .filter(Boolean);
    this.lastResults.set(editor, { session, uri, epoch, result });
    return result;
  }
  async resolveCodeLens(lens) {
    if (this.disposed) return null;
    const source = this.sources.get(lens);
    if (!source) return null;
    const { lsp, session, canResolve, epoch } = source;
    if (!canResolve || epoch !== this.epoch) return null;
    const resolved = await session.request("codeLens/resolve", lsp);
    if (this.disposed || epoch !== this.epoch) return null;
    if (!resolved?.command) return null;
    // A server may answer without echoing the range back; the one it was asked
    // about is still the right place for the lens.
    return this.toCodeLens(
      { ...resolved, range: resolved.range || lsp.range },
      session,
      canResolve,
    );
  }
  toCodeLens(lsp, session, canResolve = false) {
    if (!lsp?.range) return null;
    const lens = { range: C.rangeFromLsp(lsp.range) };
    const { command } = lsp;
    const epoch = this.epoch;
    if (command) {
      if (command.command && !canExecute(session, command.command)) return null;
      lens.title = command.title ?? "";
      // A lens whose command names nothing is a label the server wants shown,
      // not something to run.
      if (command.command)
        lens.execute = () =>
          !this.disposed && epoch === this.epoch && canExecute(session, command.command)
            ? session.request("workspace/executeCommand", {
                command: command.command,
                arguments: command.arguments,
              })
            : Promise.resolve(null);
    }
    this.sources.set(lens, { lsp, session, canResolve, epoch });
    return lens;
  }
};
