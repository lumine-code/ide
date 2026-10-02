const { pythonProjection, typescriptProjection } = require("./hover-projections");

// LSP code fences contain display signatures as well as real source code.
// The language-specific projection supplies parseable text and source spans;
// this renderer always gets colors from the editor's actual grammar and emits
// only the server's original text. Unknown forms stay on the normal renderer.
async function renderHoverCodeBlock({ text, scopeName }) {
  const projection = pythonProjection(text, scopeName) ?? typescriptProjection(text, scopeName);
  if (!projection) return null;
  const editor = lumine.workspace.buildTextEditor({ readOnly: true, keyboardInputEnabled: false });
  try {
    editor.setText(projection.text, { bypassReadOnly: true });
    if (!lumine.grammars.assignLanguageMode(editor, projection.scopeName)) return null;
    if (!(await editor.whenGrammarSettled())) return null;
    const root = editor.getSyntaxNodeAtBufferPosition([0, 0], (node) => !node.parent);
    if (!root || root.hasError || !projection.validate(root)) return null;

    const pre = document.createElement("pre");
    pre.classList.add("editor-colors");
    const code = document.createElement("code");
    pre.appendChild(code);
    const buffer = editor.getBuffer();
    const openScopes = [];
    const elements = [code];
    let run = "";
    let runScopes = [];
    const flush = () => {
      if (!run) return;
      let shared = 0;
      while (shared < openScopes.length && openScopes[shared] === runScopes[shared]) shared++;
      openScopes.length = shared;
      elements.length = shared + 1;
      for (const scope of runScopes.slice(shared)) {
        const span = document.createElement("span");
        span.className = scope
          .split(".")
          .map((part) => `syntax--${part}`)
          .join(" ");
        elements.at(-1).appendChild(span);
        elements.push(span);
        openScopes.push(scope);
      }
      elements.at(-1).appendChild(document.createTextNode(run));
      run = "";
    };

    // Offsets use UTF-16, like TextBuffer. Iterate code points so an astral
    // identifier stays whole. Unmapped descriptive labels stay neutral.
    let index = 0;
    for (const character of text) {
      const region = projection.regions.find(({ start, end }) => index >= start && index < end);
      const scopes =
        region?.scopes ??
        (region
          ? editor
              .scopeDescriptorForBufferPosition(
                buffer.positionForCharacterIndex(region.projectedStart + index - region.start),
              )
              .getScopesArray()
          : [projection.scopeName]);
      if (scopes.length !== runScopes.length || scopes.some((scope, i) => scope !== runScopes[i])) {
        flush();
        runScopes = scopes;
      }
      run += character;
      index += character.length;
    }
    flush();
    return pre;
  } catch {
    return null;
  } finally {
    editor.destroy();
  }
}

module.exports = { renderHoverCodeBlock };
