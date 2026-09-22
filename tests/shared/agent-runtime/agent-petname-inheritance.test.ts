import { afterEach, describe, expect, it } from "vitest";
import { PetnameRegistry, petname } from "../../../extensions/_shared/agent-runtime/agent-names.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";

// One petname per LOGICAL agent: the workflow journal anchor row and the SDK
// executor row it spawns are the same actor, so the child adopts the parent's
// name instead of minting a second one. This is the fix for the operator seeing
// "[agent Wren] working" in the workflow card while the drill-close notice says
// "Perrin continues running" about the same agent.

afterEach(() => {
  agentLiveStore.reset();
});

describe("petname inheritance across anchor/executor rows", () => {
  it("gives the SDK executor row the same petname as its workflow anchor parent", () => {
    const anchor = agentLiveStore.begin({
      id: "workflow:run-1:explore:reconnaissance:",
      workflowRunId: "run-1",
      agentName: "explore",
      label: "explore (reconnaissance)",
      isolated: false,
      noMcp: false,
    });
    const child = agentLiveStore.begin({
      id: "workflow-agent:run-1:explore:reconnaissance:",
      parentRowId: anchor.id,
      workflowRunId: "run-1",
      agentName: "explore",
      label: "reconnaissance",
      isolated: false,
      noMcp: false,
    });
    expect(anchor.displayName).toBeTypeOf("string");
    expect(child.displayName).toBe(anchor.displayName);
  });

  it("keeps fresh names for rows whose parent is a group summary or unknown", () => {
    const group = agentLiveStore.begin({
      id: "workflow:run-2:group:g1",
      workflowRunId: "run-2",
      agentName: "workflow-group",
      label: "parallel (2)",
      groupKind: "parallel",
      isolated: false,
      noMcp: false,
    });
    expect(group.displayName).toBeUndefined();
    const underGroup = agentLiveStore.begin({
      id: "workflow:run-2:explore:a:",
      parentRowId: group.id,
      workflowRunId: "run-2",
      agentName: "explore",
      label: "explore (a)",
      isolated: false,
      noMcp: false,
    });
    expect(underGroup.displayName).toBe(petname(underGroup.id));

    const orphan = agentLiveStore.begin({
      id: "workflow-agent:run-2:explore:b:",
      parentRowId: "workflow:run-2:never-created:b:",
      agentName: "explore",
      label: "b",
      isolated: false,
      noMcp: false,
    });
    expect(orphan.displayName).toBe(petname(orphan.id));
  });

  it("keeps an inherited name stable when the child row is re-begun (slot rounds)", () => {
    const anchor = agentLiveStore.begin({
      id: "workflow:run-3:task:slot:",
      agentName: "task",
      label: "task (slot)",
      isolated: false,
      noMcp: false,
    });
    const first = agentLiveStore.begin({
      id: "workflow-agent:run-3:task:slot:",
      parentRowId: anchor.id,
      agentName: "task",
      label: "slot",
      round: 1,
      isolated: false,
      noMcp: false,
    });
    const second = agentLiveStore.begin({
      id: "workflow-agent:run-3:task:slot:",
      parentRowId: anchor.id,
      agentName: "task",
      label: "slot",
      round: 2,
      isolated: false,
      noMcp: false,
    });
    expect(first.displayName).toBe(anchor.displayName);
    expect(second.displayName).toBe(anchor.displayName);
  });

  it("frees a shared name only when every holder row is removed", () => {
    const seed = "adopt-release-seed";
    const base = petname(seed);
    let colliding: string | undefined;
    for (let i = 0; i < 50_000 && colliding === undefined; i += 1) {
      const candidate = `adopt-probe-${i}`;
      if (candidate !== seed && petname(candidate) === base) colliding = candidate;
    }
    expect(colliding).toBeDefined();

    const registry = new PetnameRegistry();
    expect(registry.assign(seed)).toBe(base);
    expect(registry.adopt("child-of-seed", base)).toBe(base);
    // Adoption is idempotent per id and never renames an already-named row.
    expect(registry.adopt("child-of-seed", "SomethingElse")).toBe(base);

    // The parent retires first; the child still holds the name, so a colliding
    // fresh id must keep its suffix.
    expect(registry.release(seed)).toBe(true);
    expect(registry.assign(colliding!)).toBe(`${base}-2`);

    // Once the last holder releases, the surname is reusable again.
    registry.release(colliding!);
    expect(registry.release("child-of-seed")).toBe(true);
    expect(registry.assign(seed)).toBe(base);
  });
});
