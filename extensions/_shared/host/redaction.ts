export interface RedactionResult {
  redacted: boolean;
  text: string;
}

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/sk-[A-Za-z0-9]{32,}/g, "[REDACTED:openai-key]"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, "[REDACTED:github-token]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws-key]"],
  [/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED:jwt]"],
  [/[a-z]+:\/\/[^:\s]+:[^@\s]+@/gi, "[REDACTED:connection-string]@"],
  [/(?:password|passwd|pwd|secret)\s*=\s*['\"][^'\"]+['\"]/gi, "$&" as unknown as string],
  [/((?:api[_-]?key|token|secret|auth)[A-Za-z0-9_\-]*\s*[:=]\s*)[A-Za-z0-9_\-]{32,}/gi, "$1[REDACTED:api-key]"],
  [/(--(?:token|password|secret|api-key)=)[^\s]+/gi, "$1[REDACTED:cli-secret]"],
];

export function redactSecrets(text: string): RedactionResult {
  let current = text;
  for (const [pattern, replacement] of PATTERNS) {
    if (replacement === "$&") {
      current = current.replace(pattern, (match) => `${match.split("=")[0] ?? "SECRET"}=[REDACTED:password]`);
    } else {
      current = current.replace(pattern, replacement);
    }
  }
  return { redacted: current !== text, text: current };
}

export function redactForSensitivity(
  text: string,
  sensitivity: "public" | "internal" | "secret" = "internal",
): RedactionResult {
  if (sensitivity === "secret") return { redacted: true, text: "[REDACTED:secret-answer]" };
  return redactSecrets(text);
}
