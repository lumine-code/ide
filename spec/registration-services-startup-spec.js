const path = require("node:path");
const { createRequire } = require("node:module");
const { Disposable } = require("lumine");

describe("IDE registration service constructor ownership", () => {
  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("ide")) await lumine.packages.unloadPackage("ide");
  });

  it("shares cold compatibility constructors and replaces them on package reload", async () => {
    const packagePath = lumine.packages.resolvePackagePath("ide");
    if (lumine.packages.isPackageLoaded("ide")) await lumine.packages.unloadPackage("ide");
    const firstRequire = createRequire(path.join(packagePath, "package.json"));
    const FileOperations = firstRequire("./lib/workspace-file-operations");
    const Bridge = firstRequire("./lib/linter-bridge");
    const first = await lumine.packages.activatePackage("ide");
    let main = first.mainModule;
    let beforeStep, afterStep;
    const fileEdge = main.consumeFileOperationsExecutor({
      onWillExecuteStep(callback) {
        beforeStep = callback;
        return new Disposable();
      },
      onDidExecuteStep(callback) {
        afterStep = callback;
        return new Disposable();
      },
    });
    const linterEdge = main.consumeLinterRegistry(() => ({ dispose() {} }));
    expect(typeof beforeStep).toBe("function");
    expect(typeof afterStep).toBe("function");
    expect(main.manager.fileOperations.constructor).toBe(FileOperations);
    expect(main.linterBridge.constructor).toBe(Bridge);
    expect(firstRequire("./lib/registration-services").WorkspaceFileOperations).toBe(
      FileOperations,
    );
    expect(firstRequire("./lib/registration-services").LinterBridge).toBe(Bridge);
    linterEdge.dispose();
    fileEdge.dispose();
    await lumine.packages.unloadPackage("ide");
    const current = await lumine.packages.activatePackage("ide");
    main = current.mainModule;
    const currentRequire = createRequire(path.join(current.path, "package.json"));
    const currentFileEdge = main.consumeFileOperationsExecutor({});
    const currentLinterEdge = main.consumeLinterRegistry(() => ({ dispose() {} }));
    expect(main.manager.fileOperations.constructor).toBe(
      currentRequire("./lib/workspace-file-operations"),
    );
    expect(main.linterBridge.constructor).toBe(currentRequire("./lib/linter-bridge"));
    expect(main.manager.fileOperations.constructor).not.toBe(FileOperations);
    expect(main.linterBridge.constructor).not.toBe(Bridge);
    currentLinterEdge.dispose();
    currentFileEdge.dispose();
  });

  it("shares cold helpers across reload and rejects invalid adapters synchronously", async () => {
    const packagePath = lumine.packages.resolvePackagePath("ide");
    if (lumine.packages.isPackageLoaded("ide")) await lumine.packages.unloadPackage("ide");
    const firstRequire = createRequire(path.join(packagePath, "package.json"));
    const watcherFaults = firstRequire("./lib/file-watchers").fileWatcherFaults;
    const characters = firstRequire("./lib/provider-characters");
    const contract = firstRequire("./lib/adapter-contract");
    const selectionFaults = firstRequire("./lib/adapter-selection").selectionFaults;
    expect(watcherFaults).toBe(contract.fileWatcherFaults);
    expect(selectionFaults).toBe(contract.selectionFaults);
    expect(characters).toBe(firstRequire("./lib/provider-facades").providerCharacters);
    const first = await lumine.packages.activatePackage("ide");
    const ide = first.mainModule.provideIde();
    const adapter = {
      id: "helper-identity",
      displayName: "Helper Identity",
      grammarScopes: ["source.helper-identity"],
      resolveServer: async () => null,
    };
    expect(() => ide.registerAdapter({ ...adapter, selectionPriority: "invalid" })).toThrowError(
      /selectionPriority/,
    );
    expect(() =>
      ide.registerAdapter({ ...adapter, fileWatchers: [{ globPattern: "" }] }),
    ).toThrowError(/fileWatchers/);
    await lumine.packages.unloadPackage("ide");
    const current = await lumine.packages.activatePackage("ide");
    const currentRequire = createRequire(path.join(current.path, "package.json"));
    const currentContract = currentRequire("./lib/adapter-contract");
    expect(currentRequire("./lib/file-watchers").fileWatcherFaults).toBe(
      currentContract.fileWatcherFaults,
    );
    expect(currentRequire("./lib/adapter-selection").selectionFaults).toBe(
      currentContract.selectionFaults,
    );
    expect(currentRequire("./lib/provider-characters")).toBe(
      currentRequire("./lib/provider-facades").providerCharacters,
    );
    expect(currentContract.fileWatcherFaults).not.toBe(watcherFaults);
    expect(currentContract.selectionFaults).not.toBe(selectionFaults);
    expect(currentRequire("./lib/provider-characters")).not.toBe(characters);
  });
});
