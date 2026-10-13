# Writing a language-server adapter

An adapter package teaches the minimal `ide` protocol hub how to launch and configure a language server. The adapter owns server discovery and server-specific settings; `ide` owns sessions, LSP synchronization and routing into editor services, while frontend packages own presentation.

## Registering

Consume the `ide` service as shown in the [registration contract](ide.md#registration), then register an adapter through the shared resolver:

```js
module.exports = {
  consumeIde(ide) {
    return ide.registerAdapter({
      id: "ide-example",
      displayName: "Example Language Server",
      grammarScopes: ["source.example"],
      restartKeyPaths: ["ide-example.serverPath"],
      async resolveServer(context) {
        const selected = await context.resolver.select({
          configuredPath: lumine.config.get("ide-example.serverPath"),
          managed: () => {
            const installed = context.getManagedServer();
            return installed ? { path: installed.binaryPath, version: installed.version } : null;
          },
          kind: "executable",
          names: ["example-ls"],
          signal: context.signal,
        });
        if (!selected) {
          ide.reportMissingServer("ide-example", {
            description: "Install Example Language Server or choose its Server Path.",
          });
          return null;
        }
        return context.resolver.launch(selected, {
          args: ["--stdio"],
          cwd: context.rootPath,
          signal: context.signal,
        });
      },
    });
  },
};
```

Returning the registration disposable from the consumer unregisters the adapter and stops its sessions when either package deactivates.

The canonical contract, optional hooks and service methods live in [the `ide` contract](ide.md); exact TypeScript shapes live in [`lib/main.d.ts`](../lib/main.d.ts). Keep detailed API descriptions there rather than copying them into an adapter.

Language-server hover responses reach [`context-help.provider`](https://github.com/lumine-code/documentation-view/blob/master/docs/context-help.provider.md) through `ide`. `documentation-view` aggregates and renders them for its persistent dock and for `hover` tooltips; adapters do not need separate panel or hover providers. Signature help continues through the separate `hover.signature-provider` service.

## Architecture boundaries

Adapters register through `ide`; they do not consume filesystem executors, tree-view internals, hover panels or other frontend services themselves. The [client behavior contract](ide.md#behavior) owns document edits, optional `file-operations.executor` staging, and the separate user-operation boundary supplied by `tree-view.file-operations`. The user-facing [file operation guide](language-servers.md#file-operations) explains when reference updates are requested.

Preparation hooks must honor their cancellation signal. The hub applies its shared 30-second default deadline and rechecks the captured operation and document snapshots before applying staged edits; [the contract](ide.md#behavior) defines cancellation, expiry and guard ownership.

## What the adapter owns

- `id`, `displayName` and `grammarScopes` identify the adapter and the editors it serves.
- `resolveServer(context)` returns a validated launch or `null` after reporting how to install a missing server. Use `context.resolver` for path selection and launch construction, and put every command argument in `args`. Native selection rejects Windows `.cmd` and `.bat` wrappers by default; an adapter deliberately handling a wrapper opts into `allowShellWrapper`, while custom-server commands retain the client's explicit Windows wrapper route.
- `languageIdForScope(scopeName, {editor, filePath})`, initialization options, settings, protocol-extension hooks and document transforms are optional; use only the hooks the server needs. The editor context lets one grammar scope distinguish file variants such as `.js` and `.jsx`.
- `getInitializedNotifications({session, rootPath, rootUri})` may return `{method, params}` notifications that must follow the initial settings push, such as `css/customDataChanged`.
- Leave `sessionScope` at its default, `"project-root"`, unless the server has no root concept. Servers advertising multi-root support are shared across folders automatically.

## Settings and feature switches

Declare options in the package's `configSchema` in the shape the server expects. Use `getSettings` and `settingsKeyPaths` for live settings; put options needed for server resolution or initialization in `restartKeyPaths`. Omit empty editor values so project configuration remains authoritative. The [configuration hook contract](ide.md#configuration-and-adapter-hooks) defines the current `{rootPath, rootUri, launch, resolver, session?}` context and how to retain launch-dependent state safely across concurrent roots and replacements.

Put feature switches under `configSchema.features` and declare only capabilities in the server's `initialize` response. The [feature contract](ide.md#features) owns their vocabulary and scoped resolution. Disable work inside the server only when that cannot defeat a grammar-scoped true override elsewhere in the same session.

## Resolving and managing the server

Use the shared [server resolver](ide.md#server-resolution) for configured, managed, bundled and discovered candidates. Its contract defines lazy managed lookup, validation failure handling, absolute selections, runtime/payload separation, Node launches, Windows shell-wrapper opt-ins and startup cancellation. Keep SDK probes in `validate(path, {source, signal})` and reuse their results as `selection.data` when constructing arguments and environment overrides.

Select a JavaScript entry with `kind: "node"` and use `launch`, or call `nodeEntry` directly. Use `configuredKind: "auto"` when an explicit server path may select either a native executable or a `.js`, `.cjs` or `.mjs` entry. An adapter receives shared resolver code through the service rather than importing another package's runtime.

Declare a [managed server](ide.md#managed-servers) when a GitHub-release asset or npm package descriptor can model its installation. Name each platform's exact asset and checksum policy. An npm companion can use `{name, version}` to stay inside a compatible range: TypeScript 7, for example, cannot replace the TypeScript 6 runtime expected by the current servers. `ide-basedpyright` and `ide-typescript` use `source: "npm"` with `bundled: true`, so removing a managed upgrade restores their shipped dependency.

Use `installServer` for several binaries or an unusual release layout; `ide-bash` is the fleet example. The hub owns staging, replacement, rollback, installation leases and status reporting. The adapter owns checksum verification when using the low-level download primitive. Custom hooks receive `{storagePath, version, api, adapter, signal}`; forward that signal to adapter-owned subprocesses, downloads and probes, and check it before direct writes. [Installation lifetime rules](ide.md#fetching-your-own-server) define cancellation and retained helper expiry.

Call [`reportMissingServer`](ide.md#saying-the-server-is-missing) and return `null` when discovery finds no server. Preserve errors from a broken configured or managed selection so users can repair or remove that installation. A configured payload bypasses unrelated managed records; choosing only Java, Ruby, PowerShell or Rscript does not replace the independently selected server payload.

## Specs

Exercise the actual shared resolver in specs: verify resolution order, a valid configured payload with a throwing managed getter, rejection of a broken explicit or managed selection, continued discovery after an unsupported candidate, and cancellation during a probe. Test every supported platform's exact asset name. Add a live protocol suite for the real server; a native server may be skipped locally, but CI downloads a pinned, checksum-verified binary so the suite cannot silently disappear there.
