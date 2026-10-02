describe("TypeScript display signatures in IDE hover", () => {
  let renderHoverCodeBlock;
  const source =
    "(method) Array<string>.filter(predicate: (value: string, index: number, array: string[]) => unknown, thisArg?: any): string[] (+1 overload)";

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-typescript");
    ({ renderHoverCodeBlock } = require("../lib/hover-code-block"));
  });

  const render = (text) =>
    renderHoverCodeBlock({ text, language: "typescript", scopeName: "source.ts" });

  it("renders the TypeScript server's JavaScript hover with actual TypeScript scopes", async () => {
    const HoverProvider = require("../lib/hover-provider");
    const value = `\`\`\`typescript\n${source}\n\`\`\`\n\nReturns matching elements.`;
    const provider = new HoverProvider({
      addCapabilityFragment() {},
      allGrammarScopes: () => ["source.js"],
      uriForEditor: () => "file:///hover.js",
      activeSessionsForEditor: async () => [
        {
          supports: () => true,
          request: async () => ({ contents: { kind: "markdown", value } }),
        },
      ],
    });
    const result = await provider.hover(
      { getGrammar: () => ({ scopeName: "source.js" }) },
      { row: 0, column: 0 },
    );
    expect(result.contents.value).toBe(value);
    const pre = await result.contents.renderCodeBlock({
      text: source,
      language: "typescript",
      scopeName: "source.ts",
    });
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector(".syntax--source.syntax--ts")).not.toBeNull();
    expect(pre.querySelector(".syntax--attribute-name.syntax--method").textContent).toBe("filter");
    expect(
      [...pre.querySelectorAll(".syntax--variable.syntax--parameter")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["predicate", "value", "index", "array", "thisArg"]);
    expect(
      [...pre.querySelectorAll(".syntax--type.syntax--predefined")].map((span) => span.textContent),
    ).toEqual(["string", "string", "number", "string", "unknown", "any", "string"]);
    expect(pre.querySelector(".syntax--type.syntax--builtin").textContent).toBe("Array");
    expect(pre.querySelector(".syntax--constant.syntax--numeric")).toBeNull();
  });

  it("parses generic receivers and method parameters without splitting nested type names", async () => {
    const text =
      "(method) Box<(x: ns.Item) => ns.Result>.map<U extends { value: string }>(value: U): Promise<U> (+2 overloads)";
    const pre = await render(text);
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(text);
    expect(pre.querySelector(".syntax--attribute-name.syntax--method").textContent).toBe("map");
    expect(pre.querySelector(".syntax--type.syntax--builtin").textContent).toBe("Promise");
    expect(pre.querySelector(".syntax--type.syntax--predefined").textContent).toBe("string");
  });

  it("recognizes every method in an unlabeled this type, including the first", async () => {
    const text = `this: {
    initialize(): void;
    activate(_state: any, { signal, cause }?: {}): void;
    deactivate(): void;
    deserializeAboutView(state: any): any;
    ensureModel(): any;
    createModel(): any;
}`;
    const pre = await render(text);
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(text);
    expect(
      [...pre.querySelectorAll(".syntax--attribute-name.syntax--method")].map(
        (span) => span.textContent,
      ),
    ).toEqual([
      "initialize",
      "activate",
      "deactivate",
      "deserializeAboutView",
      "ensureModel",
      "createModel",
    ]);
    expect(pre.querySelector(".syntax--variable.syntax--language.syntax--this").textContent).toBe(
      "this",
    );
    expect(pre.querySelector(".syntax--variable.syntax--parameter").textContent).toBe("_state");
    expect(
      [...pre.querySelectorAll(".syntax--type.syntax--predefined")].map((span) => span.textContent),
    ).toEqual(["void", "any", "void", "void", "any", "any", "any", "any"]);
    expect(pre.querySelector(".syntax--support.syntax--function")).toBeNull();
  });

  it("recognizes named and composite this types without reinterpreting source expressions", async () => {
    for (const text of ["this: Renderer", "this: Renderer | undefined", "this: Array<string>"]) {
      const pre = await render(text);
      expect(pre).withContext(text).not.toBeNull();
      if (!pre) continue;
      expect(pre.textContent).toBe(text);
      expect(pre.querySelector(".syntax--variable.syntax--language.syntax--this").textContent).toBe(
        "this",
      );
      expect(pre.querySelector(".syntax--support.syntax--storage")).not.toBeNull();
    }
    expect(await render("this.initialize();")).toBeNull();
    expect(await render("this: { initialize(: }")).toBeNull();
  });

  it("uses the same projection path for properties, parameters and function declarations", async () => {
    for (const [text, selector, expected] of [
      ["(property) Map<string, ns.Item>.size: number", ".syntax--attribute-name", "size"],
      ["(parameter) path: string", ".syntax--variable.syntax--parameter", "path"],
      [
        "(function) function read(path: string): Promise<string>",
        ".syntax--entity.syntax--function",
        "read",
      ],
      ["(alias) const count: number", ".syntax--variable.syntax--assignment", "count"],
    ]) {
      const pre = await render(text);
      expect(pre).withContext(text).not.toBeNull();
      if (!pre) continue;
      expect(pre.textContent).toBe(text);
      expect(pre.querySelector(selector).textContent).toBe(expected);
    }
  });

  it("preserves literal content safely and disposes every temporary editor", async () => {
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    const text = '(property) Foo.text: "<tag>𐐀</tag>"';
    const pre = await render(text);
    expect(pre.textContent).toBe(text);
    expect(pre.querySelector("tag")).toBeNull();
    expect(build.calls.all().every((call) => call.returnValue.isDestroyed())).toBe(true);
  });

  it("declines malformed signatures, ordinary code and other languages", async () => {
    expect(await render("(method) Array<string>.filter(value: ):")).toBeNull();
    expect(await render("const values: string[] = [];")).toBeNull();
    expect(await renderHoverCodeBlock({ text: source, scopeName: "source.js" })).toBeNull();
    expect(await renderHoverCodeBlock({ text: source, scopeName: "source.cs" })).toBeNull();
  });
});
