const path = require("path");
const { CompositeDisposable, Disposable } = require("lumine");

describe("ide-client linter registry lifecycle", () => {
  let main, registrations, converters, sessions;
  const adapterFor = (id, options = {}) => ({
    id: `test:${id}`,
    displayName: `${id} Language Server`,
    grammarScopes: ["source.linter-registry-test"],
    resolveServer: async () => null,
    ...options,
  });
  const registry = () => {
    const delegates = [];
    const register = jasmine.createSpy("register indie").and.callFake((config) => {
      const delegate = {
        config,
        setMessages: jasmine.createSpy("set messages"),
        dispose: jasmine.createSpy("dispose indie"),
      };
      delegates.push(delegate);
      return delegate;
    });
    return { register, delegates };
  };
  const diagnostic = (message) => ({
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    message,
  });
  const publish = (adapter, message, uri = converters.pathToUri(path.resolve("main.sample"))) => {
    if (!sessions.has(adapter)) sessions.set(adapter, { adapter });
    return main.manager.publishDiagnostics(sessions.get(adapter), {
      uri,
      diagnostics: message ? [diagnostic(message)] : [],
    });
  };
  const registerAdapter = (adapter) => {
    registrations.add(main.manager.registerAdapter(adapter));
    return adapter;
  };
  const connect = (service) => {
    const registration = main.consumeLinterRegistry(service.register);
    registrations.add(registration);
    return registration;
  };

  beforeEach(async () => {
    await lumine.packages.activatePackage("ide-client");
    main = lumine.packages.getActivePackage("ide-client").mainModule;
    converters = require("../lib/converters");
    registrations = new CompositeDisposable();
    sessions = new Map();
  });

  afterEach(async () => {
    registrations.dispose();
    await lumine.packages.deactivatePackage("ide-client");
  });

  it("registers existing adapters before their first report, including disabled diagnostics", () => {
    registerAdapter(adapterFor("existing"));
    registerAdapter(adapterFor("disabled", { features: { diagnostics: false } }));
    const service = registry();

    connect(service);

    expect(service.delegates.map(({ config }) => config)).toEqual([
      { name: "existing Language Server", markerInvalidation: "never" },
      { name: "disabled Language Server", markerInvalidation: "never" },
    ]);
    expect(service.delegates.every((delegate) => !delegate.setMessages.calls.any())).toBe(true);
  });

  it("registers new adapters and preserves one delegate across selection and diagnostic events", () => {
    const service = registry();
    connect(service);
    const adapter = registerAdapter(adapterFor("new"));
    main.manager.emitter.emit("did-change-adapters", {
      adapter,
      registered: true,
      selectionChanged: true,
    });
    publish(adapter, "first");
    publish(adapter, "second");

    expect(service.register).toHaveBeenCalledTimes(1);
    expect(service.delegates[0].setMessages.calls.count()).toBe(2);
    expect(service.delegates[0].setMessages.calls.mostRecent().args[1][0].excerpt).toBe("second");
  });

  it("keeps disabled diagnostics stored and republishes them when that feature is enabled", () => {
    const adapter = registerAdapter(adapterFor("disabled", { features: { diagnostics: false } }));
    publish(adapter, "stored");
    const service = registry();
    connect(service);
    const delegate = service.delegates[0];
    expect(delegate.setMessages.calls.mostRecent().args[1]).toEqual([]);

    adapter.features.diagnostics = true;
    main.manager.emitter.emit("did-change-features", { adapter });
    expect(delegate.setMessages.calls.mostRecent().args[1][0].excerpt).toBe("stored");

    adapter.features.diagnostics = false;
    main.manager.emitter.emit("did-change-features", { adapter });
    expect(delegate.setMessages.calls.mostRecent().args[1]).toEqual([]);
    expect(main.manager.allDiagnostics()[0].diagnostics[0].message).toBe("stored");
    expect(service.register).toHaveBeenCalledTimes(1);
  });

  it("reconnects a registry with current snapshots after diagnostics changed while disconnected", () => {
    const adapter = registerAdapter(adapterFor("reconnected"));
    const previous = registry();
    const edge = connect(previous);
    publish(adapter, "before disconnect");
    edge.dispose();
    expect(previous.delegates[0].dispose).toHaveBeenCalledTimes(1);
    publish(adapter, "while disconnected");

    const next = registry();
    connect(next);

    expect(previous.delegates[0].setMessages).toHaveBeenCalledTimes(1);
    expect(next.register).toHaveBeenCalledTimes(1);
    const messages = next.delegates[0].setMessages.calls.mostRecent().args[1];
    expect(messages[0].excerpt).toBe("while disconnected");
  });

  it("does not let a replaced registry's disposable detach the current service", () => {
    const adapter = registerAdapter(adapterFor("replacement"));
    const previous = registry();
    const oldEdge = connect(previous);
    publish(adapter, "old service");
    const next = registry();
    const nextEdge = connect(next);
    oldEdge.dispose();
    publish(adapter, "current service");

    expect(previous.delegates[0].dispose).toHaveBeenCalledTimes(1);
    expect(next.delegates[0].dispose).not.toHaveBeenCalled();
    expect(next.delegates[0].setMessages.calls.mostRecent().args[1][0].excerpt).toBe(
      "current service",
    );
    nextEdge.dispose();
    expect(next.delegates[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("removes notebook buckets on unregistration and rejects diagnostics from the removed generation", async () => {
    const notebookPath = path.resolve("test", "nb.ipynb");
    const record = {
      filePath: notebookPath,
      notebookType: "jupyter-notebook",
      cellIndexOf: (id) => ({ c1: 0, c2: 1 })[id] ?? -1,
    };
    for (const cellId of ["c1", "c2"]) {
      const editor = { getRootScopeDescriptor: () => null };
      const manager = main.manager;
      manager.registerExternalDocument(editor, {
        editor,
        uri: converters.cellUri(notebookPath, cellId),
        cellId,
        record,
      });
      registrations.add(new Disposable(() => manager.unregisterExternalDocument(editor)));
    }
    const oldAdapter = registerAdapter(adapterFor("notebook"));
    const service = registry();
    connect(service);
    publish(oldAdapter, "old cell", converters.cellUri(notebookPath, "c1"));
    expect(main.notebookBuckets.has(oldAdapter.id)).toBe(true);

    await main.manager.unregisterAdapter(oldAdapter);
    expect(service.delegates[0].dispose).toHaveBeenCalledTimes(1);
    expect(main.indieDelegates.has(oldAdapter.id)).toBe(false);
    expect(main.notebookBuckets.has(oldAdapter.id)).toBe(false);
    publish(oldAdapter, "late old cell", converters.cellUri(notebookPath, "c1"));
    expect(service.register).toHaveBeenCalledTimes(1);

    const nextAdapter = registerAdapter(adapterFor("notebook"));
    publish(oldAdapter, "late old generation", converters.cellUri(notebookPath, "c1"));
    expect(service.delegates[1].setMessages).not.toHaveBeenCalled();
    publish(nextAdapter, "new cell", converters.cellUri(notebookPath, "c2"));
    const messages = service.delegates[1].setMessages.calls.mostRecent().args[1];
    expect(messages.map(({ excerpt }) => excerpt)).toEqual(["new cell"]);
    expect(messages[0].location.cell).toBe(2);

    const reconnected = registry();
    connect(reconnected);
    const restored = reconnected.delegates[0].setMessages.calls.mostRecent().args[1];
    expect(restored.map(({ excerpt }) => excerpt)).toEqual(["new cell"]);
  });

  it("disposes its delegates on package deactivation even when the service edge remains", async () => {
    registerAdapter(adapterFor("deactivated"));
    const service = registry();
    const edge = connect(service);

    await lumine.packages.deactivatePackage("ide-client");

    expect(service.delegates[0].dispose).toHaveBeenCalledTimes(1);
    edge.dispose();
    expect(service.delegates[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("coalesces pending presentation and does not convert disabled diagnostics", async () => {
    const adapter = registerAdapter(adapterFor("async"));
    const service = registry();
    connect(service);
    const completions = [];
    spyOn(main.manager, "featureEnabledForPath").and.callFake(
      () => new Promise((resolve) => completions.push(resolve)),
    );
    const convert = spyOn(require("../lib/linter-messages"), "toLinterMessages").and.callThrough();
    publish(adapter, "superseded");
    publish(adapter, "latest");
    completions[0](true);
    completions[1](false);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(convert).not.toHaveBeenCalled();
    expect(service.delegates[0].setMessages.calls.allArgs()).toEqual([
      [path.resolve("main.sample"), []],
    ]);
    expect(main.manager.allDiagnostics()[0].diagnostics[0].message).toBe("latest");

    main.manager.emitter.emit("did-change-features", { adapter });
    completions[2](true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.delegates[0].setMessages.calls.mostRecent().args[1][0].excerpt).toBe("latest");
  });

  it("rejects late scope results after a clear or registry disposal", async () => {
    const adapter = registerAdapter(adapterFor("stale"));
    const service = registry();
    const edge = connect(service);
    let complete;
    spyOn(main.manager, "featureEnabledForPath").and.callFake(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    publish(adapter, "old");
    publish(adapter, null);
    complete(true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.delegates[0].setMessages.calls.count()).toBe(1);
    expect(service.delegates[0].setMessages.calls.mostRecent().args[1]).toEqual([]);
    publish(adapter, "disposed");
    edge.dispose();
    complete(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.delegates[0].setMessages.calls.count()).toBe(1);
  });

  it("cannot clear a replacement session's pending report from the previous process", async () => {
    const adapter = registerAdapter(adapterFor("restart"));
    const service = registry();
    connect(service);
    let complete;
    spyOn(main.manager, "featureEnabledForPath").and.callFake(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    publish(adapter, "previous");
    const previous = sessions.get(adapter);
    sessions.set(adapter, { adapter });
    publish(adapter, "replacement");
    main.manager.clearDiagnosticsForSession(previous);
    complete(true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.delegates[0].setMessages.calls.count()).toBe(1);
    expect(service.delegates[0].setMessages.calls.mostRecent().args[1][0].excerpt).toBe(
      "replacement",
    );
  });
});
