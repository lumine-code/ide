const { CompositeDisposable, Disposable } = require("lumine");

class Relay {
  constructor() {
    this.listeners = new Set();
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return new Disposable(() => this.listeners.delete(callback));
  }

  emit(value) {
    for (const callback of [...this.listeners]) callback(value);
  }

  clear() {
    this.listeners.clear();
  }
}

// Stable service objects published synchronously during package activation.
// Their shape is sufficient for consumer-side validation and registration;
// provider modules are reached only when a consumer performs real work.
module.exports = class ProviderFacades {
  constructor(main) {
    this.main = main;
    this.generation = main.activationGeneration;
    this.connections = null;
    this.relays = {
      symbols: new Relay(),
      workspaceSymbols: new Relay(),
      codeLens: new Relay(),
      inlayHints: new Relay(),
      semanticTokens: new Relay(),
    };

    const provider = (name) => this.provider(name);
    const grammarScopes = () => this.activeMain().manager?.allGrammarScopes() ?? [];

    this.autocomplete = {
      scopeSelector: ".source, .text",
      inclusionPriority: 2,
      suggestionPriority: 2,
      excludeLowerPriority: false,
      filterSuggestions: true,
      get triggerCharacters() {
        return provider("completionProvider").triggerCharacters;
      },
      getSuggestions: (...args) => provider("completionProvider").getSuggestions(...args),
      getSuggestionDetailsOnSelect: (...args) =>
        provider("completionProvider").getSuggestionDetailsOnSelect(...args),
      onDidInsertSuggestion: (...args) =>
        provider("completionProvider").onDidInsertSuggestion(...args),
    };

    this.documentSymbols = {
      name: "Language Server",
      packageName: "ide",
      onDidInvalidateDocumentSymbols: (callback) => this.relays.symbols.subscribe(callback),
      getDocumentSymbolSources: (...args) =>
        provider("symbolProvider").getDocumentSymbolSources(...args),
      getDocumentSymbols: (...args) => provider("symbolProvider").getDocumentSymbols(...args),
    };
    this.workspaceSymbols = {
      name: "Language Server",
      packageName: "ide",
      onDidInvalidateWorkspaceSymbols: (callback) =>
        this.relays.workspaceSymbols.subscribe(callback),
      searchWorkspaceSymbols: (...args) =>
        provider("symbolProvider").searchWorkspaceSymbols(...args),
    };
    this.definitions = {
      name: "Language Server",
      packageName: "ide",
      canProvideDefinitions: (...args) => provider("symbolProvider").canProvideDefinitions(...args),
      getDefinitions: (...args) => provider("symbolProvider").getDefinitions(...args),
    };

    this.contextHelp = {
      name: "Language Server",
      packageName: "ide",
      priority: 2,
      get grammarScopes() {
        return grammarScopes();
      },
      getHelp: (...args) => provider("contextHelpProvider").getHelp(...args),
    };

    this.signature = {
      name: "Language Server",
      packageName: "ide",
      priority: 2,
      get grammarScopes() {
        return grammarScopes();
      },
      get triggerCharacters() {
        return provider("signatureProvider").triggerCharacters;
      },
      get retriggerCharacters() {
        return provider("signatureProvider").retriggerCharacters;
      },
      getSignature: (...args) => provider("signatureProvider").getSignature(...args),
    };

    this.codeFormatRange = this.codeFormatFacade("formatRange", "formatCode", grammarScopes);
    this.codeFormatFile = this.codeFormatFacade("formatFile", "formatEntireFile", grammarScopes);
    this.codeFormatOnType = this.codeFormatFacade(
      "formatOnType",
      "formatAtPosition",
      grammarScopes,
      { keepCursorPosition: false },
    );
    this.codeFormatOnSave = this.codeFormatFacade("formatOnSave", "formatOnSave", grammarScopes);

    this.references = {
      name: "Language Server",
      packageName: "ide",
      get grammarScopes() {
        return grammarScopes();
      },
      isEditorSupported: (editor) => !!this.activeMain().manager?.adapterForEditor(editor),
      findReferences: (...args) => provider("referencesProvider").findReferences(...args),
    };

    this.refactor = {
      priority: 2,
      packageName: "ide",
      get grammarScopes() {
        return grammarScopes();
      },
      rename: (...args) => provider("refactorProvider").rename(...args),
      prepareRename: (...args) => provider("refactorProvider").prepareRename(...args),
    };

    this.intentions = {
      get grammarScopes() {
        return grammarScopes();
      },
      getIntentions: (...args) => provider("intentionsProvider").getIntentions(...args),
    };

    this.codeLens = this.invalidatingFacade({
      relay: this.relays.codeLens,
      providerName: "codeLensProvider",
      operation: "codeLenses",
      grammarScopes,
      extraMethods: ["resolveCodeLens"],
    });
    this.inlayHints = this.invalidatingFacade({
      relay: this.relays.inlayHints,
      providerName: "inlayHintsProvider",
      operation: "inlayHints",
      grammarScopes,
    });
    this.semanticTokens = this.invalidatingFacade({
      relay: this.relays.semanticTokens,
      providerName: "semanticTokensProvider",
      operation: "semanticTokens",
      grammarScopes,
      extraMethods: ["semanticTokensInRange"],
    });

    this.hyperclick = {
      priority: 2,
      providerName: "ide",
      getSuggestionForWord: (...args) =>
        provider("documentFeatures").hyperclickProvider.getSuggestionForWord(...args),
    };
  }

  activeMain() {
    if (!this.main || this.main.activationGeneration !== this.generation)
      throw new DOMException("The ide provider is no longer active", "AbortError");
    return this.main;
  }

  provider(name) {
    return this.activeMain().ensureProviders()[name];
  }

  codeFormatFacade(providerMethod, serviceMethod, grammarScopes, extra = {}) {
    return {
      priority: 2,
      packageName: "ide",
      get grammarScopes() {
        return grammarScopes();
      },
      canFormat: (editor, request) =>
        this.provider("codeFormatProvider").canFormat(editor, providerMethod, request),
      [serviceMethod]: (...args) => this.provider("codeFormatProvider")[providerMethod](...args),
      ...extra,
    };
  }

  invalidatingFacade({ relay, providerName, operation, grammarScopes, extraMethods = [] }) {
    const facade = {
      name: "Language Server",
      packageName: "ide",
      priority: 2,
      get grammarScopes() {
        return grammarScopes();
      },
      onDidInvalidate: (callback) => relay.subscribe(callback),
      [operation]: (...args) => this.provider(providerName)[operation](...args),
    };
    for (const method of extraMethods) {
      facade[method] = (...args) => this.provider(providerName)[method](...args);
    }
    return facade;
  }

  connect(main = this.main) {
    this.disconnect();
    this.connections = new CompositeDisposable(
      main.symbolProvider.onDidInvalidateDocumentSymbols((event) =>
        this.relays.symbols.emit(event),
      ),
      main.symbolProvider.onDidInvalidateWorkspaceSymbols((event) =>
        this.relays.workspaceSymbols.emit(event),
      ),
      main.codeLensProvider.onDidInvalidate((event) => this.relays.codeLens.emit(event)),
      main.inlayHintsProvider.onDidInvalidate((event) => this.relays.inlayHints.emit(event)),
      main.semanticTokensProvider.onDidInvalidate((event) =>
        this.relays.semanticTokens.emit(event),
      ),
    );
  }

  disconnect() {
    this.connections?.dispose();
    this.connections = null;
  }

  dispose() {
    this.disconnect();
    for (const relay of Object.values(this.relays)) relay.clear();
    this.main = null;
  }
};
