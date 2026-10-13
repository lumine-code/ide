# ide

Language Server Protocol hub infrastructure.

Coordinates language-server adapters, starts sessions lazily when matching editors open, and exposes shared language features through the `ide` service.

## Features

- **Sessions**: starts every matching adapter lazily, scoped to a project root or the workspace, and safely serializes restarts and shutdown.
- **Protocol lifecycle**: negotiates document and notebook synchronization, dynamic capabilities, workspace folders, watched files, file-operation notifications, progress and three JSON-RPC transports; serializes notebook opening and structural updates.
- **Language features**: supplies completions, symbols, hover, signatures, references, document links, folding, selection ranges, linked editing, colors, formatting, rename, code actions, inlay hints, code lens and semantic tokens.
- **Diagnostics**: combines pushed, per-document pull and workspace pull reports and forwards their current state to the linter package.
- **Feature routing**: merges answers where useful and lets adapter switches choose one of several servers where only one result can apply; cancels superseded requests and discards results for changed documents.
- **Managed servers**: downloads, verifies, updates, rolls back and removes server binaries, npm packages and companion toolchains.
- **Inspection**: exposes server state, capabilities, documents, diagnostics, logs and lifecycle actions through the server list and status bar.
- **Activity**: reports server startup, slow requests and server-reported background work through the shared busy indicator, keeping concurrent operations independent.

## Installation

To install `ide` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide`.

Install the separate `file-operations` package if language servers should be allowed to create, rename or delete files through `WorkspaceEdit`. Without it, text edits and all other language features continue to work, while resource operations are not advertised.

## Commands

Commands available in `lumine-workspace`:

- `ide:servers`: list the running language servers and act on one of them,
- `ide:manage-servers`: list the language servers the editor can install and act on one of them,
- `ide:restart`: restart the language servers for the active editor,
- `ide:toggle-problems`: open the linter panel with the server diagnostics,
- `ide:format`: format the active document through `code-format`, choosing its language-server provider,
- `ide:show-log`: open the active server's log in a new editor,
- `ide:open-custom-servers-file`: open the custom servers configuration file,
- `ide:fold-server-ranges`: fold every range the active file's language server reports,
- `ide:expand-selection-range`: expand each selection to the next parent range from the language server,
- `ide:select-linked-ranges`: select every range linked to the symbol under the cursor,
- `ide:color-presentation`: choose and apply a language-server spelling for the color under the cursor.

Commands available in `.ide-session-menu`:

- `ide:show-details`: show what the selected server reports about itself,
- `ide:restart-server`: restart the selected server without leaving the list,
- `ide:stop-server`: stop the selected server until a matching editor opens again,
- `ide:show-server-log`: open the selected server's log in a new editor,
- `ide:show-problems`: open the linter panel with the diagnostics of every server.

Commands available in `.ide-managed-servers`:

- `ide:install-server`: download and install the selected server,
- `ide:update-server`: install the newest release of the selected server,
- `ide:uninstall-server`: remove the copy the editor installed,
- `ide:check-server-updates`: look up the newest release of every installable server.

Commands available in `.ide-color-presentations`:

- `ide:apply-color-presentation`: apply the selected color spelling.

## Documentation

- [Language servers](docs/language-servers.md): install adapters and frontends, manage server copies, configure custom servers and diagnose sessions.
- [Code intelligence](docs/code-intelligence.md): use diagnostics, completion, symbols, navigation and other feature frontends.
- [Writing a language-server adapter](docs/language-server-adapter.md): implement and test an adapter through the shared resolver.
- [`ide` service](docs/ide.md) and [TypeScript declarations](lib/main.d.ts): the canonical public contract and lifecycle.
- [Editor API](https://lumine-code.github.io/api/): editor objects used by integrations.

## Customization

Tweak the server list, its details step, and the status-bar item from your stylesheet. The item stays the color of the status bar whatever the servers are doing, but it carries `has-starting` and `has-failed` so you can say otherwise:

```css
.ide-session-state {
  font-weight: bold;
}
.ide-session-detail .ide-session-value {
  color: var(--text-color-subtle);
}
.ide-server-status .ide-server-label {
  color: var(--text-color-info);
}
.ide-server-status.has-failed .ide-server-label {
  color: var(--text-color-error);
}
```

## Services

- [`ide`](docs/ide.md): provided to adapter packages to register language servers and reach sessions.
- `autocomplete.provider`: provided to autocomplete to serve language-server completions.
- `symbol.document-provider`: list applicable language-server sources through `getDocumentSymbolSources(editor, { signal })` and retrieve the exact `sourceId` through `getDocumentSymbols(editor, { sourceId, signal, timeoutMs })`. Each adapter has a stable `ide:<adapter.id>` source ID, its full display name, the `LS` label and score `1`; sources report ready, starting or unavailable state. Session, adapter, notebook, capability and feature changes invalidate affected document results.
- `symbol.workspace-provider`: merge workspace symbols from supporting servers already running for the requested project roots. Searching never starts a server or opens a document; unavailable, starting, partial and failed sources are reported separately from an empty successful search.
- `symbol.definition-provider`: resolve the symbol at the requested position through the first supporting language server.
- `context-help.provider`: provided to serve documentation at a buffer position in tooltips and the documentation panel.
- `hover.signature-provider`: provided to signature-help UIs to serve call signatures while typing.
- `code-format.range`: provided to formatting orchestrators; resolves a selected range to text edits from the server.
- `code-format.file`: provided to formatting orchestrators; resolves a whole file to text edits from the server.
- `code-format.on-type`: provided to formatting orchestrators; resolves text edits as the user types a trigger character.
- `code-format.on-save`: provided to formatting orchestrators; resolves text edits on save.
- `find-references.provider`: provided to reference UIs to list occurrences of the symbol at a position.
- `refactor.provider`: provided to rename UIs; resolves to a path-to-edits map, with prepare support.
- `intentions.list`: provided to the intentions UI to serve code actions and quick fixes at the cursor.
- `code-lens.provider`: provided to the code lens UI to serve the actionable links shown above the code.
- `inlay-hints.provider`: provided to the inlay hints UI to serve the labels a server computes for the visible rows.
- `semantic-tokens.provider`: provided to the semantic tokens UI to serve the server's classification of the identifiers.
- `hyperclick.provider`: provided to hyperclick to follow language-server document links, resolving lazy targets only when clicked.
- `code-format.executor`: consumed to run `ide:format` through the same guarded editor formatting path as the hub's commands and save hook. Install and enable `code-format` to use this command.
- `file-operations.executor`: consumed to preflight and execute the create, rename and delete steps in a server `WorkspaceEdit`.
- `linter.registry`: consumed to push server diagnostics into the linter UI, one delegate per server.
- `busy-signal`: consumed to surface server startup, slow requests and server work-done progress on the busy indicator.
- `status-bar`: consumed to show the running servers in an item that opens the server list.
- `tree-view.file-operations`: consumed to stage create and delete preparations and explicitly requested reference updates, then report completed file operations.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
