let picomatch;

function matchesLspGlob(
  filePath,
  pattern,
  { nocase = process.platform === "win32", matchSuffix = true } = {},
) {
  if (!filePath || typeof pattern !== "string" || !pattern) return false;

  // LSP patterns support stars, braces and character classes. Parentheses
  // and pipes are literal, so server patterns cannot create regex groups.
  const glob = pattern.replace(/\\.|[()|]/g, (token) =>
    token.length === 1 ? `\\${token}` : token,
  );
  const normalized = filePath.replaceAll("\\", "/");
  const options = { dot: true, nocase, noext: true, nonegate: true, posix: true, regex: false };
  picomatch ||= require("picomatch");
  return (
    picomatch.isMatch(normalized, glob, options) ||
    (matchSuffix && picomatch.isMatch(normalized, `**/${glob}`, options))
  );
}

module.exports = { matchesLspGlob };
