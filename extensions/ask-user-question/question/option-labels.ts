/**
 * extensions/ask-user-question/question/option-labels.ts — The option-label vocabulary.
 *
 * The sentinel choices ask appends to every option list, the checkbox markers
 * the select fallback draws with, and the transforms between a raw option label
 * and the label the operator sees — including which label a timeout answers
 * with when the operator never chose one.
 */

const RECOMMENDED_SUFFIX = " (Recommended)";
export const OTHER_OPTION = "Other (type your own)";
export const DONE_OPTION = "Done selecting";
export const CHECKED_PREFIX = "[x] ";
export const UNCHECKED_PREFIX = "[ ] ";

export function addRecommendedSuffix(labels: string[], recommendedIndex?: number): string[] {
  if (recommendedIndex === undefined || recommendedIndex < 0 || recommendedIndex >= labels.length) return labels;
  return labels.map((label, index) =>
    index === recommendedIndex && !label.endsWith(RECOMMENDED_SUFFIX) ? `${label}${RECOMMENDED_SUFFIX}` : label,
  );
}

export function stripRecommendedSuffix(label: string): string {
  return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

export function stripCheckboxPrefix(label: string): string | undefined {
  if (label.startsWith(CHECKED_PREFIX)) return label.slice(CHECKED_PREFIX.length);
  if (label.startsWith(UNCHECKED_PREFIX)) return label.slice(UNCHECKED_PREFIX.length);
  return undefined;
}

export function getAutoSelectionOnTimeout(optionLabels: string[], recommended?: number): string[] {
  if (optionLabels.length === 0) return [];
  if (typeof recommended === "number" && recommended >= 0 && recommended < optionLabels.length)
    return [optionLabels[recommended]!];
  return [optionLabels[0]!];
}
