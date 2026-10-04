const ContextHelpProvider = require("../lib/context-help-provider");

describe("IDE context-help rendering through the tooltip", () => {
  let editor, registration, documentationPackage;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    await lumine.packages.activatePackage("language-javascript");
    await lumine.packages.activatePackage("language-typescript");
    await lumine.packages.activatePackage("language-python");
    documentationPackage = await lumine.packages.activatePackage("documentation-view");
    await lumine.packages.activatePackage("hover");
    editor = await lumine.workspace.open("hover.js");
    editor.setText("values.filter(Boolean)");
    editor.setCursorBufferPosition([0, 9]);
  });

  afterEach(async () => {
    registration?.dispose();
    await lumine.packages.deactivatePackage("hover");
    await lumine.packages.deactivatePackage("documentation-view");
    editor?.destroy();
  });

  async function show(language, text, { panel = false } = {}) {
    const value = `\`\`\`${language}\n${text}\n\`\`\`\n\nDocumentation stays intact.`;
    const provider = new ContextHelpProvider({
      addCapabilityFragment() {},
      allGrammarScopes: () => ["source.js"],
      uriForEditor: () => "file:///hover.js",
      activeSessionsForEditor: async () => [
        {
          adapter: require("./helpers/documentation-adapter")(),
          supports: () => true,
          request: async () => ({ contents: { kind: "markdown", value } }),
        },
      ],
    });
    registration = documentationPackage.mainModule.consumeContextHelp(provider);
    if (panel) {
      const main = documentationPackage.mainModule;
      const result = await main
        .provideContextHelpRegistry()
        .request(editor, editor.getCursorBufferPosition());
      const view = await main.provideContextHelpPanel().show(result);
      return view.element;
    }
    lumine.commands.dispatch(editor.getElement(), "hover:toggle");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const overlay = editor
        .getOverlayDecorations()
        .find((decoration) => decoration.getProperties().class === "hover-overlay");
      if (overlay) return overlay.getProperties().item;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("IDE hover did not render");
  }

  it("uses TypeScript scopes for a TypeScript signature returned about JavaScript", async () => {
    const source =
      "(method) Array<string>.filter(predicate: (value: string) => unknown, thisArg?: any): string[] (+1 overload)";
    const item = await show("typescript", source);
    const pre = item.querySelector("pre");
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector(".syntax--source.syntax--ts")).not.toBeNull();
    expect(pre.querySelector(".syntax--variable.syntax--parameter").textContent).toBe("predicate");
    expect(pre.querySelector(".syntax--type.syntax--predefined").textContent).toBe("string");
    expect(item.textContent).toContain("Documentation stays intact.");
  });

  it("renders the same projected documentation in the retained panel without a tooltip", async () => {
    const source = "(method) Array<string>.filter(predicate: (value: string) => unknown): string[]";
    const item = await show("typescript", source, { panel: true });
    const pre = item.querySelector("pre");
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector(".syntax--attribute-name.syntax--method").textContent).toBe("filter");
    expect(pre.querySelector(".syntax--variable.syntax--parameter").textContent).toBe("predicate");
    expect(item.textContent).toContain("Documentation stays intact.");
    expect(
      editor
        .getOverlayDecorations()
        .some((decoration) => decoration.getProperties().class === "hover-overlay"),
    ).toBe(false);
  });

  it("retains Python signature highlighting through the same language-neutral service", async () => {
    const source = "(method) def _cache_input(value: IntArray | None) -> CacheInput";
    const item = await show("python", source);
    const pre = item.querySelector("pre");
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector(".syntax--storage.syntax--function").textContent).toBe("def");
    expect(pre.querySelector(".syntax--entity.syntax--function").textContent).toBe("_cache_input");
  });

  it("renders Python console examples with continuation prompts and neutral output", async () => {
    const source = `>>> def double(value):
...     return value * 2
...
>>> double(3)
6
>>> # another example
>>> double(4)
8`;
    const item = await show("pycon", source);
    const pre = item.querySelector("pre");
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector(".syntax--source.syntax--python")).not.toBeNull();
    expect(pre.querySelector(".syntax--storage.syntax--function").textContent).toBe("def");
    expect(pre.querySelector(".syntax--entity.syntax--function").textContent).toBe("double");
    expect(pre.querySelector(".syntax--comment").textContent).toBe("# another example");
    expect(
      [...pre.querySelectorAll(".syntax--punctuation.syntax--definition.syntax--prompt")].map(
        (span) => span.textContent,
      ),
    ).toEqual([">>>", "...", "...", ">>>", ">>>", ">>>"]);
    expect(
      [...pre.querySelectorAll(".syntax--constant.syntax--numeric")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["2", "3", "4"]);
    expect(item.textContent).toContain("Documentation stays intact.");
  });

  it("renders an unlabeled this type as method declarations through the IDE provider", async () => {
    const source = "this: { initialize(): void; activate(): void; }";
    const item = await show("typescript", source);
    const pre = item.querySelector("pre");
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(
      [...pre.querySelectorAll(".syntax--attribute-name.syntax--method")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["initialize", "activate"]);
  });
});
