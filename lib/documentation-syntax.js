const path = require("node:path");

exports.pythonSignature = function (context, { names, classStart }) {
  const root = context.getRootSyntaxNode();
  if (
    root.namedChildCount !== names.length ||
    root.namedChildren.some(
      (node, index) =>
        node.type !== "function_definition" ||
        node.childForFieldName("name")?.text !== names[index],
    )
  )
    return null;
  if (classStart == null) return [];
  const name = root.firstNamedChild.childForFieldName("name");
  return [
    {
      start: classStart,
      end: classStart + 5,
      scopes: ["source.python", "storage.type.class.python"],
    },
    {
      start: name.startIndex,
      end: name.endIndex,
      scopes: ["source.python", "entity.name.type.class.python"],
    },
  ];
};

exports.runs = async function (
  context,
  { text, scopeName, regions, validation },
  { signal, emit },
) {
  const root = context.getRootSyntaxNode();
  if (!root || root.hasError || root.namedChildCount === 0) return null;
  if (validation) {
    if (!path.isAbsolute(validation.module))
      throw new TypeError("Documentation validation needs an absolute syntax module path");
    const extra = await require(validation.module)[validation.method](context, validation.params);
    signal.throwIfAborted();
    if (!extra) return null;
    regions = [...extra, ...regions];
  }
  let index = 0,
    count = 0;
  const packet = [];
  // UTF-16 offsets locate projected spans; code-point iteration keeps astral
  // identifiers intact. Only complete text runs leave the syntax owner.
  for (const character of text) {
    signal.throwIfAborted();
    const region = regions.find(({ start, end }) => index >= start && index < end);
    const scopes =
      region?.scopes ??
      (region
        ? context
            .scopeDescriptorForBufferPosition(
              context.buffer.positionForCharacterIndex(
                region.projectedStart + index - region.start,
              ),
            )
            .getScopesArray()
        : [scopeName]);
    const previous = packet.at(-1);
    if (
      previous &&
      scopes.length === previous.scopes.length &&
      scopes.every((scope, i) => scope === previous.scopes[i])
    )
      previous.text += character;
    else {
      packet.push({ text: character, scopes });
      count++;
    }
    index += character.length;
    if (packet.length >= 256 || index % 4096 === 0) {
      await emit(packet);
      packet.length = 0;
    }
  }
  if (packet.length) await emit(packet);
  return { count };
};
