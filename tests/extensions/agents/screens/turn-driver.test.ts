import { expect, it, vi } from "vitest";
import { driveChildTurn } from "../../../../extensions/_shared/agent-runtime/session/turn-driver.js";
import type { SdkAgentSessionLike } from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import type { AgentLiveExecutionHandle } from "../../../../extensions/_shared/agent-runtime/agent-live-store.js";

it("never dispatches an already-cancelled turn", async () => {
  const prompt = vi.fn();
  const session = { prompt } as unknown as SdkAgentSessionLike;
  const controller = new AbortController();
  controller.abort();
  expect(
    await driveChildTurn(
      session,
      "must not run",
      controller.signal,
      undefined,
      undefined,
      {} as AgentLiveExecutionHandle,
    ),
  ).toMatchObject({ settlement: "aborted", promptAccepted: false });
  expect(prompt).not.toHaveBeenCalled();
});
