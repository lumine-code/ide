describe("IDE status action menu", () => {
  let main, view, lease;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("ide")).mainModule;
    lease = main.consumeStatusBar({
      observeWindows: (create) =>
        create(
          {
            addRightTile({ item }) {
              lumine.workspace.getElement().appendChild(item);
              return { destroy: () => item.remove() };
            },
          },
          { window: lumine.workspace.getMainWindow(), document },
        ),
    });
    view = main.serverStatus;
  });
  afterEach(async () => {
    lease.dispose();
    await lumine.packages.deactivatePackage("ide");
  });
  it("includes the primary server picker and related management actions", () => {
    expect(lumine.contextMenu.templateForElement(view.element).map((item) => item.command)).toEqual(
      ["ide:servers", "ide:manage-servers", "ide:toggle-problems"],
    );
    const dispatch = spyOn(lumine.commands, "dispatch");
    expect(lumine.contextMenu.templateForElement(view.element)[0].mouseBindingLabel).toBe("LMB");
    view.element.dispatchEvent(new MouseEvent("click", { button: 2 }));
    expect(dispatch).not.toHaveBeenCalled();
    view.element.click();
    expect(dispatch).toHaveBeenCalledWith(view.element, "ide:servers");
  });
});
