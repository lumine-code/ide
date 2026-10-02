// A region maps unchanged display text into a valid declaration. Descriptive
// prefixes and overload counts stay neutral. Parser-only wrappers never enter
// the displayed or copied text.
function pythonProjection(source, scopeName) {
  if (scopeName !== "source.python" && scopeName !== "source.python.ipy") return null;
  const header =
    /^(\([^()\r\n]+\)[ \t]+)?(class|(?:async[ \t]+)?def)[ \t]+([\p{ID_Start}_][\p{ID_Continue}_]*)[ \t]*(?=\(|\[)/u.exec(
      source,
    );
  if (!header) return null;
  const prefixLength = header[1]?.length ?? 0;
  const isClass = header[2] === "class";
  if (isClass && !source.trimEnd().endsWith(")")) return null;
  const declaration = isClass
    ? `def  ${source.slice(prefixLength + 5)}`
    : source.slice(prefixLength);
  const regions = [];
  const projection = {
    scopeName: "source.python",
    text: `${" ".repeat(prefixLength)}${declaration}: ...`,
    regions,
    validate(root) {
      const definition = root.firstNamedChild;
      const name = definition?.childForFieldName("name");
      if (
        root.namedChildCount !== 1 ||
        definition?.type !== "function_definition" ||
        name?.text !== header[3]
      )
        return false;
      if (isClass) {
        regions.push(
          {
            start: prefixLength,
            end: prefixLength + 5,
            scopes: ["source.python", "storage.type.class.python"],
          },
          {
            start: name.startIndex,
            end: name.endIndex,
            scopes: ["source.python", "entity.name.type.class.python"],
          },
        );
      }
      regions.push({ start: prefixLength, end: source.length, projectedStart: prefixLength });
      return true;
    },
  };
  return projection;
}

// Find the receiver/member boundary before a method's parameter list or a
// property's type. Dots inside generic arguments (including callable types)
// belong to the receiver's type expression, not the member's name.
function memberBoundary(source) {
  const stack = [];
  let quote = null;
  let dot = -1;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (stack.length === 0 && (character === "(" || character === ":")) break;
    if (stack.length === 0 && character === ".") dot = index;
    if (["<", "(", "[", "{"].includes(character)) stack.push(character);
    else if (")]}".includes(character) || (character === ">" && source[index - 1] !== "="))
      stack.pop();
  }
  return dot;
}

function typescriptProjection(source, scopeName) {
  if (scopeName !== "source.ts" && scopeName !== "source.tsx") return null;
  const label = /^\((method|property|parameter|function|alias)\)[ \t]+/.exec(source);
  if (!label) return null;
  const start = label[0].length;
  const overload = /[ \t]+\(\+\d+ overloads?\)[ \t]*$/.exec(source);
  const end = overload?.index ?? source.length;
  const body = source.slice(start, end);
  const regions = [];
  let text = "";
  const append = (from, to) => {
    regions.push({ start: from, end: to, projectedStart: text.length });
    text += source.slice(from, to);
  };
  if (label[1] === "method" || label[1] === "property") {
    const dot = memberBoundary(body);
    if (dot >= 0) {
      text = "type __HoverReceiver = ";
      append(start, start + dot);
      text += ";\n";
    }
    text += "interface __Hover {\n";
    append(start + dot + 1, end);
    text += ";\n}";
  } else if (label[1] === "parameter") {
    text = "declare function __Hover(";
    append(start, end);
    text += "): void;";
  } else {
    append(start, end);
    text += ";";
  }
  return { scopeName: "source.ts", text, regions, validate: (root) => root.namedChildCount > 0 };
}

module.exports = { pythonProjection, typescriptProjection };
