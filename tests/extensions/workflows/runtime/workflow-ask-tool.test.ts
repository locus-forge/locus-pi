import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../../../extensions/_shared/host/pi-api.js";
import { SupersededInlineOperatorInteractionError } from "../../../../extensions/_shared/operator/operator-interaction.js";
import type {
  OperatorQuestionResult,
  OperatorQuestionSpec,
} from "../../../../extensions/_shared/operator/operator-question.js";
import {
  createWorkflowAskTool,
  WORKFLOW_ASK_EVIDENCE_PERSISTENCE_PREFIX,
  WORKFLOW_ASK_NO_UI_MESSAGE,
  WORKFLOW_ASK_TOOL_NAME,
  type WorkflowAskFailureCause,
  type WorkflowAskEvidenceRecord,
  type WorkflowAskToolDeps,
} from "../../../../extensions/workflows/runtime/workflow-ask-tool.js";

/**
 * T-167 — the live child-agent question tool, unit level.
 *
 * The tool's whole contract is behavioral: no timeout auto-answer exists at all,
 * Esc travels back as "declined" text with the answers already given, an evicted
 * question re-mounts instead of dying, a no-UI parent fails the CALL (through
 * `failCall`) rather than leaving refusal prose in the model's context, and
 * concurrent asking children serialize FIFO instead of superseding each other.
 */

const tuiCtx = { hasUI: true, mode: "tui" } as unknown as ExtensionContext;
const printCtx = { hasUI: false, mode: "print" } as unknown as ExtensionContext;

interface DepsProbe {
  deps: WorkflowAskToolDeps;
  events: string[];
  records: WorkflowAskEvidenceRecord[];
  failures: Array<{ message: string; cause: WorkflowAskFailureCause }>;
}

function makeDeps(overrides: Partial<WorkflowAskToolDeps> = {}, opts: { globalQueue?: boolean } = {}): DepsProbe {
  const events: string[] = [];
  const records: WorkflowAskEvidenceRecord[] = [];
  const failures: Array<{ message: string; cause: WorkflowAskFailureCause }> = [];
  const deps: WorkflowAskToolDeps = {
    ctx: tuiCtx,
    contextText: 'Workflow run test — agent "reviewer" is asking:',
    onWaitStart: () => events.push("wait-start"),
    onWaitEnd: () => events.push("wait-end"),
    failCall: (message, cause) => failures.push({ message, cause }),
    recordEvidence: (record) => records.push(record),
    // Unit tests stay off the module-global FIFO unless they test it explicitly.
    ...(opts.globalQueue === true ? {} : { enqueue: (job) => job() }),
    remountDelayMs: 1,
    ...overrides,
  };
  return { deps, events, records, failures };
}

/** Scripted operator: each call consumes the next result (or throws the next error). */
function scripted(
  results: Array<OperatorQuestionResult | Error>,
  specs?: OperatorQuestionSpec[],
): NonNullable<WorkflowAskToolDeps["requestQuestion"]> {
  const queue = [...results];
  return async (_ctx, spec) => {
    specs?.push(spec);
    const next = queue.shift();
    if (next === undefined) throw new Error("scripted question queue exhausted");
    if (next instanceof Error) throw next;
    return next;
  };
}

const signal = (): AbortSignal => new AbortController().signal;

const ONE_QUESTION = {
  questions: [
    { id: "q1", question: "Which storage?", options: [{ label: "sqlite" }, { label: "files" }], recommended: 0 },
  ],
};

const TWO_QUESTIONS = {
  questions: [
    { id: "q1", question: "Which storage?", options: [{ label: "sqlite" }, { label: "files" }] },
    { id: "q2", question: "Which name?", options: [] },
  ],
};

