const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { ZipFile } = require("yazl");
const extract = require("../lib/extract-zip");

(async () => {
  const base = fs.realpathSync.native(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(base, "ide-zip-check-"));
  try {
    const archive = path.join(scratch, "server.nupkg.zip");
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from("server"), "release/tools/server.dll");
    zip.addBuffer(Buffer.from("headers"), "release/tools/żółć😀.json");
    zip.addBuffer(Buffer.from("#!/bin/sh\n"), "release/bin/server", { mode: 0o100755 });
    zip.end();
    await pipeline(zip.outputStream, fs.createWriteStream(archive));
    const destination = path.join(scratch, "payload");
    await extract(archive, destination, 1);
    assert.equal(fs.readFileSync(path.join(destination, "tools", "server.dll"), "utf8"), "server");
    assert.equal(
      fs.readFileSync(path.join(destination, "tools", "żółć😀.json"), "utf8"),
      "headers",
    );
    if (process.platform !== "win32")
      assert.equal(fs.statSync(path.join(destination, "bin", "server")).mode & 0o111, 0o111);
    const badArchive = path.join(scratch, "invalid.zip");
    fs.writeFileSync(badArchive, "invalid archive");
    await assert.rejects(extract(badArchive, path.join(scratch, "invalid")));
    console.log(
      `ZIP extraction, Unicode paths, component stripping and file permissions passed on ${process.platform}.`,
    );
  } finally {
    if (path.dirname(scratch) === base && path.basename(scratch).startsWith("ide-zip-check-"))
      await fs.promises.rm(scratch, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
