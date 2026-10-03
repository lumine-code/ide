const { setTimeout: sleep } = require("node:timers/promises");
const { setTimeout, clearTimeout } = require("node:timers");
const transientStatuses = new Set([429, 500, 502, 503, 504]);
const transportError = (error) =>
  /^(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|UND_ERR_)/.test(
    error?.code || error?.cause?.code || "",
  ) ||
  error?.name === "TimeoutError" ||
  (error?.name === "TypeError" && /fetch failed|network/i.test(error.message));

// Retry GETs at most twice. Only response headers have a deadline, so large
// SDK bodies can continue actively streaming for much longer.
module.exports = async (
  fetchUrl,
  url,
  init = {},
  consume,
  { attempts = 3, headerTimeoutMs = 10000, delay = sleep } = {},
) => {
  const abortReason = () =>
    init.signal.reason || new DOMException("Download cancelled.", "AbortError");
  const wait = async (ms) => {
    if (init.signal?.aborted) throw abortReason();
    const operation = delay === sleep ? sleep(ms, undefined, { signal: init.signal }) : delay(ms);
    if (!init.signal) return operation;
    if (init.signal.aborted) throw abortReason();
    let onAbort;
    try {
      return await Promise.race([
        operation,
        new Promise((_resolve, reject) => {
          onAbort = () => reject(abortReason());
          init.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      init.signal.removeEventListener("abort", onAbort);
    }
  };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (init.signal?.aborted) throw abortReason();
    const controller = new AbortController();
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    let timer;
    try {
      const response = await Promise.race([
        fetchUrl(url, { ...init, signal }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Timed out waiting for response headers.");
            error.name = "TimeoutError";
            controller.abort(error);
            reject(error);
          }, headerTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (transientStatuses.has(response.status) && attempt + 1 < attempts) {
        controller.abort();
        await wait(250 * 2 ** attempt);
        continue;
      }
      if (!response.ok) controller.abort();
      return { response, value: response.ok && consume ? await consume(response) : undefined };
    } catch (error) {
      controller.abort();
      if (init.signal?.aborted || !transportError(error) || attempt + 1 === attempts) throw error;
      await wait(250 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("No download attempts were allowed.");
};
