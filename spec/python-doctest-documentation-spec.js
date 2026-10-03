describe("Python doctest documentation blocks", () => {
  let renderDocumentationCodeBlock, adapter;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    ({ renderDocumentationCodeBlock } = require("../lib/documentation-code-block"));
    adapter = require("./helpers/documentation-adapter")();
  });

  const render = (text, options = {}) =>
    renderDocumentationCodeBlock(
      { text, language: "", scopeName: "text.plain", ...options },
      adapter,
    );

  function expectNeutralText(pre, text) {
    const start = pre.textContent.lastIndexOf(text);
    expect(start).toBeGreaterThanOrEqual(0);
    if (start < 0) return;
    const end = start + text.length;
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      const nextOffset = offset + node.textContent.length;
      if (offset < end && nextOffset > start) {
        expect(node.parentElement.className)
          .withContext(text)
          .toBe("syntax--source syntax--python");
      }
      offset = nextOffset;
    }
  }

  it("recognizes an unlabeled docstring example and keeps prompts and output copyable", async () => {
    const source = `>>> from bacadra import units as U
>>>
>>> # direct unit usage
>>> length = 5 * U.m
>>> print(length)
5 m`;
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    const pre = await render(source);
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector(".syntax--keyword.syntax--import").textContent).toBe("from");
    expect(pre.querySelector(".syntax--comment").textContent).toBe("# direct unit usage");
    expect(pre.querySelector(".syntax--support.syntax--builtin").textContent).toBe("print");
    expect(pre.querySelector(".syntax--punctuation.syntax--prompt").textContent).toBe(">>>");
    expectNeutralText(pre, "5 m");
    expect(build.calls.all().every((call) => call.returnValue.isDestroyed())).toBe(true);
  });

  it("parses continuation indentation while leaving transcript output neutral", async () => {
    const source = `>>> def twice(α):
...     return α * 2
...
>>> twice(3)
6
... output elided
>>> print("<tag>")
<tag>`;
    const pre = await render(source);
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector(".syntax--storage.syntax--function").textContent).toBe("def");
    expect(pre.querySelector(".syntax--variable.syntax--parameter").textContent).toBe("α");
    expect(pre.querySelector(".syntax--keyword.syntax--return").textContent).toBe("return");
    expect(pre.querySelectorAll(".syntax--punctuation.syntax--prompt").length).toBe(5);
    expect(pre.querySelector("tag")).toBeNull();
    expectNeutralText(pre, "6\n... output elided");
    expectNeutralText(pre, "<tag>");
  });

  it("keeps lookalike prompts and Python-shaped stdout out of the grammar", async () => {
    const source = `>>> print(True)
...word
>>>> output
True
def fake(value):
>>> print(2)
2`;
    const pre = await render(source);
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(pre.querySelectorAll(".syntax--punctuation.syntax--prompt").length).toBe(2);
    expect(pre.querySelector(".syntax--entity.syntax--function")).toBeNull();
    expectNeutralText(pre, "...word\n>>>> output\nTrue\ndef fake(value):");
    expectNeutralText(pre, "2");
  });

  it("preserves leading indentation, CRLF and astral identifiers", async () => {
    const source = "  >>> 𝛼 = 2\r\n  >>> print(𝛼)\r\n  2";
    const pre = await render(source);
    expect(pre).not.toBeNull();
    if (!pre) return;
    expect(pre.textContent).toBe(source);
    expect(pre.querySelector(".syntax--constant.syntax--numeric").textContent).toBe("2");
    expect(pre.querySelector(".syntax--support.syntax--builtin").textContent).toBe("print");
  });

  it("handles Python and console fences through the same projection", async () => {
    for (const options of [
      { language: "python", scopeName: "source.python" },
      { language: "py", scopeName: "source.python" },
      { language: "source.python.ipy", scopeName: "source.python.ipy" },
      { language: "pycon" },
      { language: "python-console" },
    ]) {
      const pre = await render(">>> print(2)\n2", options);
      expect(pre).withContext(JSON.stringify(options)).not.toBeNull();
      expect(pre?.querySelector(".syntax--support.syntax--builtin")?.textContent).toBe("print");
    }
  });

  it("leaves explicit text and other language fences to their renderer", async () => {
    for (const options of [
      { language: "text" },
      { language: "javascript", scopeName: "source.js" },
      { language: "bash", scopeName: "source.shell" },
    ]) {
      expect(await render(">>> print(2)", options)).toBeNull();
    }
    expect(await render("Prose mentions >>> print(2).\n>>> print(2)")).toBeNull();
  });

  it("falls back safely for an unparseable transcript and destroys its temporary editor", async () => {
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    expect(await render(">>> def broken(:\n...     pass")).toBeNull();
    expect(build).toHaveBeenCalled();
    if (build.calls.any()) expect(build.calls.first().returnValue.isDestroyed()).toBe(true);
  });

  it("does not infer Python console syntax without the originating adapter", async () => {
    for (const language of ["", "pycon", "python-console", "python"]) {
      expect(
        await renderDocumentationCodeBlock({
          text: ">>> print(2)\n2",
          language,
          scopeName: language === "python" ? "source.python" : "text.plain",
        }),
      ).toBeNull();
    }
  });
});
