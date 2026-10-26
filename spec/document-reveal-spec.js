const LanguageServerManager = require("../lib/language-server-manager");

describe("language-server document reveals", () => {
  let manager, editor, requests, subscription;

  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    manager = Object.create(LanguageServerManager.prototype);
    editor = lumine.workspace.buildTextEditor();
    editor.setText("first\nsecond\nthird");
    requests = [];
    subscription = editor.onDidRequestAutoscroll((request) => requests.push(request));
    lumine.config.set("editor.scrollZone", [25, 75]);
  });

  afterEach(() => {
    subscription.dispose();
    editor.destroy();
  });

  for (const kind of ["file", "untitled", "cell"]) {
    it(`reveals a selected ${kind} document in the shared zone without taking focus`, async () => {
      const uri = `${kind}:selected`;
      const selection = {
        start: { line: 1, character: 1 },
        end: { line: 1, character: 4 },
      };
      manager.workspaceDocuments = {
        resolveUri: () => ({ kind, editor, path: __filename, record: {} }),
      };
      const open = spyOn(lumine.workspace, "open").and.resolveTo(editor);
      expect(await manager.showDocument({ uri, selection, takeFocus: false })).toEqual({
        success: true,
      });
      expect(editor.getSelectedText()).toBe("eco");
      expect(requests.at(-1).options.mode).toEqual([25, 75]);
      if (kind === "file")
        expect(open).toHaveBeenCalledOnceWith(__filename, { activateItem: false });
      else expect(open).not.toHaveBeenCalled();
    });
  }
});
