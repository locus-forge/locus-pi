/** Explicit input admission and serialized identities; no filesystem, host or execution policy. */
import { createHash } from "node:crypto";
import {
  canonicalWorkflowJSON,
  immutableJSON,
  normalizeWorkflowStructuredContract,
  compileWorkflowSchema,
  validateWorkflowProposal,
  WORKFLOW_SCHEMA_DIALECT,
  type WorkflowJSONSchema,
} from "./structured-results/schema.js";

export type WorkflowInputValue =
  null | boolean | number | string | readonly WorkflowInputValue[] | { readonly [key: string]: WorkflowInputValue };
export interface WorkflowInputFields {
  input?: string;
  inputValue?: WorkflowInputValue;
}
export interface WorkflowTypedInputIdentity {
  kind: "json";
  dialect: typeof WORKFLOW_SCHEMA_DIALECT;
  valueSha256: string;
  schemaSha256: string;
}
export interface WorkflowOperatorContext {
  originRunId: string;
  operatorAnswer: string;
}
export interface WorkflowTypedInput {
  value: WorkflowInputValue;
  schema: WorkflowJSONSchema;
  identity: WorkflowTypedInputIdentity;
  operatorContext?: Readonly<WorkflowOperatorContext>;
}
export type WorkflowTypedInputProjection = WorkflowTypedInputIdentity & {
  operatorContext?: { originRunId: string; answerSha256: string };
};

/** Own-field presence matters. Detach before any callback, wait or caller mutation. */
export function snapshotWorkflowInput(fields: WorkflowInputFields): WorkflowInputFields {
  if (!Object.hasOwn(fields, "inputValue")) return fields.input === undefined ? {} : { input: fields.input };
  if (Object.hasOwn(fields, "input")) throw new Error("inputValue and input are mutually exclusive");
  const property = Object.getOwnPropertyDescriptor(fields, "inputValue")!;
  if (!("value" in property)) throw new Error("inputValue requires JSON data properties");
  try {
    return { inputValue: immutableJSON(property.value) };
  } catch (error) {
    throw new Error(`inputValue: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function prepareWorkflowTypedInput(
  fields: WorkflowInputFields,
  inputSchema: WorkflowJSONSchema | undefined,
  operatorContext?: Readonly<WorkflowOperatorContext>,
): Promise<WorkflowTypedInput | undefined> {
  const typed = Object.hasOwn(fields, "inputValue");
  if (!typed && inputSchema === undefined) return undefined;
  if (!typed || inputSchema === undefined)
    throw new Error("typed input requires explicit inputValue and meta.inputSchema");
  const value = immutableJSON(fields.inputValue);
  const contract = normalizeWorkflowStructuredContract(inputSchema);
  const schema = contract.schema;
  const invalid = validateWorkflowProposal(value, await compileWorkflowSchema(contract));
  if (invalid !== undefined) throw new Error(`typed input does not satisfy inputSchema: ${invalid}`);
  return Object.freeze({
    value,
    schema,
    identity: workflowTypedInputIdentity(value, schema),
    ...(operatorContext === undefined ? {} : { operatorContext: Object.freeze({ ...operatorContext }) }),
  });
}

/** Named v4/v2 protocol bytes. These digests never replace in-memory equality. */
export function workflowInputDigest(value: unknown): string {
  return createHash("sha256").update(canonicalWorkflowJSON(value)).digest("hex");
}
export function workflowTypedInputIdentity(value: unknown, schema: WorkflowJSONSchema): WorkflowTypedInputIdentity {
  return {
    kind: "json",
    dialect: WORKFLOW_SCHEMA_DIALECT,
    valueSha256: workflowInputDigest(value),
    schemaSha256: workflowInputDigest(schema),
  };
}
export function workflowTypedInputProjection(input: WorkflowTypedInput): WorkflowTypedInputProjection {
  return {
    ...input.identity,
    ...(input.operatorContext === undefined
      ? {}
      : {
          operatorContext: {
            originRunId: input.operatorContext.originRunId,
            answerSha256: workflowInputDigest(input.operatorContext.operatorAnswer),
          },
        }),
  };
}

/** Closed authority readback; async schema validation still occurs at admission. */
export function parseWorkflowTypedInput(value: unknown): WorkflowTypedInput {
  const record = immutableJSON(value) as unknown as WorkflowTypedInput;
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).some((key) => !["value", "schema", "identity", "operatorContext"].includes(key)) ||
    !Object.hasOwn(record, "value")
  )
    throw new Error("Invalid typed input authority");
  const schema = normalizeWorkflowStructuredContract(record.schema).schema;
  if (
    canonicalWorkflowJSON(record.identity) !== canonicalWorkflowJSON(workflowTypedInputIdentity(record.value, schema))
  )
    throw new Error("Invalid typed input identity");
  const context = record.operatorContext;
  if (
    context !== undefined &&
    (context === null ||
      typeof context !== "object" ||
      Array.isArray(context) ||
      Object.keys(context).length !== 2 ||
      typeof context.originRunId !== "string" ||
      typeof context.operatorAnswer !== "string")
  )
    throw new Error("Invalid typed operator context");
  return Object.freeze({ ...record, schema });
}
