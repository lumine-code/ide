# Language servers

The optional **`ide`** package is the editor's minimal Language Server Protocol 3.17 hub. It starts and synchronizes servers, coordinates protocol operations, and routes results to editor services; feature packages render those results, and separate optional infrastructure can perform filesystem changes. `ide` is not bundled.

## Installation

A working setup has three layers:

1. Install `ide`.
2. Install an adapter for each language, such as `ide-typescript`, `ide-eslint`, `ide-bash`, `ide-html`, `ide-yaml`, `ide-marksman`, `ide-basedpyright`, or `ide-ruff`.
3. Install the frontends you want: `autocomplete` for completions, `linter` for diagnostics, `symbol` plus a symbol provider for symbol lists, and packages from [Code intelligence](code-intelligence.md) for other features.

Install the optional, UI-less `file-operations` package when language servers should be allowed to create, rename or delete files through `WorkspaceEdit`. Without it, text edits and the other language features continue to work, while `ide` does not advertise resource-operation support.

For example, a minimal TypeScript setup with completions and diagnostics is:

```sh
lumine --install lumine-code/ide
lumine --install lumine-code/ide-typescript
lumine --install lumine-code/autocomplete
lumine --install lumine-code/linter
```

A minimal CSS and HTML setup with completions is:

```sh
lumine --install lumine-code/ide
lumine --install lumine-code/ide-css
lumine --install lumine-code/ide-html
lumine --install lumine-code/autocomplete
```

For indented `.sass` files, also install `ide-sass`:

```sh
lumine --install lumine-code/ide-sass
```

Installing an adapter alone does not install or replace `ide`; adapters connect to it through an editor service. Each adapter's settings page contains its server path, feature switches, and server-specific options. Project configuration files such as `tsconfig.json`, `pyrightconfig.json`, and `ruff.toml` continue to apply when the corresponding editor setting is left empty.

Through `jupyter-view`, servers with notebook support — including Basedpyright and Ruff — can analyze notebook cells. The same document transforms apply to ordinary editors and cells, so IPython magics and adapter-specific source masking stay out of diagnostics without changing notebook text.

Tree View renames files and folders without waiting for language servers. Use `tree-view:confirm-and-update-references` from the rename dialog's actions, or press Alt+Enter there, when you also want servers to update imports, paths or links in other document buffers. These text edits are not saved automatically. Ordinary document synchronization and supported file-change notifications run with both choices. Files that need no reference changes stay closed.

While the rename dialog is preparing reference updates, cancelling it or changing the entered path discards the preparation. A changed source or destination, or another integration refusing the operation, also prevents those edits. Server preparation has a default limit of 30 seconds, configurable through **File Operation Preparation Timeout** in the IDE settings; exceeding the limit stops the operation and reports the timeout. After all checks pass, the dialog closes and execution begins. Real reference edits remain in ordinary document tabs until you save or undo them.

## C, Rust, Go, TOML and R

These adapters use the same `ide` and frontend packages as the other languages:

