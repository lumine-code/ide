const assert = require("node:assert/strict");
const { setTimeout: sleep } = require("node:timers/promises");
const request = require("../lib/fetch-retry");
const reply = (status = 200) => ({ status, ok: status === 200 });
(async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    let calls = 0;
    const delays = [];
    const result = await request(
      async () => reply(++calls === 3 ? 200 : status),
      "https://fixture",
      {},
      async () => "body",
      { delay: async (ms) => delays.push(ms) },
    );
    assert.equal(calls, 3);
    assert.deepEqual(delays, [250, 500]);
    assert.equal(result.value, "body");
  }
  for (const status of [400, 401, 403, 404, 410]) {
    let calls = 0;
    const result = await request(async () => {
      calls++;
      return reply(status);
    }, "https://fixture");
    assert.equal(result.response.status, status);
    assert.equal(calls, 1);
  }
  for (const body of [false, true]) {
    let calls = 0;
    const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    await assert.rejects(
      request(
        async () => {
          calls++;
          if (!body) throw error;
          return reply();
        },
        "https://fixture",
        {},
        () => {
          throw error;
        },
        { delay: async () => {} },
      ),
      /reset/,
    );
    assert.equal(calls, 3);
  }
  let calls = 0;
  await assert.rejects(
    request(
      () => {
        calls++;
        return new Promise(() => {});
      },
      "https://fixture",
      {},
      undefined,
      { headerTimeoutMs: 5, delay: async () => {} },
    ),
    /response headers/,
  );
  assert.equal(calls, 3);
  let signal;
  const result = await request(
    async (_url, init) => {
      signal = init.signal;
      return reply();
    },
    "https://fixture",
    {},
    async () => {
      await sleep(25);
      return "active SDK body";
    },
    { headerTimeoutMs: 5 },
  );
  assert.equal(result.value, "active SDK body");
  assert.equal(signal.aborted, false);
  calls = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        return reply();
      },
      "https://fixture",
      {},
      () => {
        throw new SyntaxError("malformed JSON");
      },
    ),
    SyntaxError,
  );
  assert.equal(calls, 1);
  const backoffAbort = new AbortController();
  calls = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        return reply(503);
      },
      "https://fixture",
      { signal: backoffAbort.signal },
      undefined,
      {
        delay: () => {
          backoffAbort.abort();
          return new Promise(() => {});
        },
      },
    ),
  );
  assert.equal(calls, 1);
  const realmError = require("node:vm").runInNewContext("new TypeError('fetch failed')");
  calls = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        throw realmError;
      },
      "https://fixture",
      {},
      undefined,
      { delay: async () => {} },
    ),
  );
  assert.equal(calls, 3);
  const abort = new AbortController();
  calls = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        abort.abort();
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
      "https://fixture",
      { signal: abort.signal },
      undefined,
      { delay: async () => {} },
    ),
  );
  assert.equal(calls, 1);
  console.log(
    "Bounded cross-realm HTTP/transport retries, header deadlines, active SDK bodies and cancelled backoff passed.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
