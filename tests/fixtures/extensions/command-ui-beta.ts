import { registerCommandWithUiLifecycle } from "../../../extensions/_shared/operator/command-ui.js";
import type { ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";

const BETA_KEY = "fixture-beta";

export default function commandUiBeta(pi: ExtensionAPI): void {
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "test-beta-view",
      group: "test-beta",
      surfaces: ["transient-widget", "status"],
      transientWidgets: [BETA_KEY],
      transientStatuses: [BETA_KEY],
    },
    {
      handler: (_args, ctx) => {
        ctx.ui.setWidget(BETA_KEY, ["beta view"]);
        ctx.ui.setStatus(BETA_KEY, "beta transient status");
      },
    },
  );
}