| Adapter      | Languages                             | Server           | Additional setup                                                                                                               |
| ------------ | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ide-clangd` | C, C++, Objective-C and Objective-C++ | clangd           | install `language-c`, or `language-objective-c` for Objective-C; provide your project's compilation database.                  |
| `ide-rust`   | Rust                                  | rust-analyzer    | install `language-rust` and a Rust toolchain; `rust-src` enables standard-library navigation and `rustfmt` enables formatting. |
| `ide-gopls`  | Go                                    | gopls            | install `language-go` and the Go SDK; open the folder containing `go.mod` or `go.work`.                                        |
| `ide-tombi`  | TOML                                  | Tombi            | install `language-toml`; `tombi.toml` can select schemas and project formatting rules.                                         |
| `ide-r`      | R source files                        | R languageserver | install `language-r` and R; Manage Servers can install the `languageserver` package into a private R library.                  |

For CMake projects, `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` generates the `compile_commands.json` clangd uses to resolve include paths, macros and compiler options. The adapter's Compile Commands Path selects another database directory, and Fallback Flags cover files without a database entry. Project `.clangd` and `.clang-format` settings continue to apply.

The Go SDK remains necessary after installing gopls because the server uses it to load modules and dependencies. Go Path selects the SDK's `go` or `go.exe` executable when it is outside PATH. Rscript Path similarly selects the R runtime; the R adapter uses that installation's libraries, the managed library when present, or Library Path for another library. A `.lintr` file controls R diagnostics, and `.Rprofile` can customize the server's styler formatting.

Tombi respects project configuration before editor fallback settings. Local schema associations entered in the editor use absolute paths or URLs; relative schema paths belong in `tombi.toml`. Its supported features include schema diagnostics, completions, hover, navigation and formatting; the server does not implement rename.

Rust and R reference code lenses use client commands specific to other editors, so these adapters disable those lenses. References remain available through `find-references`. Rust-analyzer does not implement type hierarchy; clangd, gopls and R expose the hierarchies their servers support.

## Java, C#, PHP and Ruby

Install `ide`, the language grammar and the adapter, then choose the frontends for the features you want:

| Adapter        | Server                            | Runtime and project setup                                                                                                             |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ide-jdtls`    | Eclipse JDT Language Server       | use a Java 21 or newer JDK and `language-java`; open the project's Maven, Gradle or Eclipse root.                                     |
| `ide-roslyn`   | Standalone Roslyn Language Server | use the .NET 10 SDK and `language-csharp`; open the solution or project folder.                                                       |
| `ide-phpantom` | PHPantom                          | use `language-php`; open the Composer project root, or a folder of PHP files. Built-in analysis and formatting need no PHP runtime.   |
| `ide-ruby`     | Ruby LSP                          | use Ruby 3.0 or newer and `language-ruby`; select the project's Ruby version and run `bundle install` when the project has a Gemfile. |

Manage Servers installs the server independently of its runtime. Java uses a milestone distribution with separate Eclipse cache directories for each project and editor window. Its launch JDK requires Java 21 or newer; project build files can still target earlier Java versions. Ruby installs gems into a private directory and records the selected Ruby ABI and platform; reinstall the managed server after changing to an incompatible runtime. Windows native gem dependencies need RubyInstaller's Devkit or equivalent build tools.

C# uses Microsoft's standalone MIT-licensed Roslyn NuGet distribution, currently published as a prerelease. The adapter launches `Microsoft.CodeAnalysis.LanguageServer.dll` directly through the selected .NET runtime, preserving the full MSBuild payload. Roslyn requires .NET 10 to start and an SDK to load projects; keep other SDKs required by `global.json` installed too. **.NET Path** can select a portable SDK, and an explicit server selection can name the engine DLL. Project solutions, dependencies and SDK selection remain authoritative.

PHPantom reads `composer.json` and `.phpantom.toml` directly. Its adapter redirects supported method renames to the canonical inheritance declaration, so a concrete implementation and its interface change together. PHPantom 0.10.0 cannot safely rename a method shared by independent contracts; the adapter refuses that case before applying edits. Plain and mixed HTML/PHP documents are served, while Blade templates remain outside the adapter's document scope. PHPantom does not implement call hierarchy or range formatting. External tools such as PHPStan and PHP-CS-Fixer keep their own runtime requirements.

Ruby LSP uses the project's `Gemfile.lock` and composes its own `.ruby-lsp/Gemfile` through the official executable. Add RuboCop or Syntax Tree to the project bundle for formatting; formatter and linter settings default to upstream detection. The adapter corrects Prism UTF-16 ranges in Ruby LSP 0.26.0 through 0.26.11, preserving Unicode positions in preparation, references and rename edits. Constant rename and type ancestors are supported; Ruby LSP does not implement call hierarchy or type descendants, and it may defer references, rename and workspace symbols when it detects Sorbet.

Java project-source navigation is supported. Virtual JDK and dependency class-file documents require another client capability and are not enabled by this adapter; C# metadata definitions are supported. The Java, C# and Ruby adapters omit client-only code lenses; PHP method-prototype lenses use an executable server command. Code actions that require another editor's client command, including Roslyn's client-only Fix All actions, are filtered by `ide`, while ordinary edit-based fixes remain available.

