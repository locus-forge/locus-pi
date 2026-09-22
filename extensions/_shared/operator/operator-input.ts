import type { ExtensionContext } from "../host/pi-api.js";

export type OperatorInputResult =
  { status: "submitted"; value: string } | { status: "cancelled" } | { status: "unavailable"; reason: "no-ui" };

export type OperatorInputSpec =
  { kind: "input"; title: string; placeholder?: string } | { kind: "editor"; title: string; prefill?: string };

interface LegacyDialogResult {
  value: string;
  cancelled?: boolean;
}

type HostDialogResult = string | undefined | LegacyDialogResult;
type HostInput = (title: string, placeholder?: string) => Promise<HostDialogResult>;
type HostEditor = (title: string, prefill?: string) => Promise<HostDialogResult>;

/**
 * Call Pi's official free-text dialog signatures and project their result into
 * one local contract. The object-result branch is retained only for older
 * partial hosts and the repository test harness.
 */
export async function requestOperatorInput(
  ctx: ExtensionContext,
  spec: OperatorInputSpec,
): Promise<OperatorInputResult> {
  if (ctx.mode !== "tui" || ctx.hasUI === false) {
    return { status: "unavailable", reason: "no-ui" };
  }

  const raw =
    spec.kind === "input"
      ? await (ctx.ui.input as unknown as HostInput)(spec.title, spec.placeholder)
      : await (ctx.ui.editor as unknown as HostEditor)(spec.title, spec.prefill);

  return normalizeHostDialogResult(raw);
}

function normalizeHostDialogResult(raw: HostDialogResult): OperatorInputResult {
  if (raw === undefined) return { status: "cancelled" };
  if (typeof raw === "string") return { status: "submitted", value: raw };
  if (!isLegacyDialogResult(raw)) {
    throw new TypeError("Unsupported Pi dialog result; expected string, undefined, or { value, cancelled }");
  }
  if (raw.cancelled === true) return { status: "cancelled" };
  return { status: "submitted", value: raw.value };
}

function isLegacyDialogResult(value: unknown): value is LegacyDialogResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { value?: unknown; cancelled?: unknown };
  return (
    typeof candidate.value === "string" &&
    (candidate.cancelled === undefined || typeof candidate.cancelled === "boolean")
  );
}
