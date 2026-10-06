// A rejected cancellation still observes the original operation: an adapter's
// injected transport may ignore AbortSignal and fail after its owner is gone.
function abortable(operation, signal) {
  const pending = Promise.resolve(operation);
  if (!signal) return pending;
  if (signal.aborted) {
    pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

const combinedSignal = (lifetime, signal) =>
  lifetime && signal && lifetime !== signal
    ? AbortSignal.any([lifetime, signal])
    : lifetime || signal;

module.exports = { abortable, combinedSignal };
