const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { XzReadableStream } = require("xz-decompress");
const tar = require("tar");

// The small MIT-licensed WebAssembly codec avoids native Windows tar's silent
// replacement of astral characters in entry names. Inspect before extracting.
module.exports = async (archivePath, destination, strip = 0) => {
  if (!Number.isInteger(strip) || strip < 0)
    throw new Error("XZ strip must be a non-negative integer.");
  await fs.promises.mkdir(destination, { recursive: true });
  const root = await fs.promises.realpath(destination);
  const temporary = await fs.promises.mkdtemp(path.join(root, ".xz-"));
  if (path.dirname(temporary) !== root || !path.basename(temporary).startsWith(".xz-"))
    throw new Error("Refusing unexpected XZ temporary cleanup.");
  const decoded = path.join(temporary, "payload.tar");
  try {
    await pipeline(
      Readable.fromWeb(new XzReadableStream(Readable.toWeb(fs.createReadStream(archivePath)))),
      fs.createWriteStream(decoded, { flags: "wx", mode: 0o600 }),
    );
    const entries = [];
    await tar.t({
      file: decoded,
      strict: true,
      onReadEntry: (entry) =>
        entries.push({ name: entry.path, type: entry.type, mode: entry.mode }),
    });
    const destinations = new Set();
    for (const { name, type, mode } of entries) {
      if (!["File", "OldFile", "Directory"].includes(type) || mode & 0o7000)
        throw new Error(
          `XZ entry is not a regular file or directory with ordinary permissions: ${name}`,
        );
      if (
        name.startsWith("/") ||
        name.includes("\\") ||
        name.includes(":") ||
        [...name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error(`Unsafe XZ path: ${name}`);
      const components = name
        .replace(/^(?:\.\/)+/, "")
        .split("/")
        .filter(Boolean);
      if (components.some((part) => part === "." || part === ".."))
        throw new Error(`Unsafe XZ path: ${name}`);
      const parts = components.slice(strip);
      if (!parts.length) continue;
      const target = path.resolve(root, ...parts),
        relative = path.relative(root, target);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(`XZ entry escapes its destination: ${name}`);
      const directory = type === "Directory";
      const key =
        process.platform === "win32" || process.platform === "darwin"
          ? target.normalize("NFD").toLowerCase()
          : target;
      if (!directory && destinations.has(key)) throw new Error(`Duplicate XZ file: ${name}`);
      destinations.add(key);
      let current = root;
      for (let part = 0; part < parts.length; part++) {
        current = path.join(current, parts[part]);
        try {
          const info = await fs.promises.lstat(current);
          if (
            info.isSymbolicLink() ||
            !info.isDirectory() ||
            (part === parts.length - 1 && !directory)
          )
            throw new Error(`Unsafe existing XZ destination: ${name}`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    await tar.x({
      file: decoded,
      cwd: root,
      strip,
      strict: true,
      preservePaths: false,
      noChown: true,
      keep: true,
    });
  } finally {
    await fs.promises.rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
};
