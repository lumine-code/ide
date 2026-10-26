describe("ide command scopes", () => {
  const commands = [
    "format",
    "fold-server-ranges",
    "expand-selection-range",
    "select-linked-ranges",
    "color-presentation",
  ].map((name) => `ide:${name}`);
  let editor, mini, button;

  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("ide");
    editor = await lumine.workspace.open();
    mini = lumine.workspace.buildTextEditor({ mini: true });
    button = document.createElement("button");
    lumine.workspace.getElement().append(mini.getElement(), button);
  });

  afterEach(async () => {
    button.remove();
    mini.destroy();
    editor.destroy();
    await lumine.packages.deactivatePackage("ide");
  });

  it("exposes local actions only where their registered surface handles them", () => {
    for (const command of commands) {
      expect(lumine.commands.canDispatch(editor.getElement(), command))
        .withContext(command)
        .toBe(true);
      expect(lumine.commands.canDispatch(button, command)).withContext(command).toBe(false);
      expect(lumine.commands.canDispatch(lumine.workspace.getElement(), command))
        .withContext(command)
        .toBe(false);
      expect(lumine.commands.canDispatch(mini.getElement(), command))
        .withContext(command)
        .toBe(false);
    }
  });

  it("keeps selection and navigation available while disabling text mutations in a read-only editor", () => {
    editor.getElement().setAttribute("readonly", "");
    const mutators = new Set(["format", "color-presentation"].map((name) => `ide:${name}`));
    for (const command of commands)
      expect(lumine.commands.canDispatch(editor.getElement(), command))
        .withContext(command)
        .toBe(!mutators.has(command));
  });

  it("does not offer local actions in an empty workspace", () => {
    editor.destroy();
    for (const command of commands)
      expect(lumine.commands.canDispatch(lumine.workspace.getElement(), command))
        .withContext(command)
        .toBe(false);
  });
});
