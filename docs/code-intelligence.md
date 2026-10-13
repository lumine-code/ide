# Code intelligence

A working [language-server setup](language-servers.md#installation) uses `ide` as a protocol hub that exposes editor services without rendering every feature itself. Install only the UI packages for the features you want; other providers can supply the same services without a language server.

| Feature                                   | Package                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Persistent documentation and context help | [`documentation-view`](https://github.com/lumine-code/documentation-view#readme) |
| Documentation tooltips and signature help | [`hover`](https://github.com/lumine-code/hover#readme)                           |
| Symbol outline of the active file         | [`outline-view`](https://github.com/lumine-code/outline-view#readme)             |
| Code actions and quick fixes              | [`intentions`](https://github.com/lumine-code/intentions#readme)                 |
| Rename a symbol across the project        | [`refactor`](https://github.com/lumine-code/refactor#readme)                     |
| Formatting, on demand or on save          | [`code-format`](https://github.com/lumine-code/code-format#readme)               |
| References to the symbol under the cursor | [`find-references`](https://github.com/lumine-code/find-references#readme)       |
| Callers, callees, supertypes and subtypes | [`hierarchy-view`](https://github.com/lumine-code/hierarchy-view#readme)         |
| Actionable links above the code           | [`code-lens`](https://github.com/lumine-code/code-lens#readme)                   |
| Inferred types and parameter names inline | [`inlay-hints`](https://github.com/lumine-code/inlay-hints#readme)               |
| Semantic highlighting over the grammar    | [`semantic-tokens`](https://github.com/lumine-code/semantic-tokens#readme)       |

Every package in the table is optional and available under **Settings → Install**.

## Documentation and context help

`documentation-view` collects contextual help from providers and shows it in a persistent dock. Run `documentation-view:open` in an editor to request documentation, types, and diagnostics at the cursor. The panel opens without taking focus and keeps that answer when the cursor moves or you switch files. Its header identifies the source file and position and indicates when the source has changed or closed. Refresh requests help at that saved position, clamped to the current buffer after edits; Clear removes the answer. Returning to the editor focuses the currently active editor.

The panel works without `hover`. Install `documentation-view` together with a provider such as a language-server setup or `linter`; add `hover` for temporary tooltips using the same answers. In a tooltip, choose **Open in Documentation View** to preserve the displayed answer in the dock. That action uses the tooltip's source position, which may differ from the cursor, and does not query providers again.

`documentation-view:toggle` shows or hides the dock, while `documentation-view:toggle-focus` focuses it or returns focus to the editor. Help is requested explicitly; the panel does not follow the cursor automatically.

## Hover and signature help

`hover` shows provider documentation, types, and linter messages at the pointer or cursor through the `documentation-view` registry. Use `hover:toggle` at the cursor, `hover:toggle-signature-help` while entering arguments, and `hover:dismiss` to close either overlay. Signature help uses its own provider service. Pointer and cursor delays are configurable. Both overlays prefer the space above the source line when opening and fall back when window edges or other overlays leave too little room. The chosen side stays fixed while the overlay is open; reopening evaluates the available space again. A wheel gesture closes either panel unless the pointer is over a panel with scrollable content. Scrollable content keeps wheel events inside its panel, including at the beginning and end; a panel without scrollable content lets the wheel reach the editor as it closes. Wheel gestures reaching the source editor also cancel pending hover requests, even when the editor cannot scroll further.

Trace mode follows the mouse pointer and requests help when it rests over a symbol. It starts from `hover.trace`, which defaults to `true`. Use `hover:toggle-trace` (`Ctrl+H`) to switch it for the current window. Enable `hover.statusBar`, which defaults to `false`, to show an eye icon on the right side of the status bar and switch trace by clicking it. These switches last until the window reloads and do not change saved configuration; a later change to `hover.trace` replaces the current mode. Switching trace off immediately closes the current hover and cancels pending hover work; switching it on immediately checks the current pointer position without waiting for mouse movement. This applies to the command, icon, and setting changes. Switching trace off leaves signature help open. Cursor-triggered hover and explicit commands work independently of trace.

Python doctest examples supplied by `ide-basedpyright` use Python syntax highlighting in hover documentation, with `>>>` prompts, `...` continuations, and expected output preserved. When several servers contribute to a hover, each example keeps its originating server's rendering. [Autocomplete documentation](https://github.com/lumine-code/autocomplete/blob/master/docs/usage.md#documentation-and-detail) uses the same rendering.

## Outline

`outline-view` lists the active file's symbols as a collapsible dock tree and follows the cursor. Use `outline-view:toggle` to show or hide it and `outline-view:reveal-in-outline-view` to reveal the current symbol. A language server can provide the tree directly; otherwise the package can use an installed `symbol` hub and its providers.

The outline marks the symbol containing the last editor cursor in bold, including positions inside a multiline body. Like the navigation panel, it shades the current symbol's branch and every ancestor branch with a translucent background, so deeper levels accumulate shading and reveal the hierarchy. Keyboard browsing uses an independent dotted outline: focusing the panel creates no selection, and the first Up or Down moves from the current symbol to its neighbour. Subsequent Up and Down wrap through visible entries, Left collapses a branch or its parent, and Right expands it. Keyboard navigation from search focuses the tree; Tab switches between the tree and search without losing the selection. Leaving the panel clears the temporary selection while the current symbol continues following the last cursor.

Click an entry or press Enter to jump to its symbol and focus the editor. With no keyboard selection, Enter uses the current visible symbol or the first entry. Alt+Enter or Alt+click also clears the search; Ctrl+Enter or Ctrl+click adds a cursor while keeping focus in the outline. Escape clears the query. The optional keyboard preview setting moves the editor cursor as you browse while keeping the outline focused.

## Code actions and quick fixes

`intentions` combines provider code actions and linter fixes. Run `intentions:show` (`Alt+Enter` by default), choose with the arrow keys, confirm with Enter, or close with Escape.

## Rename

`refactor:rename` (`F2` by default) asks a provider to rename the symbol under the cursor across affected files. The edits are applied transactionally, with one undo step per buffer and rollback if any file fails.

## References

`find-references` highlights references in visible editors and lists them by file with `find-references:show-panel`; `find-references:highlight` refreshes the inline highlights. Install `marker` and a compatible overview map to add scrollbar or minimap markers.

Moving the cursor keeps the previous highlights visible while the next lookup is pending, so navigating within a name does not make its references blink. The latest result replaces them, and an empty result clears them. Buffer edits clear old highlights immediately before a new lookup.

## Call and type hierarchies

`hierarchy-view:incoming-calls` and `hierarchy-view:outgoing-calls` show callers and callees; `hierarchy-view:supertypes` and `hierarchy-view:subtypes` show inheritance. Availability depends on the active server, and expanding an entry requests the next level.

## Formatting

`code-format:format-code` formats the selection or, when none exists, the whole file. **Format On Save** and **Format On Type** are opt-in scoped settings. The hub owns the save hook, chooses one capable provider, and discards cancelled or outdated results. Install `prettier` to add the Prettier engine and select it as the default formatter for the desired languages. Language-server formatting uses the same hub.

```json
{
  ".source.python": {
    "code-format": {
      "defaultProvider": "ide",
      "formatOnSave": true
    }
  }
}
```

The hub also owns save glob filters, session-only observed-file opt-ins and status-bar indicators. Provider eligibility checks still apply. `prettier:format` and `ide:format` explicitly choose their engine through the hub; Prettier project commands format files on disk.

## Code lens

`code-lens` renders provider actions above the lines they describe. It is enabled after installation; use `code-lens:toggle`, `code-lens:refresh`, or the per-language **Enabled** setting.

## Inlay hints

`inlay-hints` displays provider-supplied type and parameter labels without changing the buffer. It is enabled after installation; use `inlay-hints:toggle`, `inlay-hints:refresh`, or the per-language **Enabled** setting.

Labels follow edits and refresh as scrolling, folding, resizing or font changes expose different rows. Multiple labels at the same position appear together, while labels before the last character and after the line stay separate. Refresh reports when hints are disabled or no provider serves the file.

## Semantic tokens

`semantic-tokens` layers a server's identifier classifications over grammar highlighting, leaving unclassified text unchanged. It is enabled after installation; use `semantic-tokens:toggle`, `semantic-tokens:refresh`, or the per-language **Enabled** setting.

It needs a backend that supports semantic tokens. Highlighting follows edits and file renames. Large files cache the full classification and decorate only the rows near the view, so scrolling applies their colors before the next paint without another server request. A backend that only supplies ranges refreshes the visible rows after scrolling, folding or resizing settles. Deprecated identifiers keep their strike while linter underlines remain visible on the same text.
