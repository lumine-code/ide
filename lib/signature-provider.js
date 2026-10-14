const C = require("./converters");
const providerCharacters = require("./provider-characters");

const SIGNATURE_CAPABILITIES = {
  textDocument: {
    signatureHelp: {
      dynamicRegistration: true,
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        activeParameterSupport: true,
        parameterInformation: { labelOffsetSupport: true },
      },
    },
  },
};

module.exports = class SignatureProvider {
  static capabilities = SIGNATURE_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(SIGNATURE_CAPABILITIES);
    this.name = "Language Server";
    this.packageName = "ide";
    this.priority = 2;
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  get triggerCharacters() {
    return this.collectCharacters("triggerCharacters");
  }
  get retriggerCharacters() {
    return this.collectCharacters("retriggerCharacters");
  }
  collectCharacters(key) {
    return providerCharacters(this.manager, "textDocument/signatureHelp", key);
  }
  // Returns the raw LSP SignatureHelp result; the consumer renders it.
  async getSignature(editor, point, context) {
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/signatureHelp",
    );
    if (!session) return null;
    try {
      return await session.request("textDocument/signatureHelp", {
        textDocument: { uri: this.manager.uriForEditor(editor) },
        position: C.pointToPosition(point),
        context: context ?? { triggerKind: 1, isRetrigger: false },
      });
    } catch {
      return null;
    }
  }
};
