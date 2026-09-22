import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";
import { setOperatorStatus } from "../../../extensions/_shared/operator/operator-status.js";

export default function operatorStatusConsumer(pi: ExtensionAPI): void {
  pi.registerCommand("test-consume-operator-status", {
    handler: (_args, ctx) => {
      setOperatorStatus(
        ctx,
        {
          id: "goal.activity",
          lane: "activity",
          priority: 1,
          wide: "run: goal review",
          compact: "run: review",
          narrow: "run",
        },
        146,
      );
    },
  });
}
