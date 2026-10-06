const ServerActivity = require("../lib/server-activity");
const LanguageServerManager = require("../lib/language-server-manager");
const makeBusySignal = require("./helpers/busy-signal");

describe("Language server activity", () => {
  let activity, signal, session;

  beforeEach(() => {
    activity = new ServerActivity();
    signal = makeBusySignal();
    session = { adapter: { id: "test", displayName: "Test Server" } };
    activity.setBusySignal(signal);
  });

  afterEach(() => activity.dispose());

  it("keeps same-title tasks independent across tokens and project sessions", () => {
    const first = activity.begin(session, "a", { title: "Indexing" });
    activity.begin(session, "b", { title: "Indexing" });
    activity.begin({ adapter: session.adapter }, "a", { title: "Indexing" });
    expect(signal.entries().length).toBe(3);
    first.dispose();
    expect(signal.entries().length).toBe(2);
    expect(signal.entries().map(({ title }) => title)).toEqual([
      "Test Server: Indexing",
      "Test Server: Indexing",
    ]);
  });

  it("retires replaced tokens without letting an old handle remove the replacement", () => {
    const first = activity.begin(session, "a", { title: "Old phase" });
    const replacement = activity.begin(session, "a", { title: "New phase" });
    first.update({ title: "Stale phase" });
    first.dispose();
    expect(signal.entries().map(({ title }) => title)).toEqual(["Test Server: New phase"]);
    expect(signal.providers.size).toBe(1);
    replacement.dispose();
    expect(signal.entries()).toEqual([]);
    expect(activity.operations.size).toBe(0);
  });

  it("replays current details when the service arrives during work", () => {
    activity.setBusySignal(null);
    const task = activity.begin(session, "a", { title: "Indexing", percentage: 0 });
    task.update({ message: "First file" });
    activity.setBusySignal(signal);
    expect(signal.entries()[0].title).toBe("Test Server: Indexing (First file) — 0%");
    task.update({ percentage: 50 });
    expect(signal.entries()[0].title).toBe("Test Server: Indexing (First file) — 50%");
  });

  it("replays through service replacement and does not resurrect finished tasks", () => {
    const task = activity.begin(session, "a", { title: "Indexing" });
    const replacement = makeBusySignal();
    activity.setBusySignal(null);
    expect(signal.providers.size).toBe(0);
    task.update({ message: "Halfway" });
    activity.setBusySignal(replacement);
    expect(replacement.entries()[0].title).toBe("Test Server: Indexing (Halfway)");
    activity.setBusySignal(null);
    task.dispose();
    activity.setBusySignal(signal);
    expect(signal.entries()).toEqual([]);
  });

  it("suppresses quick requests and shows the latest details after the delay", () => {
    const quick = activity.begin(session, "quick", { title: "Hover", delay: 400 });
    quick.dispose();
    const slow = activity.begin(session, "slow", { title: "References", delay: 400 });
    slow.update({ message: "Scanning" });
    advanceClock(399);
    expect(signal.created).toBe(0);
    advanceClock(1);
    expect(signal.entries()[0].title).toBe("Test Server: References (Scanning)");
    expect(signal.created).toBe(1);
  });

  it("preserves start time when percentage or clickability changes", () => {
    const cancel = jasmine.createSpy("cancel work");
    const task = activity.begin(session, "a", {
      title: "Indexing",
      percentage: 0,
      cancellable: true,
      cancel,
    });
    const started = signal.entries()[0].started;
    advanceClock(500);
    task.update({ percentage: 50, cancellable: false });
    expect(signal.entries()[0].started).toBe(started);
    expect(signal.entries()[0].options.onDidClick).toBe(null);
    task.update({ cancellable: true });
    signal.entries()[0].options.onDidClick();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(signal.entries()[0].options.onDidClick).toBe(null);
    expect(signal.entries().length).toBe(1);
  });

  it("explains cancellation only while it is available and omits it from history", () => {
    const task = activity.begin(session, "a", {
      title: "Indexing",
      cancellable: true,
      cancel() {},
    });
    expect(signal.entries()[0].title).toBe("Test Server: Indexing · Click to cancel");
    signal.entries()[0].options.onDidClick();
    expect(signal.entries()[0].title).toBe("Test Server: Indexing");
    task.update({ cancellable: true });
    expect(signal.entries()[0].title).toContain("Click to cancel");
    task.dispose();
    expect(signal.completed[0].title).toBe("Test Server: Indexing");
  });

  it("omits cancellation hints from history when replacing the service", () => {
    activity.begin(session, "a", { title: "Indexing", cancellable: true, cancel() {} });
    const replacement = makeBusySignal();
    activity.setBusySignal(replacement);
    expect(signal.completed[0].title).toBe("Test Server: Indexing");
    expect(replacement.entries()[0].title).toBe("Test Server: Indexing · Click to cancel");
  });

  it("ignores cancellation callbacks captured before a task ends", () => {
    const cancel = jasmine.createSpy("cancel ended work");
    const task = activity.begin(session, "a", { title: "Indexing", cancellable: true, cancel });
    const click = signal.entries()[0].options.onDidClick;
    task.dispose();
    click();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("reports cancellation failures without dropping the active task", async () => {
    const error = new Error("Unable to cancel");
    activity.onError = jasmine.createSpy("report cancellation failure");
    activity.begin(session, "a", {
      title: "Indexing",
      cancellable: true,
      cancel: () => Promise.reject(error),
    });
    signal.entries()[0].options.onDidClick();
    await Promise.resolve();
    expect(activity.onError).toHaveBeenCalledWith(session, error);
    expect(signal.entries().length).toBe(1);
  });

  it("clears one session including its delayed work and disposes global work", () => {
    activity.begin(session, "active", { title: "Indexing" });
    activity.begin(session, "delayed", { title: "References", delay: 400 });
    const other = { adapter: session.adapter };
    activity.begin(other, "active", { title: "Checking" });
    activity.begin(null, Symbol("install"), { title: "Installing a server" });
    activity.clear(session);
    advanceClock(400);
    expect(signal.entries().map(({ title }) => title)).toEqual([
      "Test Server: Checking",
      "Installing a server",
    ]);
    activity.dispose();
    expect(signal.providers.size).toBe(0);
    expect(activity.operations.size).toBe(0);
    activity.begin(session, "late", { title: "Stale" });
    expect(signal.entries()).toEqual([]);
  });
});

describe("Language server progress adapter", () => {
  let manager, signal, session;

  beforeEach(() => {
    manager = new LanguageServerManager();
    signal = makeBusySignal();
    manager.setBusySignal(signal);
    session = {
      adapter: { id: "test", displayName: "Test Server" },
      progressTitles: new Map(),
      clientProgressTokens: new Map(),
      retiredProgressTokens: new Set(),
      notify: jasmine.createSpy("notify server"),
    };
  });

  afterEach(() => {
    manager.activity.dispose();
    manager.emitter.dispose();
  });

  const progress = (session, token, value) => ({ session, params: { token, value } });
  const send = (manager, event) => manager.handleProgress(event.session, event.params);

  it("includes begin details, percentage-only reports and final messages", () => {
    send(
      manager,
      progress(session, "a", {
        kind: "begin",
        title: "Indexing",
        message: "Scanning",
        percentage: 0,
      }),
    );
    expect(signal.entries()[0].title).toBe("Test Server: Indexing (Scanning) — 0%");
    send(manager, progress(session, "a", { kind: "report", percentage: 50 }));
    expect(signal.entries()[0].title).toBe("Test Server: Indexing (Scanning) — 50%");
    send(manager, progress(session, "a", { kind: "end", message: "Completed" }));
    expect(signal.entries()).toEqual([]);
    expect(signal.completed[0].title).toBe("Test Server: Indexing (Completed) — 50%");
    expect(session.progressTitles.size).toBe(0);
  });

  it("routes cancellable server work to work-done cancellation", () => {
    send(manager, progress(session, 0, { kind: "begin", title: "Indexing", cancellable: true }));
    signal.entries()[0].options.onDidClick();
    expect(session.notify).toHaveBeenCalledWith("window/workDoneProgress/cancel", { token: 0 });
    expect(signal.entries().length).toBe(1);
  });

  it("merges client-owned progress into the request and preserves its cancellation policy", () => {
    const cancel = jasmine.createSpy("cancel request");
    session.clientProgressTokens.set("a", { title: "References", cancellable: false, cancel });
    const task = manager.beginActivity(session, "a", {
      title: "References",
      cancellable: false,
      cancel,
      delay: 400,
    });
    send(manager, progress(session, "a", { kind: "begin", title: "", cancellable: true }));
    send(manager, progress(session, "a", { kind: "report", message: "Searching", percentage: 20 }));
    advanceClock(400);
    expect(signal.providers.size).toBe(1);
    expect(signal.entries()[0].title).toBe("Test Server: References (Searching) — 20%");
    expect(signal.entries()[0].options.onDidClick).toBe(null);
    task.dispose();
    expect(signal.providers.size).toBe(0);
  });

  it("creates explicit progress for a client token without a fallback task", () => {
    const cancel = jasmine.createSpy("cancel client work");
    session.clientProgressTokens.set("a", { title: "Checking", cancellable: true, cancel });
    send(
      manager,
      progress(session, "a", { kind: "begin", title: "Diagnostics", cancellable: true }),
    );
    advanceClock(400);
    expect(signal.entries()[0].title).toBe("Test Server: Diagnostics · Click to cancel");
    signal.entries()[0].options.onDidClick();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(session.notify).not.toHaveBeenCalled();
  });

  it("ignores late progress for retired requests", () => {
    session.retiredProgressTokens.add("a");
    send(manager, progress(session, "a", { kind: "begin", title: "Too late" }));
    advanceClock(400);
    expect(signal.entries()).toEqual([]);
    expect(session.progressTitles.size).toBe(0);
  });

  it("ignores generated client tokens even after their retirement tombstone is evicted", () => {
    for (const token of ["ide-client-request-evicted", "ide-client-start-evicted"]) {
      send(manager, progress(session, token, { kind: "begin", title: "Too late" }));
    }
    advanceClock(400);
    expect(signal.entries()).toEqual([]);
    expect(session.progressTitles.size).toBe(0);
    expect(manager.activity.operations.size).toBe(0);
  });

  it("ignores progress once a session is stopping, stopped or failed", () => {
    for (const state of ["stopping", "stopped", "failed"]) {
      session.state = state;
      send(manager, progress(session, state, { kind: "begin", title: "Too late" }));
      send(manager, progress(session, state, { kind: "report", message: "Late report" }));
    }
    expect(signal.entries()).toEqual([]);
    expect(session.progressTitles.size).toBe(0);
  });

  it("cleans repeated begins and ignores reports without a matching begin", () => {
    send(manager, progress(session, "a", { kind: "begin", title: "Old phase" }));
    send(manager, progress(session, "a", { kind: "begin", title: "New phase" }));
    send(manager, progress(session, "unknown", { kind: "report", message: "Untracked" }));
    send(manager, progress(session, "a", { kind: "end" }));
    manager.clearProgress(session);
    expect(signal.entries()).toEqual([]);
    expect(signal.providers.size).toBe(0);
    expect(session.progressTitles.size).toBe(0);
  });

  it("tracks slow server preparation before a session exists", async () => {
    const controller = manager.createController(
      session.adapter,
      require("path").resolve("activity-project"),
    );
    let finish;
    spyOn(controller, "prepareStartupSnapshot").and.returnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const pending = controller.prepareStartup(1, 2);
    advanceClock(400);
    expect(signal.entries()[0].title).toBe("Test Server: Preparing server");
    const args = controller.prepareStartupSnapshot.calls.mostRecent().args;
    expect(args.slice(0, 2)).toEqual([1, 2]);
    expect(args[2].aborted).toBe(false);
    expect(typeof args[2].throwIfAborted).toBe("function");
    const prepared = { stale: true };
    finish(prepared);
    expect(await pending).toBe(prepared);
    expect(signal.providers.size).toBe(0);
    expect(manager.activity.operations.size).toBe(0);
  });

  it("clears failed preparation and replays it when the service arrives late", async () => {
    const controller = manager.createController(
      session.adapter,
      require("path").resolve("activity-project"),
    );
    const error = new Error("Resolver failed");
    let fail;
    manager.setBusySignal(null);
    spyOn(controller, "prepareStartupSnapshot").and.returnValue(
      new Promise((_resolve, reject) => (fail = reject)),
    );
    const pending = controller.prepareStartup(1, 2);
    advanceClock(400);
    manager.setBusySignal(signal);
    expect(signal.entries()[0].title).toBe("Test Server: Preparing server");
    fail(error);
    await expectAsync(pending).toBeRejectedWith(error);
    expect(signal.providers.size).toBe(0);
    expect(manager.activity.operations.size).toBe(0);
  });
});
