const C = require("./converters");
const { CompositeDisposable } = require("lumine");
const observeEditorRequest = require("./observe-editor-request");
const { canExecute } = require("./server-commands");
const createDocumentationCodeBlockRenderer = (...args) =>
  require("./documentation-code-block").createDocumentationCodeBlockRenderer(...args);
const { languageIdForEditor } = require("./language-ids");
const providerCharacters = require("./provider-characters");
const Budget = require("./document-budget");

const DOCUMENTATION_FIELDS = ["description", "descriptionMarkdown", "descriptionCodeBlockRenderer"];
const AUTOMATIC_REQUEST_INTERVAL_MS = 50;

const COMPLETION_CAPABILITIES = {
  textDocument: {
    completion: {
      dynamicRegistration: true,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        insertTextModeSupport: { valueSet: [1, 2] },
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        // `CompletionItemTag.Deprecated` — the 3.15 replacement for the
        // `deprecated` boolean above, which servers still send in its place.
        tagSupport: { valueSet: [1] },
        preselectSupport: true,
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        commitCharactersSupport: true,
        resolveSupport: {
          properties: ["documentation", "detail", "additionalTextEdits", "command", "labelDetails"],
        },
      },
      completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
      completionList: {
        itemDefaults: [
          "editRange",
          "insertTextFormat",
          "insertTextMode",
          "data",
          "commitCharacters",
        ],
      },
    },
  },
};

// Commands a server may attach to a completion item that the editor answers
// itself rather than handing back over the protocol.
const CLIENT_COMMANDS = new Map([
  ["editor.action.triggerSuggest", "autocomplete:activate"],
  ["editor.action.triggerParameterHints", "hover:toggle-signature-help"],
]);

