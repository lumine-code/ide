const path = require("path");
const C = require("../lib/converters");
const { toLinterMessages, toNotebookLinterMessages } = require("../lib/linter-messages");

describe("LSP diagnostics linter mapping", () => {
  it("maps diagnostics to linter.registry messages", () => {
    const filePath = path.resolve("project", "main.ts");
    const result = toLinterMessages(C.pathToUri(filePath), [
      {
        range: { start: { line: 2, character: 3 }, end: { line: 2, character: 7 } },
        severity: 1,
        message: "Unknown name",
        source: "typescript",
        code: 2304,
        codeDescription: { href: "https://example.test/2304" },
        data: { resolutionToken: "server-owned-fix" },
      },
    ]);
    expect(result.filePath).toBe(filePath);
    // Protocol-only data stays in the manager's diagnostic store. Rebuilt raw
    // objects would otherwise make unchanged linter messages look updated.
    expect(result.messages[0].lspDiagnostic).toBeUndefined();
    expect(result.messages[0]).toEqual(
      jasmine.objectContaining({
        severity: "error",
        excerpt: "Unknown name",
        source: "typescript",
        code: 2304,
        description: "typescript: 2304",
        url: "https://example.test/2304",
        location: {
          file: filePath,
          position: [
            [2, 3],
            [2, 7],
          ],
        },
      }),
    );
  });

  describe("structured diagnostic details", () => {
    const mainFile = path.resolve("project", "main.dat");
    const range = () => ({
      start: { line: 2, character: 3 },
      end: { line: 2, character: 9 },
    });
    const mapped = (details) =>
      toLinterMessages(C.pathToUri(mainFile), [
        { range: range(), message: "Invalid numeric literal", ...details },
      ]).messages[0];

    it("keeps source and numeric code zero without duplicating protocol objects", () => {
      const message = mapped({ source: "solver", code: 0 });
      expect(message.source).toBe("solver");
      expect(message.code).toBe(0);
      expect(message.description).toBe("solver: 0");
      expect(message.relatedInformation).toBeUndefined();
      expect(mapped({ code: "G310" }).code).toBe("G310");
      expect(mapped({ source: {}, code: Infinity }).source).toBeUndefined();
      expect(mapped({ source: {}, code: Infinity }).code).toBeUndefined();
    });

    it("decodes escaped file paths and keeps both ends of the related range", () => {
      const file = path.resolve("project", "a folder", "łąka #1%.dat");
      const uri = C.pathToUri(file);
      const message = mapped({
        source: "sofistik-linter",
        code: "G310",
        relatedInformation: [{ message: "Value defined here.", location: { uri, range: range() } }],
      });
      expect(message.relatedInformation).toEqual([
        {
          message: "Value defined here.",
          location: {
            file,
            position: [
              [2, 3],
              [2, 9],
            ],
          },
        },
      ]);
      expect(message.description).toBe(`sofistik-linter: G310\n\n${file}:3:4: Value defined here.`);
      expect(message.description).not.toContain(uri);
    });

    it("normalizes an escaped lowercase Windows drive without folding the filename", () => {
      const uri = "file:///c%3A/Users/Someone/a%20folder/Name%23%25.dat";
      const file =
        process.platform === "win32"
          ? "C:\\Users\\Someone\\a folder\\Name#%.dat"
          : "/C:/Users/Someone/a folder/Name#%.dat";
      const message = mapped({
        relatedInformation: [{ message: "Program header.", location: { uri, range: range() } }],
      });
      expect(message.relatedInformation[0].location.file).toBe(file);
      expect(message.description).toBe(`${file}:3:4: Program header.`);
    });

    it("copies nested coordinates and observes changed related metadata in a later batch", () => {
      const related = {
        message: "Program header.",
        location: { uri: C.pathToUri(mainFile), range: range() },
      };
      const first = mapped({ relatedInformation: [related] });
      related.location.range.start.character = 5;
      related.message = "Changed header.";
      const second = mapped({ relatedInformation: [related] });
      expect(first.relatedInformation[0].message).toBe("Program header.");
      expect(first.relatedInformation[0].location.position[0]).toEqual([2, 3]);
      expect(second.relatedInformation[0].location.position[0]).toEqual([2, 5]);
      expect(second.description).toContain(":3:6: Changed header.");
      second.relatedInformation[0].location.position[0][1] = 7;
      expect(related.location.range.start.character).toBe(5);
    });

    it("keeps unsupported, unsafe and malformed URI schemes as plain related text", () => {
      for (const uri of [
        "untitled:Untitled-1",
        "vscode-remote://ssh-remote+host/project/model.dat",
        "https://example.test/model.dat",
        "javascript:alert(1)",
        "data:text/html,<script>bad()</script>",
        "file:///bad%ZZ.dat",
        "file:///encoded%2Fseparator.dat",
      ]) {
        const message = mapped({
          relatedInformation: [{ message: "Related context.", location: { uri, range: range() } }],
        });
        expect(message.relatedInformation).toEqual([{ message: "Related context.", uri }]);
        expect(message.description).toBe(`${uri}: Related context.`);
      }
    });

    it("keeps invalid local coordinates as plain URI without inventing a navigation target", () => {
      const uri = C.pathToUri(mainFile);
      for (const invalid of [
        undefined,
        { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } },
        { start: { line: 0, character: NaN }, end: { line: 0, character: 0 } },
        { start: { line: 0, character: 0 }, end: { line: Infinity, character: 0 } },
        { start: { line: 3, character: 0 }, end: { line: 2, character: 0 } },
        { start: { line: 2, character: 4 }, end: { line: 2, character: 3 } },
      ]) {
        const message = mapped({
          relatedInformation: [
            { message: "Unlocated context.", location: { uri, range: invalid } },
          ],
        });
        expect(message.relatedInformation).toEqual([{ message: "Unlocated context.", uri }]);
      }
      expect(
        mapped({ relatedInformation: [null, {}, { message: "No URI." }] }).relatedInformation,
      ).toBeUndefined();
      expect(mapped({ relatedInformation: {} }).relatedInformation).toBeUndefined();
    });

    it("decodes Windows UNC files only on a platform that supports that authority", () => {
      const uri = "file://server/share/a%20folder/model%231.dat";
      const message = mapped({
        relatedInformation: [
          { message: "Remote file context.", location: { uri, range: range() } },
        ],
      });
      if (process.platform === "win32") {
        const file = "\\\\server\\share\\a folder\\model#1.dat";
        expect(message.relatedInformation[0].location.file).toBe(file);
        expect(message.description).toBe(`${file}:3:4: Remote file context.`);
      } else {
        expect(message.relatedInformation).toEqual([{ message: "Remote file context.", uri }]);
      }
    });

    it("preserves an explicit local target outside the project without treating it as a URL action", () => {
      const uri = "file:///C:/project/../external/model.dat";
      const file =
        process.platform === "win32" ? "C:\\external\\model.dat" : "/C:/external/model.dat";
      const message = mapped({
        relatedInformation: [{ message: "Included file.", location: { uri, range: range() } }],
      });
      expect(message.relatedInformation[0].location.file).toBe(file);
      expect(message.description).toBe(`${file}:3:4: Included file.`);
    });

    it("uses the same structured details for notebook messages and plain cell URI context", () => {
      const notebookPath = path.resolve("project", "model.ipynb");
      const cellUri = C.cellUri(notebookPath, "cell-1");
      const relatedFile = path.resolve("project", "values.dat");
      const diagnostic = {
        range: range(),
        message: "Invalid value",
        source: "solver",
        code: 0,
        relatedInformation: [
          {
            message: "Local definition.",
            location: { uri: C.pathToUri(relatedFile), range: range() },
          },
          { message: "Cell context.", location: { uri: cellUri, range: range() } },
        ],
      };
      const message = toNotebookLinterMessages({ notebookPath, cellIndex: 2 }, [diagnostic])
        .messages[0];
      expect(message.code).toBe(0);
      expect(message.source).toBe("solver");
      expect(message.location.cell).toBe(3);
      expect(message.relatedInformation).toEqual([
        {
          message: "Local definition.",
          location: {
            file: relatedFile,
            position: [
              [2, 3],
              [2, 9],
            ],
          },
        },
        { message: "Cell context.", uri: cellUri },
      ]);
    });
  });

  describe("severity", () => {
    const mapped = (diagnostic) => {
      const filePath = path.resolve("project", "main.ts");
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      const { messages } = toLinterMessages(C.pathToUri(filePath), [
        { range, message: "m", ...diagnostic },
      ]);
      return messages[0];
    };

    it("maps every LSP severity onto its linter tier", () => {
      expect([1, 2, 3, 4].map((severity) => mapped({ severity }).severity)).toEqual([
        "error",
        "warning",
        "info",
        "hint",
      ]);
    });

    // LSP leaves an omitted severity to the client, and a server that says
    // nothing is not saying "minor".
    it("treats a diagnostic with no severity as an error", () => {
      expect(mapped({}).severity).toBe("error");
    });

    // Guards a future protocol addition from silently arriving as a hint.
    it("treats an unknown severity as an error", () => {
      expect(mapped({ severity: 5 }).severity).toBe("error");
    });
  });

  describe("tags", () => {
    const tagsOf = (tags) => {
      const filePath = path.resolve("project", "main.ts");
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      const { messages } = toLinterMessages(C.pathToUri(filePath), [
        { range, message: "m", severity: 4, tags },
      ]);
      return messages[0].tags;
    };

    it("maps LSP DiagnosticTag onto the contract names", () => {
      expect(tagsOf([1])).toEqual(["unnecessary"]);
      expect(tagsOf([2])).toEqual(["deprecated"]);
      expect(tagsOf([1, 2])).toEqual(["unnecessary", "deprecated"]);
    });

    it("omits the field when there is nothing to say", () => {
      expect(tagsOf(undefined)).toBeUndefined();
      expect(tagsOf([])).toBeUndefined();
      expect(tagsOf([99])).toBeUndefined();
    });

    it("keeps the known tags when an unknown one rides along", () => {
      expect(tagsOf([2, 99])).toEqual(["deprecated"]);
    });
  });

  it("returns an empty batch to clear stale messages", () => {
    const filePath = path.resolve("project", "main.py");
    expect(toLinterMessages(C.pathToUri(filePath), [])).toEqual({
      filePath,
      messages: [],
    });
  });

  describe("the path handed to the linter", () => {
    // Everything downstream compares it against `editor.getPath()`: the panel
    // filtering to the active file, the gutter choosing an editor. A server
    // that spells the same file differently is not a different file, but it
    // was a different string, so nothing was ever shown for it.
    it("is the editor's spelling, not the server's", () => {
      const fromServer = "file:///c%3A/Users/asiloisad/project/main.py";
      const fromEditor = "file:///C:/Users/asiloisad/project/main.py";
      expect(fromServer).not.toBe(fromEditor);
      expect(toLinterMessages(fromServer, []).filePath).toBe(
        toLinterMessages(fromEditor, []).filePath,
      );
    });

    it("drops a URI that belongs to no file rather than inventing one", () => {
      expect(toLinterMessages("untitled:Untitled-1", []).filePath).toBeNull();
      expect(toLinterMessages(undefined, []).filePath).toBeNull();
    });

    // Cell diagnostics come through their own conversion — the generic one
    // must not resolve a cell URI to a path it does not have.
    it("drops a cell URI on the generic path", () => {
      const uri = C.cellUri(path.resolve("proj", "nb.ipynb"), "c1");
      expect(toLinterMessages(uri, []).filePath).toBeNull();
    });
  });

  describe("notebook cell messages", () => {
    it("lands on the notebook with a full-list 1-based cell and cell-relative position", () => {
      const notebookPath = path.resolve("proj", "nb.ipynb");
      const { filePath, messages } = toNotebookLinterMessages({ notebookPath, cellIndex: 2 }, [
        {
          range: { start: { line: 1, character: 4 }, end: { line: 1, character: 9 } },
          severity: 2,
          message: "unused",
          source: "ruff",
          code: "F401",
        },
      ]);
      expect(filePath).toBe(notebookPath);
      expect(messages[0].lspDiagnostic).toBeUndefined();
      expect(messages[0]).toEqual(
        jasmine.objectContaining({
          severity: "warning",
          excerpt: "unused",
          description: "ruff: F401",
          location: {
            file: notebookPath,
            cell: 3,
            position: [
              [1, 4],
              [1, 9],
            ],
          },
        }),
      );
      // Deliberately no buffer: split views give one cell different buffers.
      expect(messages[0].location.buffer).toBeUndefined();
    });
  });
});
