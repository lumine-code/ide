const { CompositeDisposable } = require("lumine");
const C = require("./converters");

const pointArray = (point) => [point.row ?? point[0], point.column ?? point[1]];
const rangeArray = (range) => [
  pointArray(range.start ?? range[0]),
  pointArray(range.end ?? range[1]),
];
const comparePoints = (left, right) => left[0] - right[0] || left[1] - right[1];
const rangesEqual = (left, right) =>
  comparePoints(left[0], right[0]) === 0 && comparePoints(left[1], right[1]) === 0;
const rangeContains = (outer, inner) =>
  comparePoints(outer[0], inner[0]) <= 0 && comparePoints(inner[1], outer[1]) <= 0;
const pointInRange = (point, range) =>
  comparePoints(range[0], point) <= 0 && comparePoints(point, range[1]) < 0;
const REQUEST_FAILED = Symbol("request-failed");

module.exports = class DocumentFeatures {
  constructor(manager) {
    this.manager = manager;
    this.linkCaches = new WeakMap();
    this.linkGenerations = new WeakMap();
    this.linkEpoch = 0;
    this.destroyed = false;
    this.editorSubscriptions = new Map();
    const invalidate = () => {
      this.linkCaches = new WeakMap();
      this.linkEpoch++;
    };
    this.subscriptions = new CompositeDisposable(
      manager.onDidChangeSession(invalidate),
      manager.onDidChangeCapabilities(invalidate),
      manager.onDidChangeFeatures(invalidate),
    );
    this.hyperclickProvider = {
      priority: 2,
      providerName: "ide",
      getSuggestionForWord: (editor, _text, range) => this.documentLink(editor, range),
    };
  }

  ensureEditorSubscription(editor) {
    if (this.editorSubscriptions.has(editor)) return;
    const invalidate = () => {
      this.linkCaches.delete(editor);
      this.linkGenerations.set(editor, (this.linkGenerations.get(editor) || 0) + 1);
    };
    const subscriptions = new CompositeDisposable(
      editor.getBuffer().onDidChangeText(invalidate),
      editor.onDidDestroy(() => {
        subscriptions.dispose();
        this.editorSubscriptions.delete(editor);
        invalidate();
      }),
    );
    for (const event of ["onDidChangePath", "onDidChangeGrammar"]) {
      const subscription = editor[event]?.(invalidate);
      if (subscription) subscriptions.add(subscription);
    }
    this.editorSubscriptions.set(editor, subscriptions);
  }

  async documentLinks(editor) {
    if (this.destroyed || editor.isDestroyed?.()) return null;
    // Observe before server startup or RPC: a response for an earlier document
    // must never repopulate a cache that an edit has just invalidated.
    this.ensureEditorSubscription(editor);
    const epoch = this.linkEpoch;
    const generation = this.linkGenerations.get(editor);
    const isCurrent = () =>
      !this.destroyed &&
      !editor.isDestroyed?.() &&
      epoch === this.linkEpoch &&
      generation === this.linkGenerations.get(editor);
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/documentLink");
    if (!session || !isCurrent()) return null;
    const uri = this.manager.uriForEditor(editor);
    if (!uri) return null;
    const cached = this.linkCaches.get(editor);
    if (cached?.session === session && cached.uri === uri) return cached;
    let links;
    try {
      links = await session.request("textDocument/documentLink", { textDocument: { uri } });
    } catch {
      return null;
    }
    if (!isCurrent() || uri !== this.manager.uriForEditor(editor)) return null;
    const value = {
      session,
      uri,
      isCurrent,
      links: Array.isArray(links) ? links : [],
      canResolve: !!session.capabilityOptions("textDocument/documentLink", editor)?.resolveProvider,
    };
    this.linkCaches.set(editor, value);
    return value;
  }

  async documentLink(editor, wordRange) {
    const source = await this.documentLinks(editor);
    if (!source) return;
    const point = pointArray(wordRange.start ?? wordRange[0]);
    const link = source.links.find((candidate) =>
      candidate?.range ? pointInRange(point, C.rangeFromLsp(candidate.range)) : false,
    );
    if (!link || (!link.target && !source.canResolve)) return;
    return {
      range: C.rangeFromLsp(link.range),
      callback: () =>
        source.isCurrent()
          ? this.followDocumentLink(source.session, link, source.canResolve, source.isCurrent)
          : Promise.resolve(false),
    };
  }

  async followDocumentLink(session, original, canResolve, isCurrent = () => !this.destroyed) {
    let link = original;
    if (!link.target && canResolve) {
      const resolved = await this.requestForCommand(session, "documentLink/resolve", link);
      if (resolved === REQUEST_FAILED) return false;
      link = resolved || link;
    }
    if (!isCurrent()) return false;
    if (!link.target) return false;
    if (this.manager.resolveUri(link.target))
      return (await this.manager.showDocument({ uri: link.target, takeFocus: true })).success;
    if (/^(?:https?|mailto):/i.test(link.target)) {
      try {
        await lumine.shell.openExternal(link.target);
        return true;
      } catch (error) {
        lumine.notifications.addWarning("Unable to open the language server link.", {
          detail: error.message,
          dismissable: true,
        });
        return false;
      }
    }
    lumine.notifications.addWarning("The language server returned an unsupported link target.", {
      detail: link.target,
      dismissable: true,
    });
    return false;
  }

  commandContext(editor, { selection = false } = {}) {
    this.ensureEditorSubscription(editor);
    const epoch = this.linkEpoch;
    const generation = this.linkGenerations.get(editor);
    const selections = selection && editor.getSelectedBufferRanges().map(rangeArray);
    const cursors = selection && editor.getCursorBufferPositions().map(pointArray);
    return {
      isCurrent: () =>
        !this.destroyed &&
        !editor.isDestroyed?.() &&
        epoch === this.linkEpoch &&
        generation === this.linkGenerations.get(editor) &&
        (!selection ||
          (JSON.stringify(editor.getSelectedBufferRanges().map(rangeArray)) ===
            JSON.stringify(selections) &&
            JSON.stringify(editor.getCursorBufferPositions().map(pointArray)) ===
              JSON.stringify(cursors))),
    };
  }

  async sessionFor(editor, method, isCurrent = () => !this.destroyed) {
    const session = await this.manager.activeSessionForFeature(editor, method);
    if (!isCurrent()) return null;
    if (session) return session;
    lumine.notifications.addWarning("No language server for this file supports this operation.");
    return null;
  }

  async requestForCommand(session, method, params, isCurrent = () => !this.destroyed) {
    try {
      return await session.request(method, params);
    } catch (error) {
      if (!isCurrent()) return REQUEST_FAILED;
      lumine.notifications.addWarning(`Language server request '${method}' failed.`, {
        detail: error.message,
        dismissable: true,
      });
      return REQUEST_FAILED;
    }
  }

  async foldRanges(editor) {
    const { isCurrent } = this.commandContext(editor);
    const session = await this.sessionFor(editor, "textDocument/foldingRange", isCurrent);
    if (!session) return false;
    const result = await this.requestForCommand(
      session,
      "textDocument/foldingRange",
      { textDocument: { uri: this.manager.uriForEditor(editor) } },
      isCurrent,
    );
    if (result === REQUEST_FAILED || !isCurrent()) return false;
    for (const range of result || []) {
      if (!isCurrent()) return false;
      if (range?.startLine == null || range?.endLine == null) continue;
      editor.foldBufferRange([
        [range.startLine, range.startCharacter ?? Infinity],
        [range.endLine, range.endCharacter ?? Infinity],
      ]);
    }
    return true;
  }

  async expandSelectionRanges(editor) {
    const { isCurrent } = this.commandContext(editor, { selection: true });
    const session = await this.sessionFor(editor, "textDocument/selectionRange", isCurrent);
    if (!session) return false;
    const selections = editor.getSelectedBufferRanges().map(rangeArray);
    const positions = editor.getCursorBufferPositions().map(C.pointToPosition);
    const result = await this.requestForCommand(
      session,
      "textDocument/selectionRange",
      { textDocument: { uri: this.manager.uriForEditor(editor) }, positions },
      isCurrent,
    );
    if (result === REQUEST_FAILED || !isCurrent()) return false;
    const expanded = selections.map((current, index) => {
      let candidate = result?.[index];
      while (candidate) {
        const next = C.rangeFromLsp(candidate.range);
        if (rangeContains(next, current) && !rangesEqual(next, current)) return next;
        candidate = candidate.parent;
      }
      return current;
    });
    if (!expanded.some((range, index) => !rangesEqual(range, selections[index]))) return false;
    editor.setSelectedBufferRanges(expanded, { autoscroll: true });
    return true;
  }

  async selectLinkedRanges(editor) {
    const { isCurrent } = this.commandContext(editor, { selection: true });
    const session = await this.sessionFor(editor, "textDocument/linkedEditingRange", isCurrent);
    if (!session) return false;
    const result = await this.requestForCommand(
      session,
      "textDocument/linkedEditingRange",
      {
        textDocument: { uri: this.manager.uriForEditor(editor) },
        position: C.pointToPosition(editor.getCursorBufferPosition()),
      },
      isCurrent,
    );
    if (result === REQUEST_FAILED || !isCurrent()) return false;
    const ranges = (result?.ranges || []).map(C.rangeFromLsp);
    if (!ranges.length) return false;
    editor.setSelectedBufferRanges(ranges, { autoscroll: true });
    return true;
  }

  async colorPresentations(editor) {
    const { isCurrent } = this.commandContext(editor, { selection: true });
    const session = await this.sessionFor(editor, "textDocument/documentColor", isCurrent);
    if (!session) return false;
    const uri = this.manager.uriForEditor(editor);
    const point = pointArray(editor.getCursorBufferPosition());
    const colors = await this.requestForCommand(
      session,
      "textDocument/documentColor",
      { textDocument: { uri } },
      isCurrent,
    );
    if (colors === REQUEST_FAILED || !isCurrent()) return false;
    const color = (colors || []).find((candidate) =>
      candidate?.range ? pointInRange(point, C.rangeFromLsp(candidate.range)) : false,
    );
    if (!color) {
      lumine.notifications.addInfo("No language-server color is under the cursor.");
      return false;
    }
    const presentations = await this.requestForCommand(
      session,
      "textDocument/colorPresentation",
      { textDocument: { uri }, color: color.color, range: color.range },
      isCurrent,
    );
    if (presentations === REQUEST_FAILED || !isCurrent()) return false;
    if (!presentations?.length) return false;
    await this.showColorPresentations({ editor, session, uri, color, presentations, isCurrent });
    return isCurrent();
  }

  getColorList() {
    if (this.colorListHost) return this.colorListHost;
    this.colorListHost = lumine.workspace.addSelectList(
      {
        items: [],
        emptyMessage: "No color presentations",
        getItemId: (item) => item.id,
        search: { getFilterText: (item) => item.presentation.label },
        renderItem: (item, { highlight }) => ({ primary: highlight(item.presentation.label) }),
        commands: {
          "ide:apply-color-presentation": {
            description: "Apply the selected language-server color presentation.",
            didDispatch: (event) => this.applyColorPresentation(event.detail.item),
          },
        },
        actions: [
          {
            command: "ide:apply-color-presentation",
            context: "item",
            primary: true,
            disposition: "close",
            dispatch: "local",
          },
        ],
      },
      { className: "ide-color-presentations", crumb: "Color Presentations" },
    );
    this.colorList = this.colorListHost.getModel();
    return this.colorListHost;
  }

  async showColorPresentations(context) {
    if (!context.isCurrent()) return;
    const host = this.getColorList();
    await this.colorList.update({
      items: context.presentations.map((presentation, index) => ({
        id: `${index}:${presentation.label}`,
        presentation,
        context,
      })),
    });
    if (context.isCurrent()) host.show();
  }

  applyColorPresentation(item) {
    const { context, presentation } = item;
    if (!context.isCurrent()) return false;
    const primary = presentation.textEdit || {
      range: context.color.range,
      newText: presentation.label,
    };
    return this.manager.applyWorkspaceEdit(
      {
        changes: {
          [context.uri]: [primary, ...(presentation.additionalTextEdits || [])],
        },
      },
      `Apply ${presentation.label}`,
      context.session,
    );
  }

  destroy() {
    this.destroyed = true;
    this.linkEpoch++;
    this.linkCaches = new WeakMap();
    this.subscriptions.dispose();
    for (const subscription of this.editorSubscriptions.values()) subscription.dispose();
    this.editorSubscriptions.clear();
    this.colorListHost?.destroy();
    this.colorListHost = null;
    this.colorList = null;
  }
};

module.exports.rangeContains = rangeContains;
