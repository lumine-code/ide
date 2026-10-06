const { selectionFaults } = require("./adapter-selection");
const { fileWatcherFaults } = require("./file-watchers");
const { FEATURES } = require("./features");

// What is wrong with an adapter's `managedServer`, if it declares one. Checked
// at registration rather than at install time: a descriptor is static data, and
// a typo in it should not wait until a user asks for the install to surface.
function managedServerFaults(adapter) {
  const descriptor = adapter?.managedServer;
  const fetchesItsOwn = typeof adapter?.installServer === "function";
  // Two ways in, and an adapter that declares both leaves it ambiguous which
  // one fills the staging directory.
  if (descriptor && fetchesItsOwn) return ["managedServer with installServer"];
  if (descriptor === undefined) return [];
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor))
    return ["managedServer"];
  const faults = [];
  const named = (key) => `managedServer.${key}`;
  if (descriptor.source === "npm") {
    if (!Array.isArray(descriptor.packages) || !descriptor.packages.length)
      faults.push(named("packages"));
    else if (
      descriptor.packages.some(
        (entry) =>
          !(
            nonemptyString(entry) ||
            (entry &&
              typeof entry === "object" &&
              nonemptyString(entry.name) &&
              (entry.version === undefined || nonemptyString(entry.version)))
          ),
      )
    )
      faults.push(named("packages"));
    if (!nonemptyString(descriptor.module)) faults.push(named("module"));
    if (descriptor.bundled !== undefined && typeof descriptor.bundled !== "boolean")
      faults.push(named("bundled"));
  } else if (descriptor.source === "github-release") {
    if (!nonemptyString(descriptor.repository)) faults.push(named("repository"));
    if (typeof descriptor.assetFor !== "function") faults.push(named("assetFor"));
    if (
      !nonemptyString(descriptor.binary) ||
      /[/\\]/.test(descriptor.binary) ||
      [".", ".."].includes(descriptor.binary)
    )
      faults.push(named("binary"));
    if (descriptor.assetType !== undefined && !["archive", "binary"].includes(descriptor.assetType))
      faults.push(named("assetType"));
    if (
      descriptor.strip !== undefined &&
      (!Number.isInteger(descriptor.strip) || descriptor.strip < 0)
    )
      faults.push(named("strip"));
    // Stated, never inferred: a source that publishes nothing to verify against
    // has to say so, so the gap is visible in the adapter rather than here.
    if (!["sha256-sidecar", "none"].includes(descriptor.checksum)) faults.push(named("checksum"));
  } else {
    faults.push(named("source"));
  }
  return faults;
}

const nonemptyString = (value) => typeof value === "string" && !!value.trim();
const stringList = (value, allowEmpty = true) =>
  Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(nonemptyString);

const HOOKS = [
  "languageIdForScope",
  "getInitializationOptions",
  "getSettings",
  "getInitializedNotifications",
  "getWorkspaceConfiguration",
  "handleServerRequest",
  "handleServerNotification",
  "isFeatureAvailable",
  "installServer",
  "latestServerVersion",
  "transformDocumentText",
  "restoreDocumentText",
  "transformDiagnostics",
  "transformServerCapabilities",
  "prepareRequest",
  "searchWorkspaceSymbols",
  "getDocumentationCodeBlockProjection",
  "needsDocumentTransform",
  "getDocumentProjection",
  "formatProjectedDocument",
  "resolveRenameTarget",
];

function validateAdapter(adapter) {
  const value = adapter && typeof adapter === "object" ? adapter : {};
  const faults = ["id", "displayName"].filter((key) => !nonemptyString(value[key]));
  if (!stringList(value.grammarScopes, false)) faults.push("grammarScopes");
  if (
    value.documentSymbolScopes !== undefined &&
    (!stringList(value.documentSymbolScopes) ||
      value.documentSymbolScopes.some(
        (scope) => !Array.isArray(value.grammarScopes) || !value.grammarScopes.includes(scope),
      ))
  )
    faults.push("documentSymbolScopes");
  if (typeof value.resolveServer !== "function") faults.push("resolveServer");
  for (const key of HOOKS)
    if (value[key] !== undefined && typeof value[key] !== "function") faults.push(key);
  for (const key of ["settingsKeyPaths", "restartKeyPaths"])
    if (value[key] !== undefined && !stringList(value[key])) faults.push(key);
  for (const key of ["languageId", "featuresKeyPath", "managedServerDisplayName"])
    if (value[key] !== undefined && !nonemptyString(value[key])) faults.push(key);
  if (
    value.sessionScope !== undefined &&
    !["project-root", "workspace"].includes(value.sessionScope)
  )
    faults.push("sessionScope");
  if (
    value.features !== undefined &&
    (!value.features ||
      typeof value.features !== "object" ||
      Array.isArray(value.features) ||
      Object.entries(value.features).some(
        ([key, enabled]) => !FEATURES.includes(key) || typeof enabled !== "boolean",
      ))
  )
    faults.push("features");
  faults.push(
    ...managedServerFaults(value),
    ...selectionFaults(value),
    ...fileWatcherFaults(value),
  );
  if (faults.length) throw new TypeError(`Invalid language-server adapter: ${faults.join(", ")}`);
}

module.exports = { validateAdapter };
