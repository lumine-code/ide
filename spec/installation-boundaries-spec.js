const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Manager = require("../lib/language-server-manager");
const ManagedServers = require("../lib/managed-servers");

describe("managed installation descriptor boundaries", () => {
  let manager, managed, scratch, storageRoot, requests;
  const register = (managedServer) => {
    const adapter = {
      id: "installation-boundary-test",
      displayName: "Boundary Test Server",
      grammarScopes: ["source.boundary-test"],
      resolveServer: async () => null,
      managedServer,
    };
    manager.registerAdapter(adapter);
    manager.reattachAll.calls.reset();
    return adapter;
  };
  const recordedWrites = () =>
    fs.promises.writeFile.calls.allArgs().map(([filename]) => String(filename));

  beforeEach(() => {
    manager = new Manager();
    spyOn(manager, "reattachAll").and.resolveTo();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ide-installation-boundaries-"));
    storageRoot = path.join(scratch, "language-servers");
    requests = [];
    managed = new ManagedServers(manager, {
      storageRoot,
      fetchUrl: async (url) => {
        requests.push(url);
        throw new Error("An invalid installation descriptor reached the network");
      },
    });
    manager.setManagedServers(managed);
    spyOn(fs.promises, "writeFile").and.callThrough();
  });
  afterEach(async () => {
    await manager.deactivate();
    if (
      path.dirname(scratch) !== path.resolve(os.tmpdir()) ||
      !path.basename(scratch).startsWith("ide-installation-boundaries-")
    )
      throw new Error("Refusing to remove an unexpected installation boundary test path");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("rejects a release asset outside staging before downloading or writing its payload", async () => {
    const adapter = register({
      source: "github-release",
      repository: "example/server",
      assetFor: () => "../escape.tar.gz",
      binary: "server",
      checksum: "none",
    });
    await expectAsync(managed.install(adapter.id, { version: "1.0.0" })).toBeRejectedWithError(
      /asset|archive|filename|file name/i,
    );
    expect(requests).toEqual([]);
    expect(recordedWrites().some((filename) => filename.includes("escape.tar.gz"))).toBeFalse();
    expect(managed.installFor(adapter)).toBeNull();
    expect(manager.reattachAll).not.toHaveBeenCalled();
  });

  it("rejects an npm package outside node_modules before requesting metadata or writing its payload", async () => {
    const adapter = register({
      source: "npm",
      packages: ["../escape"],
      module: "server.js",
    });
    await expectAsync(managed.install(adapter.id, { version: "1.0.0" })).toBeRejectedWithError(
      /npm.*package|package.*name/i,
    );
    expect(requests).toEqual([]);
    expect(
      recordedWrites().some((filename) => /[/\\]escape(?:[/\\]|$)/.test(filename)),
    ).toBeFalse();
    expect(managed.installFor(adapter)).toBeNull();
    expect(manager.reattachAll).not.toHaveBeenCalled();
  });
});
