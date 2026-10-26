describe("language-server color dialogs in editor windows", () => {
  let features;
  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("ide");
  });
  afterEach(async () => {
    features?.destroy();
    await lumine.packages.deactivatePackage("ide");
    await lumine.workspace.discardEditorWindows();
  });
  it("keeps color choices in independent hosts while preserving their captured editor", async () => {
    const DocumentFeatures = require("../lib/document-features");
    const { Disposable } = require("lumine");
    features = new DocumentFeatures({
      onDidChangeSession: () => new Disposable(),
      onDidChangeCapabilities: () => new Disposable(),
      onDidChangeFeatures: () => new Disposable(),
      applyWorkspaceEdit: jasmine.createSpy("edit").and.resolveTo(true),
    });
    const workspace = lumine.workspace;
    const first = await workspace.open();
    const extra = await workspace.openEditorWindow({ show: false });
    const second = workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    const context = (window, editor) => ({
      window,
      editor,
      session: {},
      uri: "file:///test",
      color: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      presentations: [{ label: "red" }],
      isCurrent: () => !editor.isDestroyed(),
    });
    await features.showColorPresentations(context(workspace.getMainWindow(), first));
    await features.showColorPresentations(context(extra, second));
    const local = features.colorLists.get(workspace.getMainWindow()).host;
    const remote = features.colorLists.get(extra).host;
    expect(local.isVisible()).toBe(true);
    expect(remote.getModel().getElement().ownerDocument).toBe(extra.getDocument());
    await local.getModel().setQuery("local");
    await remote.getModel().setQuery("remote");
    expect(local.getModel().getQuery()).toBe("local");
    expect(remote.getModel().getItems()[0].context.editor).toBe(second);
    await workspace.attachWindow(extra);
    expect(features.colorLists.has(extra)).toBe(false);
  });
});

describe("language server menus in editor windows", () => {
  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("ide");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide");
    await lumine.workspace.discardEditorWindows();
  });
  it("creates server and management menus in their requested native hosts", async () => {
    const workspace = lumine.workspace;
    const extra = await workspace.openEditorWindow({ show: false });
    const main = lumine.packages.getActivePackage("ide").mainModule;
    const local = main.getSessionMenu(workspace.getMainWindow());
    const remote = main.getSessionMenu(extra);
    local.serverListHost.getPanel();
    remote.serverListHost.getPanel();
    expect(remote.serverList.getElement().ownerDocument).toBe(extra.getDocument());
    expect(local.serverList.getElement().ownerDocument).toBe(document);
    remote.detailsListHost.getPanel();
    expect(remote.detailsList.getElement().ownerDocument).toBe(extra.getDocument());
    await workspace.attachWindow(extra);
    expect(main.sessionMenus.has(extra)).toBe(false);
  });
});
