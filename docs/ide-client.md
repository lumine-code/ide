# ide-client

Registers a language server with the editor. The adapter says how to launch it and which grammars it serves; `ide-client` does the rest of LSP.

|             |                                                   |
| ----------- | ------------------------------------------------- |
| Version     | `1.0.0`                                           |
| Provided by | `provideIdeClient()` returning the client service |
| Consumed by | `consumeIdeClient(client)`                        |
| Owner       | `ide-client`                                      |

An adapter package is small — a manifest entry, a `resolveServer`, and a grammar list. Everything a language server can do then arrives in the editor at once, because `ide-client` implements the UI-facing services (`autocomplete.provider`, `symbol.document-provider`, `symbol.workspace-provider`, `symbol.definition-provider`, `context-help.provider`, `hyperclick.provider`, `refactor.provider`, `find-references.provider`, `intentions.list`, `code-lens.provider`, `inlay-hints.provider`, `semantic-tokens.provider`, and the four `code-format.*`) on every adapter's behalf. You do not implement any of them.

Workspace symbol search asks every supporting session already running for the requested project roots, once per process, and preserves other servers' results when one fails. It does not discover languages, launch servers or open files. An adapter may implement `searchWorkspaceSymbols(query, { session, signal })` to use its server's own project search protocol; return LSP `SymbolInformation` records with URI and range. The default sends `workspace/symbol`. The `symbols` feature switch governs both document and workspace symbols, including per-language overrides.

Document symbol sources are enumerated from adapters applicable to the current editor and their existing session state, including notebook cell routing. Enumeration does not launch a server or scan the project. Each source identifies one adapter as `ide-client:<adapter.id>`, uses the adapter's display name and the short label `LS`, and reports `ready`, `starting` or `unavailable` with an optional reason. A document request carries the exact `sourceId`; an unavailable or unsupported source returns `null`, and the client never substitutes another backend. The hub owns automatic selection and a user's explicit choice.

`documentSymbolScopes` declares whole-document ownership as a subset of `grammarScopes`. It defaults to `grammarScopes`; `[]` disables document symbol sources for the adapter. Each entry must be a nonempty scope already in `grammarScopes`. A server that handles foreign embedded fragments keeps their scopes in `grammarScopes` for completion, hover and navigation, but excludes them from `documentSymbolScopes`. Sources for those host buffers are omitted, and an exact request for such a source returns `null` before waiting for a session or opening a document. Eligibility uses the editor's root grammar, including a notebook cell's own grammar. This declaration does not change protocol capabilities, feature switches or workspace symbols.

Hover and completion documentation fences use their own declared language, which may differ from the file being edited: JavaScript documentation can describe TypeScript types. The client supplies the presentation services' optional code-block renderers for display signatures that are not valid source, including descriptive labels, overload counts, omitted parameters and callable type notation. Both surfaces share one renderer, which parses private declarations with the editor's grammar and maps scopes back to the original text; the displayed and copied signature stays unchanged. Unsupported forms, failed parses and ordinary source use the normal renderer. An adapter can supply `getDocumentationCodeBlockProjection(block)` for its own server's documentation conventions; unlabelled blocks are never offered to an unrelated adapter.

The full types are `lib/main.d.ts` in this package.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "ide-client": {
      "versions": { "^1.0.0": "consumeIdeClient" }
    }
  }
}
```

## Contract

The adapter you register:

```ts
interface LanguageServerAdapter {
  id: string;
  displayName: string;
  grammarScopes: string[];
  documentSymbolScopes?: string[];
  resolveServer(context: ServerResolutionContext): Promise<ServerLaunch | null>;