module.exports = class CompletionProvider {
  static capabilities = COMPLETION_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(COMPLETION_CAPABILITIES);
    this.scopeSelector = ".source, .text";
    this.inclusionPriority = 2;
    this.suggestionPriority = 2;
    this.excludeLowerPriority = false;
    // Let autocomplete score and rank: a server sends the whole visible scope
    // and expects the client to narrow it, and its ranking understands
    // subsequence matches that a prefix test cannot.
    this.filterSuggestions = true;
    this.cache = null;
    this.abortController = null;
    this.cacheSubscription = null;
    this.disposed = false;
    this.remoteRequestTimes = new WeakMap();
  }
  // The characters every running server wants completion asked for on, which
  // `autocomplete` reads to open the list even where it otherwise would not —
  // `.` in TypeScript is the archetype. Computed on every read, never
  // snapshotted: sessions start and stop as projects and grammars change, and
  // a server only advertises its trigger characters once it is running.
  get triggerCharacters() {
    return providerCharacters(this.manager, "textDocument/completion", "triggerCharacters");
  }
  // Completions from every server serving the editor are merged: a type
  // checker and a linter each contribute their own, and the user wants both.
  async getSuggestions(request) {
    const { editor, bufferPosition } = request;
    if (this.disposed || request.signal?.aborted || editor.isDestroyed?.()) return [];
    if (!Budget.editorAvailable(editor)) {
      this.clearCache();
      return [];
    }
    if (this.abortController && !this.abortController.signal.aborted) this.abortController.abort();
    this.requestSubscriptions?.dispose();
    this.resolveController?.abort();
    if (this.cache && this.cache.editor !== editor) this.clearCache();
    const controller = (this.abortController = new AbortController());
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    const subscriptions = observeEditorRequest(editor, controller);
    this.requestSubscriptions = subscriptions;
    let cancel;
    try {
      if (signal.aborted) return [];
      const cancelled = new Promise((resolve) => {
        cancel = () => resolve([]);
        signal.addEventListener("abort", cancel, { once: true });
      });
      return await Promise.race([
        this.suggestionsForRequest(
          {
            ...request,
            bufferPosition: { row: bufferPosition.row, column: bufferPosition.column },
            prefix: request.prefix || "",
          },
          signal,
        ),
        cancelled,
      ]);
    } finally {
      if (cancel) signal.removeEventListener("abort", cancel);
      subscriptions.dispose();
      if (this.abortController === controller) this.abortController = null;
      if (this.requestSubscriptions === subscriptions) this.requestSubscriptions = null;
    }
  }

  async suggestionsForRequest(request, signal) {
    const { editor, bufferPosition, prefix, publishSuggestions } = request;
    const readiness = this.manager.sessionsForEditorWhenReady
      ? this.manager.sessionsForEditorWhenReady(editor, { signal })
      : await this.manager.activeSessionsForEditor(editor);
    if (signal.aborted || editor.isDestroyed?.()) return [];
    const triggerCharacter =
      request.triggerKind === undefined
        ? editor.getTextInBufferRange([
            [bufferPosition.row, Math.max(0, bufferPosition.column - 1)],
            bufferPosition,
          ])
        : request.triggerCharacter;
    const query = {
      ...request,
      triggerCharacter,
      row: bufferPosition.row,
      wordStart: bufferPosition.column - prefix.length,
    };
    const groups = new Array(readiness.length);
    const active = new Set();
    let pending = readiness.length;
    let publicationPending = false;
    const combine = () => groups.flat().sort((a, b) => a.sortText.localeCompare(b.sortText));
    await Promise.all(
      readiness.map(async (ready, index) => {
        try {
          const session = await ready;
          if (signal.aborted || !session?.supports("textDocument/completion", editor)) return;
          active.add(session);
          const items = await this.suggestionsForSession(session, query, signal);
          if (items.length && !signal.aborted) groups[index] = items;
        } catch {
          // Startup and document attachment can fail independently per server.
        } finally {
          pending--;
          if (groups[index] && pending && publishSuggestions && !publicationPending) {
            publicationPending = true;
            queueMicrotask(() => {
              publicationPending = false;
              if (pending && !signal.aborted) publishSuggestions(combine());
            });
          }
        }
      }),
    );
    if (signal.aborted) return [];
    for (const session of this.cache?.entries.keys() || [])
      if (!active.has(session)) this.cache.entries.delete(session);
    return combine();
  }

  async suggestionsForSession(session, query, signal) {
    const { editor, bufferPosition, row, wordStart, prefix, activatedManually, triggerCharacter } =
      query;
    const uri = this.manager.uriForEditor(editor);
    const options = session.capabilityOptions("textDocument/completion", editor);
    const cached = this.cache?.entries.get(session);
    const sameWord =
      !!cached &&
      cached.uri === uri &&
      cached.options === options &&
      cached.row === row &&
      cached.wordStart === wordStart &&
      prefix.startsWith(cached.prefix);
    const triggered = !activatedManually && options?.triggerCharacters?.includes(triggerCharacter);
    if (!activatedManually && !triggered && sameWord && !cached.isIncomplete) {
      if (cached.projection?.isCurrent() !== false) return this.filterCached(cached, prefix);
      const renewed = await this.renewIdentityCache(cached, editor, session, prefix, signal);
      if (signal.aborted) return [];
      if (renewed) {
        this.cache.entries.set(session, renewed);
        return renewed.items;
      }
    }
    if (!activatedManually && !triggered)
      await this.waitForAutomaticRequest(editor, session, signal);
    if (signal.aborted) return [];
    const times = this.remoteRequestTimes.get(editor) || new WeakMap();
    this.remoteRequestTimes.set(editor, times);
    times.set(session, performance.now());
    const context = triggered
      ? { triggerKind: 2, triggerCharacter }
      : { triggerKind: !activatedManually && sameWord && cached.isIncomplete ? 3 : 1 };
    let result, projection, items;
    try {
      result = await session.request(
        "textDocument/completion",
        { textDocument: { uri }, position: C.pointToPosition(bufferPosition), context },
        { signal, editor },
      );
      if (signal.aborted || !Budget.editorAvailable(editor)) return [];
      projection = session.responseProjection?.(result);
      items = this.suggestionsFromResponse(session, result, editor, uri, projection);
    } catch {
      // A failure belongs to one server. Its next request should try again.
      if (!signal.aborted) this.cache?.entries.delete(session);
      return [];
    }
    const cache = this.cacheForEditor(editor);
    cache.entries.set(session, {
      uri,
      options,
      row,
      wordStart,
      prefix,
      isIncomplete: !Array.isArray(result) && result?.isIncomplete === true,
      items,
      result: projection ? result : undefined,
      projection,
      offset: projection?.isIdentity
        ? editor.getBuffer?.()?.characterIndexForPosition?.(bufferPosition)
        : undefined,
    });
    return items;
  }

  suggestionsFromResponse(session, result, editor, uri, projection) {
    const items = Array.isArray(result) ? result : result?.items || [];
    const defaults = Array.isArray(result) ? null : result?.itemDefaults;
    const seen = new Map();
    for (const item of items) {
      const complete = this.applyDefaults(item, defaults);
      const mappedItem = projection
        ? session.mapCompletionItem(complete, editor, uri, projection)
        : complete;
      if (!mappedItem) continue;
      const suggestion = this.toSuggestion(session, mappedItem);
      // Retain the server's relevance order for equally good client matches.
      suggestion.sortText = item.sortText ?? item.label;
      // Resolve data and commands belong to this session's own items.
      const identity = JSON.stringify([
        suggestion.displayText,
        suggestion.displayTextDetail,
        suggestion.text,
        suggestion.snippet,
        suggestion.textEdit,
        suggestion.additionalTextEdits,
        item.kind,
        item.detail,
        item.labelDetails,
        item.filterText,
        item.insertTextMode,
        item.commitCharacters,
        item.data,
        item.command,
      ]);
      const previous = seen.get(identity);
      if (previous) {
        if (!previous.description && suggestion.description) {
          previous.description = suggestion.description;
          previous.descriptionMarkdown = suggestion.descriptionMarkdown;
          previous.descriptionCodeBlockRenderer = suggestion.descriptionCodeBlockRenderer;
        }
      } else {
        seen.set(identity, suggestion);
      }
    }
    return [...seen.values()];
  }

  cacheForEditor(editor) {
    if (this.cache?.editor === editor) return this.cache;
    this.clearCache();
    const cache = (this.cache = { editor, entries: new Map() });
    const retireCache = () => {
      if (this.cache === cache) this.clearCache();
    };
    this.cacheSubscription = new CompositeDisposable();
    for (const event of ["onDidChangeGrammar", "onDidChangePath", "onDidDestroy"]) {
      const subscription = editor[event]?.(retireCache);
      if (subscription) this.cacheSubscription.add(subscription);
    }
    const budgetChanged = () => {
      if (!Budget.canSynchronizeEditor(editor)) retireCache();
    };
    const sizeChanges = editor.getBuffer?.()?.onDidChangeText?.(budgetChanged);
    if (sizeChanges) this.cacheSubscription.add(sizeChanges);
    this.cacheSubscription.add(lumine.config.onDidChange(Budget.SETTING, budgetChanged));
    return cache;
  }

  clearCache() {
    this.cache = null;
    this.resolveController?.abort();
    this.cacheSubscription?.dispose();
    this.cacheSubscription = null;
  }

  async waitForAutomaticRequest(editor, session, signal) {
    // A slow or newly started server gets its own slot. A complete cache hit,
    // a server trigger character and an explicit invocation bypass this gate.
    const remaining =
      (this.remoteRequestTimes.get(editor)?.get(session) ?? -Infinity) +
      AUTOMATIC_REQUEST_INTERVAL_MS -
      performance.now();
    if (remaining <= 0 || signal.aborted) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, remaining);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  // A projection's generation expires on every edit. An unchanged transport
  // can still reuse a complete list when the only edit extended this prefix.
  async renewIdentityCache(cache, editor, session, prefix, signal) {
    const growth = prefix.length - cache.prefix.length;
    const previous = cache.projection;
    if (
      growth <= 0 ||
      previous?.isIdentity !== true ||
      previous.text !== previous.source ||
      !Number.isInteger(cache.offset)
    )
      return null;
    const source =
      previous.source.slice(0, cache.offset) +
      prefix.slice(cache.prefix.length) +
      previous.source.slice(cache.offset);
    if (editor.getText?.() !== source) return null;
    let projection;
    try {
      projection = await session.currentDocumentProjection(editor);
    } catch {
      return null;
    }
    if (
      signal.aborted ||
      projection?.isIdentity !== true ||
      projection.source !== source ||
      projection.text !== source ||
      !session.canRenewCompletionResponse(cache.result, editor, cache.uri, projection)
    )
      return null;
    const items = [];
    for (const suggestion of cache.items) {
      const item = session.renewCompletionItem(
        suggestion._lspItem,
        editor,
        cache.uri,
        projection,
        { row: cache.row, column: cache.wordStart + cache.prefix.length },
        growth,
      );
      if (!item) return null;
      const renewed = { ...suggestion, ...this.defined(this.toSuggestion(session, item)) };
      for (const key of ["leftLabel", ...DOCUMENTATION_FIELDS]) renewed[key] = suggestion[key];
      items.push(renewed);
    }
    const result = {};
    session.rememberCompletionResponse(result, editor, cache.uri, projection);
    return { ...cache, items, prefix, offset: cache.offset + growth, projection, result };
  }
  // Narrowing is autocomplete's job now, so this only re-anchors. Filtering
  // here as well would reject subsequence matches (`sfn` for `setFontName`)
  // before the scorer ever saw them.
  filterCached(cache, prefix) {
    // The cached edits were computed at the column the request was made from.
    // The user has typed since, so every replaced span has to grow by the same
    // number of characters; otherwise accepting `console` after typing `con`
    // replaces only `co` and leaves the tail behind as `consolen`.
    const growth = prefix.length - cache.prefix.length;
    return cache.items.map((suggestion) => this.reanchor(suggestion, growth));
  }
  // Returns a copy whose edit range ends `growth` characters later. The cached
  // suggestion itself is left alone so a later, shorter prefix re-anchors from
  // the original range rather than compounding.
  reanchor(suggestion, growth) {
    if (!growth || !suggestion.textEdit) return suggestion;
    const [start, end] = suggestion.textEdit.range;
    return {
      ...suggestion,
      textEdit: {
        range: [start, [end[0], end[1] + growth]],
        newText: suggestion.textEdit.newText,
      },
    };
  }
  applyDefaults(item, defaults) {
    if (!defaults) return item;
    const merged = { ...item };
    if (merged.insertTextFormat == null && defaults.insertTextFormat != null)
      merged.insertTextFormat = defaults.insertTextFormat;
    if (merged.insertTextMode == null && defaults.insertTextMode != null)
      merged.insertTextMode = defaults.insertTextMode;
    if (merged.data == null && defaults.data != null) merged.data = defaults.data;
    if (merged.commitCharacters == null && defaults.commitCharacters != null)
      merged.commitCharacters = defaults.commitCharacters;
    if (!merged.textEdit && defaults.editRange) {
      const newText = merged.textEditText ?? merged.insertText ?? merged.label;
      merged.textEdit = defaults.editRange.start
        ? { range: defaults.editRange, newText }
        : { insert: defaults.editRange.insert, replace: defaults.editRange.replace, newText };
    }
    return merged;
  }
  toSuggestion(session, item) {
    const documentation = item.documentation;
    const documentationText =
      typeof documentation === "string" ? documentation : documentation?.value;
    const suggestion = {
      displayText: item.label,
      // `labelDetails.detail` is a signature glued to the label; `.description`
      // is the source module, which reads like every other right label.
      displayTextDetail: item.labelDetails?.detail,
      text: item.insertText || item.label,
      type: C.completionKind(item.kind),
      leftLabel: item.detail,
      rightLabel: item.labelDetails?.description,
      description: documentationText,
      // Characters that accept this item when typed. Honoured only when the
      // user turns `autocomplete.commitCharacters` on.
      commitCharacters: item.commitCharacters,
      // What the server wants matched against, which is not always the label.
      filterText: item.filterText,
      preselect: item.preselect,
      // Whether the inserted text should be re-indented to its new
      // surroundings, or left exactly as the server wrote it.
      insertTextMode: item.insertTextMode,
      // A deprecated symbol is struck through rather than hidden: it still
      // exists and still compiles, and the user needs to see which of the two
      // overloads in front of them is the one on the way out. `tags` is the
      // 3.15 form; `deprecated` is the boolean it replaced, and servers still
      // send either.
      className: item.tags?.includes(1) || item.deprecated === true ? "ide-strike" : undefined,
      _lspItem: item,
      _lspSession: session,
    };
    // The plain `description` stays set alongside it: anything reading the
    // suggestion as text still gets the source, and the popup falls back to it
    // if the markdown ever fails to render.
    if (documentation?.kind === "markdown" && documentationText) {
      suggestion.descriptionMarkdown = documentationText;
      suggestion.descriptionCodeBlockRenderer = createDocumentationCodeBlockRenderer(
        session.adapter,
      );
    }
    if (item.insertTextFormat === 2) {
      suggestion.snippet = item.insertText || item.textEdit?.newText || item.label;
      delete suggestion.text;
    }
    // An InsertReplaceEdit offers two ranges: `insert` stops at the cursor,
    // `replace` covers the whole identifier being edited. Honour the user's
    // consume-suffix preference rather than always taking the shorter one,
    // which duplicated the tail (`console` + accept → `consolesole`).
    const edit = item.textEdit;
    const editRange =
      edit?.range ||
      (lumine.config.get("autocomplete.consumeSuffix")
        ? edit?.replace || edit?.insert
        : edit?.insert) ||
      edit?.replace;
    if (editRange)
      suggestion.textEdit = { range: C.rangeFromLsp(editRange), newText: edit.newText };
    suggestion.additionalTextEdits = item.additionalTextEdits?.map((edit) => ({
      range: C.rangeFromLsp(edit.range),
      newText: edit.newText,
    }));
    return suggestion;
  }
  async getSuggestionDetailsOnSelect(suggestion) {
    if (this.disposed) return null;
    this.resolveController?.abort();
    if (suggestion._lspSession?.isResponseCurrent?.(suggestion._lspItem) === false) return null;
    const editor = this.cache?.editor;
    const provider = suggestion._lspSession?.capabilityOptions("textDocument/completion", editor);
    if (!provider?.resolveProvider || suggestion._resolved) return suggestion;
    // Selection moves once per arrow key, so without a cancel the backlog of
    // resolves queues up behind the next completion request.
    const controller = (this.resolveController = new AbortController());
    try {
      const item = await suggestion._lspSession.request(
        "completionItem/resolve",
        suggestion._lspItem,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || this.disposed) return suggestion;
      const session = suggestion._lspSession;
      const projection = session.responseProjection?.(item);
      const mappedItem =
        projection && editor
          ? session.mapCompletionItem(
              item,
              editor,
              this.manager.uriForEditor(editor),
              projection,
              suggestion._lspItem,
            )
          : item;
      if (!mappedItem) return null;
      const mappedSuggestion = this.toSuggestion(suggestion._lspSession, mappedItem);
      const detailed = {
        ...suggestion,
        // A server may answer with only the fields it filled in; spreading
        // those blanks over the original would wipe `additionalTextEdits` and
        // the labels that came with the initial item.
        ...this.defined(mappedSuggestion),
        // Resolve fills only the selected item. Its full signature belongs in
        // that item's documentation, never in a new column on visited rows.
        leftLabel: suggestion.leftLabel,
        _resolved: true,
      };
      // Omitted documentation preserves the original item. An explicit new
      // document replaces every representation, including an older Markdown
      // rendering callback when the server now supplies plain text or nothing.
      if (Object.hasOwn(mappedItem, "documentation")) {
        for (const key of DOCUMENTATION_FIELDS) {
          detailed[key] = mappedSuggestion[key];
        }
      }
      if (typeof mappedItem.detail === "string" && mappedItem.detail !== suggestion.leftLabel)
        this.addResolvedDetail(detailed, mappedItem.detail, mappedItem.documentation, editor);
      // Swap the resolved item into the cache: the next keystroke filters the
      // cached list, and without this it would hand back the unresolved object
      // and re-request detail that has already been fetched.
      const cached = this.cache?.entries.get(session)?.items;
      const index = cached?.indexOf(suggestion);
      if (index >= 0) cached[index] = detailed;
      return detailed;
    } catch {
      return suggestion;
    } finally {
      if (this.resolveController === controller) this.resolveController = null;
    }
  }
  addResolvedDetail(suggestion, detail, documentation, editor) {
    if (!detail) return;
    const description = suggestion.description;
    const markdown =
      suggestion.descriptionMarkdown ?? (documentation?.kind === "markdown" ? "" : null);
    suggestion.description = [detail, description].filter(Boolean).join("\n\n");
    if (markdown != null) {
      let language = editor
        ? languageIdForEditor(suggestion._lspSession.adapter || {}, editor)
        : "";
      // A JavaScript completion can describe TypeScript types.
      if (["javascript", "javascriptreact", "typescriptreact"].includes(language))
        language = "typescript";
      // A literal signature can itself contain Markdown fences (for example a
      // template literal). Use a longer fence so all of it remains code.
      const fence = "`".repeat(
        Math.max(3, ...Array.from(detail.matchAll(/`+/g), ([run]) => run.length + 1)),
      );
      suggestion.descriptionMarkdown = [`${fence}${language}\n${detail}\n${fence}`, markdown]
        .filter(Boolean)
        .join("\n\n");
      suggestion.descriptionCodeBlockRenderer = createDocumentationCodeBlockRenderer(
        suggestion._lspSession.adapter,
      );
    }
  }
  defined(suggestion) {
    return Object.fromEntries(
      Object.entries(suggestion).filter(([, value]) => value !== undefined),
    );
  }
  onDidInsertSuggestion({ editor, suggestion }) {
    if (this.disposed) return;
    const command = suggestion._lspItem?.command;
    if (!command) return;
    // Servers ask for this one after inserting a member or an import, expecting
    // the client to reopen the list. Sending it on to the server would only
    // produce a "command not found" that nobody sees.
    if (CLIENT_COMMANDS.has(command.command)) {
      lumine.commands.dispatch(lumine.views.getView(editor), CLIENT_COMMANDS.get(command.command));
      return;
    }
    if (suggestion._lspSession && !canExecute(suggestion._lspSession, command.command)) return;
    suggestion._lspSession
      ?.request("workspace/executeCommand", {
        command: command.command,
        arguments: command.arguments,
      })
      // A command the server declared and then failed is worth surfacing;
      // swallowing it left auto-import failures invisible.
      .catch((error) =>
        lumine.notifications.addWarning("Language server command failed", {
          detail: `Command: ${command.command}\n\n${error.message}`,
          dismissable: true,
        }),
      );
  }
  dispose() {
    this.disposed = true;
    this.abortController?.abort();
    this.resolveController?.abort();
    this.requestSubscriptions?.dispose();
    this.cacheSubscription?.dispose();
    this.abortController = null;
    this.resolveController = null;
    this.requestSubscriptions = null;
    this.cacheSubscription = null;
    this.cache = null;
  }
};
