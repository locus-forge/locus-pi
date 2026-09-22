import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";
import { setOperatorStatus } from "../../../extensions/_shared/operator/operator-status.js";

export default function operatorStatusProducer(pi: ExtensionAPI): void {
  pi.registerCommand("test-produce-operator-status", {
    handler: (_args, ctx) => {
      setOperatorStatus(
        ctx,
        {
          id: "workflow.route",
          lane: "route",
          priority: 10,
          wide: "route: plan-build-review",
          compact: "route: plan-build",
          narrow: "route",
        },
        146,
      );
    },
  });
}