  languageId?: string;
  languageIdForScope?(
    scopeName: string,
    context: { editor: TextEditor; filePath: string | null },
  ): string | undefined;
  documentSelector?: Array<{ language?: string; scheme?: string; pattern?: string }>;
  sessionScope?: "project-root" | "workspace";
  exclusiveGroup?: string;
  selectionPriority?: number;
  fileWatchers?: Array<{
    globPattern: string | { baseUri: string | { uri: string; name?: string }; pattern: string };
    kind?: number;
  }>;
  getInitializationOptions?(context: { rootPath: string; rootUri: string }): unknown;
  getSettings?(context: ServerConfigurationContext): unknown | Promise<unknown>;
  getInitializedNotifications?(context: {
    session: LanguageServerSession;
    rootPath: string;
    rootUri: string;
  }): Array<{ method: string; params?: unknown }>;
  settingsKeyPaths?: string[];
  restartKeyPaths?: string[];
  getWorkspaceConfiguration?(
    section: string | undefined,
    resource: string | undefined,
    context: ServerConfigurationContext,
  ): unknown | Promise<unknown>;
  handleServerRequest?(
    method: string,
    params: unknown,
    context: { session: LanguageServerSession },
  ): unknown;
  handleServerNotification?(
    method: string,
    params: unknown,
    context: { session: LanguageServerSession },
  ): void;
  features?: Partial<Record<LanguageServerFeature, boolean>>;
  featuresKeyPath?: string;
  isFeatureAvailable?(
    feature: LanguageServerFeature,
    context?: TextEditor | { getRootScopeDescriptor(): ScopeDescriptor | string[] },
  ): boolean;
  getDocumentationCodeBlockProjection?(block: {
    text: string;
    scopeName?: string;
    language?: string;
  }): DocumentationCodeBlockProjection | null | Promise<DocumentationCodeBlockProjection | null>;
  managedServer?: ManagedServerDescriptor;
  managedServerDisplayName?: string;
  bundledServer?: boolean;
  installServer?(context: ServerInstallContext): Promise<AdapterInstallResult>;
  latestServerVersion?(api: InstallApi): Promise<string | null>;
  transformDocumentText?(text: string, context: { editor: TextEditor; uri: string }): string;
  restoreDocumentText?(text: string, context: { editor: TextEditor; uri: string }): string;
  transformDiagnostics?(
    diagnostics: Diagnostic[],
    context: { editor?: TextEditor; uri: string; session: LanguageServerSession },
  ): Diagnostic[];
  transformServerCapabilities?(caps: Record<string, unknown>): Record<string, unknown>;
  prepareRequest?(
    method: string,
    params: unknown,
    context: {
      session: LanguageServerSession;
      editor?: TextEditor;
      signal?: AbortSignal;
      getDocument(uri: string): {
        uri: string;
        text: string;
        version: number;
        isCurrent(): boolean;
      } | null;
    },
  ):
    | { params?: unknown; mapResult?(result: unknown): unknown | Promise<unknown> }
    | void
    | Promise<{ params?: unknown; mapResult?(result: unknown): unknown | Promise<unknown> } | void>;
}
```

Four fields are required:

| Field                    | Description                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | Stable identifier, also the key for `getLog`.                                                                                  |
| `displayName`            | Shown to the user in status and logs.                                                                                          |
| `grammarScopes`          | Which editors this server serves.                                                                                              |
| `resolveServer(context)` | Returns a `ServerLaunch`, or `null` when the server is not installed — which disables the adapter quietly rather than failing. |

`ServerLaunch` is `{ command, args?, cwd?, env?, transport?, host?, port?, version?, fileCancellationFolder? }` with `transport` one of `"stdio"` (default), `"ipc"`, or `"socket"`. `fileCancellationFolder` is an absolute, session-unique directory for a server that uses marker files instead of `$/cancelRequest`; `ide-client` creates it and removes it with the connection.

`env` overrides the child process environment; a value of `undefined` removes an inherited variable. This lets an adapter enforce its chosen transport without changing the editor's own environment.

`getSettings(context)` is the canonical server settings tree. The client reads it during startup preflight and on configuration changes, then pushes it through `workspace/didChangeConfiguration`. Configuration pulls resolve dotted sections from that same tree, reading one snapshot per request and returning `null` for missing sections. Lookup visits own properties only and preserves `false`, zero and empty strings. It never falls back to the editor's configuration. Custom servers use their entry's `settings` tree through the same resolver.

The configuration context is `{ rootPath, rootUri, launch, session? }`. `launch` is the exact object returned by this startup's `resolveServer`; `session` becomes available after preflight. Store launch-dependent settings against that object rather than in mutable module state, so concurrent roots and replacement sessions cannot overwrite each other's tool paths. `getWorkspaceConfiguration(section, resource, context)` is an optional authoritative override for server aliases or resource-specific settings. Its absent results become `null`; it is never called to synthesize pushed settings.

`getDocumentationCodeBlockProjection` receives a block's original text, fence language and resolved grammar scope. Return `null` to use the normal renderer, or `{ scopeName, text, regions, validate }` to parse private source with the editor's grammar. Each region has UTF-16 `start` and `end` offsets in the original block, plus either `projectedStart` in the private source or explicit `scopes`. Text outside those regions stays neutral. `validate(root)` confirms the intended Tree-sitter structure after an error-free parse. Failed hooks, invalid parses and unavailable grammars fall back to the normal renderer, and the temporary editor is always destroyed.

Completion blocks belong to the session that supplied the item, including after resolve. Merged hover blocks retain the adapter of each surviving section; deduplicated sections keep their first owner. Identical blocks embedded in different sections from different servers use the normal renderer when their ownership is ambiguous.

The service you receive:

| Member                                                            | Description                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `registerAdapter(adapter)`                                        | Registers it and returns a `Disposable`.                                                 |
| `adaptersForEditor(editor)`                                       | Selected adapters for that editor, whether or not their servers are running.             |
| `onDidChangeAdapters(fn)`                                         | `{ adapter, registered, selectionChanged? }` on registration or selection changes.       |
| `sessionForEditor(editor)`                                        | The session serving that editor, or `null`. May still be starting.                       |
| `activeSessionForEditor(editor)`                                  | Resolves once the session has finished starting; `null` when absent, failed, or stopped. |
| `activeSessionsForEditor(editor)`                                 | Every running session serving that editor, in adapter registration order.                |
| `activeSessionForFeature(editor, method, feature?)`               | The first of those that serves `method`, honouring dynamic registrations and switches.   |
| `getSessions()`                                                   | Every session.                                                                           |
| `request(editor, method, params, opts)`                           | Sends a request through the **first** session serving that editor, unchecked. See below. |
| `onDidChangeSession(fn)`                                          | `{ session, state, error? }` on every state transition.                                  |
| `onDidChangeCapabilities(fn)`                                     | `{ session }` after a server dynamically registers or unregisters a capability.          |
| `onDidPublishDiagnostics(fn)`                                     | Normalized pushed or pulled diagnostics, after the adapter transform.                    |
| `createProjectDiagnostics(adapterId, delegate)`                   | Retains manual scan results and hides documents or cells covered by live diagnostics.    |
| `onDidChangeFeatures(fn)`                                         | `{ adapter }` when one of an adapter's feature switches changes.                         |
| `featureEnabled(adapter, feature, editor?)`                       | Whether that feature is on for that adapter, in that editor's scope.                     |
| `onDidLog(fn)`, `getLog(adapterId)`                               | Server stderr and protocol log.                                                          |
| `restart(session)`, `stop(session)`                               | Serialized lifecycle control; restart may resolve `null` when cancelled or unavailable.  |
| `reportMissingServer(adapterId, opts?)`                           | Says once per window that the server was not found; honours the package's opt-out.       |
| `installServer(adapterId, opts?)`                                 | Fetches and installs the server; reports its own progress and failure.                   |
| `updateServer(adapterId)`                                         | Installs the newest release, or resolves unchanged when already current.                 |
| `uninstallServer(adapterId)`                                      | Removes the managed copy only.                                                           |
| `managedServer(adapterId)`                                        | The installed copy, or `null`.                                                           |
| `serverInstallationStatus(adapterId)`                             | What is happening to that server right now, or `null`.                                   |
| `onDidChangeServerInstallation(fn)`                               | `{ adapterId, status }` as an install proceeds.                                          |
| `applyWorkspaceEdit(edit, label)`                                 | Applies an LSP `WorkspaceEdit` to the workspace.                                         |
| `willCreateFiles`, `willRenameFiles`, `willDeleteFiles`           | Prepares a file operation through every matching server; `false` cancels it.             |
| `didCreateFiles`, `didRenameFiles`, `didDeleteFiles`              | Reports a completed file operation to every matching server.                             |
| `openNotebookDocument(descriptor)`                                | Opens a notebook for language servers; see "Notebook documents" below.                   |
| `adaptersForNotebook(filePath)`                                   | The adapters serving an open notebook — the stand-down question, notebook-shaped.        |
| `cellUri(notebookPath, cellId)`, `parseCellUri(uri)`              | The `vscode-notebook-cell:` URI vocabulary, e.g. for configuration scope URIs.           |
| `openNotebook`, `changeNotebook`, `saveNotebook`, `closeNotebook` | Raw per-session notebook notifications; prefer `openNotebookDocument`.                   |

`createProjectDiagnostics` takes a delegate registered with `linter.registry` using `deleteOnOpen: false`. Its returned coordinator exposes `setAllMessages(messages, options?, notebookSnapshots?)`, `getMessages()` and `dispose()`. It retains the complete scan snapshot, yielding a document or notebook cell only after that adapter's running session has published current diagnostics with the feature enabled. Disabling diagnostics, stopping the server or closing the document restores the retained findings. An empty accepted report also owns the document. For notebook scans, pass a map from each path to the saved JSON source used by the scanner. Findings whose cell order, identity, type or source differs from an open notebook are invalidated until another scan; subsequent structural and content changes cannot move stale findings onto another cell. Before replacing the coordinator, retain `getMessages()` in the scanner's cache: it includes findings hidden by live diagnostics but excludes invalidated notebook findings. Dispose the coordinator when either service edge disappears; its delegate remains owned by the caller. Options such as `showProjectView` apply only to the explicit scan publication, so later coverage changes do not open the panel again.

`opts` for `request` — both optional:

| Option           | Description                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`         | An `AbortSignal`. Aborting settles the returned promise straight away, whatever the server does next.                                                                                                                                       |
| `cancelOnServer` | Whether aborting also sends `$/cancelRequest`. Defaults to `true`, except for `textDocument/references` and `workspace/executeCommand`, which are abandoned quietly — servers supersede the first themselves, and the second is a mutation. |