describe("workflow_ask — validation", () => {
  it("rejects malformed params as a tool error, without mounting anything", async () => {
    const { deps, events } = makeDeps({ requestQuestion: scripted([]) });
    const tool = createWorkflowAskTool(deps);
    const empty = await tool.execute("c1", { questions: [] }, signal());
    expect(empty.isError).toBe(true);
    expect(empty.content[0]?.text).toContain("questions");
    const badOption = await tool.execute("c2", { questions: [{ question: "x", options: [{ label: "" }] }] }, signal());
    expect(badOption.isError).toBe(true);
    const badRecommended = await tool.execute(
      "c3",
      { questions: [{ question: "x", options: [{ label: "a" }], recommended: 5 }] },
      signal(),
    );
    expect(badRecommended.isError).toBe(true);
    expect(events).toEqual([]); // the fuse was never touched
  });

  it("asks twelve questions in one call: the queue length is not a refusal", async () => {
    const asked: string[] = [];
    const { deps, records } = makeDeps({
      requestQuestion: async (_ctx, spec) => {
        asked.push(spec.question);
        return { status: "answered", kind: "custom", answer: `answer-${asked.length}` };
      },
    });
    const tool = createWorkflowAskTool(deps);
    const questions = Array.from({ length: 12 }, (_, index) => ({
      id: `q${index + 1}`,
      question: `Question ${index + 1}?`,
      options: [],
    }));

    const result = await tool.execute("call-many", { questions }, signal());

    expect(result.isError).toBeUndefined();
    expect(asked).toHaveLength(12);
    expect(records[0]?.entries).toHaveLength(12);
    expect(result.content[0]?.text).toContain("Operator answered 12 of 12");
  });
});

describe("workflow_ask — answers", () => {
  it("returns the operator's answer as the tool result and records evidence", async () => {
    const specs: OperatorQuestionSpec[] = [];
    const { deps, events, records } = makeDeps({
      requestQuestion: async (ctx, spec, request) => {
        events.push("mounted");
        return scripted([{ status: "answered", kind: "option", answer: "sqlite", label: "sqlite" }])(
          ctx,
          spec,
          request,
        );
      },
    });
    void specs;
    const tool = createWorkflowAskTool(deps);
    const result = await tool.execute("call-1", ONE_QUESTION, signal());
    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Operator answered 1 of 1");
    expect(text).toContain("Answer: sqlite");
    // The fuse pauses across the WHOLE wait, including queue time before the mount.
    expect(events).toEqual(["wait-start", "mounted", "wait-end"]);
    expect(records).toHaveLength(1);
    expect(records[0]?.declined).toBe(false);
    expect(records[0]?.entries[0]).toMatchObject({ id: "q1", status: "answered", answer: "sqlite", kind: "option" });
  });

  it("treats Esc as 'declined': keeps earlier answers, marks the rest, never hangs", async () => {
    const { deps, records } = makeDeps({
      requestQuestion: scripted([
        { status: "answered", kind: "option", answer: "sqlite", label: "sqlite" },
        { status: "cancelled" },
      ]),
    });
    const tool = createWorkflowAskTool(deps);
    const result = await tool.execute("call-1", TWO_QUESTIONS, signal());
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Operator answered 1 of 2");
    expect(text).toContain("DECLINED");
    expect(text).toContain("Do not invent the operator's answer.");
    expect(records[0]?.declined).toBe(true);
    expect(records[0]?.entries.map((entry) => entry.status)).toEqual(["answered", "declined"]);
  });

  it("supports back-navigation and re-answers the earlier question", async () => {
    const specs: OperatorQuestionSpec[] = [];
    const { deps, records } = makeDeps({
      requestQuestion: scripted(
        [
          { status: "answered", kind: "option", answer: "sqlite", label: "sqlite" },
          { status: "navigate", direction: "back" },
          { status: "answered", kind: "custom", answer: "postgres" },
          { status: "answered", kind: "custom", answer: "locus" },
        ],
        specs,
      ),
    });
    const tool = createWorkflowAskTool(deps);
    await tool.execute("call-1", TWO_QUESTIONS, signal());
    // The re-asked first question carried the earlier answer back as the initial one.
    expect(specs[2]?.initialAnswer).toEqual({ kind: "option", answer: "sqlite" });
    expect(records[0]?.entries[0]).toMatchObject({ status: "answered", answer: "postgres", kind: "custom" });
    expect(records[0]?.entries[1]).toMatchObject({ status: "answered", answer: "locus" });
  });

  it("re-mounts a question evicted by the operator's own interaction", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      requestQuestion: async () => {
        calls += 1;
        if (calls === 1) throw new SupersededInlineOperatorInteractionError();
        return { status: "answered", kind: "option", answer: "sqlite", label: "sqlite" };
      },
    });
    const tool = createWorkflowAskTool(deps);
    const result = await tool.execute("call-1", ONE_QUESTION, signal());
    expect(calls).toBe(2);
    expect(result.content[0]?.text).toContain("Answer: sqlite");
  });
});

