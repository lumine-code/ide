let picomatch;

function matchesGlob(filePath, pattern, options, matchSuffix) {
  if (!filePath || typeof pattern !== "string" || !pattern) return false;
  const normalized = filePath.replaceAll("\\", "/");
  picomatch ||= require("picomatch");
  return (
    picomatch.isMatch(normalized, pattern, options) ||
    (matchSuffix && picomatch.isMatch(normalized, `**/${pattern}`, options))
  );
}

function matchesLspGlob(
  filePath,
  pattern,
  { nocase = process.platform === "win32", matchSuffix = true } = {},
) {
  if (typeof pattern !== "string") return false;

  // LSP patterns support stars, braces and character classes. Parentheses
  // and pipes are literal, so server patterns cannot create regex groups.
  const glob = pattern.replace(/\\.|[()|]/g, (token) =>
    token.length === 1 ? `\\${token}` : token,
  );
  const options = { dot: true, nocase, noext: true, nonegate: true, posix: true, regex: false };
  return matchesGlob(filePath, glob, options, matchSuffix);
}

function matchesAdapterGlob(filePath, pattern, { matchSuffix = true } = {}) {
  const options = { dot: true, nocase: process.platform === "win32" };
  return matchesGlob(filePath, pattern, options, matchSuffix);
}

module.exports = { matchesLspGlob, matchesAdapterGlob };
