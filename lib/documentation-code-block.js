const { pythonProjection, typescriptProjection } = require("./documentation-projections");

// LSP code fences contain display signatures as well as real source code.
// The language-specific projection supplies parseable text and source spans;
// this renderer always gets colors from the editor's actual grammar and emits
// only the server's original text. Unknown forms stay on the normal renderer.
async function renderDocumentationCodeBlock(block, adapter) {
  const { text, scopeName } = block;
  let projection;
  try {
    projection =
      (await adapter?.getDocumentationCodeBlockProjection?.(block)) ??
      pythonProjection(text, scopeName) ??
      typescriptProjection(text, scopeName);
  } catch {
    return null;
  }
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

const createDocumentationCodeBlockRenderer = (adapter) =>
  adapter?.getDocumentationCodeBlockProjection
    ? (block) => renderDocumentationCodeBlock(block, adapter)
    : renderDocumentationCodeBlock;

// Only surviving hover sections are considered. Match their rendered code
// blocks using the same Markdown path as the presentation service, so an
// adapter never sees documentation contributed by another language server.
function createHoverCodeBlockRenderer(sections) {
  if (!sections.some(({ adapter }) => adapter?.getDocumentationCodeBlockProjection))
    return renderDocumentationCodeBlock;
  let owners;
  const keyForBlock = ({ text, language }) => JSON.stringify([language ?? "", text]);
  return (block) => {
    if (!owners) {
      owners = new Map();
      for (const { value, adapter } of sections) {
        const html = lumine.tools.markdown.render(value, {
          renderMode: "fragment",
          html: false,
          breaks: false,
          handleFrontMatter: false,
          useTaskCheckbox: false,
          transformImageLinks: false,
          transformLegacyLinks: false,
          transformNonFqdnLinks: false,
        });
        const fragment = lumine.tools.markdown.convertToDOM(html);
        for (const pre of fragment.querySelectorAll("pre")) {
          const code = pre.firstElementChild;
          const key = keyForBlock({
            text: (code ?? pre).textContent.replace(/\r?\n$/, ""),
            language: code?.className.replace(/^language-/, ""),
          });
          // Identical blocks can occur inside different prose/list sections.
          // If their owners differ, keep the ordinary renderer for that block.
          if (owners.has(key) && owners.get(key) !== adapter) owners.set(key, null);
          else if (!owners.has(key)) owners.set(key, adapter);
        }
      }
    }
    return renderDocumentationCodeBlock(block, owners.get(keyForBlock(block)));
  };
}

module.exports = {
  renderDocumentationCodeBlock,
  createDocumentationCodeBlockRenderer,
  createHoverCodeBlockRenderer,
};
