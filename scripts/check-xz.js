const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const extract = require("../lib/extract-xz");
const tar = require("tar");
const runFile = promisify(execFile);
let stage = "setup";
process.on("uncaughtException", (error) => {
  console.error(`XZ smoke failed during ${stage}: ${error.stack || error.message}`);
  process.exit(1);
});

const createArchive = async (archive, source, entries) => {
  const raw = `${archive}.tar`;
  // Node creates UTF-8 tar headers; Windows bsdtar otherwise changes emoji to
  // underscores before our decoder ever sees the compressed archive.
  stage = `create UTF-8 tar fixture ${path.basename(archive)}`;
  // Tiny fixtures need no parallel pack jobs. Synchronous packing also avoids
  // an intermittent Node tar 7.x write-after-end race during fixture cleanup.
  tar.c({ file: raw, cwd: source, portable: true, sync: true }, entries);
  await compressRaw(archive, raw);
};
const compressRaw = async (archive, raw) => {
  stage = `compress ${path.basename(archive)}`;
  if (process.platform === "linux") {
    const { stdout } = await runFile("xz", ["-c", raw], {
      encoding: "buffer",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    fs.writeFileSync(archive, stdout);
  } else {
    await runFile(
      "tar",
      ["-cJf", archive, "--format=raw", "-C", path.dirname(raw), path.basename(raw)],
      { windowsHide: true, timeout: 30000 },
    );
  }
};

(async () => {
  const base = fs.realpathSync.native(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(base, "ide-client-xz-check-"));
  if (path.dirname(scratch) !== base || !path.basename(scratch).startsWith("ide-client-xz-check-"))
    throw new Error("Refusing an unexpected XZ scratch cleanup.");
  try {
    const source = path.join(scratch, "source");
    fs.mkdirSync(path.join(source, "release", "bin"), { recursive: true });
    fs.writeFileSync(path.join(source, "release", "bin", "server"), "#!/bin/sh\n");
    fs.chmodSync(path.join(source, "release", "bin", "server"), 0o755);
    fs.writeFileSync(path.join(source, "release", "żółć😀.txt"), "unicode");
    const archive = path.join(scratch, "server.tar.xz");
    await createArchive(archive, source, ["release"]);
    const destination = path.join(scratch, "valid");
    stage = "extract valid Unicode archive";
    await extract(archive, destination, 1);
    assert.equal(fs.readFileSync(path.join(destination, "bin", "server"), "utf8"), "#!/bin/sh\n");
    assert.equal(fs.readFileSync(path.join(destination, "żółć😀.txt"), "utf8"), "unicode");
    if (process.platform !== "win32")
      assert.equal(fs.statSync(path.join(destination, "bin", "server")).mode & 0o111, 0o111);
    stage = "reject existing destinations";
    await assert.rejects(extract(archive, destination, 1), /existing/);
    await assert.rejects(extract(archive, path.join(scratch, "negative"), -1), /non-negative/);
    const broken = path.join(scratch, "broken.tar.xz");
    fs.writeFileSync(broken, "not an XZ archive");
    stage = "reject corrupt XZ data";
    await assert.rejects(extract(broken, path.join(scratch, "broken")));
    const linked = path.join(scratch, "linked"),
      outside = path.join(scratch, "outside");
    fs.mkdirSync(linked);
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(linked, "bin"),
      process.platform === "win32" ? "junction" : "dir",
    );
    stage = "reject existing directory link";
    await assert.rejects(extract(archive, linked, 1), /existing/);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.linkSync(path.join(source, "release", "bin", "server"), path.join(source, "hardlink"));
    const hardArchive = path.join(scratch, "hard.tar.xz");
    await createArchive(hardArchive, source, ["release/bin/server", "hardlink"]);
    stage = "reject archive hard link";
    await assert.rejects(extract(hardArchive, path.join(scratch, "hard")), /not a regular file/);
    const traversal = path.join(scratch, "traversal.tar.xz"),
      rawTraversal = `${traversal}.tar`;
    const header = new tar.Header({
      path: "../outside/sentinel",
      mode: 0o644,
      size: 7,
      type: "File",
    });
    header.encode();
    fs.writeFileSync(
      rawTraversal,
      Buffer.concat([
        header.block,
        Buffer.from("payload"),
        Buffer.alloc(512 - 7),
        Buffer.alloc(1024),
      ]),
    );
    await compressRaw(traversal, rawTraversal);
    stage = "reject traversal archive";
    await assert.rejects(extract(traversal, path.join(scratch, "traversal")), /Unsafe XZ path/);
    assert.equal(fs.existsSync(path.join(outside, "sentinel")), false);
    console.log(
      `Real XZ extraction, Unicode, strip, modes, corruption, traversal, hard links and existing links passed on ${process.platform}.`,
    );
  } catch (error) {
    error.xzStage = stage;
    throw error;
  } finally {
    stage = "clean fixture workspace";
    await fs.promises.rm(scratch, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
})().catch((error) => {
  console.error(
    `XZ smoke failed during ${error.xzStage || stage}: ${error.stack || error.message}`,
  );
  process.exitCode = 1;
});
