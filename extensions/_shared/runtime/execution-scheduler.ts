/** FIFO permits with one owner and cancellable queue admission. */
export interface ExecutionPermit {
  activate(): void;
  release(): void;
}

export function executionAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Execution was cancelled", "AbortError");
}

export function createExecutionScheduler(concurrency: number) {
  let inUse = 0;
  let active = 0;
  let peak = 0;
  interface Waiter {
    signal: AbortSignal;
    admit: () => void;
    abort: () => void;
  }
  const waiters: Waiter[] = [];
  function dispatch(): void {
    while (inUse < concurrency && waiters.length > 0) waiters.shift()!.admit();
  }
  function acquire(signal: AbortSignal): Promise<ExecutionPermit> {
    if (signal.aborted) return Promise.reject(executionAbortReason(signal));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        admit() {
          signal.removeEventListener("abort", waiter.abort);
          if (signal.aborted) {
            reject(executionAbortReason(signal));
            return;
          }
          inUse += 1;
          let released = false;
          let executing = false;
          resolve({
            activate() {
              if (released) throw new Error("cannot activate a released execution permit");
              if (executing) return;
              executing = true;
              active += 1;
              peak = Math.max(peak, active);
            },
            release() {
              if (released) return;
              released = true;
              inUse -= 1;
              if (executing) active -= 1;
              dispatch();
            },
          });
        },
        abort() {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          reject(executionAbortReason(signal));
          dispatch();
        },
      };
      waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      dispatch();
    });
  }
  return { acquire, peak: () => peak, active: () => active };
}
