const path = require("node:path");
const crypto = require("node:crypto");
const fetchWithRetry = require("./fetch-retry");
const { abortable } = require("./installation-io");

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Lumine.ide-client",
};

function parseSidecar(text) {
  const match = String(text || "").match(/\b([0-9a-f]{64})\b/i);
  return match ? match[1].toLowerCase() : null;
}

// Source protocols and payload verification have no knowledge of installations,
// staging directories, sessions or swaps. Their caller owns the operation.
module.exports = class ServerReleaseSources {
  constructor({ fetchUrl, fetchPolicy = {} } = {}) {
    this.fetchUrl = fetchUrl || ((url, init) => fetch(url, { redirect: "follow", ...init }));
    this.fetchPolicy = fetchPolicy;
  }

  async request(url, init, consume, signal) {
    signal?.throwIfAborted();
    const result = await abortable(
      fetchWithRetry(
        (requestUrl, options) => abortable(this.fetchUrl(requestUrl, options), options.signal),
        url,
        { ...init, signal },
        (response) => {
          signal?.throwIfAborted();
          return abortable(consume(response), signal);
        },
        this.fetchPolicy,
      ),
      signal,
    );
    signal?.throwIfAborted();
    return result;
  }

  async githubRelease(repository, ref, { signal } = {}) {
    const { response, value } = await this.request(
      `https://api.github.com/repos/${repository}/releases/${ref}`,
      { headers: GITHUB_HEADERS },
      (reply) => reply.json(),
      signal,
    );
    if (!response.ok)
      throw new Error(`GitHub answered ${response.status} for ${repository} releases/${ref}.`);
    return value;
  }

  async githubReleases(repository, { signal } = {}) {
    const { response, value } = await this.request(
      `https://api.github.com/repos/${repository}/releases`,
      { headers: GITHUB_HEADERS },
      (reply) => reply.json(),
      signal,
    );
    if (!response.ok)
      throw new Error(`GitHub answered ${response.status} for ${repository} releases.`);
    return Array.isArray(value) ? value : [];
  }

  toRelease(release, repository) {
    if (!release?.tag_name) throw new Error(`No release found for ${repository}.`);
    return {
      version: String(release.tag_name).replace(/^v/, ""),
      tag: release.tag_name,
      assets: (release.assets || []).map((asset) => ({
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
        ...(asset.digest ? { digest: asset.digest } : {}),
      })),
    };
  }

  async npmMetadata(name, version, { signal } = {}) {
    const { response, value } = await this.request(
      `https://registry.npmjs.org/${name}/${encodeURIComponent(version)}`,
      {},
      (reply) => reply.json(),
      signal,
    );
    if (!response.ok)
      throw new Error(`The npm registry answered ${response.status} for ${name}@${version}.`);
    return value;
  }

  async download(url, label, { signal } = {}) {
    let result;
    try {
      result = await this.request(url, {}, (reply) => reply.arrayBuffer(), signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Could not download ${label}: ${error.message}`, { cause: error });
    }
    if (!result.response.ok)
      throw new Error(
        `Could not download ${label}: the server answered ${result.response.status}.`,
      );
    return Buffer.from(result.value);
  }

  async verify(payload, url, checksum, { signal } = {}) {
    signal?.throwIfAborted();
    if (checksum === "none") return;
    if (checksum !== "sha256-sidecar") throw new Error(`Unknown checksum policy '${checksum}'.`);
    const { response, value } = await this.request(
      `${url}.sha256`,
      {},
      (reply) => reply.text(),
      signal,
    );
    if (!response.ok)
      throw new Error(`Could not download the checksum: the server answered ${response.status}.`);
    const expected = parseSidecar(value);
    if (!expected) throw new Error("The published checksum could not be read.");
    const actual = crypto.createHash("sha256").update(payload).digest("hex");
    if (actual !== expected)
      throw new Error(
        `The download does not match its published checksum and was discarded.\nexpected ${expected}\nreceived ${actual}`,
      );
  }

  verifyIntegrity(payload, integrity, name, { signal } = {}) {
    signal?.throwIfAborted();
    if (!integrity) throw new Error(`npm published no integrity hash for ${name}.`);
    const [algorithm, expected] = String(integrity).split("-");
    if (!algorithm || !expected) throw new Error(`Unreadable integrity hash for ${name}.`);
    const actual = crypto.createHash(algorithm).update(payload).digest("base64");
    if (actual !== expected)
      throw new Error(`${name} does not match its published integrity hash and was discarded.`);
  }

  verifyDigest(payload, digest, name, { signal } = {}) {
    signal?.throwIfAborted();
    const match = /^([a-z0-9-]+):([0-9a-f]+)$/i.exec(String(digest || ""));
    if (!match) throw new Error(`Unreadable checksum for ${name}.`);
    const [, algorithm, expected] = match;
    let actual;
    try {
      actual = crypto.createHash(algorithm).update(payload).digest("hex");
    } catch (error) {
      throw new Error(`Unsupported checksum algorithm '${algorithm}' for ${name}.`, {
        cause: error,
      });
    }
    if (actual.toLowerCase() !== expected.toLowerCase())
      throw new Error(`${name} does not match its published checksum and was discarded.`);
  }

  async extract(archivePath, destination, archiveName, strip = 0, { signal } = {}) {
    signal?.throwIfAborted();
    if (!Number.isInteger(strip) || strip < 0)
      throw new Error("Archive strip must be a non-negative integer.");
    try {
      if (/\.(tar\.gz|tgz)$/i.test(archiveName)) {
        // tar has no AbortSignal support. Stop accepting entries on abort and
        // wait for outstanding filesystem jobs before the owner cleans staging.
        await require("tar").x({
          file: archivePath,
          cwd: destination,
          strip,
          filter: () => !signal?.aborted,
          onwarn: () => {},
        });
      } else if (/\.(tar\.xz|txz)$/i.test(archiveName)) {
        await require("./extract-xz")(archivePath, destination, strip, { signal });
      } else if (/\.zip$/i.test(archiveName)) {
        await this.extractZip(archivePath, destination, strip, { signal });
      } else {
        throw new Error(`Unsupported archive '${path.basename(archiveName)}'.`);
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
    signal?.throwIfAborted();
  }

  async extractZip(archivePath, destination, strip = 0, { signal } = {}) {
    signal?.throwIfAborted();
    await require("./extract-zip")(archivePath, destination, strip, { signal });
    signal?.throwIfAborted();
  }
};

module.exports.parseSidecar = parseSidecar;
