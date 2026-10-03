const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const yauzl = require("yauzl");

// Extract only regular files and directories into an installer-owned staging
// tree. Keeping ZIP handling in Node makes NuGet and native-server archives
// independent of the host's tar implementation.
module.exports = async (archivePath, destination, strip = 0) => {
  if (!Number.isInteger(strip) || strip < 0)
    throw new Error("ZIP strip must be a non-negative integer.");
  await fs.promises.mkdir(destination, { recursive: true });
  const root = await fs.promises.realpath(destination);
  const archive = await yauzl.openPromise(archivePath, { lazyEntries: true, autoClose: false });
  const ensureDirectory = async (parts) => {
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const info = await fs.promises.lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error(`Unsafe ZIP directory: ${part}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await fs.promises.mkdir(current);
      }
    }
  };
  try {
    for await (const entry of archive.eachEntry()) {
      const components = entry.fileName.split("/").filter(Boolean);
      if (components.some((part) => part === ".." || part === "." || part.includes(":")))
        throw new Error(`Unsafe ZIP path: ${entry.fileName}`);
      const parts = components.slice(strip);
      if (!parts.length) continue;
      const target = path.resolve(root, ...parts);
      const relative = path.relative(root, target);
      if (
        !relative ||
        relative.startsWith(`..${path.sep}`) ||
        relative === ".." ||
        path.isAbsolute(relative)
      )
        throw new Error(`ZIP entry escapes its destination: ${entry.fileName}`);
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const kind = mode & 0o170000;
      if (kind && kind !== 0o100000 && kind !== 0o040000)
        throw new Error(`ZIP entry is not a regular file or directory: ${entry.fileName}`);
      if (entry.fileName.endsWith("/") || kind === 0o040000) {
        await ensureDirectory(parts);
        continue;
      }
      await ensureDirectory(parts.slice(0, -1));
      const input = await archive.openReadStreamPromise(entry);
      // Exclusive creation refuses duplicate names, pre-existing files and
      // links rather than following an archive-controlled filesystem edge.
      const output = fs.createWriteStream(target, { flags: "wx", mode: mode & 0o777 || 0o644 });
      await pipeline(input, output);
    }
  } finally {
    archive.close();
  }
};
