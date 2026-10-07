/** Closed native workflow-tool schema; execution policy remains in workflow-tool.ts. */

import { Type } from "@sinclair/typebox";
import {
  WORKFLOW_ARTIFACT_DISPLAY_NAME_PATTERN,
  WORKFLOW_LEGACY_PLANS_STORAGE_PREFIX,
  WORKFLOW_SAFE_COMPONENT_PATTERN,
  WORKFLOW_WORKSPACES_STORAGE_PREFIX,
} from "../runtime/workflow-run-layout.js";
import { WORKFLOW_AGENT_MAX_TURNS } from "../runtime/workflow-budget.js";
import { WORKFLOW_SAVED_NAME_MAX_CHARS, WORKFLOW_SAVED_NAME_PATTERN } from "../runtime/workflow-saved-name.js";
import { WORKFLOW_RUN_NAME_MAX_CHARS, WORKFLOW_RUN_NAME_PATTERN } from "../runtime/workflow-output.js";

const WorkflowBudgetParams = Type.Object(
  {
    concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    totalAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    runtimeMs: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    // A long explicit deadline runs as a chain of representable waits; the
    // number representation is the only schema-level ceiling.
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    toolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    turns: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKFLOW_AGENT_MAX_TURNS })),
  },
  { additionalProperties: false },
);

const WorkflowArtifactRefParams = Type.Object(
  {
    runId: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
    artifactId: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
    // `artifactId` is the storage id; `name` is the exact published display label.
    name: Type.String({
      description: "Published artifact display label, exactly as the origin run recorded it",
      pattern: WORKFLOW_ARTIFACT_DISPLAY_NAME_PATTERN,
    }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

const WorkflowContinuationParams = Type.Object(
  {
    originRunId: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
    // Carry every artifact the origin published; identity and same-origin checks
    // remain runtime-owned rather than imposing an arbitrary schema cap.
    artifactRefs: Type.Array(WorkflowArtifactRefParams, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const WorkflowParams = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        description:
          "Exact saved workflow ref: <workflow> or <workflow>/<child>, 1-200 characters total, interior whitespace allowed, with no edge whitespace, backslash, control characters, or .mjs suffix",
        maxLength: WORKFLOW_SAVED_NAME_MAX_CHARS,
        pattern: WORKFLOW_SAVED_NAME_PATTERN,
      }),
    ),
    // Filesystem confinement owns path limits; no aggregate character cap.
    scriptPath: Type.Optional(
      Type.String({
        description: "Project-relative .mjs workflow script path",
      }),
    ),
    script: Type.Optional(
      Type.String({
        description: "Legacy compatibility alias for name or project-relative scriptPath",
      }),
    ),
    input: Type.Optional(
      Type.String({
        description: "Optional human semantic request passed unchanged to runWorkflow(dsl, input).",
      }),
    ),
    inputValue: Type.Optional(
      Type.Unknown({
        description:
          "Explicit finite JSON input, mutually exclusive with input; requires the target's static meta.inputSchema.",
      }),
    ),
    items: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Optional exact text work units exposed unchanged and in order through dsl.items(); empty strings and duplicates are preserved.",
      }),
    ),
    workspaceDir: Type.Optional(
      Type.String({
        description: `Optional workflow workspace path. Fresh workflows default to unique ${WORKFLOW_WORKSPACES_STORAGE_PREFIX}<generated-run-name> workspaces; resume repeats the source workspace. Existing legacy ${WORKFLOW_LEGACY_PLANS_STORAGE_PREFIX}<name> paths are accepted only when already present. A task artifacts directory such as .tasks/<task>/artifacts is a legal explicit workspace. Absolute paths must stay inside the project; ./ paths resolve from the agent working directory; other relative paths resolve from the project root. User-file destinations belong in agent prompts and never change cwd.`,
      }),
    ),
    runName: Type.Optional(
      Type.String({
        maxLength: WORKFLOW_RUN_NAME_MAX_CHARS,
        pattern: WORKFLOW_RUN_NAME_PATTERN,
        description: `Optional short workflow run name. The runtime expands new names to ${WORKFLOW_WORKSPACES_STORAGE_PREFIX}<runName> and reuses an existing legacy-only ${WORKFLOW_LEGACY_PLANS_STORAGE_PREFIX}<runName>. Mutually exclusive with workspaceDir.`,
      }),
    ),
    continuation: Type.Optional(WorkflowContinuationParams),
    budget: Type.Optional(WorkflowBudgetParams),
    recoverInterrupted: Type.Optional(
      Type.Boolean({
        description:
          "Explicit recovery of a confirmed serial prefix after hard crash; requires resumeFromRunId and identical source/inputs.",
      }),
    ),
    force: Type.Optional(
      Type.Boolean({
        description:
          "Reclaim a leaked workspace/output lease only when the matching run has a complete, internally consistent terminal result envelope. Active, unverifiable, partial, or ambiguous owners remain blocked.",
      }),
    ),
    resumeFromRunId: Type.Optional(
      Type.String({
        description: "Optional prior workflow run id used as persisted retry metadata",
        pattern: WORKFLOW_SAFE_COMPONENT_PATTERN,
      }),
    ),
    noOperator: Type.Optional(
      Type.Boolean({
        description:
          "Run-level no-operator mode for unattended launches: any request for operator input " +
          "(dsl.awaitOperator or an agent({ ask: true }) stage) fails closed with a named reason " +
          "instead of pausing the run. Saved children inherit the mode and cannot unset it. " +
          "Defaults to true in a headless (print/json) host, where no operator can be reached; " +
          "pass false there to keep the designed awaitOperator split-run pause.",
      }),
    ),
  },
  { additionalProperties: false },
);
