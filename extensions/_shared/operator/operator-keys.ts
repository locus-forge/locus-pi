/**
 * extensions/_shared/operator/operator-keys.ts — The raw terminal key vocabulary shared
 * by every operator-facing TUI component.
 *
 * Pi hands a component the raw input bytes, so each component has to decide for
 * itself what "the operator pressed Down" means: an ANSI cursor sequence, its
 * application-mode variant, or the vi-style letter. Three surfaces had grown
 * byte-identical private copies of that decision — `operator-question.ts`,
 * `extensions/ask-user-question/question/question-panel.ts`, and
 * `extensions/model/model-role-selector.ts` — which meant the answer to "which
 * keys move the selection" lived in three places and could drift in two of them
 * unnoticed.
 *
 * Every predicate here is the exact expression those copies used; this module
 * introduces no new key binding. Components that accept named keys in addition
 * to raw bytes (`"up"`, `"escape"`, as `extensions/agents/fleet/session-viewer.ts`
 * does) deliberately keep their own predicates — that is a different input
 * contract, not a duplicate of this one.
 */

export function isEnter(data: string): boolean {
  return data === "\r" || data === "\n";
}

export function isSpace(data: string): boolean {
  return data === " ";
}

export function isEscape(data: string): boolean {
  return data === "\x1b";
}

export function isCtrlC(data: string): boolean {
  return data === "\x03";
}

export function isUp(data: string): boolean {
  return data === "\x1b[A" || data === "\x1bOA" || data === "k";
}

export function isDown(data: string): boolean {
  return data === "\x1b[B" || data === "\x1bOB" || data === "j";
}

export function isLeft(data: string): boolean {
  return data === "\x1b[D" || data === "\x1bOD" || data === "h";
}

export function isRight(data: string): boolean {
  return data === "\x1b[C" || data === "\x1bOC" || data === "l";
}

export function isHome(data: string): boolean {
  return data === "\x1b[H" || data === "\x1bOH" || data === "g";
}

export function isEnd(data: string): boolean {
  return data === "\x1b[F" || data === "\x1bOF" || data === "G";
}

export function isPageUp(data: string): boolean {
  return data === "\x1b[5~";
}

export function isPageDown(data: string): boolean {
  return data === "\x1b[6~";
}
