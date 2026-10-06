const fs = require("fs");
const os = require("os");
const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const C = require("../lib/converters");

describe("Workspace edits with empty targets", () => {
  let manager, tempDir;

  const installFileOperationsExecutor = () => {
    manager.setFileOperationsExecutor({
      inspect: async (paths) =>
        paths.map((filePath) => {
          const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
          return {
            path: filePath,
            status: stat ? (stat.isDirectory() ? "directory" : "file") : "missing",
          };
        }),
    });
  };

  beforeEach(() => {
    jasmine.useRealClock();
    manager = new LanguageServerManager();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-empty-edits-"));
  });

  afterEach(async () => manager.deactivate());

  for (const preparation of [false, true]) {
    for (const form of ["changes", "documentChanges"]) {
      it(`applies ${form} ${preparation ? "preparations" : "workspace edits"} without opening empty targets`, async () => {
        installFileOperationsExecutor();
        const filePath = path.join(tempDir, "changed.js");
        fs.writeFileSync(filePath, "original\n");
        const editor = await lumine.workspace.open(filePath);
        const paneItems = lumine.workspace.getPaneItems();
        const untouchedFiles = new Map();
        const emptyChanges = Array.from({ length: 75 }, (_, index) => {
          const target = path.join(tempDir, `untouched-${index}.${index % 2 ? "ipy" : "py"}`);
          fs.writeFileSync(target, "unchanged\n");
          untouchedFiles.set(target, "unchanged\n");
          return { textDocument: { uri: C.pathToUri(target), version: null }, edits: [] };
        });
        for (let index = 0; index < 34; index++) {
          const target = path.join(tempDir, `untouched-${index}.ipynb`);
          const text = JSON.stringify({
            cells: Array.from({ length: 2 }, () => ({
              cell_type: "code",
              metadata: {},
              source: ["pass\n"],
              execution_count: null,
              outputs: [],
            })),
            metadata: {},
            nbformat: 4,
            nbformat_minor: 5,
          });
          fs.writeFileSync(target, text);
          untouchedFiles.set(target, text);
          for (const cell of [0, 1])
            emptyChanges.unshift({
              textDocument: { uri: `${C.pathToUri(target)}#${cell}`, version: null },
              edits: [],
            });
        }
        const changes = [
          ...emptyChanges,
          {
            textDocument: { uri: C.pathToUri(filePath), version: null },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
                newText: "changed",
              },
            ],
          },
        ];
        const edit =
          form === "changes"
            ? {
                changes: Object.fromEntries(
                  changes.map(({ textDocument, edits }) => [textDocument.uri, edits]),
                ),
              }
            : { documentChanges: changes };
        const session = {
          adapter: { getDocumentProjection: jasmine.createSpy("getDocumentProjection") },
          needsDocumentTransform: (target) => /\.ipy$/i.test(target.getPath()),
        };
        const open = spyOn(lumine.workspace, "open").and.callThrough();
        const applied = preparation
          ? await manager.applyWorkspaceEdits([{ edit, session }], "Prepare file rename")
          : await manager.applyWorkspaceEdit(edit, "Server edit", session);

        expect(applied).toBe(true);
        expect(editor.getText()).toBe("changed\n");
        expect(open).not.toHaveBeenCalled();
        expect(lumine.workspace.getPaneItems()).toEqual(paneItems);
        expect(session.adapter.getDocumentProjection).not.toHaveBeenCalled();
        for (const [target, text] of untouchedFiles)
          expect(fs.readFileSync(target, "utf8")).toBe(text);
      });
    }
  }

  it("retains version guards for empty workspace edits without resolving an editor", async () => {
    const filePath = path.join(tempDir, "empty-versioned.js");
    fs.writeFileSync(filePath, "current\n");
    const editor = await lumine.workspace.open(filePath);
    const uri = C.pathToUri(filePath);
    const document = { editor, uri, version: 1 };
    const session = { documents: new Map([[C.uriKey(uri), document]]) };
    const resolveEditor = spyOn(manager.workspaceEdits, "editorForWorkspaceEdit").and.callThrough();
    const plan = await manager.workspaceEdits.preflightWorkspaceEdit(
      [{ textDocument: { uri, version: 1 }, edits: [] }],
      session,
    );
    document.version = 2;

    const result = await manager.workspaceEdits.applyWorkspaceEditPlanDetailed(plan);

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("A document changed");
    expect(result.failedChange).toBe(0);
    expect(resolveEditor).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("current\n");
  });
});
