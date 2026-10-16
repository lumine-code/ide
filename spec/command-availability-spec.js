describe("IDE session command availability", () => {
  it("does not initialize a cold routing graph for presentation", async () => {
    const Manager = require("../lib/language-server-manager");
    const manager = new Manager();
    const editor = lumine.workspace.buildTextEditor();
    const read = spyOn(manager, "sessionsForEditor").and.throwError("active routing");
    try {
      expect(manager.peekSessionsForEditor(editor)).toEqual([]);
      expect(manager._workspaceDocuments).toBe(null);
      expect(read).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
      await manager.deactivate();
    }
  });
  it("reads matching existing routes without starting or attaching a server", async () => {
    const Manager = require("../lib/language-server-manager");
    const manager = new Manager();
    const editor = lumine.workspace.buildTextEditor();
    const root = manager.rootForPath(null, {});
    const documents = { bindingFor: () => null, isDetached: () => false, dispose() {} };
    manager.workspaceDocuments = documents;
    const adapter = { id: "cached-route", grammarScopes: [editor.getGrammar().scopeName] };
    const session = { adapter, documents: new Map() };
    manager.adapters.set(adapter.id, adapter);
    manager.controllerRoutes.set(adapter, new Map([[root, { session }]]));
    const ensure = spyOn(manager, "ensureSession").and.throwError("start server");
    try {
      expect(manager.peekSessionsForEditor(editor)).toEqual([session]);
      adapter.grammarScopes = [];
      expect(manager.peekSessionsForEditor(editor)).toEqual([]);
      expect(ensure).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
      manager.adapters.clear();
      await manager.deactivate();
    }
  });
});
