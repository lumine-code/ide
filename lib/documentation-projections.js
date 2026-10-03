// A region maps unchanged documentation text into parseable source. Descriptive
// prefixes and overload counts stay neutral. Parser-only wrappers never enter
// the displayed or copied text.
function pythonDoctestProjection(source, scopeName, language) {
  const python = scopeName === "source.python" || scopeName === "source.python.ipy";
  const consoleFence = language === "pycon" || language === "python-console";
  const unlabeled = !language && (!scopeName || scopeName === "text.plain");
  if (!python && !consoleFence && !unlabeled) return null;

  const lines = source.split(/(\r\n|\n|\r)/);
  let firstLine;
  for (let index = 0; index < lines.length; index += 2) {
    if (lines[index].trim()) {
      firstLine = lines[index];
      break;
    }
  }
  const firstPrompt = /^([ \t]*)>>>(?:[ \t]|$)/.exec(firstLine ?? "");
  if (!firstPrompt) return null;

  const indentation = firstPrompt[1];
  const regions = [];
  let text = "";
  let offset = 0;
  let input = false;
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const newline = lines[index + 1] ?? "";
    const prompt = /^([ \t]*)(>>>|\.\.\.)(?:[ \t]|$)/.exec(line);
    if (prompt && prompt[1] === indentation && (prompt[2] === ">>>" || input)) {
      input = true;
      const promptStart = offset + indentation.length;
      regions.push({
        start: promptStart,
        end: promptStart + 3,
        scopes: ["source.python", "punctuation.definition.prompt.python"],
      });
      // Remove just the prompt and one separator. Any remaining spaces belong
      // to the Python input, especially a continuation's suite indentation.
      const start = offset + prompt[0].length;
      if (start < offset + line.length) {
        regions.push({ start, end: offset + line.length, projectedStart: text.length });
        text += line.slice(prompt[0].length);
      }
    } else {
      // Output is displayed verbatim but never parsed as Python. In particular,
      // doctest's output ellipsis after stdout is not a continuation prompt.
      input = false;
    }
    if (newline) text += "\n";
    offset += line.length + newline.length;
  }
  return {
    scopeName: "source.python",
    text,
    regions,
    validate: (root) => root.namedChildCount > 0,
  };
}

function pythonStringEnd(source, start, end) {
  const quote = source[start];
  const delimiter = source.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
  for (let index = start + delimiter.length; index < end; index++) {
    if (source[index] === "\\") index++;
    else if (source.startsWith(delimiter, index)) return index + delimiter.length;
  }
  return end;
}

