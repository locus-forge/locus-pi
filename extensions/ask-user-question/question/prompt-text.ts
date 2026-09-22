/**
 * extensions/ask-user-question/question/prompt-text.ts — Operator-facing text shapes.
 *
 * The one-line collapse every ask dialog title needs, and the two titles built
 * from it. Pure string work: no question model, no Pi handle.
 */

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function singleLine(text: string): string {
  return text.split(/\r?\n/).join(" ").trim();
}

export function selectTitle(question: string): string {
  return `[SELECT] Ask — ${singleLine(question)}`;
}

export function inputTitle(question: string): string {
  return `[INPUT] Ask — ${singleLine(question)}`;
}
