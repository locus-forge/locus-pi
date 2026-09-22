import { redactSecrets } from "./redaction.js";

/**
 * The package-wide bounds on text handed back to a model. They live in the host layer beside
 * the truncation that applies them: `maxBytes` and `maxLines` are this module's own defaults,
 * and `subagentSummaryBytes` is the same bound applied by `agent-runtime/agent-execution-prompt`
 * to a child's summary. A consumer at any layer may read them, which is why they may not sit
 * anywhere higher than `host`.
 */
export const OUTPUT_DEFAULTS = {
  maxBytes: 64 * 1024,
  maxLines: 2000,
  astMatches: 500,
  astMaxBytes: 50 * 1024,
  browserSnapshotBytes: 100 * 1024,
  subagentSummaryBytes: 16 * 1024,
} as const;

export interface TruncateResult {
  truncated: boolean;
  text: string;
}

export function truncateOutput(
  text: string,
  maxBytes: number = OUTPUT_DEFAULTS.maxBytes,
  maxLines: number = OUTPUT_DEFAULTS.maxLines,
): TruncateResult {
  const lines = text.split(/\r?\n/);
  let bounded =
    lines.length > maxLines
      ? `${lines.slice(0, maxLines).join("\n")}\n[TRUNCATED:lines ${lines.length - maxLines}]`
      : text;
  const bytes = Buffer.byteLength(bounded, "utf8");
  if (bytes <= maxBytes) return { truncated: bounded !== text, text: bounded };
  let end = Math.max(0, maxBytes - 64);
  while (Buffer.byteLength(bounded.slice(0, end), "utf8") > maxBytes - 64 && end > 0) end -= 32;
  bounded = `${bounded.slice(0, end)}\n[TRUNCATED:bytes ${bytes - end}]`;
  return { truncated: true, text: bounded };
}

export function safeToolText(
  text: string,
  maxBytes = OUTPUT_DEFAULTS.maxBytes,
): { text: string; truncated: boolean; redacted: boolean } {
  const redacted = redactSecrets(text);
  const truncated = truncateOutput(redacted.text, maxBytes);
  return { text: truncated.text, truncated: truncated.truncated, redacted: redacted.redacted };
}
