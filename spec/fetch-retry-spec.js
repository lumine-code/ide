const fetchWithRetry = require("../lib/fetch-retry");
const { setTimeout: sleep } = require("node:timers/promises");

describe("Managed server bounded GET retries", () => {
  beforeEach(() => {
    jasmine.useRealClock();
  });
  const reply = (status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => Buffer.from("payload"),
  });
  it("retries transient HTTP responses with bounded backoff and consumes only success", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      let calls = 0;
      const delays = [];
      const result = await fetchWithRetry(
        async () => reply(++calls === 3 ? 200 : status),
        "https://server",
        {},
        (response) => response.arrayBuffer(),
        { delay: async (ms) => delays.push(ms) },
      );
      expect(calls).toBe(3);
      expect(delays).toEqual([250, 500]);
      expect(Buffer.from(result.value).toString()).toBe("payload");
    }
  });
  it("does not retry permanent HTTP errors or malformed metadata", async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      let calls = 0;
      const result = await fetchWithRetry(async () => {
        calls++;
        return reply(status);
      }, "https://server");
      expect(result.response.status).toBe(status);
      expect(calls).toBe(1);
    }
    let calls = 0;
    await expectAsync(
      fetchWithRetry(
        async () => {
          calls++;
          return reply();
        },
        "https://server",
        {},
        () => {
          throw new SyntaxError("Malformed JSON");
        },
      ),
    ).toBeRejectedWithError(SyntaxError);
    expect(calls).toBe(1);
  });
  it("retries connection resets in headers and body but stops after three attempts", async () => {
    for (const body of [false, true]) {
      let calls = 0;
      const reset = Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
      await expectAsync(
        fetchWithRetry(
          async () => {
            calls++;
            if (!body) throw reset;
            return reply();
          },
          "https://server",
          {},
          () => {
            throw reset;
          },
          { delay: async () => {} },
        ),
      ).toBeRejectedWithError(/reset/);
      expect(calls).toBe(3);
    }
  });
  it("times out unanswered headers while allowing an active body to outlast that deadline", async () => {
    let calls = 0;
    await expectAsync(
      fetchWithRetry(
        () => {
          calls++;
          return new Promise(() => {});
        },
        "https://server",
        {},
        undefined,
        { headerTimeoutMs: 5, delay: async () => {} },
      ),
    ).toBeRejectedWithError(/response headers/);
    expect(calls).toBe(3);
    let signal;
    const result = await fetchWithRetry(
      async (_url, init) => {
        signal = init.signal;
        return reply();
      },
      "https://server",
      {},
      async () => {
        await sleep(25);
        return "large SDK";
      },
      { headerTimeoutMs: 5 },
    );
    expect(result.value).toBe("large SDK");
    expect(signal.aborted).toBe(false);
  });
  it("preserves caller cancellation without retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expectAsync(
      fetchWithRetry(
        async () => {
          calls++;
          controller.abort();
          throw Object.assign(new Error("reset after cancellation"), { code: "ECONNRESET" });
        },
        "https://server",
        { signal: controller.signal },
        undefined,
        { delay: async () => {} },
      ),
    ).toBeRejected();
    expect(calls).toBe(1);
  });
  it("recognizes transport errors from another package realm", async () => {
    const error = require("node:vm").runInNewContext("new TypeError('fetch failed')");
    let calls = 0;
    await expectAsync(
      fetchWithRetry(
        async () => {
          calls++;
          throw error;
        },
        "https://server",
        {},
        undefined,
        { delay: async () => {} },
      ),
    ).toBeRejected();
    expect(calls).toBe(3);
  });
  it("cancels retry backoff and never starts another request", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expectAsync(
      fetchWithRetry(
        async () => {
          calls++;
          return reply(503);
        },
        "https://server",
        { signal: controller.signal },
        undefined,
        {
          delay: () => {
            controller.abort();
            return new Promise(() => {});
          },
        },
      ),
    ).toBeRejected();
    expect(calls).toBe(1);
    await expectAsync(
      fetchWithRetry(
        async () => {
          calls++;
          return reply();
        },
        "https://server",
        { signal: controller.signal },
      ),
    ).toBeRejected();
    expect(calls).toBe(1);
  });
});
