const fs = require("fs");
const os = require("os");
const path = require("path");
const Manager = require("../lib/language-server-manager");
const C = require("../lib/converters");
const { publishSession } = require("./helpers/session-fixtures");

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
};
const flush = async () => {
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
};

describe("Staged file operation preparations", () => {
  let manager, directory, editors;

  beforeEach(() => {
    manager = new Manager();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ide-file-preparation-"));
    editors = [];
  });
  afterEach(async () => {
    await manager.deactivate();
    for (const editor of editors) editor.destroy();
    lumine.config.unset("ide-client.fileOperationPreparationTimeout");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const file = (name, text = "original\n") => {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, text);
    return filePath;
  };
  const open = async (name, text) => {
    const editor = await lumine.workspace.open(file(name, text));
    editors.push(editor);
    return editor;
  };
  const editFor = (filePath) => ({
    changes: {
      [C.pathToUri(filePath)]: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
          newText: "prepared",
        },
      ],
    },
  });
  const payload = (signal) => ({
    files: [
      { oldPath: path.join(directory, "before.test"), newPath: path.join(directory, "after.test") },
    ],
    paths: [path.join(directory, "before.test")],
    signal,
  });
  const sessionFor = (request, editor) => {
    const uri = editor && C.pathToUri(editor.getPath());
    const session = {
      state: "running",
      adapter: { id: `fake-${manager.sessions.size}`, grammarScopes: [] },
      documents: new Map(uri ? [[C.uriKey(uri), { editor, uri, version: 1 }]] : []),
      capabilities: {
        workspace: {
          fileOperations: Object.fromEntries(
            ["willCreate", "willRename", "willDelete"].map((name) => [
              name,
              { filters: [{ pattern: { glob: "**/*" } }] },
            ]),
          ),
        },
      },
      request: jasmine.createSpy("request").and.callFake(request),
    };
    publishSession(manager, session, directory);
    return session;
  };

  it("stages raw edits without opening targets or preflighting until commit", async () => {
    const target = file("closed.test");
    sessionFor(async () => editFor(target));
    const preflight = spyOn(manager, "preflightWorkspaceEdit").and.callThrough();
    const workspaceOpen = spyOn(lumine.workspace, "open").and.callThrough();

    const stage = await manager.prepareRenameFiles(payload());
    expect(stage.hasEdits()).toBe(true);
    expect(preflight).not.toHaveBeenCalled();
    expect(workspaceOpen).not.toHaveBeenCalled();
    stage.dispose();
    expect(await stage.commit()).toBe(false);
    expect(preflight).not.toHaveBeenCalled();
    expect(workspaceOpen).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
  });

  it("commits multi-buffer edits once without invalidating its own snapshots", async () => {
    const first = await open("first.test");
    const second = await open("second.test");
    sessionFor(async () => ({
      changes: { ...editFor(first.getPath()).changes, ...editFor(second.getPath()).changes },
    }));
    const stage = await manager.prepareRenameFiles(payload());
    expect(first.getText()).toBe("original\n");
    expect(second.getText()).toBe("original\n");
    const apply = spyOn(manager, "applyWorkspaceEdits").and.callThrough();

    const committed = stage.commit();
    expect(stage.commit()).toBe(committed);
    expect(await committed).toBe(true);
    expect(first.getText()).toBe("prepared\n");
    expect(second.getText()).toBe("prepared\n");
    expect(apply.calls.count()).toBe(1);
    expect(manager.fileOperationPreparations.size).toBe(0);
  });

  it("keeps every closed reference target alive until a multi-file commit finishes", async () => {
    lumine.config.set("core.allowPendingPaneItems", true);
    const firstPath = file("closed-first.test");
    const secondPath = file("closed-second.test");
    sessionFor(async () => ({
      changes: { ...editFor(firstPath).changes, ...editFor(secondPath).changes },
    }));
    const stage = await manager.prepareRenameFiles(payload());

    expect(await stage.commit()).toBe(true);
    const opened = lumine.workspace.getTextEditors();
    for (const target of [firstPath, secondPath]) {
      const editor = opened.find((item) => item.getPath() === target);
      expect(editor).toBeDefined();
      expect(editor?.getText()).toBe("prepared\n");
      if (editor) editors.push(editor);
    }
  });

  it("abandons an ignored cancellation immediately and discards the late reply", async () => {
    const target = file("cancelled.test");
    const reply = deferred();
    const session = sessionFor(() => reply.promise);
    const controller = new AbortController();
    const warning = spyOn(lumine.notifications, "addWarning");
    const apply = spyOn(manager, "applyWorkspaceEdits").and.callThrough();
    const pending = manager.prepareRenameFiles(payload(controller.signal));

    controller.abort();
    expect(await pending).toBe(false);
    expect(session.request.calls.mostRecent().args[2].signal.aborted).toBe(true);
    reply.resolve(editFor(target));
    await flush();
    expect(apply).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(manager.fileOperationPreparations.size).toBe(0);
  });

  it("rejects a relevant buffer changed and reverted while the server was preparing", async () => {
    const editor = await open("changed-during-request.test");
    const reply = deferred();
    sessionFor(() => reply.promise, editor);
    const pending = manager.prepareRenameFiles(payload());
    editor.setText("changed\n");
    editor.setText("original\n");
    reply.resolve(editFor(editor.getPath()));

    expect(await pending).toBe(false);
    expect(editor.getText()).toBe("original\n");
  });

  it("consumes a rejection returned by a request that synchronously cancels", async () => {
    const controller = new AbortController();
    sessionFor(() => {
      controller.abort();
      return Promise.reject(new Error("Cancelled request"));
    });

    expect(await manager.prepareRenameFiles(payload(controller.signal))).toBe(false);
    await flush();
    expect(manager.fileOperationPreparations.size).toBe(0);
  });

  it("keeps an oversized timeout inside the timer's supported range", async () => {
    lumine.config.set("ide-client.fileOperationPreparationTimeout", 1000000000);
    sessionFor(() => new Promise(() => {}));
    const pending = manager.prepareRenameFiles(payload());
    const delay = window.setTimeout.calls.mostRecent().args[1];
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(3600000);
    advanceClock(delay);

    expect(await pending).toBe(false);
  });

  it("rejects a relevant buffer changed between preparation and commit", async () => {
    const editor = await open("changed-after-response.test");
    sessionFor(async () => editFor(editor.getPath()), editor);
    const stage = await manager.prepareRenameFiles(payload());
    const warning = spyOn(lumine.notifications, "addWarning");
    editor.setText("new value\n");

    expect(await stage.commit()).toBe(false);
    expect(editor.getText()).toBe("new value\n");
    expect(warning.calls.count()).toBe(1);
    expect(warning.calls.mostRecent().args[1].detail).toContain("changed");
  });

  it("does not cancel when an unrelated buffer changes", async () => {
    const target = await open("target.test");
    const other = await open("unrelated.test");
    sessionFor(async () => editFor(target.getPath()), target);
    const stage = await manager.prepareRenameFiles(payload());
    other.setText("unrelated change\n");

    expect(await stage.commit()).toBe(true);
    expect(target.getText()).toBe("prepared\n");
    expect(other.getText()).toBe("unrelated change\n");
  });

  it("rejects a replaced document generation even when its version is unchanged", async () => {
    const editor = await open("generation.test");
    const session = sessionFor(async () => editFor(editor.getPath()), editor);
    const stage = await manager.prepareRenameFiles(payload());
    const key = C.uriKey(C.pathToUri(editor.getPath()));
    session.documents.set(key, { ...session.documents.get(key) });

    expect(await stage.commit()).toBe(false);
    expect(editor.getText()).toBe("original\n");
  });

  it("checks cancellation after an awaited editor acquisition before touching text", async () => {
    const target = file("late-open.test");
    sessionFor(async () => editFor(target));
    const stage = await manager.prepareRenameFiles(payload());
    const acquisition = deferred();
    spyOn(manager, "editorForWorkspaceEdit").and.returnValue(acquisition.promise);
    const editor = lumine.workspace.buildTextEditor();
    editor.setText("original\n");
    editors.push(editor);
    const committed = stage.commit();
    await flush();
    stage.dispose();
    acquisition.resolve(editor);

    expect(await committed).toBe(false);
    expect(editor.getText()).toBe("original\n");
  });

  it("checks caller path guards after an awaited inspection", async () => {
    const target = file("path-guard.test");
    sessionFor(async () => editFor(target));
    const inspection = deferred();
    manager.setFileOperationsExecutor({ inspect: () => inspection.promise });
    const stage = await manager.prepareRenameFiles(payload());
    let current = true;
    const warning = spyOn(lumine.notifications, "addWarning");
    const workspaceOpen = spyOn(lumine.workspace, "open").and.callThrough();
    const committed = stage.commit({ isCurrent: () => current });
    await flush();
    current = false;
    inspection.resolve([{ path: target, status: "file" }]);

    expect(await committed).toBe(false);
    expect(workspaceOpen).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
    expect(warning.calls.count()).toBe(1);
    expect(warning.calls.mostRecent().args[1].detail).toContain("guard changed");
  });

  it("keeps cancellation with an Error reason quiet immediately before text mutation", async () => {
    const editor = await open("cancel-before-mutation.test");
    const controller = new AbortController();
    const session = sessionFor(async () => editFor(editor.getPath()), editor);
    session.restoreDocumentText = (text) => {
      controller.abort(new Error("User cancelled"));
      return text;
    };
    const warning = spyOn(lumine.notifications, "addWarning");
    const error = spyOn(lumine.notifications, "addError");
    const stage = await manager.prepareRenameFiles(payload(controller.signal));

    expect(await stage.commit()).toBe(false);
    expect(editor.getText()).toBe("original\n");
    expect(warning).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after restoring text in a mixed resource preparation", async () => {
    const editor = await open("cancel-mixed-preparation.test");
    const controller = new AbortController();
    const uri = C.pathToUri(editor.getPath());
    const session = sessionFor(
      async () => ({
        documentChanges: [
          { kind: "create", uri: C.pathToUri(path.join(directory, "already-created.test")) },
          { textDocument: { uri }, edits: editFor(editor.getPath()).changes[uri] },
        ],
      }),
      editor,
    );
    session.restoreDocumentText = (text) => {
      controller.abort(new Error("User cancelled"));
      return text;
    };
    const plan = {
      describe: () => [{ status: "skip" }],
      executeNext: jasmine
        .createSpy("executeNext")
        .and.resolveTo({ status: "skipped", effects: [] }),
      dispose: jasmine.createSpy("dispose"),
    };
    manager.setFileOperationsExecutor({ prepare: async () => ({ status: "ready", plan }) });
    const error = spyOn(lumine.notifications, "addError");
    const stage = await manager.prepareRenameFiles(payload(controller.signal));

    expect(await stage.commit()).toBe(false);
    expect(editor.getText()).toBe("original\n");
    expect(error).not.toHaveBeenCalled();
    expect(plan.dispose.calls.count()).toBe(1);
  });

  for (const kind of ["Create", "Rename", "Delete"]) {
    for (const stalled of ["first", "second"]) {
      it(`bounds the whole ${kind.toLowerCase()} preparation while the ${stalled} server stalls`, async () => {
        lumine.config.set("ide-client.fileOperationPreparationTimeout", 1);
        const editor = await open(`timeout-${kind}-${stalled}.test`);
        const firstReply = deferred();
        const secondReply = deferred();
        const first = sessionFor(() => firstReply.promise, editor);
        const second = sessionFor(() => secondReply.promise, editor);
        const warning = spyOn(lumine.notifications, "addWarning");
        const pending = manager[`will${kind}Files`](payload());
        advanceClock(600);
        if (stalled === "second") {
          firstReply.resolve(editFor(editor.getPath()));
          await flush();
          expect(second.request).toHaveBeenCalled();
        }
        advanceClock(400);

        expect(await pending).toBe(false);
        expect(first.request.calls.mostRecent().args[2].signal.aborted).toBe(true);
        expect(warning.calls.count()).toBe(1);
        expect(warning.calls.mostRecent().args[1].detail).toContain("timed out after 1 second");
        firstReply.resolve(editFor(editor.getPath()));
        secondReply.resolve(editFor(editor.getPath()));
        await flush();
        expect(editor.getText()).toBe("original\n");
      });
    }
  }

  it("invalidates an outstanding preparation when the manager deactivates", async () => {
    const editor = await open("deactivated.test");
    const reply = deferred();
    sessionFor(() => reply.promise, editor);
    const pending = manager.prepareRenameFiles(payload());
    await manager.deactivate();

    expect(await pending).toBe(false);
    reply.resolve(editFor(editor.getPath()));
    await flush();
    expect(editor.getText()).toBe("original\n");
  });
});
