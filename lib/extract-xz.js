const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { XzReadableStream } = require("xz-decompress");
const tar = require("tar");

// The small MIT-licensed WebAssembly codec avoids native Windows tar's silent
// replacement of astral characters in entry names. Inspect before extracting.
module.exports = async (archivePath, destination, strip = 0, { signal } = {}) => {
  signal?.throwIfAborted();
  if (!Number.isInteger(strip) || strip < 0)
    throw new Error("XZ strip must be a non-negative integer.");
  await fs.promises.mkdir(destination, { recursive: true });
  signal?.throwIfAborted();
  const root = await fs.promises.realpath(destination);
  signal?.throwIfAborted();
  const temporary = await fs.promises.mkdtemp(path.join(root, ".xz-"));
  if (path.dirname(temporary) !== root || !path.basename(temporary).startsWith(".xz-"))
    throw new Error("Refusing unexpected XZ temporary cleanup.");
  const decoded = path.join(temporary, "payload.tar");
  let input, reader;
  try {
    signal?.throwIfAborted();
    input = fs.createReadStream(archivePath);
    reader = new XzReadableStream(Readable.toWeb(input)).getReader();
    // The codec may inherit Chromium's ReadableStream inside a package VM.
    // Pump its public reader API instead of Node's realm-specific fromWeb.
    const chunks = async function* () {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) return;
        yield Buffer.from(value);
      }
    };
    const output = fs.createWriteStream(decoded, { flags: "wx", mode: 0o600 });
    const outputClosed = new Promise((resolve) => output.once("close", resolve));
    try {
      await pipeline(Readable.from(chunks()), output, { signal });
    } finally {
      output.destroy();
      await outputClosed;
    }
    signal?.throwIfAborted();
    const entries = [];
    await tar.t({
      file: decoded,
      strict: true,
      onReadEntry: (entry) =>
        entries.push({ name: entry.path, type: entry.type, mode: entry.mode }),
    });
    signal?.throwIfAborted();
    const destinations = new Set();
    for (const { name, type, mode } of entries) {
      signal?.throwIfAborted();
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
          signal?.throwIfAborted();
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
      filter: () => !signal?.aborted,
    });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // Keep the original transfer/decoder error when an errored stream also
      // rejects cancellation.
    } finally {
      reader?.releaseLock();
      const closed =
        !input || input.closed
          ? Promise.resolve()
          : new Promise((resolve) => input.once("close", resolve));
      input?.destroy();
      await closed;
    }
    await fs.promises.rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
};
