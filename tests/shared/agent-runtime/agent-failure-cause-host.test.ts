import { describe, expect, it } from "vitest";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import { runHost } from "../../fixtures/agent-runtime/agent-failure-probes.js";

/**
 * The shared SDK host's own classification calls, where the answer is NOT just the
 * cause name.
 *
 * One producing case per closed cause lives in the workflow cause matrix
 * (`tests/extensions/workflows/runtime/workflow-agent-failure-causes.test.ts`). These
 * two are the second reachable path into a cause that matrix already owns, and each
 * pins something extra the host decides on its own: that a length-stopped turn is
 * REFUSED rather than returned truncated, and that a throw from inside the turn stays
 * unclassified rather than being read as a dropped channel.
 *
 * Kept out of `agent-sdk-host.test.ts` on purpose: that suite is at its size ceiling,
 * and these belong to the failure-cause family rather than to the host's session
 * lifecycle.
 */

describe("agent failure cause — shared SDK host", () => {
  it("refuses a provider-truncated assistant answer", async () => {
    agentLiveStore.reset();
    try {
      const result = await runHost({
        lastAssistantText: "This answer ends in the midd",
        messages: [{ role: "assistant", content: [], stopReason: "length" }],
      });

      expect(result.status).toBe("failed");
      expect(result.reason).toContain("output-token limit");
      expect(result.reason).toContain("refusing the truncated answer");
      expect(result.failureCause).toBe("provider-error");
      expect(result.text).toBeUndefined();
    } finally {
      agentLiveStore.reset();
    }
  });

  it("leaves an unproven mid-turn throw unclassified", async () => {
    const result = await runHost({ lastAssistantText: undefined, promptError: "kaboom inside the turn" });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("kaboom inside the turn");
    expect(result.failureCause).toBe("unclassified");
  });
});