## Lua, Dart, Swift and Zig

These adapters use `ide`, their language grammar and the same feature frontends as the other languages:

| Adapter     | Server                   | Runtime and project setup                                                                                                             |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ide-luals` | LuaLS                    | install `language-lua`; open the Lua module folder. The complete LuaLS distribution includes its runtime and formatter.               |
| `ide-dart`  | Dart SDK Analysis Server | install `language-dart`; open the pub or Flutter project and resolve its dependencies with the matching SDK.                          |
| `ide-swift` | SourceKit-LSP            | install `language-swift`; open the Swift package and keep its matching compiler, SDK and SourceKit-LSP together.                      |
| `ide-zls`   | ZLS                      | install `language-zig` and the Zig SDK; open the folder containing `build.zig`. ZLS and Zig must share their major and minor version. |

LuaLS 3.19.1 analyzes Lua 5.1 through 5.5 and LuaJIT without a separately installed Lua interpreter. Manage Servers downloads the full distribution, including the scripts, metadata and native formatter required beside the executable. `.luarc.json` or `.luarc.jsonc` takes precedence over editor fallbacks; use it to select the analyzed Lua version, application globals and annotated library paths. Reference-count labels are informational, and `find-references` supplies navigation. LuaLS does not implement standard call or type hierarchy, and the adapter disables the upstream editor's addon-manager integration.

Dart's managed installation contains the complete Dart SDK, including the analyzer, formatter, pub tools, libraries and licenses. Dart SDK 3.13.5 provides both hierarchy APIs, analyzer diagnostics, quick fixes and Unicode workspace edits. **Dart Path** selects a project SDK explicitly. For Flutter, select its bundled Dart executable and run `flutter pub get`; a managed standalone Dart SDK does not install Flutter. `pubspec.yaml`, resolved pub dependencies and `analysis_options.yaml` remain authoritative, including `formatter.page_width`. Dart-specific test and navigation lenses are disabled; Flutter outlines, hot reload and debugging require separate integrations.

SourceKit-LSP from Swift 6.4 runs with its matching compiler, SDK, libraries and runtime resources. Manage Servers downloads the complete toolchain into private editor storage, verifying the official Linux release signature, Windows installer checksum or macOS package signature for the selected platform. Existing **Server Path** or **Swift Toolchain** selections take precedence over the managed copy; PATH and the selected Xcode toolchain supply discovery fallbacks. Windows also needs the platform C++ build tools and Windows SDK. Keep `SDKROOT` and project SourceKit-LSP configuration authoritative; managed extraction preserves the payload without performing a global toolchain installation or installing those platform prerequisites.

Swift supplies compiler diagnostics, completion and signatures, source and cross-module navigation, rename, formatting, edit-based fixes, hints, semantic highlighting and both call and type hierarchies. Background indexing follows the server and project defaults unless overridden. Swift run, debug and test lenses require editor-specific commands and are disabled.

ZLS 0.16.0 works with Zig 0.16.x; Manage Servers installs the matching ZLS server, while **Zig Path** selects the separately installed SDK. Build-runner discovery, standard-library navigation and compiler checks depend on that SDK. ZLS preserves automatic build-on-save detection, including a project's `check` step. Its comptime and semantic analysis remain incomplete. ZON files use diagnostics, formatting and semantic highlighting; source completion, navigation, rename, actions and hints are gated off. ZLS does not advertise call hierarchy, type hierarchy, code lenses or range formatting.

## XML and PowerShell

These adapters connect through `ide` and the same completion, diagnostic and navigation frontends:

| Adapter          | Server                     | Runtime and project setup                                                                                               |
| ---------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ide-lemminx`    | Eclipse LemMinX            | use Java 11 or newer and `language-xml`; open XML or XSL files with their schemas, DTDs and XML catalogs.               |
| `ide-powershell` | PowerShell Editor Services | use PowerShell 7 and `language-powershell`; open the script or module folder. `.ps1xml` files belong to `language-xml`. |

