/**
 * source/workflow-source-diagnostics.ts — the identity of one workflow source
 * diagnostic and the order a set of them is reported in.
 *
 * A diagnostic is addressed by severity, code, message and span, and two
 * findings with the same address are the same finding however many checks
 * produced them. That identity decides both the deduplication inside a bag and
 * the total order the checker publishes, so both live here rather than being
 * restated by each check.
 *
 * This module owns no rule. It never decides whether a source is acceptable and
 * knows nothing about the standard grammar, DSL methods, bindings or
 * provenance: callers hand it a message and an ast-grep node, and it answers
 * with a stable record and a stable order.
 */
import type { SgNode } from "@ast-grep/napi";

export type WorkflowSourceDiagnosticSeverity = "error" | "warning";

export interface WorkflowSourceSpan {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface WorkflowSourceDiagnosticRelated extends WorkflowSourceSpan {
  message: string;
}

export const WORKFLOW_SOURCE_DIAGNOSTIC_CODES = {
  agentLabelDuplicate: "WF_AGENT_LABEL_DUPLICATE",
  agentLabelMissing: "WF_AGENT_LABEL_MISSING",
  authoringSubset: "WF_AUTHORING_SUBSET",
  binding: "WF_BINDING",
  call: "WF_CALL",
  dataFlow: "WF_DATA_FLOW",
  expression: "WF_EXPRESSION",
  identifier: "WF_IDENTIFIER",
  import: "WF_IMPORT",
  metaProfile: "WF_META_PROFILE",
  phaseCaseMismatch: "WF_PHASE_CASE_MISMATCH",
  phaseDuplicateDeclaration: "WF_PHASE_DUPLICATE_DECLARATION",
  phaseOrderDrift: "WF_PHASE_ORDER_DRIFT",
  phaseUndeclared: "WF_PHASE_UNDECLARED",
  phaseUnusedDeclaration: "WF_PHASE_UNUSED_DECLARATION",
  policy: "WF_POLICY",
  runExport: "WF_RUN_EXPORT",
  sourceParse: "WF_SOURCE_PARSE",
  statement: "WF_STATEMENT",
  topLevel: "WF_TOP_LEVEL",
} as const;

export type WorkflowSourceDiagnosticCode =
  (typeof WORKFLOW_SOURCE_DIAGNOSTIC_CODES)[keyof typeof WORKFLOW_SOURCE_DIAGNOSTIC_CODES];

export interface WorkflowSourceDiagnostic extends WorkflowSourceSpan {
  code: WorkflowSourceDiagnosticCode;
  severity: WorkflowSourceDiagnosticSeverity;
  message: string;
  related?: readonly WorkflowSourceDiagnosticRelated[];
}

export interface WorkflowSourceDiagnosticRelatedNode {
  message: string;
  node: SgNode;
}

export interface WorkflowSourceDiagnosticSink {
  add(
    message: string,
    node?: SgNode,
    code?: WorkflowSourceDiagnosticCode,
    severity?: WorkflowSourceDiagnosticSeverity,
    related?: readonly WorkflowSourceDiagnosticRelatedNode[],
  ): void;
}

export class WorkflowSourceDiagnosticBag {
  readonly #diagnostics: WorkflowSourceDiagnostic[] = [];
  readonly #keys = new Set<string>();

  sink(defaultCode: WorkflowSourceDiagnosticCode, fallbackNode?: SgNode): WorkflowSourceDiagnosticSink {
    return {
      add: (message, node = fallbackNode, code = defaultCode, severity = "error", related) => {
        this.add(code, severity, message, node, related);
      },
    };
  }

  add(
    code: WorkflowSourceDiagnosticCode,
    severity: WorkflowSourceDiagnosticSeverity,
    message: string,
    node?: SgNode,
    related?: readonly WorkflowSourceDiagnosticRelatedNode[],
  ): void {
    const span = workflowSourceSpan(node);
    const normalizedRelated = related?.map((item) => ({ message: item.message, ...workflowSourceSpan(item.node) }));
    const diagnostic: WorkflowSourceDiagnostic = {
      code,
      severity,
      message,
      ...span,
      ...(normalizedRelated !== undefined && normalizedRelated.length > 0 ? { related: normalizedRelated } : {}),
    };
    const key = workflowSourceDiagnosticIdentity(diagnostic);
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    this.#diagnostics.push(diagnostic);
  }

  values(): WorkflowSourceDiagnostic[] {
    return [...this.#diagnostics].sort(
      (left, right) =>
        left.line - right.line ||
        left.column - right.column ||
        left.endLine - right.endLine ||
        left.endColumn - right.endColumn ||
        severityRank(left.severity) - severityRank(right.severity) ||
        compareCodeUnits(left.code, right.code) ||
        compareCodeUnits(left.message, right.message) ||
        compareCodeUnits(workflowSourceRelatedIdentity(left.related), workflowSourceRelatedIdentity(right.related)),
    );
  }
}

function workflowSourceSpan(node: SgNode | undefined): WorkflowSourceSpan {
  if (node === undefined) return { line: 1, column: 1, endLine: 1, endColumn: 1 };
  const range = node.range();
  return {
    line: range.start.line + 1,
    column: range.start.column + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.column + 1,
  };
}

function severityRank(severity: WorkflowSourceDiagnosticSeverity): number {
  return severity === "error" ? 0 : 1;
}

function workflowSourceDiagnosticIdentity(diagnostic: WorkflowSourceDiagnostic): string {
  return JSON.stringify([
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
    diagnostic.line,
    diagnostic.column,
    diagnostic.endLine,
    diagnostic.endColumn,
    workflowSourceRelatedIdentity(diagnostic.related),
  ]);
}

function workflowSourceRelatedIdentity(related: readonly WorkflowSourceDiagnosticRelated[] | undefined): string {
  return JSON.stringify(
    related?.map(({ message, line, column, endLine, endColumn }) => [message, line, column, endLine, endColumn]) ?? [],
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The published order for diagnostics merged from two passes: position first,
 * then severity, code and message. Related locations do not participate — the
 * merge only ever joins findings that already differ by code.
 */
export function sortMergedWorkflowSourceDiagnostics(
  diagnostics: readonly WorkflowSourceDiagnostic[],
): WorkflowSourceDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.endLine - right.endLine ||
      left.endColumn - right.endColumn ||
      severityRank(left.severity) - severityRank(right.severity) ||
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(left.message, right.message),
  );
}
