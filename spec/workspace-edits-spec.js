const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const LanguageServerManager = require("../lib/language-server-manager");
const C = require("../lib/converters");

const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => (resolve = complete));
  return { promise, resolve };
};

describe("Workspace edit target lifetimes", () => {
  let manager, tempDir, editors, filePlan;

  const openTarget = async (name = "target.js") => {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, "original\n");
    const editor = await lumine.workspace.open(filePath);
    editors.push(editor);
    const uri = C.pathToUri(filePath);
    const document = { editor, uri, version: 1 };
    const session = { state: "running", documents: new Map([[C.uriKey(uri), document]]) };
    return { filePath, editor, uri, document, session };
  };

  const textChange = (uri, version = null) => ({
    textDocument: { uri, version },
    edits: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        newText: "server",
      },
    ],
  });

  const deleteChange = () => ({
    kind: "delete",
    uri: C.pathToUri(path.join(tempDir, "unrelated.txt")),
  });

  beforeEach(() => {
    jasmine.useRealClock();
    manager = new LanguageServerManager();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-workspace-lifetimes-"));
    editors = [];
    fs.writeFileSync(path.join(tempDir, "unrelated.txt"), "unrelated");
    filePlan = {
      describe: () => [{ status: "apply" }],
      executeNext: jasmine.createSpy("executeNext").and.resolveTo({
        status: "skipped",
        effects: [],
      }),
      dispose: jasmine.createSpy("dispose file plan"),
    };
    manager.setFileOperationsExecutor({
      prepare: jasmine.createSpy("prepare").and.resolveTo({ status: "ready", plan: filePlan }),
    });
  });

  afterEach(async () => {
    await manager.deactivate();
    for (const editor of editors) {
      if (!editor.isDestroyed()) editor.destroy();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  for (const replace of [false, true]) {
    it(`refuses a ${replace ? "replaced" : "closed"} document generation after confirmation`, async () => {
      const { editor, uri, document, session } = await openTarget();
      spyOn(lumine.window, "confirm").and.callFake(async () => {
        if (replace) session.documents.set(C.uriKey(uri), { ...document });
        else session.documents.delete(C.uriKey(uri));
        return 0;
      });

      const result = await manager.applyWorkspaceEditDetailed(
        { documentChanges: [textChange(uri, 1), deleteChange()] },
        "Server operation",
        session,
      );

      expect(result.applied).toBe(false);
      expect(result.failedChange).toBe(0);
      expect(editor.getText()).toBe("original\n");
      expect(filePlan.executeNext).not.toHaveBeenCalled();
      expect(filePlan.dispose).toHaveBeenCalled();
    });
  }

  it("refuses an unversioned target retargeted while confirmation is open", async () => {
    const { editor, uri } = await openTarget();
    const newPath = path.join(tempDir, "different.js");
    const mutate = spyOn(editor, "setTextInBufferRange").and.callThrough();
    spyOn(lumine.window, "confirm").and.callFake(async () => {
      editor.getBuffer().setPath(newPath);
      return 0;
    });

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [textChange(uri), deleteChange()],
    });

    expect(result.applied).toBe(false);
    expect(result.failedChange).withContext(JSON.stringify(result)).toBe(0);
    expect(editor.getPath()).toBe(newPath);
    expect(editor.getText()).toBe("original\n");
    expect(mutate).not.toHaveBeenCalled();
    expect(filePlan.executeNext).not.toHaveBeenCalled();
    expect(filePlan.dispose).toHaveBeenCalled();
  });

  it("refuses an unversioned target destroyed while confirmation is open", async () => {
    const { editor, uri } = await openTarget();
    const mutate = spyOn(editor, "setTextInBufferRange").and.callThrough();
    spyOn(lumine.window, "confirm").and.callFake(async () => {
      editor.destroy();
      return 0;
    });

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [textChange(uri), deleteChange()],
    });

    expect(result.applied).toBe(false);
    expect(result.failedChange).toBe(0);
    expect(mutate).not.toHaveBeenCalled();
    expect(filePlan.executeNext).not.toHaveBeenCalled();
    expect(filePlan.dispose).toHaveBeenCalled();
  });

  for (const revert of [false, true]) {
    it(`refuses an unversioned target changed${revert ? " and reverted" : ""} during confirmation`, async () => {
      const { editor, uri } = await openTarget();
      spyOn(lumine.window, "confirm").and.callFake(async () => {
        editor.setText("user\n");
        if (revert) editor.setText("original\n");
        return 0;
      });

      const result = await manager.applyWorkspaceEditDetailed({
        documentChanges: [textChange(uri), deleteChange()],
      });

      expect(result.applied).toBe(false);
      expect(result.failedChange).toBe(0);
      expect(editor.getText()).toBe(revert ? "original\n" : "user\n");
      expect(filePlan.executeNext).not.toHaveBeenCalled();
      expect(filePlan.dispose).toHaveBeenCalled();
    });
  }

  it("advances its own snapshot between sequential unversioned text batches", async () => {
    const { editor, uri } = await openTarget();

    const result = await manager.applyWorkspaceEditDetailed({
      documentChanges: [
        textChange(uri),
        {
          textDocument: { uri, version: null },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
              newText: "finished",
            },
          ],
        },
      ],
    });

    expect(result.applied).toBe(true);
    expect(editor.getText()).toBe("finished\n");
  });

  for (const replace of [false, true]) {
    it(`refuses a cell binding ${replace ? "replaced" : "removed"} while its editor stays alive`, async () => {
      const editor = lumine.workspace.buildTextEditor();
      editors.push(editor);
      editor.setText("original\n");
      const notebookPath = path.join(tempDir, "notebook.ipynb");
      const uri = C.cellUri(notebookPath, "cell");
      const record = { filePath: notebookPath, cellIndexOf: () => 0 };
      const binding = { editor, uri, cellId: "cell", record };
      manager.workspaceDocuments.bind(editor, binding);
      spyOn(lumine.window, "confirm").and.callFake(async () => {
        if (replace) manager.workspaceDocuments.bind(editor, { ...binding, record: { ...record } });
        else manager.workspaceDocuments.unbind(editor);
        return 0;
      });

      const result = await manager.applyWorkspaceEditDetailed({
        documentChanges: [textChange(uri), deleteChange()],
      });

      expect(result.applied).toBe(false);
      expect(result.failedChange).toBe(0);
      expect(editor.isDestroyed()).toBe(false);
      expect(editor.getText()).toBe("original\n");
      expect(filePlan.executeNext).not.toHaveBeenCalled();
      expect(filePlan.dispose).toHaveBeenCalled();
    });
  }

  for (const replaceDocument of [false, true]) {
    it(`captures ${replaceDocument ? "document generations" : "unversioned buffer revisions"} before file preparation waits`, async () => {
      const { editor, uri, document, session } = await openTarget();
      const preparation = deferred();
      const entered = deferred();
      manager.setFileOperationsExecutor({
        prepare: async () => {
          entered.resolve();
          await preparation.promise;
          return { status: "ready", plan: filePlan };
        },
      });
      spyOn(lumine.window, "confirm").and.resolveTo(0);
      const applying = manager.applyWorkspaceEditDetailed(
        { documentChanges: [textChange(uri, replaceDocument ? 1 : null), deleteChange()] },
        "Server operation",
        replaceDocument ? session : null,
      );
      await entered.promise;
      if (replaceDocument) session.documents.set(C.uriKey(uri), { ...document });
      else {
        editor.setText("user\n");
        editor.setText("original\n");
      }
      preparation.resolve();

      const result = await applying;

      expect(result.applied).toBe(false);
      expect(result.failedChange).toBe(0);
      expect(editor.getText()).toBe("original\n");
      expect(filePlan.executeNext).not.toHaveBeenCalled();
      expect(filePlan.dispose).toHaveBeenCalled();
    });
  }

  it("disposes a waiting plan and prevents mutation when the manager deactivates", async () => {
    const { editor, uri } = await openTarget();
    const confirmation = deferred();
    const entered = deferred();
    const mutate = spyOn(editor, "setTextInBufferRange").and.callThrough();
    spyOn(lumine.window, "confirm").and.callFake(() => {
      entered.resolve();
      return confirmation.promise;
    });
    const applying = manager.applyWorkspaceEditDetailed({
      documentChanges: [textChange(uri), deleteChange()],
    });
    await entered.promise;

    await manager.deactivate();
    confirmation.resolve(0);
    const result = await applying;

    expect(result.applied).toBe(false);
    expect(editor.getText()).toBe("original\n");
    expect(mutate).not.toHaveBeenCalled();
    expect(filePlan.executeNext).not.toHaveBeenCalled();
    expect(filePlan.dispose).toHaveBeenCalled();
  });

  it("refuses a resource-only mutation after its source session stops", async () => {
    const session = { state: "running", documents: new Map() };
    spyOn(lumine.window, "confirm").and.callFake(async () => {
      session.state = "stopped";
      return 0;
    });

    const result = await manager.applyWorkspaceEditDetailed(
      { documentChanges: [deleteChange()] },
      "Server operation",
      session,
    );

    expect(result.applied).toBe(false);
    expect(filePlan.executeNext).not.toHaveBeenCalled();
    expect(filePlan.dispose).toHaveBeenCalled();
  });

  for (const [method, label] of [
    ["deactivate", "deactivation"],
    ["killAllSessions", "window teardown"],
  ]) {
    it(`cancels executor validation before filesystem mutation on ${label}`, async () => {
      const filePath = path.join(tempDir, "unrelated.txt");
      const validation = deferred();
      const entered = deferred();
      filePlan.executeNext.and.callFake(async ({ signal } = {}) => {
        entered.resolve();
        await validation.promise;
        signal?.throwIfAborted();
        fs.unlinkSync(filePath);
        return { status: "applied", effects: [{ kind: "delete", path: filePath }] };
      });
      spyOn(lumine.window, "confirm").and.resolveTo(0);
      const applying = manager.applyWorkspaceEditDetailed({ documentChanges: [deleteChange()] });
      await entered.promise;

      await manager[method]();
      validation.resolve();
      const result = await applying;

      expect(result.applied).toBe(false);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(filePlan.dispose).toHaveBeenCalled();
    });
  }

  it("cancels executor validation when its source session stops", async () => {
    const filePath = path.join(tempDir, "unrelated.txt");
    const validation = deferred();
    const entered = deferred();
    let stateChanged;
    const dispose = jasmine.createSpy("dispose state subscription");
    const session = {
      state: "running",
      documents: new Map(),
      onDidChangeState: (callback) => {
        stateChanged = callback;
        return { dispose };
      },
    };
    filePlan.executeNext.and.callFake(async ({ signal } = {}) => {
      entered.resolve();
      await validation.promise;
      signal?.throwIfAborted();
      fs.unlinkSync(filePath);
      return { status: "applied", effects: [{ kind: "delete", path: filePath }] };
    });
    spyOn(lumine.window, "confirm").and.resolveTo(0);
    const applying = manager.applyWorkspaceEditDetailed(
      { documentChanges: [deleteChange()] },
      "Server operation",
      session,
    );
    await entered.promise;
    session.state = "stopped";
    stateChanged({ state: "stopped" });
    validation.resolve();

    const result = await applying;

    expect(result.applied).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(dispose).toHaveBeenCalled();
    expect(filePlan.dispose).toHaveBeenCalled();
  });

  it("rechecks a rename target opened during the executor's path inspection", async () => {
    const source = path.join(tempDir, "unrelated.txt");
    const target = path.join(tempDir, "late-open-target.js");
    const inspection = deferred();
    const entered = deferred();
    manager.setFileOperationsExecutor({
      prepare: async () => ({ status: "ready", plan: filePlan }),
      inspect: async (paths) => {
        entered.resolve();
        await inspection.promise;
        return paths.map((filePath) => ({ path: filePath, status: "file" }));
      },
    });
    spyOn(lumine.window, "confirm").and.resolveTo(0);
    const applying = manager.applyWorkspaceEditDetailed({
      documentChanges: [
        { kind: "rename", oldUri: C.pathToUri(source), newUri: C.pathToUri(target) },
      ],
    });
    await entered.promise;
    const editor = await lumine.workspace.open(target);
    editors.push(editor);
    editor.setText("unsaved target\n");
    inspection.resolve();

    const result = await applying;

    expect(result.applied).toBe(false);
    expect(result.failedChange).toBe(0);
    expect(result.failureReason).toContain("while it is open in the workspace");
    expect(editor.getText()).toBe("unsaved target\n");
    expect(filePlan.executeNext).not.toHaveBeenCalled();
    expect(filePlan.dispose).toHaveBeenCalled();
    expect(fs.readFileSync(source, "utf8")).toBe("unrelated");
  });

  it("rechecks document generation after an awaited file step", async () => {
    const { editor, uri, document, session } = await openTarget();
    const execution = deferred();
    const entered = deferred();
    filePlan.executeNext.and.callFake(async () => {
      entered.resolve();
      await execution.promise;
      return { status: "skipped", effects: [] };
    });
    spyOn(lumine.window, "confirm").and.resolveTo(0);
    const applying = manager.applyWorkspaceEditDetailed(
      { documentChanges: [deleteChange(), textChange(uri, 1)] },
      "Server operation",
      session,
    );
    await entered.promise;
    session.documents.set(C.uriKey(uri), { ...document });
    execution.resolve();

    const result = await applying;

    expect(result.applied).toBe(false);
    expect(result.failedChange).toBe(1);
    expect(editor.getText()).toBe("original\n");
    expect(filePlan.executeNext).toHaveBeenCalledTimes(1);
    expect(filePlan.dispose).toHaveBeenCalled();
  });

  for (const [name, invalidEdit] of [
    ["missing range", { newText: "invalid" }],
    [
      "non-text replacement",
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        newText: 12,
      },
    ],
    [
      "negative position",
      {
        range: { start: { line: 0, character: -1 }, end: { line: 0, character: 8 } },
        newText: "invalid",
      },
    ],
    [
      "reversed range",
      {
        range: { start: { line: 0, character: 8 }, end: { line: 0, character: 0 } },
        newText: "invalid",
      },
    ],
  ]) {
    it(`prevalidates a later ${name} before modifying any document`, async () => {
      const first = await openTarget("first.js");
      const second = await openTarget("second.js");
      const mutate = spyOn(first.editor, "setTextInBufferRange").and.callThrough();

      const result = await manager.applyWorkspaceEditDetailed({
        documentChanges: [
          textChange(first.uri),
          { textDocument: { uri: second.uri, version: null }, edits: [invalidEdit] },
        ],
      });

      expect(result.applied).toBe(false);
      expect(result.failedChange).toBe(1);
      expect(first.editor.getText()).toBe("original\n");
      expect(second.editor.getText()).toBe("original\n");
      expect(mutate).not.toHaveBeenCalled();
    });
  }

  it("consumes a prepared plan once and refuses a second application", async () => {
    const { editor, uri } = await openTarget();
    const mutate = spyOn(editor, "setTextInBufferRange").and.callThrough();
    const edits = manager.workspaceEdits;
    const plan = await edits.preflightWorkspaceEdit([textChange(uri)], null);

    expect((await edits.applyWorkspaceEditPlanDetailed(plan)).applied).toBe(true);
    const appliedText = editor.getText();
    const replay = await edits.applyWorkspaceEditPlanDetailed(plan);

    expect(replay.applied).toBe(false);
    expect(editor.getText()).toBe(appliedText);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  for (const replace of [false, true]) {
    it(`preserves array order for same-position insertions${replace ? " followed by a replacement" : ""}`, async () => {
      const { editor, uri } = await openTarget();
      const insertion = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
      const edits = [
        { range: insertion, newText: "first " },
        { range: insertion, newText: "second " },
      ];
      if (replace) edits.push(textChange(uri).edits[0]);

      const result = await manager.applyWorkspaceEditDetailed({
        documentChanges: [{ textDocument: { uri, version: null }, edits }],
      });

      expect(result.applied).toBe(true);
      expect(editor.getText()).toBe(`first second ${replace ? "server" : "original"}\n`);
    });
  }
});