function pythonDelimiterEnd(source, start, end) {
  const closing = { "(": ")", "[": "]", "{": "}" };
  const stack = [closing[source[start]]];
  for (let index = start + 1; index < end; index++) {
    const character = source[index];
    if (character === "'" || character === '"') {
      index = pythonStringEnd(source, index, end) - 1;
    } else if (closing[character]) stack.push(closing[character]);
    else if (")]}".includes(character)) {
      if (stack.pop() !== character) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

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
  let parametersStart = header[0].length;
  if (source[parametersStart] === "[") {
    const typeParametersEnd = pythonDelimiterEnd(source, parametersStart, source.length);
    if (typeParametersEnd < 0) return null;
    parametersStart = typeParametersEnd + 1;
    while (/\s/.test(source[parametersStart] ?? "")) parametersStart++;
  }
  if (source[parametersStart] !== "(") return null;
  const parametersEnd = pythonDelimiterEnd(source, parametersStart, source.length);
  if (parametersEnd < 0) return null;

  const callables = [];
  let callableCount = 0;
  const createBuilder = () => {
    const builder = { text: "", regions: [] };
    builder.append = (start, end) => {
      if (start === end) return;
      builder.regions.push({ start, end, projectedStart: builder.text.length });
      builder.text += source.slice(start, end);
    };
    builder.extend = (part) => {
      builder.regions.push(
        ...part.regions.map((region) => ({
          ...region,
          projectedStart: region.projectedStart + builder.text.length,
        })),
      );
      builder.text += part.text;
    };
    return builder;
  };

  // Pyright's callable type `(value: Type) -> Result` is display syntax, not
  // a Python expression. Parse it as a separate function declaration, so its
  // parameters, annotations and arrow get the grammar's real definition scopes.
  // The surrounding annotation uses an unmapped placeholder for that callable.
  const buildRange = (start, end, parameters = false) => {
    const builder = createBuilder();
    let runStart = start;
    let parameterStart = start;
    for (let index = start; index < end;) {
      const character = source[index];
      if (character === "'" || character === '"') {
        index = pythonStringEnd(source, index, end);
        continue;
      }
      if (
        parameters &&
        source.startsWith("...", index) &&
        /^\s*$/.test(source.slice(parameterStart, index)) &&
        /^\s*(?:,|$)/.test(source.slice(index + 3, end))
      ) {
        builder.append(runStart, index);
        builder.text += "__SignatureOmitted = ";
        builder.append(index, index + 3);
        index += 3;
        runStart = index;
        continue;
      }
      if ("([{".includes(character)) {
        const close = pythonDelimiterEnd(source, index, end);
        if (close < 0) break;
        let arrow = close + 1;
        while (/\s/.test(source[arrow] ?? "") && arrow < end) arrow++;
        if (character === "(" && source.startsWith("->", arrow)) {
          let returnEnd = arrow + 2;
          while (returnEnd < end && !",=".includes(source[returnEnd])) {
            if (source[returnEnd] === "'" || source[returnEnd] === '"') {
              returnEnd = pythonStringEnd(source, returnEnd, end);
            } else if ("([{".includes(source[returnEnd])) {
              const returnClose = pythonDelimiterEnd(source, returnEnd, end);
              if (returnClose < 0) break;
              returnEnd = returnClose + 1;
            } else returnEnd++;
          }
          const name = `__SignatureCallable${callableCount++}`;
          const callable = createBuilder();
          callable.text = `def ${name}`;
          callable.append(index, index + 1);
          callable.extend(buildRange(index + 1, close, true));
          callable.append(close, arrow + 2);
          callable.extend(buildRange(arrow + 2, returnEnd));
          callable.text += ": ...";
          callables.push({ name, builder: callable });
          builder.append(runStart, index);
          builder.text += name;
          index = returnEnd;
        } else {
          builder.append(runStart, index + 1);
          builder.extend(buildRange(index + 1, close));
          builder.append(close, close + 1);
          index = close + 1;
        }
        runStart = index;
        continue;
      }
      if (parameters && character === ",") parameterStart = index + 1;
      index++;
    }
    builder.append(runStart, end);
    return builder;
  };

  const builder = createBuilder();
  builder.text = " ".repeat(prefixLength);
  if (isClass) {
    builder.text += "def  ";
    builder.append(prefixLength + 5, parametersStart + 1);
  } else builder.append(prefixLength, parametersStart + 1);
  builder.extend(buildRange(parametersStart + 1, parametersEnd, true));
  builder.append(parametersEnd, parametersEnd + 1);
  builder.extend(buildRange(parametersEnd + 1, source.length));
  builder.text += ": ...";
  for (const callable of callables) {
    builder.text += "\n";
    builder.extend(callable.builder);
  }
  const regions = builder.regions;
  const projection = {
    scopeName: "source.python",
    text: builder.text,
    regions,
    validate(root) {
      const definition = root.firstNamedChild;
      const name = definition?.childForFieldName("name");
      if (
        root.namedChildCount !== callables.length + 1 ||
        definition?.type !== "function_definition" ||
        name?.text !== header[3] ||
        root.namedChildren
          .slice(1)
          .some(
            (node, index) =>
              node.type !== "function_definition" ||
              node.childForFieldName("name")?.text !== callables[index].name,
          )
      )
        return false;
      if (isClass) {
        regions.unshift(
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
  // TypeScript's quick info for `this` omits the usual `(parameter)` label.
  // It still needs a parameter declaration so its object body is a type,
  // rather than a statement block recovered from invalid source.
  const kind = label?.[1] ?? (/^this\s*:/.test(source) ? "parameter" : null);
  if (!kind) return null;
  const start = label?.[0].length ?? 0;
  const overload = /[ \t]+\(\+\d+ overloads?\)[ \t]*$/.exec(source);
  const end = overload?.index ?? source.length;
  const body = source.slice(start, end);
  const regions = [];
  let text = "";
  const append = (from, to) => {
    regions.push({ start: from, end: to, projectedStart: text.length });
    text += source.slice(from, to);
  };
  if (kind === "method" || kind === "property") {
    const dot = memberBoundary(body);
    if (dot >= 0) {
      text = "type __HoverReceiver = ";
      append(start, start + dot);
      text += ";\n";
    }
    text += "interface __Hover {\n";
    append(start + dot + 1, end);
    text += ";\n}";
  } else if (kind === "parameter") {
    text = "declare function __Hover(";
    append(start, end);
    text += "): void;";
  } else {
    append(start, end);
    text += ";";
  }
  return { scopeName: "source.ts", text, regions, validate: (root) => root.namedChildCount > 0 };
}

module.exports = { pythonDoctestProjection, pythonProjection, typescriptProjection };
