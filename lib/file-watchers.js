const validGlob = (glob) => {
  if (typeof glob === "string") return glob.length > 0;
  if (!glob || typeof glob !== "object" || typeof glob.pattern !== "string" || !glob.pattern)
    return false;
  const base = typeof glob.baseUri === "string" ? glob.baseUri : glob.baseUri?.uri;
  try {
    return typeof base === "string" && new URL(base).protocol === "file:";
  } catch {
    return false;
  }
};
exports.fileWatcherFaults = (adapter) => {
  if (adapter?.fileWatchers === undefined) return [];
  if (
    !Array.isArray(adapter.fileWatchers) ||
    adapter.fileWatchers.some(
      (watcher) =>
        !watcher ||
        !validGlob(watcher.globPattern) ||
        (watcher.kind !== undefined &&
          (!Number.isInteger(watcher.kind) || watcher.kind < 1 || watcher.kind > 7)),
    )
  )
    return ["fileWatchers"];
  return [];
};