describe("workflow_ask — fail-closed", () => {
  it("fails the CALL when the parent has no UI, instead of returning prose to talk past", async () => {
    const { deps, failures } = makeDeps({ ctx: printCtx, requestQuestion: scripted([]) });
    const tool = createWorkflowAskTool(deps);
    const result = await tool.execute("call-1", ONE_QUESTION, signal());
    expect(failures).toEqual([{ message: WORKFLOW_ASK_NO_UI_MESSAGE, cause: "ask-unavailable" }]);
    expect(result.isError).toBe(true);
  });

  it("fails the CALL when the question surface itself reports no-ui", async () => {
    const { deps, failures } = makeDeps({
      requestQuestion: scripted([{ status: "unavailable", reason: "no-ui" }]),
    });
    const tool = createWorkflowAskTool(deps);
    const result = await tool.execute("call-1", ONE_QUESTION, signal());
    expect(failures).toEqual([{ message: WORKFLOW_ASK_NO_UI_MESSAGE, cause: "ask-unavailable" }]);
    expect(result.isError).toBe(true);
  });

  it("aborts after one displayed answer when durable evidence persistence fails", async () => {
    let mounts = 0;
    const { deps, failures } = makeDeps({
      requestQuestion: async () => {
        mounts += 1;
        return { status: "answered", kind: "option", answer: "sqlite", label: "sqlite" };
      },
      recordEvidence: () => {
        throw new Error("injected index write failure");
      },
    });
    const tool = createWorkflowAskTool(deps);

    const result = await tool.execute("call-1", ONE_QUESTION, signal());

    expect(mounts).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(WORKFLOW_ASK_EVIDENCE_PERSISTENCE_PREFIX);
    expect(result.content[0]?.text).not.toContain("Answer: sqlite");
    expect(failures).toEqual([
      {
        message: `${WORKFLOW_ASK_EVIDENCE_PERSISTENCE_PREFIX}: injected index write failure`,
        cause: "ask-evidence-persistence",
      },
    ]);
  });
});

describe("workflow_ask — FIFO across concurrent children", () => {
  it("serializes two asking children: the second mounts only after the first settles", async () => {
    const order: string[] = [];
    let releaseFirst: ((result: OperatorQuestionResult) => void) | undefined;
    const first = makeDeps(
      {
        requestQuestion: () => {
          order.push("first-mounted");
          return new Promise<OperatorQuestionResult>((resolve) => {
            releaseFirst = resolve;
          });
        },
      },
      { globalQueue: true },
    );
    const second = makeDeps(
      {
        requestQuestion: async () => {
          order.push("second-mounted");
          return { status: "answered", kind: "custom", answer: "later" };
        },
      },
      { globalQueue: true },
    );
    const firstTool = createWorkflowAskTool(first.deps);
    const secondTool = createWorkflowAskTool(second.deps);
    const firstCall = firstTool.execute("a", ONE_QUESTION, signal());
    const secondCall = secondTool.execute("b", { questions: [{ question: "B?", options: [] }] }, signal());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first-mounted"]);
    releaseFirst?.({ status: "answered", kind: "option", answer: "sqlite", label: "sqlite" });
    await firstCall;
    await secondCall;
    expect(order).toEqual(["first-mounted", "second-mounted"]);
    expect(firstTool.name).toBe(WORKFLOW_ASK_TOOL_NAME);
  });
});
