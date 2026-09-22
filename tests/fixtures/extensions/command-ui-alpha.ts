import {
  pinTransientUiKey,
  registerCommandWithUiLifecycle,
  registerTransientUiCleanup,
  unpinTransientUiKey,
} from "../../../extensions/_shared/operator/command-ui.js";
import type { CommandArgs, ExtensionAPI } from "../../../extensions/_shared/host/pi-api.js";

const ALPHA_KEY = "fixture-alpha";
const ALPHA_CLEANUP_KEY = "fixture-alpha-cleanup";
const ALPHA_PERSISTENT_KEY = "fixture-alpha-route";

export default function commandUiAlpha(pi: ExtensionAPI): void {
  registerTransientUiCleanup(pi, ALPHA_KEY, (ctx) => {
    ctx.ui.setStatus(ALPHA_CLEANUP_KEY, "alpha owner cleanup ran");
  });

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "test-alpha-view",
      group: "test-alpha",
      surfaces: ["transient-widget", "status"],
      transientWidgets: [ALPHA_KEY],
      transientStatuses: [ALPHA_KEY],
      persistentStatuses: [ALPHA_PERSISTENT_KEY],
    },
    {
      handler: (args, ctx) => {
        const action = commandText(args);
        if (action === "unpin") {
          unpinTransientUiKey(pi, ALPHA_KEY);
          ctx.ui.setStatus(ALPHA_CLEANUP_KEY, undefined);
          return;
        }

        ctx.ui.setStatus(ALPHA_CLEANUP_KEY, undefined);
        if (action === "pin") pinTransientUiKey(pi, ALPHA_KEY);
        ctx.ui.setWidget(ALPHA_KEY, ["alpha view"]);
        ctx.ui.setStatus(ALPHA_KEY, "alpha transient status");
        ctx.ui.setStatus(ALPHA_PERSISTENT_KEY, "alpha persistent route");
      },
    },
  );
}

function commandText(args: CommandArgs): string {
  if (typeof args === "string") return args.trim();
  return args.text?.trim() ?? "";
}
