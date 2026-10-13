const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { ZipFile } = require("yazl");

describe("ZIP decoder native import boundary", () => {
  let root, runtime, extract;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("ide");
    runtime = require("../lib/zip-runtime");
    extract = require("../lib/extract-zip");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-zip-import-"));
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide");
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("shares the native decoder import and its CommonJS identity", async () => {
    const first = runtime.load();
    expect(runtime.load()).toBe(first);
    expect(await first).toBe(require("yauzl"));
  });
  it("rejects cancellation during import before opening archives or staging files", async () => {
    const actual = await runtime.load();
    let finishImport;
    spyOn(runtime, "load").and.returnValue(
      new Promise((resolve) => {
        finishImport = resolve;
      }),
    );
    const opening = spyOn(actual, "openPromise");
    const creating = spyOn(fs.promises, "mkdir");
    const owner = new AbortController();
    const request = extract("unused.zip", path.join(root, "destination"), 0, {
      signal: owner.signal,
    });
    owner.abort();
    finishImport(actual);
    await expectAsync(request).toBeRejectedWith(owner.signal.reason);
    expect(opening).not.toHaveBeenCalled();
    expect(creating).not.toHaveBeenCalled();
  });
  it("can retry a decoder failure and extract actual ZIP bytes without leftover staging", async () => {
    const archive = path.join(root, "source.zip");
    const writer = new ZipFile();
    writer.addBuffer(Buffer.from("verified bytes"), "release/folder/tool.txt");
    writer.end();
    await pipeline(writer.outputStream, fs.createWriteStream(archive));
    const actualLoad = runtime.load.bind(runtime);
    let first = true;
    spyOn(runtime, "load").and.callFake(() => {
      if (first) {
        first = false;
        return Promise.reject(new Error("Cannot import ZIP decoder"));
      }
      return actualLoad();
    });
    const destination = path.join(root, "destination");
    await expectAsync(extract(archive, destination, 1)).toBeRejectedWithError(
      "Cannot import ZIP decoder",
    );
    expect(fs.existsSync(destination)).toBe(false);
    await extract(archive, destination, 1);
    expect(fs.readFileSync(path.join(destination, "folder", "tool.txt"), "utf8")).toBe(
      "verified bytes",
    );
  });
});
