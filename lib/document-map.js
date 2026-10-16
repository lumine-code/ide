const path = require("node:path");
const C = require("./converters");

// A server may identify file names differently from the host filesystem. Keep
// that policy on its session maps; notebook cells and other URI schemes retain
// their own identities, including case-sensitive fragments.
module.exports = class DocumentMap extends Map {
  constructor(caseSensitiveFileNames, entries = []) {
    super();
    this.caseSensitiveFileNames = caseSensitiveFileNames;
    for (const [key, value] of entries) this.set(key, value);
  }
  key(uri) {
    const key = C.uriKey(uri);
    return this.caseSensitiveFileNames === false &&
      (path.posix.isAbsolute(key) || path.win32.isAbsolute(key))
      ? key.toLowerCase()
      : key;
  }
  get(key) {
    return super.get(this.key(key));
  }
  has(key) {
    return super.has(this.key(key));
  }
  set(key, value) {
    return super.set(this.key(key), value);
  }
  delete(key) {
    return super.delete(this.key(key));
  }
};
