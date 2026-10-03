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
    const scope = editor.getGrammar().scopeName;
    const session = {
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
    lumine.commands.dispatch(editor.getElement(), "autocomplete:activate");
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
});
