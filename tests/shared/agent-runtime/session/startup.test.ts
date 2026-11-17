import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentStartup,
  AgentStartupTimeoutError,
} from "../../../../extensions/_shared/agent-runtime/session/startup.js";
import { agentStartupMarkProblem } from "../../../../extensions/_shared/agent-runtime/session/startup-format.js";
import { workflowJournalLineProblem } from "../../../../extensions/workflows/runtime/workflow-journal-format.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startup measurements and expiry boundaries", () => {
  it("measures process CPU and synchronous event-loop delay, resetting intervals after every mark", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let clock = 0;
    let user = 1000;
    let system = 2000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(process, "cpuUsage").mockImplementation(() => ({ user, system }));
    const startup = new AgentStartup(1000);
    try {
      clock = 35;
      user = 6000;
      system = 4000;
      startup.mark("resources_load_start");
      expect(startup.marks[1]).toMatchObject({
        elapsedMs: 35,
        wallMs: 35,
        cpuUserMs: 5,
        cpuSystemMs: 2,
        eventLoopDelayMs: 25,
      });
      clock = 40;
      user = 7000;
      system = 4500;
      startup.mark("resources_loaded");
      expect(startup.marks[2]).toMatchObject({
        elapsedMs: 40,
        wallMs: 5,
        cpuUserMs: 1,
        cpuSystemMs: 0.5,
        eventLoopDelayMs: 0,
      });
    } finally {
      startup.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the largest sampled delay and clears it at the next boundary", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const startup = new AgentStartup(1000);
    try {
      clock = 45;
      await vi.advanceTimersByTimeAsync(10);
      clock = 50;
      startup.mark("model_roles_loaded");
      expect(startup.marks.at(-1)?.eventLoopDelayMs).toBe(35);
      clock = 55;
      startup.mark("model_resolved");
      expect(startup.marks.at(-1)?.eventLoopDelayMs).toBe(0);
    } finally {
      startup.close();
    }
  });

  it("refuses progress after a synchronous stage exceeds the limit, before timers can execute", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const startup = new AgentStartup(1000);
    try {
      startup.mark("resources_load_start");
      clock = 1001;
      expect(() => startup.mark("resources_loaded")).toThrow(/last completed stage: resources_load_start/);
      await expect(startup.wait(Promise.resolve("late"))).rejects.toBeInstanceOf(AgentStartupTimeoutError);
      expect(startup.marks.at(-1)?.stage).toBe("resources_load_start");
    } finally {
      startup.close();
    }
  });

  it("cleans timers when a startup journal observer throws", () => {
    vi.useFakeTimers();
    expect(
      () =>
        new AgentStartup(1000, () => {
          throw new Error("sink failed");
        }),
    ).toThrow("sink failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("validates startup journal data without weakening legacy records or cross-kind fields", () => {
    const startup = new AgentStartup(1000);
    try {
      const mark = startup.marks[0]!;
      const line = {
        ts: mark.ts,
        runId: "codec",
        kind: "log",
        source: "runtime",
        callId: "call-0001",
        message: "startup",
        startup: mark,
      };
      expect(workflowJournalLineProblem(line, "codec")).toBeUndefined();
      const { startup: _mark, ...legacy } = line;
      expect(workflowJournalLineProblem(legacy, "codec")).toBeUndefined();
      for (const invalid of [
        { ...mark, stage: "invented" },
        { ...mark, wallMs: -1 },
        { ...mark, cpuUserMs: NaN },
        { ...mark, extra: 1 },
        { ...mark, ts: "invalid" },
      ]) {
        expect(agentStartupMarkProblem(invalid)).toBeDefined();
        expect(workflowJournalLineProblem({ ...line, startup: invalid }, "codec")).toBeDefined();
      }
      expect(workflowJournalLineProblem({ ...line, kind: "error" }, "codec")).toContain("not allowed");
      expect(workflowJournalLineProblem({ ...line, source: "script" }, "codec")).toBeDefined();
    } finally {
      startup.close();
    }
  });
});
