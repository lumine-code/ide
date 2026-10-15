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
});