### Picking a session

More than one server on a grammar is normal, so `sessionForEditor` and `request` — both of which take the first — are only right when any of them will do. Otherwise resolve a session and use its own `request()`:

```js
const session = await client.activeSessionForFeature(
  editor,
  "textDocument/prepareTypeHierarchy",
  "typeHierarchy",
);
if (!session) return; // nothing running here serves it
const items = await session.request("textDocument/prepareTypeHierarchy", params);
```

Two reasons to hold the session rather than re-pick per request. A reply's `data` is opaque and meaningful only to the server that produced it, so a follow-up sent elsewhere is a protocol violation, not merely a routing preference. And `supports()` consults the dynamic registrations **before** the static capability, while the feature switches are honoured either way — a raw `session.capabilities.<x>Provider` read misses a server that registered late and finds `{}` for one that registers everything dynamically.

Some capabilities the hub advertises on a consumer's behalf, because fragments are merged once at initialize and an external package cannot contribute one: `textDocument.callHierarchy` and `textDocument.typeHierarchy` are both declared for `hierarchy-view`.

The unchecked request API is still a client-capability contract. Document links back the `hyperclick.provider`; the `ide-client:fold-server-ranges`, `ide-client:expand-selection-range`, `ide-client:select-linked-ranges`, and `ide-client:color-presentation` commands expose folding ranges, selection ranges, linked-editing ranges, document colours and color presentations without another package. These routes remain available through the raw request API as well. Keep their capability objects truthful and complete: servers in the wild sometimes read an optional child such as `textDocument.foldingRange.lineFoldingOnly` without first checking its parent, so an omitted shape can break a valid request inside the server.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeIdeClient(client) {
    return client.registerAdapter({
      id: "my-language-server",
      displayName: "My Language Server",
      grammarScopes: ["source.mylang"],
      async resolveServer({ rootPath }) {
        const command = await which("my-langserver");
        if (!command) return null;
        return { command, args: ["--stdio"], cwd: rootPath };
      },
      getSettings: () => ({ mylang: lumine.config.get("my-package.serverSettings") }),
      settingsKeyPaths: ["my-package.serverSettings"],
      restartKeyPaths: ["my-package.serverPath"],
    });
  },
};
```

## Behavior

`fileWatchers` supplies standard LSP `FileSystemWatcher` entries for servers whose official clients send filesystem notifications without a server registration. String or file-backed relative globs use `kind` bits `1` (create), `2` (change), `4` (delete), defaulting to all three. The hub routes these through its existing project-file and file-operation pipeline, filters static watchers to the session's project folders, combines them with dynamic server registrations and removes consecutive duplicate URI/type events. Terminal sessions receive nothing, and unregistering the adapter removes its routes. Prefer the server's dynamic registration when it supplies one; this field does not create an independent native watcher.

`prepareRequest` is an optional compatibility hook for a server's request and response conventions. It runs after document synchronization and source-to-wire projection; returning `params` replaces the outgoing request, and `mapResult` restores the response to UTF-16 wire coordinates before the client's source projection and normal result handling. Returning nothing preserves the request. The hook must preserve opaque server data and must not modify the caller's parameters. `getDocument` returns immutable snapshots of open and temporary documents as the server received them; closed-file reads belong to the adapter. The client rejects cancelled preparation, stopped sessions and results whose consulted snapshots changed during preparation or response mapping. An adapter can use `isCurrent()` for its own intermediate checks.

Adapters normally coexist. An optional `exclusiveGroup` selects one of that group's applicable adapters per editor: the first ID named in `ide-client.preferredServers`, then the highest `selectionPriority` (default `0`), then lexicographic ID. Preferences affect only these groups; unrelated servers and disjoint document selectors remain available. The choice does not depend on asynchronous executable discovery. Registering, unregistering or changing a preference withdraws obsolete controllers and waits for their physical process exit before a replacement starts on an overlapping route; a child that survives shutdown remains quarantined. Unregistering the winner restores the next applicable adapter. `adaptersForEditor` reports the selected coverage immediately, and `onDidChangeAdapters` also emits `{ adapter, registered: true, selectionChanged: true }` when a preference changes that coverage.

`resolveServer` returning `null` is the supported way to be a no-op: an adapter whose server is not installed should return `null` rather than throw, and nothing appears in the UI.

Sessions are keyed by `sessionScope`. `"project-root"`, the default, gives each project folder its own server, because most servers resolve their configuration relative to a root and would answer for the wrong project otherwise. `"workspace"` gives the window a single server whose identity never moves, whichever folders come and go.

A `"project-root"` server that declares `workspace.workspaceFolders.supported` **and** `changeNotifications` does not pay for a second process per folder: the running session takes the new folder through `workspace/didChangeWorkspaceFolders` and is then reachable under both. Servers that declare neither get an instance each. Nothing has to be set on the adapter for this — the capabilities decide.

`getSessions()` returns each server once however many folders it answers for.

`sessionForEditor` may hand back a session that is still starting. Await `activeSessionForEditor` when the next thing you do is a request.

`adaptersForEditor` reports which registered adapters serve an editor. Its answer is settled when the adapter activates and remains stable while its server starts or restarts. Registration does not establish that diagnostics have actually arrived. An adapter that also runs manual project scans uses `createProjectDiagnostics` to yield its scan findings to accepted live reports and restore them when those reports stop covering the document.

The `languageId` sent to the server is resolved in order: `languageIdForScope(scopeName, { editor, filePath })`, then path-aware built-ins, then the scope table, then the blanket `languageId`. The context is what lets one grammar scope distinguish `.js` from `.jsx`.

`getSettings` is pushed as `workspace/didChangeConfiguration` after initialize, and re-pushed whenever a config key listed in `settingsKeyPaths` changes. Changes received while a session is starting are coalesced and pushed once it reaches `running`, so its initialization snapshot cannot make a newer setting disappear. A key read by `resolveServer` or `getInitializationOptions` belongs in `restartKeyPaths` instead: the manager serializes and coalesces those changes, restarts every root, and starts a previously unavailable server for files that are already open. A change matching both lists restarts without first pushing settings to the process being replaced. Without either list the settings are sent once and never refreshed.

`getInitializedNotifications` returns protocol-extension notifications that must follow `initialized` and the initial settings push, such as `css/customDataChanged`. They are written to the connection in array order before the session becomes available to feature providers.

`handleServerRequest` and `handleServerNotification` cover protocol extensions owned by one server rather than LSP itself. Core client handlers still take precedence; the adapter sees only otherwise-unhandled traffic. Requests must return the JSON-RPC result the server expects, while notifications are also emitted through `session.onNotification` after the adapter observes them.

The core handlers include server-initiated `workspace/workspaceFolders`. Its result is the same current folder list sent during initialize, so a server may query it later without an adapter hook. The client also sends folder-change notifications to sessions that declare support for them.

`transformDocumentText` can adapt an editor's text before `didOpen`, `didChange`, and `didSave`, including notebook cell text. For ordinary editor documents the client waits for `whenGrammarSettled()` before reading a projection, coalesces pending full-document changes, and holds document requests until the latest change has reached the server. An adapter that uses it receives full-document changes so the server never sees a mixture of transformed and original text. `restoreDocumentText` reverses the adaptation in formatting, rename, and workspace edits before they reach the editor. A transform must preserve line positions outside the text it intentionally hides. An irreversible projection must refuse host-wide editing features through `isFeatureAvailable`.

`transformDiagnostics` is the adapter's last word on what its server reported, for the diagnostic a server insists on and its own users do not want — `ide-json` drops "Comments are not permitted in JSON" with it. Every route arrives at the same funnel, push notifications and pulled reports alike, so what it returns is what is stored, emitted, counted and handed to a code-action request as context; there is no unfiltered copy behind it. Returning the array unchanged is free. Prefer it over `transformDocumentText` whenever the goal is what the server _says_ rather than what it _sees_: hiding text costs a reversal in every edit that comes back, and one that survives a reformat is rarely writable.

`needsDocumentTransform(editor)` limits adaptation to documents that require it, preserving incremental changes for ordinary files. `getDocumentProjection(editor, { uri, signal })` asynchronously prepares a settled analysis snapshot with `source`, `text`, `isCurrent()`, position/range mappings, ownership gates and atomic `mapEdits()`. A missing or cancelled projection must reject rather than returning raw source. A snapshot may declare `isIdentity: true` only when `text` exactly equals the original `source` and wire positions use original UTF-16 coordinates. When both the previous wire snapshot and current snapshot declare this identity, an incremental-sync server receives the original edit ranges in transaction order; an actual mask, expansion, transition or unknown identity receives a full update. The client coalesces pending changes, holds requests until synchronization completes, gates positions, maps read-only responses and validates complete edit batches before applying them. Projection data belongs to its source revision; a stale response or edit is refused. Projected workspace edits require one atomic text-edit batch per document; repeated sequential batches and unopened projected targets are refused because their intermediate coordinate systems cannot be established safely.

`formatProjectedDocument(editor, projection, { uri, method, range, options, signal, session, isInvocationCurrent })` may format projected Python and return already restored source-coordinate edits. For file/save formatting it may instead return a complete `{ text, edits, isCurrent }` source plan: the client preserves the plan's guard, adds caller and document cancellation guards, and `code-format` independently verifies or derives its target ranges and applies it once. The client captures the original text, selections and pathname before its first asynchronous wait and refuses results after they change. A queued adapter should also consult `isInvocationCurrent()` before starting work and after each wait; its signal combines the formatting request and document synchronization lifetimes. The adapter must preserve protected text through the snapshot's formatting restoration contract and return its entire result before anything is applied. `session.withTemporaryDocument({ uri, languageId, text }, callback, { signal })` serializes non-file-backed analysis documents in that same server session, opens each before the callback and closes it in `finally`. Use a unique Python URI in the original project directory; no physical file is created. Temporary diagnostics are suppressed, and workspace edits against temporary documents are refused.

Each `code-format.*` provider exposes `canFormat(editor, request)` and receives the hub's immutable `{ text, path, reason, kind, signal, isCurrent }` request as the final formatting argument. Eligibility checks the actual server capability and scoped feature switch for that service; save formatting also accepts a server that implements only `willSaveWaitUntil`. A missing capability or stale request returns `null` so the hub can decline safely, while `[]` is a successful no-op. Server failures propagate for the hub to report. The client forwards cancellation to protocol requests and refuses replies that arrive after the caller's request expires. `ide-client:format` consumes `code-format.executor` and explicitly chooses the `ide-client` provider; it requires the hub to be enabled and never applies edits through a separate command path.

`session.supports(method, editor)` honours dynamic registrations, so ask it rather than reading `capabilities` yourself when a server registers capabilities after initialize. A dynamic registration adds support for its matching document selector; a registration for another language does not withdraw a static capability for the current editor. It also honours the feature switches below, which is why it is the only correct way to ask.

`session.canExecuteCommand(command, editor)` checks the server's static and matching dynamic command registrations. Code lenses and code actions execute only advertised server commands; commands naming another editor's client UI are omitted. If an action resolves to an unsupported command, its entire edit is refused before any files change.

`transformServerCapabilities` is the escape hatch for a server that under- or over-reports what it can do.

`resolveRenameTarget({ uri, position }, { session, editor, signal })` can redirect rename to a canonical declaration, such as an interface method whose implementations must change together. Return `{ uri, position }` to retarget, `undefined` to preserve the original target, or `null` to decline. Positions use original UTF-16 source coordinates; the hook is limited to identity documents, and the client rejects the result if the initiating document changes or closes during lookup. The hook may query the same session for read-only information; it must not recursively issue rename or apply edits.

Workspace diagnostics use the same storage and linter funnel as pushed and document-pulled reports. A server declaring `diagnosticProvider.workspaceDiagnostics` is queried as soon as it starts, after relevant edits, settings changes and `workspace/diagnostic/refresh`; full and partial reports replace a URI's messages, unchanged reports preserve them, and result IDs remain separate from the per-document pull stream.

Servers may register several diagnostic providers with different identifiers. The client requests each matching provider, retains its document and workspace result IDs independently and publishes their combined diagnostics. An unchanged provider keeps its cached report when another provider clears; removing a registration removes only that source. Adapter filtering and projection mapping run once on the combined report.

The linter bridge preserves a diagnostic's optional `source` and `code` as separate fields (`code` may be a string or a finite number, including zero). Its optional `relatedInformation` array contains `{ message, location: { file, position } }` for decoded local file URIs with valid ranges; `position` is a copied range in the linter's coordinate shape. Unsupported or malformed URIs and invalid related ranges become `{ message, uri }` for plain display, without an invented file or navigation position. The bridge does not open related targets or external URLs. The `description` remains a plain-text fallback for consumers without structured rendering: source and code first, then each decoded local `path:line:column` and contextual message, using one-based display coordinates. `url` continues to carry the diagnostic's rule-documentation link.

`WorkspaceEdit` stays protocol orchestration rather than a second filesystem implementation. The hub validates document versions, preserves `documentChanges` order, restores transformed text and edits buffers; when the optional `file-operations` package supplies `file-operations.executor`, it delegates closed-path inspection and every create, rename and delete step to that service, then retargets open buffers from the durable effects the executor reports. Executor lifecycle scopes hold project watcher events across private staging, discard internal paths, preserve unrelated and descendant events, and publish one canonical LSP file-operation outcome. Resource operations are omitted from client capabilities when the service is absent, and an unexpected resource edit is rejected before any text changes with `failureReason` and the original zero-based `failedChange`. The public `applyWorkspaceEdit` method retains its boolean result for compatibility.

The `tree-view.file-operations` service supplies the user-operation boundary that filesystem watchers cannot. Ordinary tree-view renames proceed without a language-server preparation request. A rename payload with `updateReferences: true` explicitly requests `workspace/willRenameFiles`; matching servers prepare reference updates before the move. Create and delete operations continue to send `workspace/willCreateFiles` and `workspace/willDeleteFiles`. Completed operations, including ordinary renames, emit the matching `workspace/did*Files` notification; ordinary project watcher events still cover external create, update and delete changes.

A tree-view service declaring `supportsStagedPreparations()` as `true` receives `{ commit({ isCurrent } = {}), dispose() }` from preparation callbacks that returned edits. The client collects the raw edits and captures open-document state before requesting them; it opens targets and preflights the combined edits only when tree-view commits after every listener, path and dialog guard passes. Cancellation and later vetoes dispose the stage without changing text. A changed relevant buffer, document generation or projection refuses the stage, while unrelated edits do not. Services without staging support accept empty preparations but must upgrade before applying real edits. The public `willCreateFiles`, `willRenameFiles` and `willDeleteFiles` methods retain their boolean results and explicitly commit preparation immediately; `willRenameFiles` needs no `updateReferences` flag when called directly.

File-operation payloads may carry an `AbortSignal`. Aborting stops the wait locally, sends cancellation to the server and discards late replies even when the server ignores cancellation. `ide-client.fileOperationPreparationTimeout` bounds the whole collection across matching servers, defaults to 30 seconds and accepts 1–3600 seconds. Manual cancellation stays quiet; a timeout or stale preparation reports its reason. Real text-edit targets remain open with unsaved changes for review, and empty edit entries require no editor or projection snapshot.

## Progress

`ide-client` owns the optional `busy-signal` integration for every adapter and custom server. Adapters do not consume that service themselves. The client tracks server startup and common finite language requests, adding a fallback description when either remains pending after 400 ms; an operation that settles sooner adds no fallback message. Persistent `workspace/diagnostic` subscriptions have no fallback indicator and appear only while the server reports work. Responses, errors and cancellation clear request activity, while stopping or losing a session clears every operation it owns.

The client supplies `workDoneToken` during `initialize` and for supported language requests whose server capability declares `workDoneProgress: true`. The server can describe those operations with standard `$/progress` begin, report and end notifications. Partial results also use `$/progress`, but remain routed to their result consumer rather than appearing as work-done activity.

Background work after a request has answered must use its own server-initiated `window/workDoneProgress/create` token. The client advertises `window.workDoneProgress` and accepts that request; a server uses the resulting token for one begin, its reports and one end. This is how a server reports workspace indexing or re-indexing without tying it to a pending editor request. The client cannot observe unreported server work, so a server that performs such work must report its actual lifetime. An initialize token is valid only until the initialize response; server-initiated progress starts after initialization.

Each independent operation owns a busy-signal provider, so identical titles in concurrent requests or project roots do not collide. Active records remain available when `busy-signal` is absent and reappear if the service reconnects. Operation completion removes the active message; teardown also releases its provider. Long-lived server processes belong in the separate server status-bar item rather than keeping the busy indicator active.

When an operation can be cancelled, clicking its active entry in the busy indicator's tooltip requests cancellation. Client-owned progress cancels the corresponding request; independent server progress sends `window/workDoneProgress/cancel` and remains visible until the server ends it. Commands whose cancellation policy only abandons their response, including references and execute-command requests by default, do not offer that action.

## Notebook documents

`openNotebookDocument(descriptor)` teaches the hub a notebook: LSP 3.17 notebook sync, per capable session. The descriptor carries the notebook's `filePath`, its `notebookType` (defaults to `"jupyter-notebook"`), and the **full ordered cell list** — markup cells included, because the 1-based cell numbers diagnostics carry count every cell — each cell with a stable `id`, its `kind`, and its live `editors`. The returned bridge has `updateCells(cells)` for structural changes (the hub computes the LSP deltas), `didSave()`, and `dispose()`; content sync follows each code cell's buffer on its own. The caller of record is `jupyter-view`, whose own bridge adapts its document model to this shape — another notebook UI would drive the same bridge.

Structural updates and saves wait for the initial open, earlier mutations and pending cell projections. Typing during structural preparation follows that structure with its own notebook version. Disposal immediately releases locally adopted cells and sends `didClose` only for a notebook actually opened on the server. A failed open rolls back session ownership so attachment can be retried. `updateCells` returns a promise for its queued reconciliation, and `didSave` returns one for the queued save while the bridge remains open.

What follows from an open bridge, with no further wiring:

- Each cell is its own text document under a `vscode-notebook-cell:` URI whose path component is the notebook's, so client and server positions are both cell-relative — identity, no mapping.
- Only sessions whose server advertises a matching `notebookDocumentSync` ever see the notebook, and only they are asked about cell URIs. A same-grammar server without notebook sync is never consulted for a cell.
- Cell editors route through every provider — completions, hover, signature, code actions, formatting — exactly like file editors.
- Cell diagnostics aggregate per notebook and reach the linter against the notebook's path with `cell` numbers, the same shape project scans emit; jupyter-view's adapter projects them onto the cells.
- Workspace edits and `window/showDocument` targets naming cell URIs land in the right cell buffers; the descriptor's `show` callback is how server-initiated navigation reveals a cell.

An untitled notebook cannot open — `openNotebookDocument` returns `null` until the notebook has a path. The bridge is **path-immutable**: on a save-as, dispose it and open a new one, which is also how servers expect a renamed notebook to behave.

A server that exits on its own is restarted on a growing delay, up to `restartLimit` times in a row, and the session is replaced each time — an adapter that holds one has to follow `onDidChangeSession` rather than keep the reference. The limit counts a failure run rather than the life of the window: a server that stays up for a minute has its restarts back, and one that dies on every start reaches the limit and is reported to the user with a way into its log. A restart somebody asked for, through `restart(session)` or the server list, starts a new run. Parallel requests for one logical server share one operation; configuration changes arriving during it cancel the stale start, are coalesced, and leave the final process on the newest configuration. The complete startup input — launch, initialization options, workspace folders, and initial settings — is prepared before the healthy process is stopped, so an invalid new setting leaves it running. `restart` resolves `null` if the adapter returns no launch, its session became stale, or teardown cancelled the operation. A server that fails its very first start is reported once and not retried, since nothing about it has worked yet.

Each logical server owns its startup, restart, settings and shutdown operations through one session controller. Removing a session from routing does not release ownership of a child process that may still be alive. Failed cleanup of an initial or superseded start blocks another process for that route until physical exit; independent project roots can continue to start their own servers. Retry and idle timers belong to that controller and expire with it. Publication callbacks may stop or supersede a session, or close its initiating editor, before startup; the client rechecks ownership and demand before launching. Window teardown cancels outstanding transition and exit waits while still attempting cleanup of every owned process.

## Managed servers

An adapter that declares `managedServer` lets the editor fetch its server, keep it current and remove it again, and appears in the Manage Servers list. Nothing else changes: the descriptor is data, and `resolveServer` stays the only thing that decides what runs.

```ts
type ManagedServerDescriptor =
  | {
      source: "github-release";
      displayName?: string;
      repository: string; // "owner/name"
      assetFor(c: { platform: string; arch: string; version: string }): string | null;
      checksum: "sha256-sidecar" | "none";
      assetType?: "archive" | "binary"; // defaults to archive
      binary: string; // installed base name; located inside an archive when applicable
      strip?: number;
    }
  | {
      source: "npm";
      displayName?: string;
      packages: Array<string | { name: string; version?: string }>;
      module: string; // entry module, relative to the install directory
      bundled?: boolean; // the package also ships the server, so uninstall falls back
    };
