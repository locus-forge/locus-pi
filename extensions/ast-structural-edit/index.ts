import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import astEditTool from "./ast-edit.js";
import astGrepTool from "./ast-grep.js";
import resolveTool from "./resolve.js";

export default function astStructuralEdit(pi: ExtensionAPI): void {
  astGrepTool(pi);
  astEditTool(pi);
  resolveTool(pi);
}
