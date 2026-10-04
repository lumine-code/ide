const ContextHelpProvider = require("../lib/context-help-provider");
const CompletionProvider = require("../lib/completion-provider");
const { createDocumentationCodeBlockRenderer } = require("../lib/documentation-code-block");

describe("adapter-owned documentation code blocks", () => {
  beforeEach(() => jasmine.useRealClock());

  const fence = (text, language = "") => `\`\`\`${language}\n${text}\n\`\`\``;
  const adapterWithHook = (name) => ({
    id: name,
    getDocumentationCodeBlockProjection: jasmine.createSpy(name).and.returnValue(null),
  });
  const sessionWithHover = (adapter, value) => ({
    adapter,
    supports: () => true,
    request: async () => (value == null ? null : { contents: { kind: "markdown", value } }),
  });
  const managerWith = (...sessions) => ({
    addCapabilityFragment() {},
    allGrammarScopes: () => ["source.python"],
    uriForEditor: () => "file:///documentation.py",
    activeSessionsForEditor: async () => sessions,
  });
  const hoverWith = (...sessions) =>
    new ContextHelpProvider(managerWith(...sessions)).getHelp({}, { row: 0, column: 0 });

  // Read blocks through the real Markdown API, as the presentation services do.
  // Hooks decline rendering so these routing tests need no language parser.
  async function renderBlocks(value, renderer) {
    const html = lumine.tools.markdown.render(value, {
      renderMode: "fragment",
      html: false,
      breaks: false,
      handleFrontMatter: false,
      useTaskCheckbox: false,
      transformImageLinks: false,
      transformLegacyLinks: false,
      transformNonFqdnLinks: false,
    });
    const fragment = lumine.tools.markdown.convertToDOM(html);
    const blocks = [];
    for (const pre of fragment.querySelectorAll("pre")) {
      const code = pre.firstElementChild;
      const block = {
        text: (code ?? pre).textContent.replace(/\r?\n$/, ""),
        language: code?.className.replace(/^language-/, ""),
        scopeName: "text.plain",
      };
      blocks.push(block);
      expect(await renderer(block)).toBeNull();
    }
    return blocks;
  }

  it("routes different blocks in a merged hover to their own adapters", async () => {
    const python = adapterWithHook("python");
    const other = adapterWithHook("other");
    const pythonText = ">>> print(1)\n1";
    const otherText = ">>> 2 + 2\n4";
    const result = await hoverWith(
      sessionWithHover(python, fence(pythonText)),
      sessionWithHover(other, fence(otherText)),
    );

    const blocks = await renderBlocks(result.contents.value, result.contents.renderCodeBlock);
    expect(blocks.map(({ text }) => text)).toEqual([pythonText, otherText]);
    expect(python.getDocumentationCodeBlockProjection.calls.allArgs()).toEqual([[blocks[0]]]);
    expect(other.getDocumentationCodeBlockProjection.calls.allArgs()).toEqual([[blocks[1]]]);
  });

  it("does not claim another adapter's unlabeled block when it has no hook", async () => {
    const python = adapterWithHook("python");
    const result = await hoverWith(
      sessionWithHover(python, fence(">>> print(1)\n1")),
      sessionWithHover({ id: "other" }, fence(">>> 2 + 2\n4")),
    );

    const blocks = await renderBlocks(result.contents.value, result.contents.renderCodeBlock);
    expect(python.getDocumentationCodeBlockProjection.calls.allArgs()).toEqual([[blocks[0]]]);
    expect(blocks.length).toBe(2);
  });

  it("keeps the first surviving owner when duplicate sections arrive in either order", async () => {
    for (const pythonFirst of [true, false]) {
      const python = adapterWithHook("python");
      const other = { id: "other" };
      const value = fence(">>> 1 + 1\n2");
      const sessions = [sessionWithHover(python, value), sessionWithHover(other, value)];
      const result = await hoverWith(...(pythonFirst ? sessions : sessions.reverse()));

      const blocks = await renderBlocks(result.contents.value, result.contents.renderCodeBlock);
      expect(blocks.length).toBe(1);
      expect(python.getDocumentationCodeBlockProjection.calls.count()).toBe(pythonFirst ? 1 : 0);
      if (pythonFirst)
        expect(python.getDocumentationCodeBlockProjection).toHaveBeenCalledWith(blocks[0]);
    }
  });

  it("declines ambiguous identical blocks inside different surviving blockquotes", async () => {
    const python = adapterWithHook("python");
    const quoted = (heading) => `${heading}:\n> \`\`\`\n> >>> 1 + 1\n> 2\n> \`\`\``;
    const result = await hoverWith(
      sessionWithHover(python, quoted("First")),
      sessionWithHover({ id: "other" }, quoted("Second")),
    );

    const blocks = await renderBlocks(result.contents.value, result.contents.renderCodeBlock);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toEqual(blocks[1]);
    expect(python.getDocumentationCodeBlockProjection).not.toHaveBeenCalled();
  });

  it("keeps session ownership aligned when an earlier hover result is null", async () => {
    const absent = adapterWithHook("absent");
    const python = adapterWithHook("python");
    const result = await hoverWith(
      sessionWithHover(absent, null),
      sessionWithHover({ id: "other" }, fence(">>> 1 + 1\n2")),
      sessionWithHover(python, fence(">>> print(3)\n3")),
    );

    const blocks = await renderBlocks(result.contents.value, result.contents.renderCodeBlock);
    expect(blocks.length).toBe(2);
    expect(absent.getDocumentationCodeBlockProjection).not.toHaveBeenCalled();
    expect(python.getDocumentationCodeBlockProjection.calls.allArgs()).toEqual([[blocks[1]]]);
  });

  it("uses each completion's own adapter before and after resolving its documentation", async () => {
    const adapters = [adapterWithHook("first"), adapterWithHook("second")];
    const sessions = adapters.map((adapter, index) => ({
      adapter,
      capabilityOptions: () => ({ resolveProvider: true }),
      request: jasmine.createSpy(`resolve ${index}`).and.resolveTo({
        label: `item${index}`,
        documentation: { kind: "markdown", value: fence(`>>> print(${index + 10})`) },
      }),
    }));
    const provider = new CompletionProvider(managerWith(...sessions));
    const suggestions = sessions.map((session, index) =>
      provider.toSuggestion(session, {
        label: `item${index}`,
        documentation: { kind: "markdown", value: fence(`>>> print(${index})`) },
      }),
    );

    for (const index of [1, 0]) {
      const first = suggestions[index];
      const initialBlocks = await renderBlocks(
        first.descriptionMarkdown,
        first.descriptionCodeBlockRenderer,
      );
      const resolved = await provider.getSuggestionDetailsOnSelect(first);
      const resolvedBlocks = await renderBlocks(
        resolved.descriptionMarkdown,
        resolved.descriptionCodeBlockRenderer,
      );
      expect(adapters[index].getDocumentationCodeBlockProjection.calls.allArgs()).toEqual([
        [initialBlocks[0]],
        [resolvedBlocks[0]],
      ]);
      expect(sessions[index].request.calls.first().args[0]).toBe("completionItem/resolve");
    }
    expect(adapters[0].getDocumentationCodeBlockProjection.calls.count()).toBe(2);
    expect(adapters[1].getDocumentationCodeBlockProjection.calls.count()).toBe(2);
  });

  it("preserves the adapter receiver and awaits an asynchronous projection hook", async () => {
    const adapter = adapterWithHook("async adapter");
    let settle;
    adapter.getDocumentationCodeBlockProjection.and.callFake(function () {
      expect(this).toBe(adapter);
      return new Promise((resolve) => (settle = resolve));
    });
    const renderer = createDocumentationCodeBlockRenderer(adapter);
    const block = { text: ">>> 1 + 1", language: "", scopeName: "text.plain" };
    let completed = false;
    const rendering = renderer(block).then((result) => {
      completed = true;
      return result;
    });

    await Promise.resolve();
    expect(adapter.getDocumentationCodeBlockProjection).toHaveBeenCalledWith(block);
    expect(completed).toBe(false);
    settle(null);
    expect(await rendering).toBeNull();
    expect(completed).toBe(true);
  });

  it("falls back to ordinary code blocks when a hook throws or rejects", async () => {
    const block = { text: ">>> 1 + 1", language: "", scopeName: "text.plain" };
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    for (const asynchronous of [false, true]) {
      const adapter = adapterWithHook("failed adapter");
      if (asynchronous)
        adapter.getDocumentationCodeBlockProjection.and.rejectWith(new Error("Unavailable"));
      else adapter.getDocumentationCodeBlockProjection.and.throwError("Unavailable");

      const renderer = createDocumentationCodeBlockRenderer(adapter);
      expect(await renderer(block)).toBeNull();
      expect(adapter.getDocumentationCodeBlockProjection).toHaveBeenCalledWith(block);
    }
    expect(build).not.toHaveBeenCalled();
  });
});
