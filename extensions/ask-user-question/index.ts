/**
 * extensions/ask-user-question/index.ts — Extension entrypoint.
 *
 * Registers the canonical `ask` tool (./ask-tool.js). The question flow, the prompt surfaces
 * that collect an answer, and every string they render live in submodules;
 * this file owns nothing but the registration.
 */

import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { registerAskTools } from "./tool/ask-tool.js";

export default function ask(pi: ExtensionAPI): void {
  registerAskTools(pi);
}
