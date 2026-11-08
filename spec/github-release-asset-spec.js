const http = require("node:http");
const crypto = require("node:crypto");
const download = require("../lib/github-release-asset");
const ServerReleaseSources = require("../lib/server-release-sources");

describe("Exact GitHub release asset transfer", () => {
  const bytes = Buffer.from("full official archive fixture");
  const asset = {
    apiUrl: "https://api.github.com/repos/example/server/releases/assets/123",
    size: bytes.length,
    digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
  };
  const token = "fixture-token-not-a-credential";
  const controlledTiming = () => {
    let now = 0;
    let nextTimer = 0;
    const pending = new Map();
    const delays = [];
    return {
      delays,
      now: () => now,
      setTimeout(callback, delay) {
        const id = ++nextTimer;
        delays.push(delay);
        pending.set(id, { callback, deadline: now + delay });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
      advance(elapsed) {
        now += elapsed;
        for (const [id, timer] of pending) {
          if (timer.deadline <= now) {
            pending.delete(id);
            timer.callback();
          }
        }
      },
      pendingTimers: () => pending.size,
    };
  };
  let server;
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });
  const fixture = async (handler) => {
    const calls = [];
    server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      calls,
      request(url, options, callback) {
        calls.push({ url, headers: options.headers });
        return http.get(
          {
            hostname: "127.0.0.1",
            port: server.address().port,
            path: new URL(url).hostname === "api.github.com" ? "/api" : "/storage",
            ...options,
          },
          callback,
        );
      },
    };
  };
  for (const host of ["release-assets.githubusercontent.com", "objects.githubusercontent.com"])
    it(`strips the API credential before real HTTP transfer from ${host}`, async () => {
      const incoming = [];
      const { request, calls } = await fixture((req, res) => {
        incoming.push({ path: req.url, authorization: req.headers.authorization });
        if (req.url === "/api") {
          res.writeHead(302, { Location: `https://${host}/archive` });
          res.end();
        } else res.end(bytes);
      });
      expect(await download(asset, { request, token })).toEqual(bytes);
      expect(calls.length).toBe(2);
      expect(calls[0].headers.Authorization).toBe(`Bearer ${token}`);
      expect(calls[1].headers).toEqual({});
      expect(incoming).toEqual([
        { path: "/api", authorization: `Bearer ${token}` },
        { path: "/storage", authorization: undefined },
      ]);
    });
  it("keeps anonymous runtime requests anonymous", async () => {
    const { request, calls } = await fixture((_req, res) => res.end(bytes));
    expect(await download(asset, { request })).toEqual(bytes);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });
  for (const location of [
    "http://release-assets.githubusercontent.com/archive",
    "https://untrusted.example/archive",
    "https://api.github.com/other",
    "https://user@release-assets.githubusercontent.com/archive",
    "https://release-assets.githubusercontent.com:8443/archive",
  ])
    it(`refuses a redirect outside the exact HTTPS storage boundary: ${location}`, async () => {
      const { request, calls } = await fixture((_req, res) => {
        res.writeHead(302, { Location: location });
        res.end();
      });
      await expectAsync(download(asset, { request, token })).toBeRejectedWithError(/outside/);
      expect(calls.length).toBe(1);
    });
  for (const change of [
    { digest: `sha256:${"0".repeat(64)}` },
    { size: bytes.length - 1 },
    { size: bytes.length + 1 },
  ])
    it(`rejects real streamed bytes with incorrect published identity: ${JSON.stringify(change)}`, async () => {
      const { request } = await fixture((_req, res) => res.end(bytes));
      await expectAsync(download({ ...asset, ...change }, { request })).toBeRejectedWithError(
        /published/,
      );
    });
  it("bounds redirects and sends credentials only on the first exact API request", async () => {
    const { request, calls } = await fixture((_req, res) => {
      res.writeHead(302, { Location: "https://release-assets.githubusercontent.com/again" });
      res.end();
    });
    await expectAsync(download(asset, { request, token })).toBeRejectedWithError(/too many/);
    expect(calls.length).toBe(4);
    expect(calls.slice(1).every((call) => Object.keys(call.headers).length === 0)).toBe(true);
  });
  for (const status of [403, 404, 504])
    it(`propagates API HTTP ${status} without retries`, async () => {
      const { request, calls } = await fixture((_req, res) => {
        res.writeHead(status);
        res.end();
      });
      await expectAsync(download(asset, { request })).toBeRejectedWithError(
        `The GitHub release asset answered HTTP ${status}.`,
      );
      expect(calls.length).toBe(1);
    });
  it("limits response headers while permitting an active body past that deadline", async () => {
    const timing = controlledTiming();
    let releaseBody;
    const transport = await fixture((_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      releaseBody = () => res.end(bytes);
    });
    const request = (url, options, callback) =>
      transport.request(url, options, (reply) => {
        callback(reply);
        expect(timing.pendingTimers()).toBe(0);
        timing.advance(75);
        releaseBody();
      });
    expect(await download(asset, { request, headerTimeoutMs: 50, timing })).toEqual(bytes);
    expect(timing.now()).toBe(75);
  });
  it("closes an unanswered request at the header deadline", async () => {
    const { request, calls } = await fixture(() => {});
    await expectAsync(download(asset, { request, headerTimeoutMs: 10 })).toBeRejectedWithError(
      /release asset headers/,
    );
    expect(calls.length).toBe(1);
  });
  it("shares one header budget across the API and storage redirect", async () => {
    const timing = controlledTiming();
    const transport = await fixture((req, res) => {
      if (req.url === "/api") {
        res.writeHead(302, { Location: "https://release-assets.githubusercontent.com/archive" });
        res.end();
      } else {
        timing.advance(70);
        res.end(bytes);
      }
    });
    const request = (url, options, callback) =>
      transport.request(url, options, (reply) => {
        if (new URL(url).hostname === "api.github.com") timing.advance(70);
        callback(reply);
      });
    await expectAsync(
      download(asset, { request, headerTimeoutMs: 100, timing }),
    ).toBeRejectedWithError(/release asset headers/);
    expect(transport.calls.length).toBe(2);
    expect(timing.delays).toEqual([100, 30]);
    expect(timing.now()).toBe(140);
  });
  it("honors caller cancellation both before requests and during a live body", async () => {
    const controller = new AbortController();
    const { request, calls } = await fixture((_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      controller.abort(new DOMException("Caller cancelled", "AbortError"));
    });
    await expectAsync(download(asset, { request, signal: controller.signal })).toBeRejected();
    expect(calls.length).toBe(1);
    await expectAsync(download(asset, { request, signal: controller.signal })).toBeRejected();
    expect(calls.length).toBe(1);
  });
  it("propagates a real interrupted stream without accepting its partial bytes", async () => {
    const { request } = await fixture((_req, res) => {
      res.writeHead(200);
      res.write(bytes.subarray(0, 1));
      res.destroy();
    });
    await expectAsync(download(asset, { request })).toBeRejected();
  });
});

