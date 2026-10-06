import { describe, expect, it, vi } from "vitest";
import {
  createExecutionState,
  type ExecutionLease,
  type ExecutionScope,
} from "../../../extensions/_shared/runtime/execution-state.js";

function state(input: Partial<Parameters<typeof createExecutionState>[0]> = {}) {
  return createExecutionState({
    concurrency: 1,
    capError: () => new Error("totalAgents exceeded"),
    deadlineError: () => new Error("deadline exceeded"),
    ...input,
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("shared physical execution ownership", () => {
  it("runs parent, child, and grandchild through concurrency=1 without double charging resumption", async () => {
    const owner = state({ totalAgents: 3 });
    const identities: unknown[] = [];
    const value = await owner.createInvocation("fresh").run(async (parent) => {
      identities.push(parent.identity);
      return parent.withChildren(async (children) =>
        children.createInvocation("fresh").run(async (child) => {
          identities.push(child.identity);
          return child.withChildren(async (grandchildren) =>
            grandchildren.createInvocation("fresh").run(async (grandchild) => {
              identities.push(grandchild.identity);
              return "complete";
            }),
          );
        }),
      );
    });
    expect(value).toBe("complete");
    expect(identities).toEqual([
      { sequence: 1 },
      { sequence: 2, parentSequence: 1 },
      { sequence: 3, parentSequence: 2 },
    ]);
    expect(owner.invocationCounts()).toEqual({ fresh: 3, replayed: 0 });
    expect(owner.peakAgentConcurrency()).toBe(1);
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("blocks the next descendant at the root cap and restores its parent's permit", async () => {
    const owner = state({ totalAgents: 1 });
    const child = vi.fn(async () => undefined);
    await expect(
      owner.createInvocation("fresh").run(async (parent) => {
        await expect(parent.withChildren(async (scope) => scope.createInvocation("fresh").run(child))).rejects.toThrow(
          "totalAgents",
        );
        expect(owner.activeAgentConcurrency()).toBe(1);
      }),
    ).rejects.toThrow("totalAgents");
    expect(child).not.toHaveBeenCalled();
    expect(owner.invocationCounts().fresh).toBe(1);
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("refuses duplicate and replay launches without another physical charge", async () => {
    const owner = state();
    const invocation = owner.createInvocation("fresh");
    await invocation.run(async () => undefined);
    await expect(invocation.run(async () => undefined)).rejects.toThrow("only once");
    await expect(owner.createInvocation("replayed").run(async () => undefined)).rejects.toThrow("replayed");
    expect(owner.invocationCounts()).toEqual({ fresh: 1, replayed: 1 });
  });

  it("atomically spends a root-owned reservation and preserves unreserved allowance", async () => {
    const owner = state({ totalAgents: 3 });
    const reserved = owner.reserve(2);
    expect(owner.remainingAgentInvocations()).toBe(1);
    await owner.createInvocation("fresh").run(async () => undefined);
    await expect(owner.createInvocation("fresh").run(async () => undefined)).rejects.toThrow("totalAgents");
    await owner.createInvocation("fresh", reserved).run(async () => undefined);
    await owner.createInvocation("fresh", reserved).run(async () => undefined);
    expect(reserved.remaining).toBe(0);
    owner.releaseReservation(reserved);
    owner.releaseReservation(reserved);
    expect(owner.invocationCounts().fresh).toBe(3);
    expect(owner.remainingAgentInvocations()).toBe(0);
  });

  it("rejects foreign and forged reservations and cannot mutate the root's allowance", async () => {
    const owner = state({ totalAgents: 1 });
    const other = state();
    const foreign = other.reserve(1);
    await expect(owner.createInvocation("fresh", foreign).run(async () => undefined)).rejects.toThrow("another root");
    expect(() => owner.releaseReservation({ remaining: 10, active: true })).toThrow("another root");
    expect(owner.remainingAgentInvocations()).toBe(1);
    expect(owner.invocationCounts().fresh).toBe(0);
  });

  it("cancels queued work without charge and keeps a running slot until callback cleanup", async () => {
    const controller = new AbortController();
    const owner = state({ signal: controller.signal });
    const gate = deferred();
    const running = owner.createInvocation("fresh").run(async () => gate.promise);
    const queuedWork = vi.fn(async () => undefined);
    const queued = owner.createInvocation("fresh").run(queuedWork);
    const refusal = expect(queued).rejects.toThrow("stop now");
    await Promise.resolve();
    controller.abort(new Error("stop now"));
    await refusal;
    expect(owner.activeAgentConcurrency()).toBe(1);
    expect(owner.invocationCounts().fresh).toBe(1);
    expect(queuedWork).not.toHaveBeenCalled();
    gate.resolve();
    await running;
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("root close cancels descendants, joins cleanup, and does not re-admit the parent", async () => {
    const owner = state();
    const entered = deferred();
    const cleanup = deferred();
    const parent = owner.createInvocation("fresh").run(async (lease) =>
      lease.withChildren(async (scope) =>
        scope.createInvocation("fresh").run(async (child) => {
          entered.resolve();
          await untilAborted(child.signal);
          await cleanup.promise;
        }),
      ),
    );
    const refused = expect(parent).rejects.toThrow("root done");
    await entered.promise;
    let closed = false;
    const closing = owner.close(new Error("root done")).then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(owner.activeAgentConcurrency()).toBe(1);
    cleanup.resolve();
    await closing;
    await refused;
    expect(owner.activeAgentConcurrency()).toBe(0);
    expect(owner.invocationCounts().fresh).toBe(2);
    expect(() => owner.createInvocation("fresh")).toThrow("root done");
  });

  it("scope failure cancels and drains every started sibling before resuming the parent", async () => {
    const owner = state({ concurrency: 2 });
    const entered = deferred();
    const cleanup = deferred();
    let parentSettled = false;
    const task = owner.createInvocation("fresh").run(async (parent) => {
      await expect(
        parent.withChildren(async (children) => {
          void children.createInvocation("fresh").run(async (child) => {
            entered.resolve();
            await untilAborted(child.signal);
            await cleanup.promise;
          });
          await entered.promise;
          throw new Error("scope failed");
        }),
      ).rejects.toThrow("scope failed");
      expect(owner.activeAgentConcurrency()).toBe(1);
      parentSettled = true;
    });
    await entered.promise;
    await Promise.resolve();
    expect(parentSettled).toBe(false);
    cleanup.resolve();
    await expect(task).rejects.toThrow("scope failed");
    expect(parentSettled).toBe(true);
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("joins a forgotten delegation and closes saved scopes and leases", async () => {
    const owner = state();
    const entered = deferred();
    const done = deferred();
    let scope: ExecutionScope | undefined;
    let savedLease: ExecutionLease | undefined;
    let settled = false;
    const task = owner
      .createInvocation("fresh")
      .run(async (parent) => {
        savedLease = parent;
        void parent.withChildren(async (children) => {
          scope = children;
          await children.createInvocation("fresh").run(async () => {
            entered.resolve();
            await done.promise;
          });
        });
      })
      .then(() => {
        settled = true;
      });
    await entered.promise;
    expect(settled).toBe(false);
    done.resolve();
    await task;
    expect(() => scope!.createInvocation("fresh")).toThrow("closed");
    await expect(savedLease!.withChildren(async () => undefined)).rejects.toThrow("finished");
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("drains admitted detached children, including their later descendants", async () => {
    const owner = state();
    const ran: number[] = [];
    await owner.createInvocation("fresh").run(async (parent) => {
      await parent.withChildren(async (scope) => {
        void scope.createInvocation("fresh").run(async (child) => {
          await Promise.resolve();
          await child.withChildren(async (nested) =>
            nested.createInvocation("fresh").run(async () => {
              ran.push(3);
            }),
          );
          ran.push(1);
        });
        void scope.createInvocation("fresh").run(async () => {
          ran.push(2);
        });
      });
    });
    expect(ran).toEqual([2, 3, 1]);
    expect(owner.invocationCounts().fresh).toBe(4);
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("retains a detached delegation failure after it settled before its parent", async () => {
    const owner = state();
    const failed = deferred();
    const task = owner.createInvocation("fresh").run(async (parent) => {
      void parent
        .withChildren(async () => {
          throw new Error("detached failure");
        })
        .catch(() => failed.resolve());
      await failed.promise;
      return "must not report success";
    });
    await expect(task).rejects.toThrow("detached failure");
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("cancels parent re-entry when its callback fails behind a sibling", async () => {
    const owner = state();
    const yielded = deferred();
    const siblingStarted = deferred();
    let parent!: Promise<unknown>;
    parent = owner.createInvocation("fresh").run(async (lease) => {
      void lease.withChildren(async () => {
        yielded.resolve();
      });
      await siblingStarted.promise;
      throw new Error("parent failed");
    });
    const parentRejected = expect(parent).rejects.toThrow("parent failed");
    const sibling = owner.createInvocation("fresh").run(async () => {
      await yielded.promise;
      siblingStarted.resolve();
      await Promise.allSettled([parent]);
    });
    await parentRejected;
    await sibling;
    expect(owner.activeAgentConcurrency()).toBe(0);
    expect(owner.invocationCounts().fresh).toBe(2);
  });

  it("cancels detached siblings on first child failure before joining them", async () => {
    const owner = state({ concurrency: 2 });
    const started = deferred();
    const failed = new Error("first detached child failed");
    let siblingCleaned = false;
    const task = owner.createInvocation("fresh").run(async (parent) =>
      parent.withChildren(async (children) => {
        void children.createInvocation("fresh").run(async () => {
          await started.promise;
          throw failed;
        });
        void children.createInvocation("fresh").run(async (sibling) => {
          started.resolve();
          await untilAborted(sibling.signal);
          siblingCleaned = true;
          throw new Error("later cancellation");
        });
      }),
    );
    await expect(task).rejects.toBe(failed);
    expect(siblingCleaned).toBe(true);
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("closes parent delegation admission when its callback returns before a detached scope", async () => {
    const owner = state();
    const finish = deferred();
    const began = deferred();
    const unexpectedChild = vi.fn(async () => undefined);
    let continuation!: Promise<unknown>;
    const parent = owner.createInvocation("fresh").run(async (lease) => {
      const first = lease.withChildren(async () => {
        began.resolve();
        await finish.promise;
      });
      continuation = first.then(() =>
        lease.withChildren(async (scope) => scope.createInvocation("fresh").run(unexpectedChild)),
      );
      void continuation.catch(() => undefined);
    });
    await began.promise;
    // Let the parent's callback settle while its detached scope is still running.
    await Promise.resolve();
    finish.resolve();
    await parent;
    await expect(continuation).rejects.toThrow("finished");
    await owner.close();
    expect(unexpectedChild).not.toHaveBeenCalled();
    expect(owner.invocationCounts().fresh).toBe(1);
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("cancels obsolete re-entry when a successful parent returns behind a sibling", async () => {
    const owner = state();
    const siblingStarted = deferred();
    const finishParent = deferred();
    let parent!: Promise<unknown>;
    parent = owner.createInvocation("fresh").run(async (lease) => {
      void lease.withChildren(async () => undefined);
      await finishParent.promise;
      return "done";
    });
    const sibling = owner.createInvocation("fresh").run(async () => {
      siblingStarted.resolve();
      await parent;
    });
    await siblingStarted.promise;
    // The empty delegation has finished and parent re-entry is queued behind B.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    finishParent.resolve();
    await expect(parent).resolves.toBe("done");
    await sibling;
    expect(owner.activeAgentConcurrency()).toBe(0);
    expect(owner.invocationCounts().fresh).toBe(2);
  });

  it("cancels queued siblings before a failed child releases its slot", async () => {
    const owner = state();
    const queued = vi.fn(async () => undefined);
    const failure = new Error("first child failed");
    const task = owner.createInvocation("fresh").run(async (parent) =>
      parent.withChildren(async (scope) => {
        void scope.createInvocation("fresh").run(async () => {
          throw failure;
        });
        void scope.createInvocation("fresh").run(queued);
      }),
    );
    await expect(task).rejects.toBe(failure);
    expect(queued).not.toHaveBeenCalled();
    expect(owner.invocationCounts().fresh).toBe(2);
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("reports executing concurrency without counting admission refusals", async () => {
    const owner = state({ concurrency: 4, totalAgents: 1 });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => owner.createInvocation("fresh").run(async () => undefined)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(owner.peakAgentConcurrency()).toBe(1);
    expect(owner.activeAgentConcurrency()).toBe(0);
    expect(owner.invocationCounts().fresh).toBe(1);
  });

  it("does not resume a parent cancelled between re-entry grant and activation", async () => {
    const controller = new AbortController();
    const owner = state({ signal: controller.signal });
    const siblingStarted = deferred();
    const finishSibling = deferred();
    const cancelled = new Error("cancelled after grant");
    let resumed = false;
    const parent = owner.createInvocation("fresh").run(async (lease) => {
      await lease.withChildren(async () => undefined);
      resumed = true;
    });
    const parentRejected = expect(parent).rejects.toBe(cancelled);
    const sibling = owner.createInvocation("fresh").run(async () => {
      siblingStarted.resolve();
      await finishSibling.promise;
      queueMicrotask(() => queueMicrotask(() => controller.abort(cancelled)));
    });
    await siblingStarted.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    finishSibling.resolve();
    await sibling;
    await parentRejected;
    expect(resumed).toBe(false);
    expect(owner.activeAgentConcurrency()).toBe(0);
    expect(owner.invocationCounts().fresh).toBe(2);
  });

  it("rejects cancellation after descendants settle but before parent re-entry begins", async () => {
    const controller = new AbortController();
    const owner = state({ signal: controller.signal });
    const cancelled = new Error("cancelled before re-entry");
    let resumed = false;
    const parent = owner.createInvocation("fresh").run(async (lease) => {
      await lease.withChildren(async () => {
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort(cancelled))));
      });
      resumed = true;
    });
    await expect(parent).rejects.toBe(cancelled);
    expect(resumed).toBe(false);
    expect(owner.activeAgentConcurrency()).toBe(0);
  });

  it("refuses a second concurrent delegation scope while the first owns suspension", async () => {
    const owner = state();
    await owner.createInvocation("fresh").run(async (parent) => {
      const done = deferred();
      const pending = parent.withChildren(async () => done.promise);
      await expect(parent.withChildren(async () => undefined)).rejects.toThrow("awaiting descendants");
      done.resolve();
      await pending;
      expect(owner.activeAgentConcurrency()).toBe(1);
    });
    expect(owner.activeAgentConcurrency()).toBe(0);
  });
});
