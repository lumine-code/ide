const ProviderFacades = require("../lib/provider-facades");

describe("Provider facade activation ownership", () => {
  let main, first, fresh, providers;
  beforeEach(() => {
    providers = {
      codeFormatProvider: {
        canFormat: jasmine.createSpy("canFormat").and.resolveTo(true),
        formatFile: jasmine.createSpy("formatFile").and.resolveTo([]),
      },
      codeLensProvider: {
        codeLenses: jasmine.createSpy("codeLenses").and.resolveTo([]),
        resolveCodeLens: jasmine.createSpy("resolveCodeLens").and.resolveTo(null),
      },
      semanticTokensProvider: {
        semanticTokensInRange: jasmine.createSpy("semanticTokensInRange").and.resolveTo([]),
      },
    };
    main = {
      activationGeneration: 1,
      manager: { allGrammarScopes: () => ["source.js"] },
      ensureProviders: jasmine.createSpy("ensureProviders").and.returnValue(providers),
    };
    first = new ProviderFacades(main);
  });
  afterEach(() => {
    first.dispose();
    fresh?.dispose();
  });

  it("prevents retained formatting and invalidating services from reaching a later activation", async () => {
    const oldFormatting = first.codeFormatFile;
    const oldCodeLens = first.codeLens;
    const oldSemanticTokens = first.semanticTokens;
    first.dispose();
    main.activationGeneration++;
    fresh = new ProviderFacades(main);

    for (const invoke of [
      () => oldFormatting.canFormat({}),
      () => oldFormatting.formatEntireFile({}),
      () => oldCodeLens.codeLenses({}),
      () => oldCodeLens.resolveCodeLens({}),
      () => oldSemanticTokens.semanticTokensInRange({}, [0, 1]),
    ]) {
      expect(invoke).toThrowMatching((error) => error.name === "AbortError");
    }
    expect(main.ensureProviders).not.toHaveBeenCalled();

    expect(await fresh.codeFormatFile.canFormat({})).toBe(true);
    expect(await fresh.codeFormatFile.formatEntireFile({})).toEqual([]);
    expect(await fresh.codeLens.codeLenses({})).toEqual([]);
    expect(await fresh.codeLens.resolveCodeLens({})).toBeNull();
    expect(await fresh.semanticTokens.semanticTokensInRange({}, [0, 1])).toEqual([]);
    expect(providers.codeFormatProvider.canFormat).toHaveBeenCalled();
    expect(providers.codeLensProvider.codeLenses).toHaveBeenCalled();
  });

  it("checks the activation generation even before an old facade has been disposed", () => {
    main.activationGeneration++;
    expect(() => first.codeLens.codeLenses({})).toThrowMatching(
      (error) => error.name === "AbortError",
    );
    expect(main.ensureProviders).not.toHaveBeenCalled();
  });
});
