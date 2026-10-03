// Activity survives a busy-signal service being absent or replaced. A provider
// belongs to one operation: the service identifies messages by their title,
// while language servers identify work by a session and a progress token.
class ServerActivity {
  constructor(onError = () => {}) {
    this.operations = new Map();
    this.busySignal = null;
    this.onError = onError;
    this.disposed = false;
  }

  setBusySignal(busySignal) {
    if (this.disposed || this.busySignal === busySignal) return;
    for (const entries of this.operations.values()) {
      for (const entry of entries.values()) this.detach(entry);
    }
    this.busySignal = busySignal;
    for (const entries of this.operations.values()) {
      for (const entry of entries.values()) this.render(entry);
    }
  }

  begin(session, token, options = {}) {
    if (this.disposed) return { update() {}, dispose() {} };
    this.end(session, token);
    const entries = this.operations.get(session) || new Map();
    const entry = {
      session,
      token,
      title: "Working",
      message: "",
      percentage: undefined,
      cancellable: false,
      cancel: null,
      options: {},
      provider: null,
      current: null,
      ready: !(options.delay > 0),
      timer: null,
    };
    entries.set(token, entry);
    this.operations.set(session, entries);
    this.updateEntry(entry, options);
    if (!entry.ready) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!this.isCurrent(entry)) return;
        entry.ready = true;
        this.render(entry);
      }, options.delay);
    }
    return {
      update: (changes) => this.updateEntry(entry, changes),
      dispose: () => this.end(session, token, entry),
    };
  }

  isCurrent(entry) {
    return this.operations.get(entry.session)?.get(entry.token) === entry;
  }

  has(session, token) {
    return this.operations.get(session)?.has(token) || false;
  }

  update(session, token, changes) {
    const entry = this.operations.get(session)?.get(token);
    if (entry) this.updateEntry(entry, changes);
  }

  updateEntry(entry, changes = {}) {
    if (!this.isCurrent(entry)) return;
    if (typeof changes.title === "string") entry.title = changes.title.trim() || "Working";
    if (typeof changes.message === "string") entry.message = changes.message;
    if (typeof changes.percentage === "number" && Number.isFinite(changes.percentage)) {
      entry.percentage = Math.round(Math.min(100, Math.max(0, changes.percentage)));
    }
    if (typeof changes.cancellable === "boolean") entry.cancellable = changes.cancellable;
    if (Object.hasOwn(changes, "cancel")) {
      entry.cancel = typeof changes.cancel === "function" ? changes.cancel : null;
    }
    this.render(entry);
  }

  titleFor(entry, showCancellation = true) {
    const prefix = entry.session?.adapter?.displayName;
    let title = prefix ? `${prefix}: ${entry.title}` : entry.title;
    if (entry.message) title += ` (${entry.message})`;
    if (entry.percentage !== undefined) title += ` — ${entry.percentage}%`;
    if (showCancellation && entry.cancellable && entry.cancel) title += " · Click to cancel";
    return title;
  }

  render(entry) {
    if (!entry.ready || !this.busySignal || !this.isCurrent(entry)) return;
    entry.options.onDidClick =
      entry.cancellable && entry.cancel
        ? () => {
            if (!this.isCurrent(entry) || !entry.cancellable || !entry.cancel) return;
            entry.cancellable = false;
            this.render(entry);
            try {
              Promise.resolve(entry.cancel()).catch((error) => this.onError(entry.session, error));
            } catch (error) {
              this.onError(entry.session, error);
            }
          }
        : null;
    const title = this.titleFor(entry);
    if (!entry.provider) {
      entry.provider = this.busySignal.create();
      entry.provider.add(title, entry.options);
    } else {
      // Renaming to the same title also refreshes clickability, and preserves
      // the service's original start time rather than adding a replacement.
      entry.provider.changeTitle(title, entry.current);
    }
    entry.current = title;
  }

  detach(entry) {
    if (entry.provider) {
      const title = this.titleFor(entry, false);
      if (title !== entry.current) entry.provider.changeTitle(title, entry.current);
    }
    entry.provider?.dispose();
    entry.provider = null;
    entry.current = null;
  }

  end(session, token, expected) {
    const entries = this.operations.get(session);
    const entry = entries?.get(token);
    if (!entry || (expected && expected !== entry)) return;
    entry.cancellable = false;
    this.render(entry);
    entries.delete(token);
    if (!entries.size) this.operations.delete(session);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    this.detach(entry);
  }

  clear(session) {
    for (const token of this.operations.get(session)?.keys() || []) this.end(session, token);
  }

  dispose() {
    for (const session of this.operations.keys()) this.clear(session);
    this.busySignal = null;
    this.disposed = true;
  }
}

module.exports = ServerActivity;