```

Everything lands in `<configDir>/language-servers/<adapter.id>/`, one directory per adapter whatever the source. The installed copy is handed back on `context.managedServer`, so `resolveServer` reads one field rather than knowing that layout:

```js
async resolveServer(context) {
  const configured = lumine.config.get("my-package.serverPath");
  if (configured) return { command: configured };
  if (context.managedServer)
    return { command: context.managedServer.binaryPath, version: context.managedServer.version };
  return { command: await which("my-langserver") } ?? null;
}
```

That order is the convention: an explicit setting wins, then the copy the user asked the editor to install, then whatever is on `PATH` — which is also where uninstalling lands.

Four things are worth knowing before writing a descriptor:

- **`assetFor` returns an exact file name**, never a pattern. A release commonly carries other archives whose names share a prefix — tinymist publishes `tinymist-docs-tool-<target>` beside the server's own — and a prefix match fetches the wrong one. Returning `null` says this platform has no build, which is reported rather than guessed at.
- **`checksum` is stated, not inferred.** `"none"` records a source that publishes nothing to verify against; texlab is one today. Making that a value in the descriptor keeps the gap visible in the adapter instead of being a step the installer quietly skips.
- **`binary` is a base name.** Archives put it at the root or one directory down, and it is searched for rather than predicted. Set `assetType: "binary"` when the release asset is the executable itself; it is installed under this base name and made executable on macOS and Linux.
- **An npm source is an upgrade tier when the package already ships the server.** Set `bundled: true` and keep the dependency: the pinned copy stays the floor, so uninstalling drops back to it and can never leave the user with nothing. `ide-basedpyright` works this way.
- **An npm companion can pin its own version.** A string keeps the old behavior — the first package follows the selected server version and later packages use `latest`; use `{ name, version }` for a companion that must stay inside a compatible range.

Descriptors are validated at `registerAdapter`, not at install time, so a typo surfaces when the package activates.

Installing, updating and removing all stop the adapter's sessions first, swap the directory, and re-attach — Windows refuses to replace a running executable, and a server that keeps running through the swap would go on serving from a directory that no longer exists.

### Fetching your own server

A descriptor only describes the shapes it was designed for. An adapter whose server does not fit one — several binaries rather than a server, a release layout nobody anticipated — implements `installServer` instead and uses the primitives the hub hands it. This is the model Zed's extension API uses, and the names mirror it deliberately.

```js
async installServer({ storagePath, api }) {
  api.setServerInstallationStatus("downloading");
  const release = await api.latestGithubRelease("owner/tool");
  const asset = release.assets.find((a) => a.name === assetForThisPlatform());
  await api.downloadFile(asset.url, storagePath, {
    type: "gzip-tar",
    digest: asset.digest,
  });
  await api.makeFileExecutable(`${storagePath}/tool`);
  return { version: release.version, binary: "tool" };
}
```

Fill `storagePath` and return `{ version, binary }` or `{ version, module }` naming what to launch, relative to the install directory. An adapter with `bundledServer: true` may return only `{ version }` when the managed payload contains companion tools and the server itself remains the bundled copy; `managedServerDisplayName` gives that toolchain its own label in Manage Servers. Everything else is unchanged: the hub stages, swaps atomically, restores an interrupted swap from its backup on the next start, writes the same `install.json`, stops and restarts sessions in the same order, and reports the same status. It is the descriptor path without the descriptor.

| primitive                                          |                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `latestGithubRelease(repository, { preRelease })`  | `{ version, tag, assets: [{ name, url, size, digest? }] }`; throws with the status rather than resolving empty                                 |
| `githubReleaseByTag(repository, tag)`              | the same shape                                                                                                                                 |
| `npmPackageLatestVersion(name)`                    |                                                                                                                                                |
| `npmPackageInstalledVersion(name, directory)`      | `null` when absent                                                                                                                             |
| `npmInstallPackage(name, version, directory)`      | installs the package and its tree; `--omit=dev --ignore-scripts`                                                                               |
| `downloadFile(url, destination, { type, digest })` | verifies an optional `algorithm:hex` digest before writing or extracting; `type` ∈ `uncompressed` \| `gzip` \| `gzip-tar` \| `xz-tar` \| `zip` |
| `makeFileExecutable(path)`                         | no-op on Windows                                                                                                                               |
| `verifyFileChecksum(path, digest)`                 | verifies an already-written file against an `algorithm:hex` digest                                                                             |
| `setServerInstallationStatus(status)`              | `checking` \| `downloading` \| `installing` \| `failed` \| `null`                                                                              |

Two things to know. **`managedServer` and `installServer` are mutually exclusive** — declaring both leaves it ambiguous which one fills the staging directory, and is rejected at `registerAdapter`. And a custom installer still owns verification policy: pass the release asset's `digest` to `downloadFile`, or call `verifyFileChecksum` for a file acquired another way; omitting both is an explicit unverified download.

XZ tar archives use a small WebAssembly decoder and the existing Node tar implementation, without a native decompressor or host archive tool. Extraction validates the complete entry list before writing files: only regular files and directories are accepted, traversal and ambiguous paths are refused, and existing files or directory links cannot be overwritten or followed. Component stripping and executable permissions are preserved; temporary decoded tar data is removed after success or failure.

Managed release metadata, payload and checksum GETs retry transient HTTP 429, 500, 502, 503 and 504 responses or transport failures at most twice, with 250 ms and 500 ms backoff. Each attempt allows ten seconds to receive response headers; the deadline is cleared before reading the body so large active SDK transfers continue. Permanent HTTP errors, malformed metadata, cancellation and checksum mismatches are not retried.

Implement `latestServerVersion(api)` as well if the Manage Servers list should have a version to compare against; without it the row simply reports what is installed.

### One status vocabulary

Whatever an adapter does underneath, it reports through `setServerInstallationStatus`, and the hub sets the same states around every install it runs. That is deliberately the only place uniformity is enforced: the Manage Servers rows and the busy indicator read the status, never the mechanism. A user should never learn that one server arrives as a GitHub asset and another as an npm tree.

### Saying the server is missing

Do not raise the notification yourself. Call `reportMissingServer(adapterId, { description })` from the `resolveServer` branch that returns `null`, and the hub handles the rest:

```js
if (!launch) {
  service.reportMissingServer("ide-ruff", { description: "Install Ruff and …" });
  return null;
}
```

It fires **once per window per adapter**, adds an **Install** button when the adapter declares `managedServer` or implements `installServer`, and always adds **Never Ask Again**. Either button closes the notification — a notification button dismisses nothing on its own, and both answers here are final, so a banner still asking the question is the only thing on screen saying whether the click registered. It is a warning, not an error: an adapter with no server is not broken, it simply has nothing to run, and several such packages installed at once otherwise means a stack of red banners for tools the user may never have wanted.

Never Ask Again writes `false` to `<adapter.id>.notifyWhenMissing`, so **declare that setting in your `configSchema`** or the user has no way to turn it back on:

```json
"notifyWhenMissing": {
  "title": "Notify When Missing",
  "description": "Show a notification when the language server cannot be found, offering to install it.",
  "type": "boolean",
  "default": true
}
```

The once-per-window flag is cleared as soon as a session for that adapter starts, so a server that is removed later is reported again rather than staying silent.

## Features

More than one adapter commonly covers one grammar — a type checker beside a linter — and for the requests whose answers cannot be merged the hub has to pick one server. Left to itself it picks whichever adapter registered first, which is package activation order and says nothing about which server the user wants. The feature switches are how that choice is expressed: a switched-off server is skipped, and the next one that can serve the request answers instead.

The vocabulary is `diagnostics`, `autocomplete`, `hover`, `signature`, `definition`, `references`, `callHierarchy`, `typeHierarchy`, `symbols`, `format`, `rename`, `codeActions`, `inlayHints`, `codeLens`, and `semanticTokens`. They are names for what the user sees, not protocol methods: one switch covers all three formatting requests, and `symbols` supplies go-to-symbol, the outline, and breadcrumbs from one document-symbol result.

Declare them in your `package.json` under `features`, listing **only what your server actually advertises** — a switch for a capability the server never had is a control that does nothing:

```json
{
  "configSchema": {
    "features": {
      "title": "Features",
      "description": "Which parts of this server the editor uses.",
      "type": "object",
      "properties": {
        "hover": {
          "title": "Hover",
          "description": "Show this server's documentation on hover.",
          "type": "boolean",
          "default": true
        }
      }
    }
  }
}
```

The hub reads `<adapter id>.features.<name>` by default. Set `featuresKeyPath` to an explicit base such as `ide-css.features` when several adapters share one package's settings. Every switch is read through the editor's scope, so a user can override one per language. A feature nobody named is on. `isFeatureAvailable(feature, context)` can return `false` to refuse a capability the adapter cannot safely offer in that document; configuration cannot override this restriction. The context may be a full editor, a scope-only object exposing `getRootScopeDescriptor()`, or absent. Scope-only contexts are used for adapter-level checks and diagnostics for paths without an open editor, including after a document closes; they do not have `getGrammar()` or `getPath()`. The descriptor may be a `ScopeDescriptor` or an array of scope names. For example, an HTML projection can complete embedded markup while refusing to format its host document.

The `features` field on the adapter object is the fallback for an adapter with no config namespace — a custom server from `language-servers.json`, whose id carries a colon. A package should use `configSchema`, which the user can actually change; that wins over the field.

`diagnostics` is the odd one: servers may push them or expose the LSP 3.17 pull model. Switching diagnostics off hides stored results; pull-capable servers are also not queried until the switch is enabled again.

## Teardown

The provided service object belongs to one activation and remains stable during it. Deactivation invalidates all retained methods with `AbortError`; reactivation publishes a new object. Consumers must return their edge's disposable and reacquire the service after replacement. A late callback from an earlier edge cannot register adapters or mutate the new manager.

`registerAdapter` returns a `Disposable` that unregisters that exact adapter object and stops every current or in-flight session it owns — return it directly from `consumeIdeClient`, as in the example. `stop(session)` first removes its whole logical server from routing, cancels restart and retry work, and then waits for all of its process generations to stop. Sessions are also stopped when `ide-client` deactivates, so an adapter needs no shutdown logic of its own.

That holds for a window reload too, which never deactivates a package: the servers are killed as the window goes away rather than asked to shut down, since no LSP round trip can finish at that point. Do not add an unload handler of your own — a language server is a child process, and one left running is orphaned for the life of the machine.

Teardown never stops early. A server that cannot be shut down cleanly is reported and skipped, so it cannot strand the servers beside it. The one exception is `stop(session)`, which rejects, because a stop somebody asked for should be able to say it failed.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
