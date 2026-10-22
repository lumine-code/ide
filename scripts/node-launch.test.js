"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createServerResolver, validateServerLaunch } = require("../lib/server-resolver");

const entry = path.resolve("server with spaces.cjs");
const preload = Object.freeze(["--require", path.resolve("compatibility with spaces.cjs")]);
const fileSystem = {
  constants: fs.constants,
  promises: {
    stat: async () => ({ isFile: () => true }),
    access: async () => {},
  },
};
const resolver = (nodeExecArguments = () => preload) =>
  createServerResolver({ fileSystem, nodeExecArguments });

for (const transport of ["stdio", "socket"]) {
  test(`${transport} places runtime arguments before the script without changing script arguments`, async () => {
    const args = ["--require", "script-owned-value", "argument with spaces"];
    const original = [...args];
    const launch = await resolver().nodeEntry(entry, args, {
      transport,
      ...(transport === "socket" && { port: 7321 }),
    });
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [...preload, entry, ...original]);
    assert.deepEqual(args, original);
    assert.deepEqual(launch.env, { ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(launch.execArgv, undefined);
    launch.args[0] = "caller-only";
    assert.equal(preload[0], "--require");
    assert.deepEqual((await resolver().nodeEntry(entry, original)).args, [
      ...preload,
      entry,
      ...original,
    ]);
  });
}

test("IPC keeps script arguments separate and copies protected and caller runtime arrays", async () => {
  const args = ["--stdio", "value with spaces"];
  const extra = ["--no-warnings"];
  const launch = await resolver().nodeEntry(entry, args, { transport: "ipc", execArgv: extra });
  assert.equal(launch.command, entry);
  assert.deepEqual(launch.args, args);
  assert.notEqual(launch.args, args);
  assert.deepEqual(launch.execArgv, [...preload, ...extra]);
  assert.deepEqual(extra, ["--no-warnings"]);
  launch.execArgv.push("caller-only");
  assert.deepEqual(extra, ["--no-warnings"]);
});

test("standalone provider leaves Node launches unchanged without setting NODE_OPTIONS", async () => {
  const before = process.env.NODE_OPTIONS;
  const api = resolver(() => []);
  const stdio = await api.nodeEntry(entry, ["script-argument"]);
  assert.deepEqual(stdio.args, [entry, "script-argument"]);
  const ipc = await api.nodeEntry(entry, ["script-argument"], { transport: "ipc" });
  assert.deepEqual(ipc.args, ["script-argument"]);
  assert.equal(ipc.execArgv, undefined);
  assert.equal(stdio.env.NODE_OPTIONS, undefined);
  assert.equal(process.env.NODE_OPTIONS, before);
});

test("native executable launches do not request or inherit Node preloads", async () => {
  const api = resolver(() => assert.fail("Native executables need no Node arguments"));
  const launch = await api.launch({ path: entry, kind: "executable" }, { args: ["native-arg"] });
  assert.deepEqual(launch.args, ["native-arg"]);
  assert.equal(launch.env, undefined);
  assert.equal(launch.execArgv, undefined);
});

test("runtime providers and execArgv reject malformed values", async () => {
  assert.throws(() => resolver([]), /provider/);
  for (const value of [null, "--require", [1], ["bad\0argument"]])
    await assert.rejects(resolver(() => value).nodeEntry(entry), TypeError);
  for (const value of [null, "--require", [1], ["bad\0argument"]])
    assert.throws(() => validateServerLaunch({ command: entry, execArgv: value }), TypeError);
});

test("execArgv is an IPC-only fork option and cannot be silently ignored", async () => {
  const extra = ["--no-warnings"];
  for (const transport of [undefined, "stdio", "socket"]) {
    const options = { execArgv: extra, transport, ...(transport === "socket" && { port: 7321 }) };
    assert.throws(
      () => validateServerLaunch({ command: entry, ...options }),
      /only supported for IPC/,
    );
    await assert.rejects(resolver().nodeEntry(entry, [], options), /only supported for IPC/);
  }
  assert.deepEqual(extra, ["--no-warnings"]);
});

test("one runtime provider delegates to the public core API on each call", () => {
  const filename = require.resolve("../lib/node-process-arguments");
  let calls = 0;
  const module = { exports: {} };
  new vm.Script(fs.readFileSync(filename, "utf8"), { filename }).runInNewContext({
    module,
    require(name) {
      assert.equal(name, "lumine");
      return {
        BufferedNodeProcess: {
          getNodeExecArguments() {
            calls++;
            return [...preload];
          },
        },
      };
    },
  });
  const first = module.exports();
  const second = module.exports();
  assert.deepEqual(first, preload);
  assert.notEqual(first, second);
  assert.equal(calls, 2);
});

test("ServerSession forwards IPC runtime arguments through fork options, never script args", async () => {
  const launch = await resolver().nodeEntry(entry, ["script-argument"], { transport: "ipc" });
  const filename = require.resolve("../lib/server-session");
  const module = { exports: {} };
  let captured;
  const requireModule = (name) => {
    if (name === "lumine") return {};
    if (name === "crypto") return require("node:crypto");
    if (name === "./server-resolver") return require("../lib/server-resolver");
    if (name === "./rpc-connection") return { ipc: () => ({}) };
    if (name === "child_process")
      return {
        fork(command, args, options) {
          captured = { command, args, options };
          return {};
        },
      };
    throw new Error(`Unexpected dependency ${name}`);
  };
  new vm.Script(fs.readFileSync(filename, "utf8"), { filename }).runInNewContext({
    module,
    require: requireModule,
    process,
    setTimeout,
    clearTimeout,
  });
  let continuing = true;
  const session = Object.assign(Object.create(module.exports.prototype), {
    launch,
    rootPath: path.dirname(entry),
    adapter: { id: "synthetic" },
    clientProgressTokens: new Map(),
    manager: { beginActivity() {}, prepareSessionServices() {} },
    continueStart: () => continuing,
    awaitDuringStart: (operation) => Promise.resolve().then(operation),
    logger: () => ({}),
    watchProcess: () => {
      continuing = false;
    },
    retireProgressToken() {},
  });
  await session.start();
  assert.equal(captured.command, entry);
  assert.deepEqual(Array.from(captured.args), ["script-argument"]);
  assert.deepEqual(Array.from(captured.options.execArgv), preload);
  assert.notEqual(captured.options.execArgv, launch.execArgv);
  assert.deepEqual(Array.from(captured.options.stdio), ["ignore", "pipe", "pipe", "ipc"]);
  assert.equal(captured.options.env.ELECTRON_RUN_AS_NODE, "1");
});
