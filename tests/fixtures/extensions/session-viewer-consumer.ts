import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-live-store.js";
import {
  AgentSessionViewer,
  createAgentViewerCapability,
  disposeAgentSessionViewers,
  hasActiveAgentSessionViewer,
} from "../../../extensions/agents/fleet/session-viewer.js";

/**
 * The peer entrypoint of `session-viewer-producer.ts`, holding its own module instance of
 * `extensions/agents/fleet/session-viewer.ts`. Its `test-viewer-consumer-*` commands read and then tear
 * down a viewer the OTHER entrypoint opened, which is only possible when both instances resolve
 * to one `locus-pi.active-agent-session-viewers.v1` set.
 */

const CONSUMER_ROW_ID = "session-viewer-consumer-row";

let openedViewer: AgentSessionViewer | undefined;
let doneCalled = false;

function viewerCapability() {
  const result = createAgentViewerCapability({
    AssistantMessageComponent: class {},
    ToolExecutionComponent: class {},
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

export default function sessionViewerConsumer(pi: ExtensionAPI): void {
  /**
   * `extensions/agents/fleet/interrupt-guard.ts:30` reads exactly this predicate to decide whether to
   * swallow an interrupt while a full-screen viewer owns Escape. Reading `true` here, from an
   * entrypoint that has opened nothing, is the guard invariant.
   */
  pi.registerCommand("test-viewer-consumer-observe", {
    handler: (_args, ctx) => {
      ctx.ui.setWidget("viewer-consumer-observe", [`has=${hasActiveAgentSessionViewer()}`]);
    },
  });

  pi.registerCommand("test-viewer-consumer-dispose", {
    handler: (_args, ctx) => {
      disposeAgentSessionViewers();
      ctx.ui.setWidget("viewer-consumer-dispose", [`has=${hasActiveAgentSessionViewer()}`]);
    },
  });

  pi.registerCommand("test-viewer-consumer-open", {
    handler: (_args, ctx) => {
      const execution = agentLiveStore.beginExecution({
        id: CONSUMER_ROW_ID,
        agentName: "explore",
        label: "row from consumer entrypoint",
      });
      openedViewer = new AgentSessionViewer(
        execution,
        { terminal: { rows: 6, columns: 40 }, requestRender: () => {} },
        () => {
          doneCalled = true;
        },
        viewerCapability(),
      );
      ctx.ui.setWidget("viewer-consumer-open", [
        `has=${hasActiveAgentSessionViewer()}`,
        `rendered=${openedViewer.render(40).length}`,
      ]);
    },
  });

  pi.registerCommand("test-viewer-consumer-observe-own", {
    handler: (_args, ctx) => {
      ctx.ui.setWidget("viewer-consumer-observe-own", [
        `has=${hasActiveAgentSessionViewer()}`,
        `rendered=${openedViewer?.render(40).length}`,
        `done=${doneCalled}`,
      ]);
    },
  });
}
