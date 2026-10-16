const path = require("node:path");
const packageRoot = path.join(__dirname, "..");

describe("IDE document commands in captured presentation contexts", () => {
  let main, first, second, extra, firstPane, notebook, expand;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      if (!jasmine.isSpy(lumine.shell[method])) spyOn(lumine.shell, method).and.resolveTo();
    if (!jasmine.isSpy(lumine.application.openWindow))
      spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage(packageRoot)).mainModule;
    first = await lumine.workspace.open();
    firstPane = lumine.workspace.paneForItem(first);
    second = lumine.workspace.buildTextEditor();
    expand = jasmine.createSpy("expand captured selections").and.resolveTo(true);
    spyOn(main, "ensureProviders").and.returnValue({
      documentFeatures: { expandSelectionRanges: expand },
    });
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide");
    await lumine.workspace.discardEditorWindows();
    if (notebook) await lumine.workspace.paneForItem(notebook)?.destroyItem(notebook);
    first?.destroy();
    second?.destroy();
    main = first = second = extra = firstPane = notebook = expand = null;
  });

  it("requires editor focus rather than forwarding an auxiliary surface to its document", async () => {
    extra = await lumine.workspace.openEditorWindow({ show: false });
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    firstPane.activate();
    firstPane.activateItem(first);
    const button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);

    await lumine.commands.dispatch(button, "ide:expand-selection-range");

    expect(lumine.commands.canDispatch(button, "ide:expand-selection-range")).toBe(false);
    expect(expand).not.toHaveBeenCalled();
    await lumine.commands.dispatch(second.getElement(), "ide:expand-selection-range");
    expect(expand).toHaveBeenCalledOnceWith(second);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
  });

  it("does not route a notebook button's selection action into its embedded editor", async () => {
    const element = document.createElement("div");
    const button = document.createElement("button");
    element.appendChild(button);
    notebook = {
      element,
      getTitle: () => "Command Context Notebook",
      getActiveEmbeddedTextEditor: () => second,
    };
    const pane = firstPane.splitRight();
    pane.activateItem(notebook, { activatePane: true });
    firstPane.activate();
    firstPane.activateItem(first);
    const context = lumine.workspace.resolveCommandContext(button);
    expect(context.editor).toBeUndefined();
    expect(context.embeddedEditor).toBe(second);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);

    await lumine.commands.dispatch(button, "ide:expand-selection-range");

    expect(lumine.commands.canDispatch(button, "ide:expand-selection-range")).toBe(false);
    expect(expand).not.toHaveBeenCalled();
  });

  it("keeps a direct non-mini editor ahead of captured fallback editors", () => {
    expect(
      main.editorForCommand({ target: first.getElement(), context: { embeddedEditor: second } }),
    ).toBe(first);
  });

  it("honors a captured editor when a host has no embedded editor", () => {
    expect(
      main.editorForCommand({ target: lumine.workspace.getElement(), context: { editor: second } }),
    ).toBe(second);
  });

  it("returns null when no document surface is available", () => {
    spyOn(lumine.workspace, "getActiveEmbeddedTextEditor").and.returnValue(null);
    spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(null);
    expect(main.editorForCommand({ target: document.createElement("button") })).toBeNull();
  });

  it("leaves the main editor untouched when an invoking auxiliary window has no document", async () => {
    extra = await lumine.workspace.openEditorWindow({ show: false });
    const button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);

    await lumine.commands.dispatch(button, "ide:expand-selection-range");

    expect(expand).not.toHaveBeenCalled();
  });

  it("keeps the shared active editor fallback for programmatic calls without context", () => {
    expect(main.editorForCommand()).toBe(first);
  });
});
