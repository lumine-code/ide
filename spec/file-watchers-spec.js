const path = require("node:path"),
  { pathToFileURL } = require("node:url");
const Manager = require("../lib/language-server-manager");
const { publishSession } = require("./helpers/session-fixtures");
describe("adapter-owned standard file watchers", () => {
  let manager, root, other, session, notifications;
  const adapter = {
    id: "watch-test",
    displayName: "Watch Test",
    grammarScopes: ["source.test"],
    resolveServer: async () => null,
  };
  beforeEach(() => {
    manager = new Manager();
    root = path.resolve("static-watch-root");
    other = path.resolve("other-watch-root");
    notifications = [];
    session = {
      adapter: { ...adapter, fileWatchers: [{ globPattern: "**/*.tf" }] },
      rootPath: root,
      folders: new Set([root]),
      state: "running",
      notify: (method, params) => notifications.push({ method, params }),
      stop: async () => {
        session.state = "stopped";
      },
    };
    publishSession(manager, session);
  });
  afterEach(async () => manager.deactivate());
  it("routes static-only create, change and delete events within project folders and validates descriptors", () => {
    for (const invalid of [
      true,
      [{ globPattern: "" }],
      [{ globPattern: { baseUri: "https://invalid.example/", pattern: "*.tf" } }],
      [{ globPattern: "*.tf", kind: 8 }],
    ])
      expect(() => manager.registerAdapter({ ...adapter, fileWatchers: invalid })).toThrowError(
        /fileWatchers/,
      );
    const file = path.join(root, "main.tf");
    manager.fileOperations.routeEvents([
      { action: "created", path: file },
      { action: "updated", path: file },
      { action: "deleted", path: file },
      { action: "created", path: path.join(root, "readme.txt") },
      { action: "created", path: path.join(other, "main.tf") },
    ]);
    expect(notifications).toEqual([
      {
        method: "workspace/didChangeWatchedFiles",
        params: {
          changes: [
            { uri: pathToFileURL(file).href, type: 1 },
            { uri: pathToFileURL(file).href, type: 2 },
            { uri: pathToFileURL(file).href, type: 3 },
          ],
        },
      },
    ]);
  });
  it("delivers relative watchers for legal child names beginning with two dots", () => {
    const child = path.join(root, "..config", "main.tf");
    session.adapter.fileWatchers = [
      { globPattern: { baseUri: pathToFileURL(root).href, pattern: "**/*.tf" } },
    ];
    manager.fileOperations.routeEvents([
      { action: "updated", path: child },
      { action: "updated", path: path.join(root, "..", "outside.tf") },
      { action: "updated", path: path.join(other, "main.tf") },
    ]);
    expect(notifications).toEqual([
      {
        method: "workspace/didChangeWatchedFiles",
        params: { changes: [{ uri: pathToFileURL(child).href, type: 2 }] },
      },
    ]);
  });
  it("merges relative static and dynamic watchers without duplicates, preserves event order and retires them with the adapter", async () => {
    const file = path.join(root, "main.tf"),
      outside = path.join(other, "external.tf");
    session.adapter.fileWatchers = [
      { globPattern: { baseUri: pathToFileURL(root).href, pattern: "*.tf" }, kind: 5 },
    ];
    manager.registerAdapter(session.adapter);
    manager.registerCapabilities(session, [
      {
        id: "dynamic",
        method: "workspace/didChangeWatchedFiles",
        registerOptions: { watchers: [{ globPattern: "**/*.tf", kind: 3 }] },
      },
    ]);
    manager.fileOperations.routeEvents([
      { action: "created", path: file },
      { action: "created", path: file },
      { action: "updated", path: file },
      { action: "deleted", path: file },
      { action: "created", path: file },
      { action: "updated", path: outside },
    ]);
    expect(notifications[0].params.changes.map((value) => value.type)).toEqual([1, 2, 3, 1, 2]);
    expect(notifications[0].params.changes.at(-1).uri).toBe(pathToFileURL(outside).href); // Dynamic watchers retain their declared scope.
    manager.unregisterCapabilities(session, [{ id: "dynamic" }]);
    manager.fileOperations.routeEvents([{ action: "updated", path: file }]);
    expect(notifications.length).toBe(1);
    await manager.unregisterAdapter(session.adapter);
    manager.fileOperations.routeEvents([{ action: "created", path: file }]);
    expect(notifications.length).toBe(1);
  });
});
