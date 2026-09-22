import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  AgentSessionViewer,
  createAgentViewerCapability,
  disposeAgentSessionViewers,
  hasActiveAgentSessionViewer,
} from "../../../extensions/agents/fleet/session-viewer.js";

/**
 * One of the two separately registered entrypoints behind
 * `tests/extensions/agents/fleet/session-viewer-entrypoints.test.ts`. Pi loads each entrypoint with the
 * module cache disabled, so this file holds its OWN instance of
 * `extensions/agents/fleet/session-viewer.ts`; every assertion in that test is about whether the two
 * instances resolve to one `locus-pi.active-agent-session-viewers.v1` set.
 */

const PRODUCER_ROW_ID = "session-viewer-producer-row";

/** The viewer this entrypoint opened, so a later command can ask whether a peer tore it down. */
let openedViewer: AgentSessionViewer | undefined;
/** True once the viewer's own `done` callback fires — only `#close()` calls it, never `dispose()`. */
let doneCalled = false;

function viewerCapability() {
  // No transcript block is ever fed to this viewer, so the native components are never
  // constructed; `createAgentViewerCapability` only requires that both are callable.
  const result = createAgentViewerCapability({
    AssistantMessageComponent: class {},
    ToolExecutionComponent: class {},
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

export default function sessionViewerProducer(pi: ExtensionAPI): void {
  pi.registerCommand("test-viewer-producer-open", {
    handler: (_args, ctx) => {
      const execution = agentLiveStore.beginExecution({
        id: PRODUCER_ROW_ID,
        agentName: "reviewer",
        label: "row from producer entrypoint",
      });
      openedViewer = new AgentSessionViewer(
        execution,
        { terminal: { rows: 6, columns: 40 }, requestRender: () => {} },
        () => {
          doneCalled = true;
        },
        viewerCapability(),
      );
      ctx.ui.setWidget("viewer-producer-open", [
        `has=${hasActiveAgentSessionViewer()}`,
        `rendered=${openedViewer.render(40).length}`,
      ]);
    },
  });

  pi.registerCommand("test-viewer-producer-observe", {
    handler: (_args, ctx) => {
      ctx.ui.setWidget("viewer-producer-observe", [
        `has=${hasActiveAgentSessionViewer()}`,
        // `render()` returns no lines once the component is disposed, so a non-empty render is
        // this entrypoint's own evidence that its viewer is still live, and an empty one is
        // evidence that the peer's dispose actually reached it.
        `rendered=${openedViewer?.render(40).length}`,
        `done=${doneCalled}`,
      ]);
    },
  });

  /**
   * The teardown `extensions/agents/index.ts:37` runs on session end, performed here by the
   * entrypoint that did NOT open the consumer's viewer. On one shared registry it disposes the
   * peer's viewer; on two copies it is a silent no-op and the peer keeps owning the terminal.
   */
  pi.registerCommand("test-viewer-producer-dispose", {
    handler: (_args, ctx) => {
      disposeAgentSessionViewers();
      ctx.ui.setWidget("viewer-producer-dispose", [`has=${hasActiveAgentSessionViewer()}`]);
    },
  });
}
