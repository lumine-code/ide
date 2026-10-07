describe("IDE completion documentation through autocomplete", () => {
  let editor, registration, watchRegistration, autocompletePackage, CompletionProvider;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("language-javascript");
    await lumine.packages.activatePackage("language-typescript");
    await lumine.packages.activatePackage("language-python");
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.enableBuiltinProvider", false);
    autocompletePackage = await lumine.packages.activatePackage("autocomplete");
    CompletionProvider = require("../lib/completion-provider");
  });

  afterEach(async () => {
    registration?.dispose();
    watchRegistration?.dispose();
    await lumine.packages.deactivatePackage("autocomplete");
    editor?.destroy();
  });

  async function show(path, word, language, signature) {
    editor = await lumine.workspace.open(path);
    editor.setText(word);
    editor.setCursorBufferPosition([0, word.length]);
    await editor.whenGrammarSettled();
    // The first pane mount can complete after workspace.open. Autocomplete's
    // command belongs to the focused editor, so wait for the surface and focus
    // it explicitly rather than relying on a platform's window startup focus.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const scope = editor.getGrammar().scopeName;
    const session = {
      adapter: path.endsWith(".py") ? require("./helpers/documentation-adapter")() : {},
      supports: () => true,
      capabilityOptions: () => ({ resolveProvider: true }),
      request: async (method) =>
        method === "completionItem/resolve"
          ? {
              label: word,
              documentation: {
                kind: "markdown",
                value: `\`\`\`${language}\n${signature}\n\`\`\`\n\nDocumentation stays intact.`,
              },
            }
          : { items: [{ label: word, kind: 2 }] },
    };
    const provider = new CompletionProvider({
      addCapabilityFragment() {},
      uriForEditor: () => `file:///${path}`,
      allGrammarScopes: () => [scope],
      activeSessionsForEditor: async () => [session],
    });
    registration = autocompletePackage.mainModule.consumeAutocomplete(provider);
    watchRegistration = autocompletePackage.mainModule.provideAutocompleteWatchEditor()(editor);
    const editorElement = editor.getElement();
    editorElement.focus();
    expect(autocompletePackage.mainModule.autocompleteManager.editor).toBe(editor);
    lumine.commands.dispatch(editorElement, "autocomplete:activate");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const content = editor.getElement().querySelector(".suggestion-description-content");
      if (content?.querySelector("pre .syntax--source")) return content;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("IDE completion documentation did not render");
  }

  it("colors a Python signature with omitted parameters and nested callable return types", async () => {
    const signature = `def limit(
    id: Unknown | None = None,
    func: Unknown | None = None,
    ...
) -> ((cls: Unknown) -> Unknown) | ((get: Unknown) -> ((cls: Unknown) -> Unknown)) | Unknown`;
    const content = await show("completion.py", "limit", "python", signature);
    const pre = content.querySelector("pre");
    expect(pre.textContent).toBe(signature);
    expect(pre.querySelector(".syntax--storage.syntax--function").textContent).toBe("def");
    expect(pre.querySelector(".syntax--entity.syntax--function").textContent).toBe("limit");
    expect(
      [...pre.querySelectorAll(".syntax--variable.syntax--parameter")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["id", "func", "get"]);
    expect(
      [...pre.querySelectorAll(".syntax--variable.syntax--language.syntax--cls")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["cls", "cls"]);
    expect(
      [...pre.querySelectorAll(".syntax--support.syntax--storage.syntax--type")].some(
        (span) => span.textContent === "Unknown",
      ),
    ).toBe(true);
    expect(content.textContent).toContain("Documentation stays intact.");
  });

  it("colors unlabelled Python doctest documentation after resolving a completion", async () => {
    const source = `>>> from bacadra import units as U
>>>
>>> # arithmetic with units
>>> length = 5 * U.m
>>> def work(force):
...     return force * length
...
>>> work(10 * U.kN)
50 kJ`;
    const content = await show("completion.py", "work", "", source);
    const pre = content.querySelector("pre");
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector(".syntax--source.syntax--python")).not.toBeNull();
    expect(pre.querySelector(".syntax--storage.syntax--function").textContent).toBe("def");
    expect(pre.querySelector(".syntax--entity.syntax--function").textContent).toBe("work");
    expect(pre.querySelector(".syntax--comment").textContent).toBe("# arithmetic with units");
    expect(
      [...pre.querySelectorAll(".syntax--punctuation.syntax--definition.syntax--prompt")].map(
        (span) => span.textContent,
      ),
    ).toEqual([">>>", ">>>", ">>>", ">>>", ">>>", "...", "...", ">>>"]);
    expect(
      [...pre.querySelectorAll(".syntax--constant.syntax--numeric")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["5", "10"]);
    expect(content.textContent).toContain("Documentation stays intact.");
  });

  it("uses TypeScript grammar for typed documentation returned about a JavaScript completion", async () => {
    const signature =
      "(method) Array<string>.filter(predicate: (value: string) => unknown): string[] (+1 overload)";
    const content = await show("completion.js", "filter", "typescript", signature);
    const pre = content.querySelector("pre");
    expect(pre.textContent).toBe(signature);
    expect(pre.querySelector(".syntax--source.syntax--ts")).not.toBeNull();
    expect(pre.querySelector(".syntax--attribute-name.syntax--method").textContent).toBe("filter");
    expect(pre.querySelector(".syntax--variable.syntax--parameter").textContent).toBe("predicate");
    expect(pre.querySelector(".syntax--type.syntax--predefined").textContent).toBe("string");
  });

  it("keeps Ctrl-Space rows consistent while resolving and reopening JavaScript globals", async () => {
    editor = await lumine.workspace.open("eslint.config.js");
    editor.setText('const globals = require("globals");\nmodule.exports = [{ rules: {} }];');
    editor.setCursorBufferPosition([1, 27]);
    await editor.whenGrammarSettled();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const items = ["globals", "js", "module", "n", "prettier", "runtimeModules"].map((label) => ({
      label,
      kind: 6,
    }));
    const signatures = {
      globals: "(alias) const globals: Globals\nimport globals",
      js: "(alias) const js: { readonly meta: { readonly name: string; }; }\nimport js",
    };
    const session = {
      adapter: {},
      supports: () => true,
      capabilityOptions: () => ({ resolveProvider: true }),
      request: async (method, item) =>
        method === "completionItem/resolve"
          ? {
              ...item,
              detail: signatures[item.label],
              documentation: { kind: "markdown", value: "" },
            }
          : { items },
    };
    const provider = new CompletionProvider({
      addCapabilityFragment() {},
      uriForEditor: () => "file:///eslint.config.js",
      allGrammarScopes: () => [editor.getGrammar().scopeName],
      activeSessionsForEditor: async () => [session],
    });
    registration = autocompletePackage.mainModule.consumeAutocomplete(provider);
    watchRegistration = autocompletePackage.mainModule.provideAutocompleteWatchEditor()(editor);
    const editorElement = editor.getElement();
    editorElement.focus();
    const list = autocompletePackage.mainModule.autocompleteManager.suggestionList;
    const view = list.suggestionListElement;
    const waitForSignature = async (signature) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const rendered = view.descriptionContent.querySelector("pre")?.textContent;
        const embedded = view.descriptionContent
          .querySelector("lumine-text-editor")
          ?.getModel()
          .getText();
        if (rendered === signature || embedded === signature) {
          for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Resolved global signature did not render");
    };
    const expectRows = () => {
      expect(
        Array.from(view.ol.querySelectorAll(".left-label"), (label) => label.textContent),
      ).toEqual(items.map(() => ""));
      expect(Array.from(view.ol.querySelectorAll(".word"), (word) => word.textContent)).toEqual(
        items.map(({ label }) => label),
      );
      const row = view.ol.firstChild;
      const iconCell = row.querySelector(".icon-container");
      const icon = iconCell.querySelector(".icon").getBoundingClientRect();
      const word = row.querySelector(".word").getBoundingClientRect();
      expect(word.left - icon.right).toBeCloseTo(
        parseFloat(getComputedStyle(iconCell).paddingRight),
        0,
      );
    };

    // Ctrl-Space invokes this command without inserting a prefix.
    lumine.commands.dispatch(editorElement, "autocomplete:activate");
    await waitForSignature(signatures.globals);
    expectRows();
    list.selectNext();
    await waitForSignature(signatures.js);
    expectRows();
    expect(view.descriptionContent.textContent).not.toContain(signatures.globals);

    autocompletePackage.mainModule.autocompleteManager.cancelSuggestions();
    await new Promise(requestAnimationFrame);
    lumine.commands.dispatch(editorElement, "autocomplete:activate");
    await waitForSignature(signatures.globals);
    expectRows();
    provider.dispose();
  });
});
