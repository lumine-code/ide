const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Disposable } = require("lumine");

describe("managed server registration", () => {
  let ManagedServers, managed, manager, sourceLoads, apiLoads, Sources, Api;

  beforeEach(() => {
    sourceLoads = 0;
    apiLoads = 0;
    Sources = class {
      static parseSidecar = () => "checksum";
      constructor(options) {
        Object.assign(this, options);
      }
    };
    Api = class {
      constructor(owner, adapter, options) {
        Object.assign(this, { owner, adapter, options });
      }
    };
    const filename = path.join(__dirname, "../lib/managed-servers.js");
    const isolatedModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      module: isolatedModule,
      AbortController,
      AbortSignal,
      DOMException,
      require: (request) => {
        if (request === "./server-release-sources") {
          sourceLoads++;
          return Sources;
        }
        if (request === "./install-api") {
          apiLoads++;
          return Api;
        }
        return require(
          request.startsWith(".") ? path.join(path.dirname(filename), request) : request,
        );
      },
    });
    ManagedServers = isolatedModule.exports;
    manager = {
      adapters: new Map(),
      onDidChangeAdapters: () => new Disposable(),
    };
    managed = new ManagedServers(manager, { storageRoot: path.resolve(__dirname, "fixtures") });
  });

  afterEach(() => managed.dispose());

  it("keeps installed-server lookup synchronous without loading release or install code", () => {
    const adapter = { id: "ide-test", managedServer: { source: "npm" } };
    const installed = { version: "1.0.0", modulePath: "/installed/server.js" };
    spyOn(managed.store, "read").and.returnValue(installed);
    expect(managed.installFor(adapter)).toBe(installed);
    expect(managed.store.read).toHaveBeenCalledOnceWith("ide-test", { allowEmptyPayload: false });
    expect(sourceLoads).toBe(0);
    expect(apiLoads).toBe(0);
    managed.dispose();
    expect(managed.controller.disposed).toBe(true);
    expect(sourceLoads).toBe(0);
    expect(apiLoads).toBe(0);
  });

  it("creates the release client once and preserves its parse helper identity", () => {
    const sources = managed.sources;
    expect(managed.sources).toBe(sources);
    expect(sourceLoads).toBe(1);
    expect(ManagedServers.parseSidecar).toBe(Sources.parseSidecar);
    expect(apiLoads).toBe(0);
  });

  it("loads the adapter installation API only when an operation requests it", () => {
    const adapter = { id: "ide-test", managedServer: { source: "npm" } };
    manager.adapters.set(adapter.id, adapter);
    const api = managed.apiFor(adapter);
    expect(api).toBeInstanceOf(Api);
    expect(api.options.signal.aborted).toBe(false);
    expect(apiLoads).toBe(1);
    expect(sourceLoads).toBe(0);
    managed.dispose();
    expect(api.options.signal.aborted).toBe(true);
  });
});
