describe("ide diagnostics presentation", () => {
  let main;
  let edges;
  const target = () => lumine.views.getView(lumine.workspace);
  const connect = (hub) => {
    const edge = main.consumeLinterHub(hub);
    edges.push(edge);
    return edge;
  };
  const provider = () => ({
    canShowProjectView: jasmine.createSpy("available project view").and.returnValue(true),
    showProjectView: jasmine.createSpy("show project view").and.returnValue(true),
  });

  beforeEach(async () => {
    await lumine.packages.activatePackage("ide");
    main = lumine.packages.getActivePackage("ide").mainModule;
    edges = [];
  });

  afterEach(async () => {
    for (const edge of edges) edge.dispose();
    await lumine.packages.deactivatePackage("ide");
  });

  it("opens the supplied project view without dispatching another package's command", () => {
    const hub = provider();
    connect(hub);
    spyOn(lumine.commands, "dispatch").and.callThrough();
    expect(lumine.commands.canDispatch(target(), "ide:show-problems")).toBe(true);
    expect(main.showProblems()).toBe(true);
    expect(hub.showProjectView).toHaveBeenCalledTimes(1);
    expect(lumine.commands.dispatch).not.toHaveBeenCalled();
    hub.canShowProjectView.and.returnValue(false);
    expect(lumine.commands.canDispatch(target(), "ide:show-problems")).toBe(false);
    expect(main.showProblems()).toBe(false);
    expect(hub.showProjectView).toHaveBeenCalledTimes(1);
  });

  it("disables the action while the hub is absent without suggesting a named package", () => {
    const edge = connect(provider());
    spyOn(lumine.notifications, "addInfo");
    spyOn(lumine.commands, "invalidateAvailability").and.callThrough();
    edge.dispose();
    expect(lumine.commands.invalidateAvailability).toHaveBeenCalled();
    expect(lumine.commands.canDispatch(target(), "ide:show-problems")).toBe(false);
    expect(main.showProblems()).toBe(false);
    expect(lumine.notifications.addInfo).not.toHaveBeenCalled();
  });

  it("does not let an old edge detach a replacement hub", () => {
    const first = provider();
    const oldEdge = connect(first);
    const second = provider();
    connect(second);
    oldEdge.dispose();
    main.showProblems();
    expect(first.showProjectView).not.toHaveBeenCalled();
    expect(second.showProjectView).toHaveBeenCalledTimes(1);
  });

  it("releases retained hub calls on deactivation without detaching a later activation", async () => {
    const oldHub = provider();
    const oldEdge = connect(oldHub);
    await lumine.packages.deactivatePackage("ide");
    expect(main.showProblems()).toBe(false);
    await lumine.packages.activatePackage("ide");
    main = lumine.packages.getActivePackage("ide").mainModule;
    const current = provider();
    connect(current);
    oldEdge.dispose();
    main.showProblems();
    expect(oldHub.showProjectView).not.toHaveBeenCalled();
    expect(current.showProjectView).toHaveBeenCalledTimes(1);
  });
});
