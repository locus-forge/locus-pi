/**
 * `/agent observe` text projection. The observer belongs to the agents feature
 * and reads only the shared live store, so these cases drive the store directly
 * — no workflow run, no widget, no host.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderAgentObserverText } from "../../../../extensions/agents/operator/agent-observer.js";
import { agentLiveStore } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";

afterEach(() => agentLiveStore.reset());

describe("agent observer text", () => {
  it("says so plainly when the store holds no rows", () => {
    agentLiveStore.reset();

    expect(renderAgentObserverText()).toBe("Agent observer: no live rows");
  });

  it("counts every row by status and spells out what each status means", () => {
    agentLiveStore.reset();
    agentLiveStore.begin({ id: "a", label: "alpha", agentName: "scout" });
    agentLiveStore.patch("a", { status: "working" });
    agentLiveStore.begin({ id: "b", label: "bravo" });
    agentLiveStore.patch("b", { status: "done" });
    agentLiveStore.begin({ id: "c", label: "charlie" });
    agentLiveStore.patch("c", { status: "error" });

    const text = renderAgentObserverText();

    expect(text).toContain("Agent observer: 3 rows total");
    expect(text).toContain(
      "counts: queued=0 waiting; working=1 running; done=1 completed; cancelled=0 terminal/not-running; error=1 terminal/not-running",
    );
  });

  it("shows the two most current rows, working first, and reports the rest as not shown", () => {
    agentLiveStore.reset();
    agentLiveStore.begin({ id: "done-row", label: "finished" });
    agentLiveStore.patch("done-row", { status: "done" });
    agentLiveStore.begin({ id: "queued-row", label: "waiting" });
    agentLiveStore.patch("queued-row", { status: "queued" });
    agentLiveStore.begin({ id: "working-row", label: "running" });
    agentLiveStore.patch("working-row", { status: "working" });

    const text = renderAgentObserverText();

    expect(text).toContain("showing 2 current/recent rows");
    expect(text).toContain("- working-row");
    expect(text).toContain("status=working (running)");
    expect(text).toContain("- queued-row");
    expect(text).toContain("status=queued (waiting)");
    expect(text).not.toContain("- done-row");
    expect(text).toContain("more: 1 row(s) not shown");
  });

  it("lists active tools only while the row is working", () => {
    agentLiveStore.reset();
    agentLiveStore.begin({ id: "a", label: "alpha" });
    agentLiveStore.patch("a", { status: "working", currentTools: ["Read", "Bash"] });

    expect(renderAgentObserverText()).toContain("tools=Read,Bash");

    agentLiveStore.patch("a", { status: "done" });

    expect(renderAgentObserverText()).not.toContain("tools=");
  });

  it("collapses repeated event lines and says how many earlier ones it dropped", () => {
    agentLiveStore.reset();
    agentLiveStore.begin({ id: "a", label: "alpha" });
    agentLiveStore.patch("a", {
      status: "working",
      eventLines: ["first", "second", "tool Read", "tool Read", "tool Read", "tool Read", "tool Read"],
    });

    const text = renderAgentObserverText();

    // Five most recent events are kept; the two before them are announced, not shown.
    expect(text).toContain("tool Read x5");
    expect(text).toContain("(+2 earlier events omitted)");
    expect(text).not.toContain("first");
  });

  it("reports a row with no events instead of an empty digest", () => {
    agentLiveStore.reset();
    agentLiveStore.begin({ id: "a", label: "alpha" });

    expect(renderAgentObserverText()).toContain("events: (no events)");
  });

  it("stays inside the agents feature and the shared layers", () => {
    // The observer moved out of workflows/operator/progress-widget.ts precisely so
    // the agents surface stops reaching into the workflows feature. A shared module
    // may not import a feature, and a feature may not import another feature's
    // internals — so this module imports `_shared/` and nothing else.
    const source = readFileSync(
      fileURLToPath(new URL("../../../../extensions/agents/operator/agent-observer.ts", import.meta.url)),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toContain("workflows/");
      expect(specifier?.startsWith(".")).toBe(true);
      expect(specifier).toContain("_shared/");
    }
  });
});
