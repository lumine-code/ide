const {
  configurationContext,
  readSettings,
  sectionValue,
  workspaceConfiguration,
} = require("../lib/workspace-configuration");
const C = require("../lib/converters");
const path = require("path");

describe("adapter workspace configuration", () => {
  it("resolves only own dotted settings and preserves false, zero and empty strings", () => {
    const settings = { language: { enabled: false, size: 0, label: "" } };
    expect(sectionValue(settings, "language.enabled")).toBe(false);
    expect(sectionValue(settings, "language.size")).toBe(0);
    expect(sectionValue(settings, "language.label")).toBe("");
    for (const section of ["missing", "toString", "language.constructor", "language..size"])
      expect(sectionValue(settings, section)).withContext(section).toBeNull();
    expect(sectionValue(settings)).toBe(settings);
    expect(sectionValue(Object.create({ inherited: 1 }), "inherited")).toBeNull();
  });

  it("reads one async settings snapshot for all sections in a request", async () => {
    const context = { rootPath: "root", launch: { command: "server" } };
    const getSettings = jasmine.createSpy("getSettings").and.resolveTo({
      language: { enabled: true, size: 2 },
    });
    expect(
      await workspaceConfiguration(
        { getSettings },
        [{ section: "language" }, { section: "language.size" }, { section: "missing" }],
        context,
      ),
    ).toEqual([{ enabled: true, size: 2 }, 2, null]);
    expect(getSettings).toHaveBeenCalledOnceWith(context);
  });

  it("lets an override answer aliases and resources without falling back to editor config", async () => {
    const context = { rootPath: "root", launch: { command: "server" } };
    const getSettings = jasmine.createSpy("getSettings");
    const getWorkspaceConfiguration = jasmine
      .createSpy("getWorkspaceConfiguration")
      .and.callFake(async (section) => (section === "alias" ? false : undefined));
    expect(
      await workspaceConfiguration(
        { getSettings, getWorkspaceConfiguration },
        [{ section: "alias", scopeUri: "file:///document" }, { section: "editor.tabLength" }],
        context,
      ),
    ).toEqual([false, null]);
    expect(getWorkspaceConfiguration.calls.first().args).toEqual([
      "alias",
      "file:///document",
      context,
    ]);
    expect(getSettings).not.toHaveBeenCalled();
  });

  it("uses getSettings as the canonical push source", async () => {
    const getWorkspaceConfiguration = jasmine.createSpy("getWorkspaceConfiguration");
    expect(await readSettings({ getWorkspaceConfiguration }, {})).toEqual({});
    expect(getWorkspaceConfiguration).not.toHaveBeenCalled();
    expect(await workspaceConfiguration({}, [{ section: "editor" }], {})).toEqual([null]);
  });

  it("binds settings context to the resolved launch and adds the session only once available", () => {
    const rootPath = path.resolve("settings-project");
    const launch = { command: "server" };
    const session = {};
    expect(configurationContext(rootPath, launch)).toEqual({
      rootPath,
      rootUri: C.pathToUri(rootPath),
      launch,
    });
    expect(configurationContext(rootPath, launch, session).session).toBe(session);
  });
});
