const https = require("node:https");
const crypto = require("node:crypto");
const { setTimeout, clearTimeout } = require("node:timers");
const { performance } = require("node:perf_hooks");

// This is only a transfer for an exact, digest-bearing release asset already
// identified by successful GitHub metadata. Ordinary URLs keep their transport.
module.exports = async (
  asset,
  {
    signal,
    token = "",
    headerTimeoutMs = 10000,
    request = https.get,
    timing = { now: () => performance.now(), setTimeout, clearTimeout },
  } = {},
) => {
  const api = new URL(asset.apiUrl);
  if (
    api.origin !== "https://api.github.com" ||
    api.username ||
    api.password ||
    api.hash ||
    !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/assets\/[1-9][0-9]*$/.test(
      api.pathname,
    ) ||
    api.search ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 1024 * 1024 * 1024 ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
  ) {
    throw new Error("The GitHub release asset has no valid exact API identity, size and SHA-256.");
  }
  const headerDeadline = timing.now() + headerTimeoutMs;
  const timeoutError = () =>
    Object.assign(new Error("Timed out waiting for GitHub release asset headers."), {
      name: "TimeoutError",
    });
  let url = api.href;
  for (let redirects = 0; ; redirects++) {
    signal?.throwIfAborted();
    const remainingHeadersMs = headerDeadline - timing.now();
    if (remainingHeadersMs <= 0) throw timeoutError();
    const headers =
      redirects === 0
        ? {
            Accept: "application/octet-stream",
            "User-Agent": "Lumine.ide",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          }
        : {};
    const response = await new Promise((resolve, reject) => {
      let timer;
      const operation = request(url, { headers, signal }, (reply) => {
        timing.clearTimeout(timer);
        resolve(reply);
      });
      operation.once("error", (error) => {
        timing.clearTimeout(timer);
        reject(error);
      });
      timer = timing.setTimeout(() => {
        operation.destroy(timeoutError());
      }, remainingHeadersMs);
    });
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (redirects >= 3) throw new Error("The GitHub release asset redirected too many times.");
        const target = new URL(response.headers.location, url);
        if (
          target.protocol !== "https:" ||
          target.port ||
          target.username ||
          target.password ||
          target.hash ||
          !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
            target.hostname,
          )
        ) {
          throw new Error(
            "The GitHub release asset redirected outside its official HTTPS storage.",
          );
        }
        url = target.href;
        continue;
      }
      if (response.statusCode !== 200)
        throw new Error(`The GitHub release asset answered HTTP ${response.statusCode}.`);
      const chunks = [];
      const hash = crypto.createHash("sha256");
      let size = 0;
      for await (const chunk of response) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > asset.size)
          throw new Error("The GitHub release asset exceeds its published size.");
        hash.update(chunk);
        chunks.push(chunk);
      }
      signal?.throwIfAborted();
      if (size !== asset.size || `sha256:${hash.digest("hex")}` !== asset.digest) {
        throw new Error("The GitHub release asset does not match its published size and SHA-256.");
      }
      return Buffer.concat(chunks, size);
    } finally {
      response.destroy();
    }
  }
};