describe("Managed release fallback qualification", () => {
  const repository = "example/server";
  const url = "https://github.com/example/server/releases/download/1.2.3/server.zip";
  const release = {
    tag_name: "1.2.3",
    assets: [
      {
        id: 123,
        name: "server.zip",
        browser_download_url: url,
        url: "https://api.github.com/repos/example/server/releases/assets/123",
        size: 8,
        digest: `sha256:${"a".repeat(64)}`,
      },
    ],
  };
  const response = (value) => ({ status: 200, ok: true, json: async () => value });
  beforeEach(() => jasmine.useRealClock());
  it("remembers only exact official digest-bearing metadata, including release lists", async () => {
    const sources = new ServerReleaseSources({ fetchUrl: async () => response(release) });
    await sources.githubRelease(repository, "tags/1.2.3");
    expect(sources.githubAssets.get(url)).toEqual({
      apiUrl: release.assets[0].url,
      size: 8,
      digest: release.assets[0].digest,
    });
    sources.fetchUrl = async () => response([release]);
    expect((await sources.githubReleases(repository)).length).toBe(1);
    for (const change of [
      { url: "https://untrusted.example/123" },
      { browser_download_url: url + "?different" },
      { digest: "" },
      { id: 0 },
      { size: 2 ** 31 },
    ]) {
      const other = new ServerReleaseSources();
      other.rememberGithubAssets(repository, {
        ...release,
        assets: [{ ...release.assets[0], ...change }],
      });
      expect(other.githubAssets.size).toBe(0);
    }
  });
  it("discards stale fallback eligibility when refreshed metadata is invalid or ambiguous", () => {
    for (const assets of [
      [],
      [{ ...release.assets[0], digest: "" }],
      [release.assets[0], { ...release.assets[0], id: 456 }],
      [
        release.assets[0],
        {
          ...release.assets[0],
          name: "other.zip",
          browser_download_url: url.replace("server.zip", "other.zip"),
        },
      ],
    ]) {
      const sources = new ServerReleaseSources();
      sources.rememberGithubAssets(repository, release);
      expect(sources.githubAssets.size).toBe(1);
      sources.rememberGithubAssets(repository, { ...release, assets });
      expect(sources.githubAssets.size).toBe(0);
    }
  });
  it("retains unrelated releases and an already captured in-flight descriptor", () => {
    const sources = new ServerReleaseSources();
    const older = {
      tag_name: "1.0.0",
      assets: [
        {
          ...release.assets[0],
          id: 789,
          url: release.assets[0].url.replace("123", "789"),
          browser_download_url: url.replace("1.2.3", "1.0.0"),
        },
      ],
    };
    sources.rememberGithubAssets(repository, release);
    const captured = sources.githubAssets.get(url);
    sources.rememberGithubAssets(repository, older);
    sources.rememberGithubAssets(repository, { ...release, assets: [] });
    expect(sources.githubAssets.size).toBe(1);
    expect(sources.githubAssets.has(older.assets[0].browser_download_url)).toBe(true);
    expect(captured).toEqual({
      apiUrl: release.assets[0].url,
      size: 8,
      digest: release.assets[0].digest,
    });
  });
  it("does not fall back for unmatched URLs, permanent responses, arbitrary errors or caller abort", async () => {
    const sources = new ServerReleaseSources({ fetchPolicy: { delay: async () => {} } });
    expect(sources.githubAssetFallback(url)).toBeNull();
    const fallback = spyOn(sources, "githubAssetFallback").and.callThrough();
    for (const status of [403, 404]) {
      sources.fetchUrl = async () => ({ status, ok: false });
      await expectAsync(sources.download(url, "fixture")).toBeRejectedWithError(/server answered/);
    }
    sources.fetchUrl = async () => {
      throw new TypeError("arbitrary programming error");
    };
    await expectAsync(sources.download(url, "fixture")).toBeRejectedWithError(/programming/);
    const controller = new AbortController();
    controller.abort();
    await expectAsync(
      sources.download(url, "fixture", { signal: controller.signal }),
    ).toBeRejected();
    expect(fallback).not.toHaveBeenCalled();
  });
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ])
    it(`delegates explicitly configured ${key} without native proxy bypass`, () => {
      const sources = new ServerReleaseSources();
      sources.rememberGithubAssets(repository, release);
      const old = process.env[key];
      try {
        process.env[key] = "http://proxy.example";
        expect(sources.githubAssetFallback(url)).toBeNull();
      } finally {
        if (old === undefined) delete process.env[key];
        else process.env[key] = old;
      }
    });
  it("preserves the primary retry budget and uses fallback only after a classified failure", async () => {
    for (const failure of ["transport", "status"]) {
      let calls = 0;
      const sources = new ServerReleaseSources({
        fetchPolicy: { delay: async () => {} },
        fetchUrl: async () => {
          calls++;
          if (failure === "transport") throw new TypeError("Failed to fetch");
          return { status: 504, ok: false };
        },
      });
      sources.rememberGithubAssets(repository, release);
      const fallback = spyOn(sources, "githubAssetFallback").and.resolveTo(Buffer.from("fallback"));
      expect(await sources.download(url, "fixture")).toEqual(Buffer.from("fallback"));
      expect(calls).toBe(3);
      expect(fallback).toHaveBeenCalledTimes(1);
    }
  });
});
