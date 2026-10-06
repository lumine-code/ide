const { Emitter, CompositeDisposable } = require("lumine");

// Providers that render cached server data share one invalidation lifetime.
// The epoch also prevents an outstanding request from restoring a result
// invalidated by a server refresh, feature change or package disposal.
module.exports = class RefreshingProvider {
  constructor(manager, capabilities, refreshKind) {
    this.manager = manager;
    manager.addCapabilityFragment(capabilities);
    this.name = "Language Server";
    this.packageName = "ide";
    this.priority = 2;
    this.epoch = 0;
    this.disposed = false;
    this.emitter = new Emitter();
    const invalidate = () => {
      this.epoch++;
      this.emitter.emit("invalidate", {});
    };
    this.subscriptions = new CompositeDisposable(
      manager.onDidRequestRefresh(({ kind }) => {
        if (kind === refreshKind) invalidate();
      }),
      manager.onDidChangeSession(({ state }) => {
        if (state !== "starting") invalidate();
      }),
      manager.onDidChangeFeatures(invalidate),
      manager.onDidChangeCapabilities(invalidate),
    );
  }

  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }

  onDidInvalidate(callback) {
    return this.emitter.on("invalidate", callback);
  }

  dispose() {
    this.disposed = true;
    this.epoch++;
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
};
