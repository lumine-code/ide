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
    key = this.key(key);
    if (this.identityObservers?.size && super.get(key) !== value) this.recordIdentityChange(key);
    return super.set(key, value);
  }
  delete(key) {
    key = this.key(key);
    const deleted = super.delete(key);
    if (deleted && this.identityObservers?.size) this.recordIdentityChange(key);
    return deleted;
  }
  clear() {
    if (this.identityObservers?.size) for (const key of this.keys()) this.recordIdentityChange(key);
    super.clear();
  }
  // A request may return edits for URIs it could not name when it was sent.
  // Record document ownership transitions for that request, with the same
  // URI identity as the live map, without snapshotting unrelated documents.
  observeIdentityChanges() {
    const changed = new Set();
    const observers = (this.identityObservers ||= new Set());
    observers.add(changed);
    return {
      hasChanged: (uri) => changed.has(this.key(uri)),
      dispose: () => observers.delete(changed),
    };
  }
  recordIdentityChange(key) {
    for (const changed of this.identityObservers) changed.add(key);
  }
};
