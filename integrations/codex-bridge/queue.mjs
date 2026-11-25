// Bound both running inference and waiting callers. Waiting callers do not
// start Codex processes or consume model quota.
export class WorkerQueue {
  constructor(concurrency, capacity, timeout) {
    this.concurrency = concurrency;
    this.capacity = capacity;
    this.timeout = timeout;
    this.active = 0;
    this.waiters = [];
  }

  async acquire(signal) {
    if (signal?.aborted) throw Object.assign(new Error('Request cancelled'), { status: 499 });
    if (this.active < this.concurrency) {
      this.active++;
      return this.releaseHandle();
    }
    if (this.waiters.length >= this.capacity) throw Object.assign(new Error('Codex bridge queue is full; retry later'), { status: 429 });
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const cancel = error => {
        const index = this.waiters.indexOf(entry);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        entry.cleanup();
        reject(error);
      };
      const onAbort = () => cancel(Object.assign(new Error('Request cancelled'), { status: 499 }));
      const timer = setTimeout(() => cancel(Object.assign(new Error('Timed out waiting for a Codex worker'), { status: 503 })), this.timeout);
      entry.cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.waiters.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.cleanup();
        next.resolve(this.releaseHandle());
      } else this.active--;
    };
  }
}