Manage Servers installs LemMinX as a checksum-verified JAR and PowerShell Editor Services as its complete official release ZIP. Java and PowerShell remain separate runtimes. Explicit runtime and server selections take precedence over managed copies.

LemMinX provides schema and DTD diagnostics, schema completions, navigation, document symbols, formatting, paired-tag rename and edit-based fixes. PowerShell Editor Services includes PSScriptAnalyzer diagnostics and fixes, signatures, navigation, formatting and semantic highlighting; project analyzer rules remain authoritative. Its rename is the upstream single-file operation and asks for acknowledgement of its limitations. Debugging and an integrated PowerShell terminal require separate integrations.

## Installing a server

Some adapters include an npm-based server; standalone servers such as Ruff, Texlab, Tinymist, and Marksman must be on `PATH`, selected with **Server Path**, or installed by Lumine. ESLint uses the library and plugins from each project when available; bundled and managed server copies fall back to bundled ESLint v8 for legacy configuration or v10 for flat configuration. Its Configuration Format defaults to automatic detection; install project-specific plugins locally.

Run `ide:manage-servers` to install, update, or remove managed copies under `language-servers/` in your configuration directory. A configured **Server Path** wins, followed by the managed copy, a server shipped with the adapter when available, then automatic discovery through SDK locations and PATH. Removing a managed copy never removes a server installed by another tool.

Install, update and removal requests for one managed server run one at a time across editor windows; requests made within one window keep their order. A replacement is downloaded and validated before the current server is stopped. If downloading, validation or stopping fails, the existing installation stays in place. Closing the window or deactivating the adapter cancels unfinished operations.

**Server Path** and runtime executable settings take absolute paths to the intended file; settings such as **Server Directory** select a complete distribution. A missing, unsupported or incomplete configured or managed installation reports its error, so correct that selection or reinstall the managed copy. Automatic discovery can continue past an unusable SDK or server to a working installation.

A corrupt managed installation record or missing installed payload reports an error when the managed source is selected. A valid explicit server selection bypasses that record and runs the chosen copy. Reinstall the managed server to repair it, or remove it to use a bundled or discovered server. Runtime selections are independent: Java Path, Ruby Path, PowerShell Path and Rscript Path choose runtimes; Server Directory, Server JAR, Server Path or R Library Path choose the corresponding server payload.

The Bash adapter always runs its audited bundled server fork. Its managed install is a separately versioned, checksum-verified toolchain containing ShellCheck and shfmt, which provide diagnostics, fixes and formatting.

