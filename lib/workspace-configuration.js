const { pathToUri } = require("./converters");

function configurationContext(rootPath, launch, session) {
  return { rootPath, rootUri: pathToUri(rootPath), launch, ...(session ? { session } : {}) };
}

// Configuration sections are paths inside the adapter's settings, never paths
// into the editor's configuration or properties inherited from Object.
function sectionValue(settings, section) {
  if (section === undefined || section === "") return settings ?? null;
  if (typeof section !== "string") return null;
  let value = settings;
  for (const key of section.split(".")) {
    if (!key || value === null || typeof value !== "object" || !Object.hasOwn(value, key))
      return null;
    value = value[key];
  }
  return value ?? null;
}

async function readSettings(adapter, context) {
  return (await adapter.getSettings?.(context)) ?? {};
}

async function workspaceConfiguration(adapter, items, context) {
  if (adapter.getWorkspaceConfiguration)
    return Promise.all(
      items.map(
        async ({ section, scopeUri }) =>
          (await adapter.getWorkspaceConfiguration(section, scopeUri, context)) ?? null,
      ),
    );
  if (!items.length) return [];
  // One request sees one settings snapshot even when it asks for several sections.
  const settings = await readSettings(adapter, context);
  return items.map(({ section }) => sectionValue(settings, section));
}

module.exports = { configurationContext, sectionValue, readSettings, workspaceConfiguration };
