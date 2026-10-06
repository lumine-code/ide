const fs = require("node:fs");
const path = require("node:path");

const KINDS = new Set(["executable", "node", "file", "directory"]);
const script = (filename) => /\.(?:cjs|mjs|js)$/i.test(filename);

const validString = (value) => typeof value === "string" && !!value.trim() && !value.includes("\0");
function validateServerLaunch(launch) {
  if (
    !launch ||
    typeof launch !== "object" ||
    Array.isArray(launch) ||
    !validString(launch.command)
  )
    throw new TypeError("A server launch must name its command.");
  if (
    launch.args !== undefined &&
    (!Array.isArray(launch.args) ||
      launch.args.some((value) => typeof value !== "string" || value.includes("\0")))
  )
    throw new TypeError("Server arguments must be strings without null bytes.");
  if (launch.cwd !== undefined && !validString(launch.cwd))
    throw new TypeError("Server cwd must name a directory.");
  if (
    launch.env !== undefined &&
    (!launch.env ||
      typeof launch.env !== "object" ||
      Array.isArray(launch.env) ||
      Object.entries(launch.env).some(
        ([name, value]) =>
          !name ||
          name.includes("\0") ||
          name.includes("=") ||
          (value !== undefined && (typeof value !== "string" || value.includes("\0"))),
      ))
  )
    throw new TypeError("Server environment must contain named string values or undefined.");
  if (launch.transport !== undefined && !["stdio", "ipc", "socket"].includes(launch.transport))
    throw new TypeError("Unknown language server transport.");
  if (
    launch.transport === "socket" &&
    (!Number.isInteger(launch.port) || launch.port < 1 || launch.port > 65535)
  )
    throw new TypeError("A socket server launch must name a valid port.");
  if (launch.host !== undefined && !validString(launch.host))
    throw new TypeError("Server host must be a nonempty name.");
  if (
    launch.fileCancellationFolder !== undefined &&
    (!validString(launch.fileCancellationFolder) || !path.isAbsolute(launch.fileCancellationFolder))
  )
    throw new TypeError("File cancellation must use an absolute directory.");
  return launch;
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  const pending = Promise.resolve(promise);
  if (signal.aborted) {
    pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function environmentPath(env, platform) {
  if (platform !== "win32") return env.PATH || "";
  const key = Object.keys(env).findLast((name) => name.toLowerCase() === "path");
  return key ? env[key] || "" : "";
}

// Windows treats environment names as case-insensitive, including when Node
// receives a plain object rather than its special process.env object.
function mergeEnvironment(inherited, overrides, platform = process.platform) {
  const merged = {};
  const names = new Map();
  for (const values of [inherited, overrides])
    for (const [name, value] of Object.entries(values || {})) {
      const key = platform === "win32" ? name.toLowerCase() : name;
      const previous = names.get(key);
      if (previous) delete merged[previous];
      names.delete(key);
      if (value !== undefined) {
        merged[name] = value;
        names.set(key, name);
      }
    }
  return merged;
}

function createServerResolver({
  platform = process.platform,
  executable = process.execPath,
  environment = process.env,
  cwd = process.cwd(),
  fileSystem = fs,
  assertActive = () => {},
  signal: lifetimeSignal,
} = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const check = (signal) => {
    assertActive();
    lifetimeSignal?.throwIfAborted();
    signal?.throwIfAborted();
  };
  const combinedSignal = (signal) =>
    lifetimeSignal && signal && lifetimeSignal !== signal
      ? AbortSignal.any([lifetimeSignal, signal])
      : lifetimeSignal || signal;
  const callbackResult = (callback, signal) => {
    let result;
    try {
      result = callback();
    } catch (error) {
      check(signal);
      throw error;
    }
    return abortable(result, signal);
  };
  const fileKind = (filename, kind) =>
    kind === "auto" ? (script(filename) ? "node" : "executable") : kind;

  async function validateFile(
    filename,
    { kind = "executable", label = "Server path", allowShellWrapper = false, signal } = {},
  ) {
    signal = combinedSignal(signal);
    check(signal);
    kind = fileKind(filename, kind);
    if (!KINDS.has(kind)) throw new TypeError(`Unknown server candidate kind '${kind}'`);
    if (typeof filename !== "string" || !filename || !paths.isAbsolute(filename))
      throw new TypeError(`${label} must be an absolute path.`);
    const normalized = paths.normalize(filename);
    let stat;
    try {
      stat = await abortable(fileSystem.promises.stat(normalized), signal);
    } catch (error) {
      check(signal);
      const failed = new Error(`${label}: ${error.message}`, { cause: error });
      if (error.code) failed.code = error.code;
      throw failed;
    }
    check(signal);
    if (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
      throw new TypeError(`${label} must name ${kind === "directory" ? "a directory" : "a file"}.`);
    if (
      kind === "executable" &&
      platform === "win32" &&
      !allowShellWrapper &&
      /\.(?:cmd|bat)$/i.test(normalized)
    )
      throw new TypeError(`${label} must name a native executable, not a shell wrapper.`);
    try {
      await abortable(
        fileSystem.promises.access(
          normalized,
          kind === "executable" ? fileSystem.constants.X_OK : fileSystem.constants.R_OK,
        ),
        signal,
      );
    } catch (error) {
      check(signal);
      const failed = new Error(`${label}: ${error.message}`, { cause: error });
      if (error.code) failed.code = error.code;
      throw failed;
    }
    check(signal);
    return normalized;
  }

  function findExecutables(name, options = {}) {
    check(options.signal);
    if (typeof name !== "string" || !name || /[/\\]/.test(name))
      throw new TypeError("A PATH command must be a nonempty basename.");
    const target = options.platform || platform;
    const targetPaths = target === "win32" ? path.win32 : path.posix;
    const env = options.env || environment;
    const base = options.cwd || cwd;
    const suffixes =
      target === "win32"
        ? /\.(?:exe|com|cmd|bat)$/i.test(name)
          ? [""]
          : [".exe", "", ...(options.allowShellWrapper ? [".cmd", ".bat"] : [])]
        : [""];
    const found = new Map();
    for (let directory of environmentPath(env, target).split(target === "win32" ? ";" : ":")) {
      if (directory.startsWith('"') && directory.endsWith('"')) directory = directory.slice(1, -1);
      if (!directory) continue;
      for (const suffix of suffixes) {
        const candidate = targetPaths.resolve(base, directory, name + suffix);
        if (target === "win32" && !options.allowShellWrapper && /\.(?:cmd|bat)$/i.test(candidate))
          continue;
        try {
          if (!fileSystem.statSync(candidate).isFile()) continue;
          fileSystem.accessSync(candidate, fileSystem.constants.X_OK);
          const key = target === "win32" ? candidate.toLowerCase() : candidate;
          if (!found.has(key)) found.set(key, candidate);
        } catch {
          // Discovery skips missing, inaccessible and non-file entries.
        }
      }
    }
    check(options.signal);
    return [...found.values()];
  }

  async function select(options = {}) {
    const {
      configuredPath,
      managedPath,
      managedVersion,
      bundledPath,
      kind = "executable",
      validate,
      signal: requestedSignal,
    } = options;
    const signal = combinedSignal(requestedSignal);
    check(signal);
    for (const [name, value] of Object.entries({ configuredPath, managedPath }))
      if (value != null && typeof value !== "string")
        throw new TypeError(`${name} must be a path string.`);
    const accept = async (filename, source, selectedKind) => {
      check(signal);
      selectedKind = fileKind(filename, selectedKind);
      const selectedPath = await validateFile(filename, {
        kind: selectedKind,
        label: options.label || `${source} server path`,
        allowShellWrapper: options.allowShellWrapper,
        signal,
      });
      const data = validate
        ? await callbackResult(() => validate(selectedPath, { source, signal }), signal)
        : undefined;
      check(signal);
      return {
        path: selectedPath,
        kind: selectedKind,
        source,
        ...(source === "managed" && typeof managedVersion === "string"
          ? { version: managedVersion }
          : {}),
        ...(data === undefined ? {} : { data }),
      };
    };
    if (configuredPath) return accept(configuredPath, "configured", options.configuredKind || kind);
    if (managedPath) return accept(managedPath, "managed", kind);
    if (bundledPath) {
      const filename =
        typeof bundledPath === "function" ? await callbackResult(bundledPath, signal) : bundledPath;
      check(signal);
      if (filename) return accept(filename, "bundled", kind);
    }
    const extra =
      typeof options.candidates === "function"
        ? await callbackResult(options.candidates, signal)
        : options.candidates || [];
    check(signal);
    if (!Array.isArray(extra))
      throw new TypeError("Discovered server candidates must be an array.");
    const names = options.names || [];
    if (!Array.isArray(names)) throw new TypeError("PATH command names must be an array.");
    const candidates = [...extra, ...names.flatMap((name) => findExecutables(name, options))];
    const visited = new Set();
    for (const filename of candidates) {
      check(signal);
      if (visited.has(filename)) continue;
      visited.add(filename);
      try {
        return await accept(filename, "discovered", kind);
      } catch (error) {
        check(signal);
        if (error?.name === "AbortError") throw error;
      }
    }
    return null;
  }

  function launchOptions(options) {
    const { args = [], cwd: directory, env, signal, ...metadata } = options;
    check(signal);
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string"))
      throw new TypeError("Server arguments must be an array of strings.");
    if (
      env !== undefined &&
      (!env ||
        typeof env !== "object" ||
        Array.isArray(env) ||
        Object.values(env).some((value) => value !== undefined && typeof value !== "string"))
    )
      throw new TypeError("Server environment values must be strings or undefined.");
    return {
      args: [...args],
      ...(env === undefined ? {} : { env: { ...env } }),
      ...(directory === undefined ? {} : { cwd: paths.resolve(cwd, directory) }),
      ...metadata,
    };
  }
  async function nodeEntry(filename, args = [], options = {}) {
    const entry = await validateFile(filename, { kind: "node", signal: options.signal });
    const result = launchOptions({ ...options, args });
    result.env = mergeEnvironment(result.env, { ELECTRON_RUN_AS_NODE: "1" }, platform);
    return validateServerLaunch({
      ...result,
      command: result.transport === "ipc" ? entry : executable,
      args: result.transport === "ipc" ? result.args : [entry, ...result.args],
    });
  }
  async function launch(selection, options = {}) {
    check(options.signal);
    if (!selection) return null;
    if (selection.kind === "node")
      return nodeEntry(selection.path, options.args, {
        ...(selection.version === undefined ? {} : { version: selection.version }),
        ...options,
      });
    if (selection.kind !== "executable")
      throw new TypeError(`A ${selection.kind} candidate needs an adapter-owned launcher.`);
    if (options.transport === "ipc")
      throw new TypeError("IPC transport requires a Node entry, not a native executable.");
    return validateServerLaunch({
      ...(selection.version === undefined ? {} : { version: selection.version }),
      ...launchOptions(options),
      command: selection.path,
    });
  }
  return Object.freeze({ select, findExecutables, validateFile, launch, nodeEntry });
}

module.exports = { createServerResolver, mergeEnvironment, validateServerLaunch };