The SOFiSTiK adapter also includes its maintained server. It provides offline CADINP intelligence and manual import of existing calculation diagnostics, using only `sofistik.def` alongside each saved file and shared release detection. Files in different directories can use different releases within one server session; definitions in workspace roots or ancestors do not apply to child directories. It replaces the archived `autocomplete-sofistik` and `linter-sofistik` providers; see [SOFiSTiK workflows](https://github.com/lumine-code/sofistik-tools/blob/master/docs/1_Workflows.md) for setup and migration.

## Sessions

Commands are spawned directly with `shell: false`; arguments belong in `args`. A server with no notion of a project root can use `sessionScope: "workspace"`. An untitled URI stays stable for the selected language; changing grammar closes that identity and opens one for the new language.

Servers start when a matching editor first opens or its grammar changes. By default each project root gets a session; a server advertising multi-root support can share one process across roots, and a file outside the project gets a temporary file session. Several servers may serve one file: mergeable results are combined, while operations such as formatting or rename use an enabled server that supports them.

Untitled editors receive language-server features after you select a supported grammar. The client gives each one a stable untitled document identity and uses the first project root, falling back to the editor process's working directory when no project is open. Saving closes the untitled document and opens the same buffer under its file identity in the session selected for that path.

## Features

Every registered adapter appears in `linter:toggle-linter`, even before it reports diagnostics. Muting it there hides its messages without stopping the server or disabling other features. Removing the adapter removes its entry and messages.

Each adapter's **Features** group exposes the capabilities that can be switched off, including diagnostics, completions, navigation, formatting, rename, code actions, hints, lenses, and semantic tokens. Use these switches to choose between overlapping servers; for example, disable Ruff hover to leave it to Basedpyright. Feature settings can be scoped per language, and adapters keep the corresponding server capability available whenever any served grammar enables it.

`ide-css` serves CSS, SCSS, and Less, including formatting.

`ide-sass` serves indented `.sass` files through Some Sass. Property completions retain indentation and omit semicolons, and signature help shows parameters for functions and mixins. The server does not provide a formatter.

`ide-html` serves HTML, EJS, ERB, and Mustache, including CSS and JavaScript embedded in HTML. In PHP, Blade, and Markdown, it sends only the grammar's HTML fragments to the server while preserving their document positions. HTML formatting is unavailable for those three host languages even when the Format setting is enabled; their own formatters handle the complete document. Vue documents use `ide-vue`. CSS in JavaScript template strings, such as styled-components, remains outside `ide-css`'s scope.

Document diagnostics and workspace diagnostics use the same route into `linter`: open buffers update as you type, while a server that implements `workspace/diagnostic` can also report files that are not open. Install `diagnostics` to browse the combined project result.

Stopping a server removes its diagnostics immediately, including notebook-cell results, while preserving reports owned by another running session. Late shutdown notifications and invalidated hint or semantic-token replies cannot restore old results.

Semantic highlighting from `semantic-tokens` keeps the last server classification while you edit. Changes within a line adjust the colored range, and identifier characters typed or pasted immediately beside a token extend its color, including Unicode characters, `_` and `$`. Adjacent spaces, punctuation and newlines keep their own colors. Inserting a newline or multiline text inside a token retains color only on the original prefix before the edit; partial deletion shortens the range and deleting the whole token removes it. The next server answer supplies the updated classification, and replies for an earlier version of the text are ignored. Large files decorate visible rows and a margin while keeping the full classification available, so scrolling preserves the same behavior while a refresh is pending.

Unused-code fading, such as Ruff's unused imports, comes from diagnostics tagged `Unnecessary` and is rendered by `linter` independently of semantic highlighting.

Ruff and ESLint also provide explicit project and tree-view scans through `ide-ruff:lint-projects`, `ide-ruff:lint-selected`, `ide-eslint:lint-projects`, and `ide-eslint:lint-selected`. These commands analyze project files directly and publish their results to `linter`; see [Linting](https://github.com/lumine-code/linter/blob/master/docs/usage.md) for scan behavior.

## File operations

Configure `ide.fileOperationPreparationTimeout` from 1 to 3600 seconds when the default preparation deadline does not suit the project.

`ide` coordinates file changes from the protocol but does not implement filesystem access. It validates document versions and ordered changes and prepares text edits; when the optional `file-operations` package is installed, closed-path inspection plus every create, rename and delete step goes to its `file-operations.executor@1.0.0` service. The executor's `inspect()` and `prepare()` calls inspect affected paths, simulate the complete sequence without mutation, and return frozen results or an opaque identity-checked plan; `ide` executes plan steps in `documentChanges` order, applies the interleaved text edits, and retargets open buffers from the effects that remain.

An edit prepared for a buffer is refused if that buffer's text, path, document generation or notebook binding changes while preparation or confirmation is waiting. Restoring the old text does not restore the old edit's validity. Invalid later text batches are detected before earlier buffers change, and repeated insertions at one position keep the server's order. Stopping the source server or closing the window cancels pending work before its next mutation; a failure after a completed step retains that step's changes for review.

The executor has no commands or user interface and deliberately exposes only its versioned service. Its neutral step lifecycle identifies private staging roots and durable logical effects so protocol consumers can gate watcher noise; it neither emits nor consumes `tree-view`'s package-private events and does not manufacture a user-operation boundary from watcher notifications. Completed editor-owned moves retarget registered documents in the initiating workspace; an external rename does not retarget them.

The bundled `tree-view` owns the interface, conflict choices, queue and will/did boundary for file operations initiated by the user. It publishes the exact planned paths through `tree-view.file-operations`. Creating files or folders, duplicating entries and pasting copies let matching servers prepare `workspace/willCreateFiles` edits; deleting entries lets them prepare `workspace/willDeleteFiles` edits. Ordinary renames and moves skip server preparation; the rename dialog's explicit reference-update action requests `workspace/willRenameFiles`. Preparation collects edits without changing buffers, and applies them only after all integrations accept the operation and its path checks pass. Cancellation, changed paths and expired requests discard pending preparations and late replies. The matching `workspace/did*Files` notifications contain only effects that actually completed and do not wait for server analysis. Copying or cutting entries to the clipboard alone changes no files. `tree-view` never executes a server-authored `WorkspaceEdit` itself.

Document links from a server open through `hyperclick`. Four built-in commands expose protocol features that do not need another frontend package: `ide:fold-server-ranges` folds every server range, `ide:expand-selection-range` grows each selection to its next structural parent, `ide:select-linked-ranges` selects linked occurrences, and `ide:color-presentation` lets you choose and apply a server-provided spelling for the color under the cursor.

When filesystem observation recovers after lost delivery, affected language-server sessions restart and receive the current open documents again, including unsaved contents. This restores the server's state without pretending to replay changes that happened during the interruption.

## Custom servers

Any other language server can be wired up without a package. `ide:open-custom-servers-file` opens `language-servers.json` in your configuration directory; each entry names a command and the grammar scopes it serves:

```json
{
  "gopls": {
    "command": "gopls",
    "args": ["serve"],
    "scopes": ["source.go"],
    "settings": { "gopls": { "usePlaceholders": true } },
    "features": { "inlayHints": false }
  }
}
```

`command` and `scopes` are required. `args`, `env`, `languageId`, `sessionScope`, `transport`, `initializationOptions`, `settings`, and `features` are optional; `settings` is handed to the server as its configuration, and `features` switches individual capabilities off, as an adapter package's settings page does. Saving the file restarts exactly the servers whose entries changed.

Configuration pulls read sections from that server's `settings` tree. For example, `gopls.usePlaceholders` resolves to the nested value above. A missing section returns `null`; a custom server never receives unrelated editor settings through this request.

## Inspecting and controlling servers

`ide:servers` lists running servers, with those serving the active editor first. A session is labeled **Root**, **Roots**, **Workspace**, or **File** according to what it covers; choose it to restart or stop it, open its log, or show its diagnostics.

The status-bar item opens the same list and reports failures; disable it with the **Status Bar** setting. With `busy-signal` installed, the shared busy indicator shows server startup and common finite language requests after 400 ms, plus background work reported by the server, such as indexing. This is managed centrally for adapters and custom servers. Concurrent operations remain visible until each finishes; running servers are listed in the separate IDE status item.

- `ide:restart` restarts every server for the active editor.
- `ide:format` formats the active document through a server.
- `ide:show-problems` reveals the project views supplied by active `linter.ui` services through `linter.hub`. It is disabled while no project view is available.

## Troubleshooting

Open the server log with `ide:show-log`; set **Protocol Trace** to `messages` or `verbose` for protocol traffic. Crashed servers restart up to **Maximum Automatic Restarts**, after which the failure notification links to the log. Fix the reported cause and restart the session from `ide:servers`.

When changing a server path, runtime or initialization setting, the client prepares the replacement launch and settings before stopping a healthy server. Failed preparation reports the cause and leaves that working session available. Correct the selected installation and retry the restart; installing another copy on PATH does not override an explicit path or managed selection.

If stopping a server fails while its process remains alive, the client waits for the operating system to confirm that process has exited before starting a replacement for the same route. This also applies to an interrupted initial start or an obsolete replacement, so repeated restarts cannot leave overlapping processes behind. Closing the window cancels pending waits and still attempts cleanup of every server the window owns.

See [Code intelligence](code-intelligence.md) for feature frontends, [Writing an adapter](language-server-adapter.md) for server integration, and the [editor API](https://lumine-code.github.io/api/) for editor objects used by those integrations.
