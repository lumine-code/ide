const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

describe("Managed npm companion version ranges through the IDE service", () => {
  let root, server, managed, service, registration, consumer;
  let routes, requested;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    const pack = await lumine.packages.activatePackage("ide");
    const main = pack.mainModule;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ide-npm-ranges-")));
    routes = new Map();
    requested = [];
    server = http.createServer((request, response) => {
      requested.push(request.url);
      const body = routes.get(request.url);
      response.writeHead(body === undefined ? 404 : 200, {
        "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json",
      });
      response.end(body === undefined ? "{}" : body);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const local = `http://127.0.0.1:${server.address().port}`;
    const ManagedServers = require(path.join(pack.path, "lib", "managed-servers"));
    managed = new ManagedServers(main.manager, {
      storageRoot: path.join(root, "store"),
      fetchUrl(url, init) {
        const remote = new URL(url);
        if (!["registry.npmjs.org", "owned-payload.invalid"].includes(remote.hostname))
          throw new Error("The registry fixture cannot reach an external endpoint.");
        return fetch(local + remote.pathname + remote.search, init);
      },
    });
    main.managedServers = managed;
    main.manager.setManagedServers(managed);
    consumer = lumine.packages.serviceHub.consume("ide", "^1.0.0", (value) => {
      service = value;
      return new (require("lumine").Disposable)();
    });
    expect(service).toBeDefined();

    const metadata = async (name, version) => {
      const payloadRoot = path.join(root, `${name}-${version}`);
      fs.mkdirSync(path.join(payloadRoot, "package"), { recursive: true });
      fs.writeFileSync(
        path.join(payloadRoot, "package", "package.json"),
        JSON.stringify({ name, version }),
      );
      fs.writeFileSync(path.join(payloadRoot, "package", "server.js"), "module.exports = {};\n");
      const archive = path.join(root, `${name}-${version}.tgz`);
      await require("tar").c({ file: archive, cwd: payloadRoot, gzip: true }, ["package"]);
      const payload = fs.readFileSync(archive);
      const pathname = `/payload/${name}-${version}.tgz`;
      routes.set(pathname, payload);
      return {
        name,
        version,
        dist: {
          tarball: `https://owned-payload.invalid${pathname}`,
          integrity: `sha512-${crypto.createHash("sha512").update(payload).digest("base64")}`,
        },
      };
    };
    const leading = await metadata("owned-server", "1.0.0");
    routes.set("/owned-server/latest", JSON.stringify(leading));
    routes.set("/owned-server/1.0.0", JSON.stringify(leading));
    const versions = {};
    for (const version of ["6.0.3", "6.1.0", "7.0.0"])
      versions[version] = await metadata("owned-companion", version);
    routes.set("/owned-companion", JSON.stringify({ "dist-tags": { latest: "7.0.0" }, versions }));
    routes.set("/owned-companion/6.0.3", JSON.stringify(versions["6.0.3"]));
    routes.set("/owned-companion/latest", JSON.stringify(versions["7.0.0"]));
    registration = service.registerAdapter({
      id: "owned-npm-range-fixture",
      displayName: "Owned npm range fixture",
      grammarScopes: ["source.owned-npm-range-fixture"],
      resolveServer: async () => null,
      managedServer: {
        source: "npm",
        packages: ["owned-server", { name: "owned-companion", version: "^6.0.3" }],
        module: "node_modules/owned-server/server.js",
      },
    });
  });

  afterEach(async () => {
    registration?.dispose();
    consumer?.dispose();
    await lumine.packages.deactivatePackage("ide");
    if (server) {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    if (!root) return;
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(root));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error(
        "The registry fixture cleanup must stay inside its owned temporary directory.",
      );
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("installs the newest compatible companion instead of requesting the range as a version", async () => {
    const installed = await service.installServer("owned-npm-range-fixture");
    expect(installed.version).toBe("1.0.0");
    const companion = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          "store",
          "owned-npm-range-fixture",
          "node_modules",
          "owned-companion",
          "package.json",
        ),
        "utf8",
      ),
    );
    expect(companion.version).toBe("6.1.0");
    expect(requested).toContain("/owned-companion");
    expect(requested).not.toContain("/owned-companion/%5E6.0.3");
    expect(requested).not.toContain("/payload/owned-companion-7.0.0.tgz");
  });

  it("retains exact-version and dist-tag lookup behavior", async () => {
    expect((await managed.npmMetadata("owned-companion", "6.0.3")).version).toBe("6.0.3");
    expect((await managed.npmMetadata("owned-companion", "latest")).version).toBe("7.0.0");
    expect(requested).toEqual(["/owned-companion/6.0.3", "/owned-companion/latest"]);
  });

  it("refuses a range for which no compatible package exists", async () => {
    await expectAsync(managed.npmMetadata("owned-companion", "^8.0.0")).toBeRejected();
    expect(requested.some((url) => url.startsWith("/payload/"))).toBeFalse();
  });
});
