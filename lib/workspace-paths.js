const path = require("node:path");

function pathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function relativePath(parentPath, candidatePath) {
  if (pathKey(parentPath) === pathKey(candidatePath)) return "";
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

module.exports = { pathKey, relativePath };
