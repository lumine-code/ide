const VERSION = 1;
const MAX_ROWS = 256;
const validRange = (value) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((part) => Number.isSafeInteger(part) && part >= 0) &&
  (value[0] < value[2] || (value[0] === value[2] && value[1] <= value[3]));

// The server sends parents before children, so context does not require a
// reconstructed tree or a second pass through a large document.
class DocumentSymbolChunks {
  constructor(target, symbolKind) {
    this.target = target;
    this.symbolKind = symbolKind;
    this.symbols = [];
  }
  accept(packet) {
    if (
      packet?.version !== VERSION ||
      packet.offset !== this.symbols.length ||
      !Array.isArray(packet.symbols) ||
      packet.symbols.length === 0 ||
      packet.symbols.length > MAX_ROWS
    )
      throw new Error("Invalid document-symbol chunk");
    for (const row of packet.symbols) {
      if (
        !Array.isArray(row) ||
        row.length !== 5 ||
        typeof row[0] !== "string" ||
        !Number.isInteger(row[1]) ||
        row[1] < 1 ||
        row[1] > 26 ||
        !validRange(row[2]) ||
        !validRange(row[3]) ||
        !Number.isInteger(row[4]) ||
        row[4] < -1 ||
        row[4] >= this.symbols.length
      )
        throw new Error("Invalid document-symbol row");
      const [name, kind, range, selection, parent] = row;
      this.symbols.push({
        name,
        tag: this.symbolKind(kind),
        ...this.target,
        position: [selection[0], selection[1]],
        range: [
          [range[0], range[1]],
          [range[2], range[3]],
        ],
        context: parent < 0 ? undefined : this.symbols[parent].name,
      });
    }
  }
}

module.exports = { DocumentSymbolChunks, VERSION };
