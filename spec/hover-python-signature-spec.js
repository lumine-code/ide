describe("Python signatures in hover documentation", () => {
  let items, renderHoverCodeBlock;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    ({ renderHoverCodeBlock } = require("../lib/hover-code-block"));
    items = [];
  });

  afterEach(() => {
    for (const item of items) {
      for (const element of item.querySelectorAll("lumine-text-editor"))
        element.getModel().destroy();
      item.remove();
    }
  });

  async function render(source, language = "python") {
    const scopeName = language.includes(".")
      ? language
      : lumine.grammars.treeSitterGrammarForLanguageString(language)?.scopeName;
    const signature = await renderHoverCodeBlock({
      text: source,
      scopeName,
    });
    const item = document.createElement("div");
    if (signature) item.appendChild(signature);
    items.push(item);
    return item;
  }

  it("colors every constructor parameter consistently and preserves the class signature", async () => {
    const source = `class WindBridgeZ(
    q_pe: Unknown,
    α: Unknown,
    β: int,
    b_tot: float,
    d_tot: float,
    c_s: float = 1,
    c_d: float = 1,
    e_w: float = 0.25
)`;
    const item = await render(source);
    const signature = item.querySelector("pre");
    expect(signature).not.toBeNull();
    if (!signature) return;
    expect(signature.textContent).toBe(source);
    expect(
      [...signature.querySelectorAll(".syntax--variable.syntax--parameter.syntax--function")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["q_pe", "α", "β", "b_tot", "d_tot", "c_s", "c_d", "e_w"]);
    expect(signature.querySelector(".syntax--storage.syntax--class").textContent).toBe("class");
    expect(signature.querySelector(".syntax--entity.syntax--class").textContent).toBe(
      "WindBridgeZ",
    );
    expect(signature.querySelector(".syntax--inherited-class")).toBeNull();
  });

  it("keeps nested annotations, defaults and all parameter names in their own roles", async () => {
    const source = `class DynSchema(
    common: Store,
    groups: dict[int, Store],
    lanes: dict[tuple[str, int], Store],
    models: bool = False,
    subs: bool = False
)`;
    const item = await render(source, "py");
    const signature = item.querySelector("pre");
    expect(signature).not.toBeNull();
    if (!signature) return;
    expect(signature.textContent).toBe(source);
    expect(
      [...signature.querySelectorAll(".syntax--variable.syntax--parameter.syntax--function")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["common", "groups", "lanes", "models", "subs"]);
    expect(
      signature.querySelectorAll(".syntax--constant.syntax--builtin.syntax--false").length,
    ).toBe(2);
  });

  it("leaves real class declarations to the ordinary Python renderer", async () => {
    const source = "class Derived(Base):\n    pass";
    const item = await render(source);
    expect(item.childElementCount).toBe(0);
  });

  it("assigns Python definition scopes to labeled method signatures", async () => {
    const source = `(method) def _cache_input(
    mechanics: MechanicsSnapshot,
    family_batches: Mapping[str, FamilyInputBatch],
    point_idxs: IntArray | None = None
) -> CacheInput`;
    const item = await render(source);
    const signature = item.querySelector("pre");
    expect(signature).not.toBeNull();
    if (!signature) return;
    expect(signature.textContent).toBe(source);
    expect(signature.querySelector(".syntax--storage.syntax--function").textContent).toBe("def");
    expect(
      signature.querySelector(".syntax--entity.syntax--name.syntax--function").textContent,
    ).toBe("_cache_input");
    expect(
      [...signature.querySelectorAll(".syntax--variable.syntax--parameter.syntax--function")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["mechanics", "family_batches", "point_idxs"]);
    expect(signature.querySelector(".syntax--function-annotation").textContent).toBe("->");
    expect(
      [...signature.querySelectorAll(".syntax--support.syntax--storage.syntax--type")].some(
        (span) => span.textContent === "CacheInput",
      ),
    ).toBe(true);
  });

  it("uses the same grammar for function signatures with optional labels and async", async () => {
    for (const source of [
      "def calculate(α: float) -> float",
      "(function) def calculate(α: float) -> float",
      "(method) async def calculate(α: float) -> float",
    ]) {
      const signature = (await render(source)).querySelector("pre");
      expect(signature).withContext(source).not.toBeNull();
      if (!signature) continue;
      expect(signature.textContent).toBe(source);
      expect(signature.querySelector(".syntax--storage.syntax--function").textContent).toBe("def");
      expect(
        signature.querySelector(".syntax--entity.syntax--name.syntax--function").textContent,
      ).toBe("calculate");
      expect(
        signature.querySelector(".syntax--variable.syntax--parameter.syntax--function").textContent,
      ).toBe("α");
      if (source.includes("async")) {
        expect(signature.querySelector(".syntax--keyword.syntax--async").textContent).toBe("async");
      }
    }
  });

  it("keeps complete function declarations on the ordinary Python renderer", async () => {
    const source = "def calculate(value: float) -> float:\n    return value";
    const item = await render(source);
    expect(item.childElementCount).toBe(0);
  });

  it("preserves Unicode, string defaults and copyable text without retaining the parser editor", async () => {
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    const source = 'class R(𝛼: str = "<tag>(α)</tag>", *, β: int = 2)';
    const item = await render(source, "source.python");
    const signature = item.querySelector("pre");
    expect(signature.textContent).toBe(source);
    expect(signature.querySelector("tag")).toBeNull();
    expect(signature.querySelector(".syntax--entity.syntax--class").textContent).toBe("R");
    expect(
      [...signature.querySelectorAll(".syntax--variable.syntax--parameter.syntax--function")].map(
        (span) => span.textContent,
      ),
    ).toEqual(["𝛼", "β"]);
    expect(build).toHaveBeenCalled();
    expect(build.calls.all().every((call) => call.returnValue.isDestroyed())).toBe(true);
  });

  it("falls back to the ordinary code block when the signature cannot be parsed", async () => {
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    const source = "class Broken(value: )";
    const item = await render(source);
    expect(item.childElementCount).toBe(0);
    expect(build.calls.first().returnValue.isDestroyed()).toBe(true);
  });

  it("keeps class-like code in other languages on the ordinary renderer", async () => {
    const source = "class Example(value: Type)";
    const item = await render(source, "text");
    expect(item.childElementCount).toBe(0);
  });
});
