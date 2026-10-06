const { abortable, combinedSignal } = require("./installation-io");

const abandoned = (message) => new DOMException(message, "AbortError");

// Caller cancellation is prompt; the underlying worker keeps its lease until
// its last writer settles. A hook ignoring its signal cannot publish afterward.
module.exports = class InstallationController {
  constructor({ assertActive, acquire, setStatus }) {
    this.assertOwner = assertActive;
    this.acquire = acquire;
    this.setStatus = setStatus;
    this.lifetime = new AbortController();
    this.queues = new Map();
    this.operations = new Set();
    this.current = new Map();
    this.disposed = false;
  }

  get signal() {
    return this.lifetime.signal;
  }

  run(adapter, work, { signal } = {}) {
    if (this.disposed)
      return Promise.reject(abandoned("Server installations are no longer active"));
    const controller = new AbortController();
    const operation = {
      adapter,
      controller,
      signal: combinedSignal(combinedSignal(this.signal, signal), controller.signal),
      finished: false,
      assertActive: () => {
        operation.signal.throwIfAborted();
        this.assertOwner(adapter);
        if (operation.finished) throw abandoned("The server installation has finished");
      },
      setStatus: (status) => {
        operation.assertActive();
        if (this.current.get(adapter.id) === operation) this.setStatus(adapter.id, status);
      },
    };
    this.operations.add(operation);
    const cancelled = () => {
      if (this.current.get(adapter.id) === operation && !this.disposed)
        this.setStatus(adapter.id, null);
    };
    operation.signal.addEventListener("abort", cancelled, { once: true });
    const predecessor = this.queues.get(adapter.id) || Promise.resolve();
    const worker = predecessor
      .catch(() => {})
      .then(async () => {
        let lease, failure, cleanupFailure, result;
        try {
          operation.assertActive();
          this.current.set(adapter.id, operation);
          operation.setStatus("waiting");
          lease = await this.acquire(adapter.id, { signal: operation.signal });
          operation.assertActive();
          result = await work(operation, lease);
          operation.assertActive();
          operation.setStatus(null);
        } catch (error) {
          failure = error;
          if (
            !operation.signal.aborted &&
            !this.disposed &&
            this.current.get(adapter.id) === operation
          )
            this.setStatus(adapter.id, "failed");
        } finally {
          operation.finished = true;
          operation.signal.removeEventListener("abort", cancelled);
          try {
            await lease?.release();
          } catch (error) {
            cleanupFailure = error;
            if (
              !operation.signal.aborted &&
              !this.disposed &&
              this.current.get(adapter.id) === operation
            )
              this.setStatus(adapter.id, "failed");
          } finally {
            this.operations.delete(operation);
            if (this.current.get(adapter.id) === operation) this.current.delete(adapter.id);
          }
        }
        if (failure && cleanupFailure)
          throw new AggregateError(
            [failure, cleanupFailure],
            `${failure.message}; installation cleanup failed: ${cleanupFailure.message}`,
            { cause: failure },
          );
        if (cleanupFailure) throw cleanupFailure;
        if (failure) throw failure;
        return result;
      });
    this.queues.set(adapter.id, worker);
    const complete = () => {
      if (this.queues.get(adapter.id) === worker) this.queues.delete(adapter.id);
      // Settle the caller before expiring capabilities borrowed by the hook.
      queueMicrotask(() => controller.abort(abandoned("The server installation has finished")));
    };
    worker.then(complete, complete);
    return abortable(worker, operation.signal);
  }

  cancelAdapter(adapter) {
    for (const operation of this.operations)
      if (operation.adapter === adapter)
        operation.controller.abort(abandoned(`Server adapter '${adapter.id}' was unregistered`));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort(abandoned("Server installations are no longer active"));
    // Workers release their own leases. Waiting for an uncooperative hook here
    // would prevent package deactivation from completing.
  }
};
