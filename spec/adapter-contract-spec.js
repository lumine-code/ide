const { validateAdapter } = require("../lib/adapter-contract");

describe("language-server adapter contract", () => {
  const adapter = () => ({
    id: "example",
    displayName: "Example Server",
    grammarScopes: ["source.example"],
    resolveServer: async () => null,
  });

  it("validates static routing and configuration before installing observers", () => {
    for (const [key, value] of [
      ["id", 1],
      ["displayName", " "],
      ["grammarScopes", ["source.example", null]],
      ["grammarScopes", [""]],
      ["sessionScope", "root"],
      ["settingsKeyPaths", "example"],
      ["restartKeyPaths", [""]],
      ["getSettings", {}],
      ["getWorkspaceConfiguration", null],
      ["getDocumentProjection", true],
      ["features", { completion: false }],
      ["features", { autocomplete: "false" }],
    ])
      expect(() => validateAdapter({ ...adapter(), [key]: value }))
        .withContext(`${key}: ${JSON.stringify(value)}`)
        .toThrowError(new RegExp(key));
  });

  it("accepts canonical configuration and optional hooks without changing identity", () => {
    const value = {
      ...adapter(),
      getSettings: async () => ({ example: { enabled: false } }),
      settingsKeyPaths: ["example"],
      restartKeyPaths: ["example.serverPath"],
      sessionScope: "project-root",
      documentSymbolScopes: [],
      features: { autocomplete: false, hover: true },
    };
    expect(() => validateAdapter(value)).not.toThrow();
    expect(value.documentSymbolScopes).toEqual([]);
  });

  it("rejects malformed managed installs before installation or path handling", () => {
    for (const managedServer of [
      null,
      { source: "npm", packages: [""], module: "entry.js" },
      { source: "npm", packages: ["example"], module: {} },
      { source: "github-release", repository: "example/server", binary: 1 },
      { source: "github-release", repository: "example/server", binary: "nested\\server.exe" },
    ])
      expect(() => validateAdapter({ ...adapter(), managedServer })).toThrowError(/managedServer/);
  });
});
