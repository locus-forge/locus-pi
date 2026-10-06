/** Public Responses wire projection and raw message evidence; acceptance stays in return.ts. */
import {
  canonicalWorkflowJSON,
  immutableJSON,
  workflowStructuredSchemaDigest,
  type WorkflowJSONSchema,
} from "./schema.js";
import type {
  AgentNativeRoute,
  AgentNativeMessage,
} from "../../../_shared/agent-runtime/output-acceptance/agent-output-contract.js";

export const WORKFLOW_NATIVE_WIRE_REVISION = "openai-responses-native-v1" as const;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export function nativeWorkflowRoute(model: unknown): AgentNativeRoute {
  const { provider, api, baseUrl, id } = record(model) ?? {};
  if (
    provider !== "openai" ||
    api !== "openai-responses" ||
    baseUrl !== "https://api.openai.com/v1" ||
    typeof id !== "string" ||
    !["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"].includes(id)
  )
    throw new Error("output-contract-unavailable: native requires a known model on the public OpenAI Responses route");
  return Object.freeze({
    provider: "openai",
    api: "openai-responses",
    baseUrl,
    model: id,
  });
}
import { sameAgentNativeRoute as sameNativeWorkflowRoute } from "../../../_shared/agent-runtime/output-acceptance/agent-output-contract.js";
export { sameAgentNativeRoute as sameNativeWorkflowRoute } from "../../../_shared/agent-runtime/output-acceptance/agent-output-contract.js";

/** Qualify fresh non-secret registry visibility without resolving host-managed authentication. */
export function nativeWorkflowReplayRoute(model: unknown, registry: unknown): AgentNativeRoute {
  const route = nativeWorkflowRoute(model);
  const current = registry as
    | {
        getRegisteredProviderConfig?: (
          provider: string,
        ) => { api?: unknown; baseUrl?: unknown; streamSimple?: unknown } | undefined;
        getRegisteredNativeProvider?: (provider: string) => unknown;
      }
    | undefined;
  if (
    typeof current?.getRegisteredProviderConfig !== "function" ||
    typeof current.getRegisteredNativeProvider !== "function"
  )
    throw new Error("replay-contract-failure: current native routing readback unavailable");
  const override = current.getRegisteredProviderConfig("openai");
  if (
    current.getRegisteredNativeProvider("openai") !== undefined ||
    typeof override?.streamSimple === "function" ||
    (override?.api !== undefined && override.api !== route.api) ||
    (override?.baseUrl !== undefined && override.baseUrl !== route.baseUrl)
  )
    throw new Error("replay-contract-failure: current native routing is opaque or changed");
  return route;
}

/** Refuse incompatible accepted sets rather than translate them into a different schema. */
export function projectNativeWorkflowSchema(schema: WorkflowJSONSchema): WorkflowJSONSchema {
  let properties = 1,
    characters = "value".length,
    enums = 0;
  const unsupported = (path: string, why: string): never => {
    throw new Error(`native unsupported-schema at ${path}: ${why}`);
  };
  function project(node: WorkflowJSONSchema, depth: number, path: string): WorkflowJSONSchema {
    if (depth > 10) unsupported(path, "provider nesting limit includes the value wrapper");
    if (node.type === "null") unsupported(path, "native null is not qualified in this slice");
    if (node.type === "string" && (Object.hasOwn(node, "minLength") || Object.hasOwn(node, "maxLength")))
      unsupported(path, "canonical grapheme length bounds have no exact native projection");
    const result = { ...node };
    delete result.$schema;
    if (Array.isArray(node.enum)) {
      enums += node.enum.length;
      let enumCharacters = 0;
      for (const value of node.enum) {
        const compatible =
          node.type === "integer" ? typeof value === "number" && Number.isInteger(value) : typeof value === node.type;
        if (value === null || !compatible) unsupported(path, "enum must match its non-null scalar type");
        if (typeof value === "string") enumCharacters += value.length;
      }
      characters += enumCharacters;
      if (node.enum.length > 250 && enumCharacters > 15000) unsupported(path, "provider string enum limit exceeded");
    }
    if (node.type === "object") {
      const children = (node.properties ?? {}) as Record<string, WorkflowJSONSchema>;
      const keys = Object.keys(children);
      if (
        node.additionalProperties !== false ||
        !Array.isArray(node.required) ||
        node.required.length !== keys.length ||
        keys.some((key) => !(node.required as string[]).includes(key))
      )
        unsupported(path, "every object must be closed and require every declared property");
      properties += keys.length;
      characters += keys.reduce((total, key) => total + key.length, 0);
      result.properties = Object.fromEntries(
        Object.entries(children).map(([key, child]) => [
          key,
          project(child, depth + (child.type === "object" || child.type === "array" ? 1 : 0), `${path}.${key}`),
        ]),
      );
    }
    if (node.type === "array") {
      if (!record(node.items)) unsupported(path, "array items must have a schema");
      const items = node.items as WorkflowJSONSchema;
      result.items = project(items, depth + (items.type === "object" || items.type === "array" ? 1 : 0), `${path}[]`);
    }
    return result;
  }
  const value = project(schema, schema.type === "object" || schema.type === "array" ? 2 : 1, "$.value");
  if (properties > 5000 || characters > 120000 || enums > 1000)
    unsupported("$", "provider property, string or total enum limit exceeded");
  return immutableJSON({
    type: "object",
    properties: { value },
    required: ["value"],
    additionalProperties: false,
  }) as WorkflowJSONSchema;
}

export function nativeWorkflowMessage(item: unknown): AgentNativeMessage {
  const message = record(item);
  if (
    message?.type !== "message" ||
    message.role !== "assistant" ||
    message.status !== "completed" ||
    typeof message.id !== "string" ||
    message.id === "" ||
    !Array.isArray(message.content) ||
    message.content.length !== 1
  )
    throw new Error("output-protocol-unknown: native requires one completed assistant message");
  const part = record(message.content[0]);
  if (part?.type === "refusal") throw new Error("output-refused: provider refused native output");
  if (part?.type !== "output_text" || typeof part.text !== "string")
    throw new Error("output-protocol-unknown: native requires one complete raw output_text part");
  if (Object.hasOwn(message, "phase") && message.phase !== null && typeof message.phase !== "string")
    throw new Error("output-protocol-unknown: invalid native message phase");
  return Object.freeze({
    messageId: message.id,
    text: part.text,
    ...(Object.hasOwn(message, "phase") ? { phase: message.phase as string | null } : {}),
  });
}

/** SDK signatures drop explicit null. Preserve raw phase before AgentSession writes message_end. */
export function preserveNativeWorkflowPhase(
  event: unknown,
  messages: ReadonlyMap<string, AgentNativeMessage>,
  responseId: string,
): string[] {
  const data = record(event);
  const message = record(data?.message);
  if (data?.type !== "message_end" || message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  if (message.responseId !== responseId) throw new Error("Native session message response identity changed");
  const preserved: string[] = [];
  for (const part of message.content) {
    const text = record(part);
    if (text?.type !== "text" || typeof text.textSignature !== "string") continue;
    let signature: Record<string, unknown> | undefined;
    try {
      signature = record(JSON.parse(text.textSignature));
    } catch {
      continue;
    }
    const observed = typeof signature?.id === "string" ? messages.get(signature.id) : undefined;
    if (observed === undefined || signature?.v !== 1 || text.text !== observed.text) continue;
    if (Object.hasOwn(observed, "phase")) signature.phase = observed.phase;
    else delete signature.phase;
    text.textSignature = JSON.stringify(signature);
    preserved.push(observed.messageId);
  }
  return preserved;
}

/** The actual SDK decoder also drops null from the next request; restore only matched raw history. */
export function preserveNativeWorkflowPayloadPhase(
  payload: Record<string, unknown>,
  messages: ReadonlyMap<string, AgentNativeMessage>,
): void {
  if (!Array.isArray(payload.input)) return;
  payload.input = payload.input.map((entry) => {
    const item = record(entry);
    if (item?.type !== "message" || item.role !== "assistant" || typeof item.id !== "string") return entry;
    const observed = messages.get(item.id);
    if (observed === undefined) return entry;
    const content = Array.isArray(item.content) && item.content.length === 1 ? record(item.content[0]) : undefined;
    if (content?.type !== "output_text" || content.text !== observed.text)
      throw new Error("output-protocol-unknown: native outgoing history differs from original raw text");
    const projected = { ...item };
    if (Object.hasOwn(observed, "phase")) projected.phase = observed.phase;
    else delete projected.phase;
    return projected;
  });
}

/** Keep inherited payload policy visible. This callback executes immediately before the real request. */
export function formatNativeWorkflowPayload(
  payload: unknown,
  model: unknown,
  schema: WorkflowJSONSchema,
  correction: boolean,
  messages: ReadonlyMap<string, AgentNativeMessage>,
): { payload: unknown; route: AgentNativeRoute } {
  const route = nativeWorkflowRoute(model);
  let data: Record<string, unknown> | undefined;
  try {
    data = record(immutableJSON(payload, { omitUndefinedObjectFields: true }));
  } catch {
    throw new Error("output-contract-unavailable: native payload requires stable JSON data properties");
  }
  const text = record(data?.text);
  if (
    data === undefined ||
    data.model !== route.model ||
    data.stream !== true ||
    (data.text !== undefined && text === undefined) ||
    (text?.format !== undefined && record(text.format)?.type !== "text")
  )
    throw new Error("output-contract-unavailable: incompatible native payload model, stream or prior text format");
  const projected = {
    ...data,
    text: {
      ...text,
      format: {
        type: "json_schema",
        name: "locus_workflow_result",
        schema,
        strict: true,
      },
    },
    ...(correction ? { tool_choice: "none" } : {}),
  };
  preserveNativeWorkflowPayloadPhase(projected, messages);
  return { payload: immutableJSON(projected), route };
}

import { sameAgentNativeMessage as sameNativeWorkflowMessage } from "../../../_shared/agent-runtime/output-acceptance/agent-output-contract.js";
export { sameAgentNativeMessage as sameNativeWorkflowMessage } from "../../../_shared/agent-runtime/output-acceptance/agent-output-contract.js";

/** Owns raw Responses identity/phase and its SDK projection, never candidate validation or quotas. */
export class NativeWorkflowResponse {
  readonly wireSchema: WorkflowJSONSchema;
  readonly messages = new Map<string, AgentNativeMessage>();
  readonly responses = new Map<string, string>();
  readonly added = new Map<string, { responseId: string; phase?: unknown }>();
  readonly completedText = new Map<string, string>();
  readonly preserved = new Set<string>();
  readonly workCalls = new Map<
    string,
    { responseId: string; callId: string; name: string; arguments?: string; done?: boolean }
  >();
  readonly terminals = new Map<string, string>();
  routeSnapshot: AgentNativeRoute | undefined;
  wireSchemaSha256 = "";
  constructor(schema: WorkflowJSONSchema) {
    this.wireSchema = projectNativeWorkflowSchema(schema);
  }
  async initialize(): Promise<void> {
    if (this.wireSchemaSha256 !== "") return;
    this.wireSchemaSha256 = await workflowStructuredSchemaDigest(this.wireSchema);
  }
  route(model: unknown): void {
    const route = nativeWorkflowRoute(model);
    if (this.routeSnapshot !== undefined && !sameNativeWorkflowRoute(this.routeSnapshot, route))
      throw new Error("output-contract-unavailable: native effective route changed");
    this.routeSnapshot ??= route;
  }
  payload(value: unknown, model: unknown, correction: boolean) {
    this.route(model);
    const formatted = formatNativeWorkflowPayload(value, model, this.wireSchema, correction, this.messages);
    return {
      value: formatted.payload,
      observation: {
        wireRevision: WORKFLOW_NATIVE_WIRE_REVISION,
        wireSchemaSha256: this.wireSchemaSha256,
        route: formatted.route,
      },
    };
  }
  observe(item: unknown, responseId: string): void {
    const message = nativeWorkflowMessage(item);
    if (this.responses.has(message.messageId) && this.responses.get(message.messageId) !== responseId)
      throw new Error("Native message identity reused across responses");
    const initial = this.added.get(message.messageId);
    if (
      initial === undefined ||
      initial.responseId !== responseId ||
      (Object.hasOwn(initial, "phase") && initial.phase !== message.phase) ||
      (this.completedText.has(message.messageId) && this.completedText.get(message.messageId) !== message.text)
    )
      throw new Error("Native finalized message differs from observed item/text identity");
    const prior = this.messages.get(message.messageId);
    if (prior !== undefined && !sameNativeWorkflowMessage(prior, message))
      throw new Error("Conflicting native message identity");
    this.responses.set(message.messageId, responseId);
    this.messages.set(message.messageId, message);
  }
  capture(
    event: Record<string, unknown>,
    responseId: string,
  ): { reason: string; failureCause: "output-refused" | "output-protocol-unknown" } | undefined {
    const item = record(event.item);
    try {
      if (item?.type === "custom_tool_call") throw new Error("Unsupported native custom tool evidence");
      if (
        item?.type === "function_call" &&
        (event.type === "response.output_item.added" || event.type === "response.output_item.done")
      ) {
        if (
          typeof item.id !== "string" ||
          typeof item.call_id !== "string" ||
          typeof item.name !== "string" ||
          item.id === "" ||
          item.call_id === "" ||
          responseId === ""
        )
          throw new Error("Native work item lacks identity");
        const prior = this.workCalls.get(item.id);
        if (this.terminals.has(responseId)) throw new Error("Native work item frame appeared after terminal");
        if (
          (prior !== undefined &&
            (event.type === "response.output_item.added" ||
              prior.responseId !== responseId ||
              prior.callId !== item.call_id ||
              prior.name !== item.name)) ||
          [...this.workCalls].some(([id, call]) => id !== item.id && call.callId === item.call_id)
        )
          throw new Error("Native work item identity changed");
        if (event.type === "response.output_item.added")
          this.workCalls.set(item.id, prior ?? { responseId, callId: item.call_id, name: item.name });
        else {
          if (
            prior === undefined ||
            prior.done === true ||
            typeof item.arguments !== "string" ||
            (prior.arguments !== undefined && prior.arguments !== item.arguments)
          )
            throw new Error("Native work arguments changed or lack added item");
          prior.arguments = item.arguments;
          prior.done = true;
        }
      }
      if (event.type === "response.function_call_arguments.done") {
        const call = typeof event.item_id === "string" ? this.workCalls.get(event.item_id) : undefined;
        if (
          call === undefined ||
          call.responseId !== responseId ||
          typeof event.arguments !== "string" ||
          (call.arguments !== undefined && call.arguments !== event.arguments)
        )
          throw new Error("Native finalized work arguments unavailable or conflicting");
        call.arguments = event.arguments;
      }
      const response = record(event.response);
      if (event.type === "response.completed" || event.type === "response.done") {
        if (response?.id !== responseId || response.status !== "completed" || !Array.isArray(response.output))
          throw new Error("Native terminal identity unavailable");
        const serialized = canonicalWorkflowJSON(response.output);
        if (this.terminals.has(responseId) && this.terminals.get(responseId) !== serialized)
          throw new Error("Conflicting duplicate native terminal output");
        const seen = new Set<string>();
        for (const entry of response.output) {
          const terminal = record(entry);
          if (terminal?.type === "function_call") {
            const call = typeof terminal.id === "string" ? this.workCalls.get(terminal.id) : undefined;
            if (
              call === undefined ||
              seen.has(terminal.id as string) ||
              call.responseId !== responseId ||
              call.arguments === undefined ||
              call.callId !== terminal.call_id ||
              call.name !== terminal.name ||
              call.arguments !== terminal.arguments
            )
              throw new Error("Native terminal work call lacks matching finalized evidence");
            seen.add(terminal.id as string);
          }
        }
        if ([...this.workCalls].some(([id, call]) => call.responseId === responseId && !seen.has(id)))
          throw new Error("Native terminal omitted observed work evidence");
        this.terminals.set(responseId, serialized);
      }
      if (item?.type === "message") {
        if (responseId === "" || typeof item.id !== "string" || item.id === "")
          throw new Error("Native message lacks created response identity");
        if (event.type === "response.output_item.added") {
          const prior = this.added.get(item.id);
          const next = { responseId, ...(Object.hasOwn(item, "phase") ? { phase: item.phase } : {}) };
          if (
            prior !== undefined &&
            (prior.responseId !== responseId ||
              Object.hasOwn(prior, "phase") !== Object.hasOwn(next, "phase") ||
              prior.phase !== next.phase)
          )
            throw new Error("Native added message identity changed");
          this.added.set(item.id, next);
        }
        if (event.type === "response.output_item.done") this.observe(item, responseId);
      }
      if (event.type === "response.output_text.done") {
        if (
          typeof event.item_id !== "string" ||
          typeof event.text !== "string" ||
          this.added.get(event.item_id)?.responseId !== responseId ||
          (this.completedText.has(event.item_id) && this.completedText.get(event.item_id) !== event.text) ||
          (this.messages.has(event.item_id) && this.messages.get(event.item_id)!.text !== event.text)
        )
          throw new Error("Native finalized text identity changed");
        this.completedText.set(event.item_id, event.text);
      }
    } catch (error) {
      return {
        reason: String(error),
        failureCause:
          Array.isArray(item?.content) && item.content.some((part) => record(part)?.type === "refusal")
            ? "output-refused"
            : "output-protocol-unknown",
      };
    }
    return undefined;
  }
  final(output: unknown): AgentNativeMessage | undefined {
    if (
      Array.isArray(output) &&
      output.some((entry) => !["message", "reasoning", "function_call"].includes(String(record(entry)?.type)))
    )
      throw new Error("Unsupported native terminal output item");
    const messages = Array.isArray(output) ? output.filter((entry) => record(entry)?.type === "message") : [];
    if (messages.length === 0) return undefined;
    if (messages.length !== 1) throw new Error("Native output has multiple assistant messages");
    const message = nativeWorkflowMessage(messages[0]);
    if (Object.hasOwn(message, "phase") && message.phase !== null && message.phase !== "final_answer")
      throw new Error("Native output is not a final answer");
    const prior = this.messages.get(message.messageId);
    if (prior === undefined || !sameNativeWorkflowMessage(prior, message))
      throw new Error("Native terminal differs from finalized raw message");
    return message;
  }
  assertHistory(): void {
    if ([...this.messages.keys()].some((id) => !this.preserved.has(id)))
      throw new Error("Native history phase preservation unavailable");
  }

  /** Inherited finish hooks run after persistence; their actual live projections must still match raw evidence. */
  finish(context: unknown, responseId: string): void {
    this.assertHistory();
    const turn = record(context),
      message = record(turn?.message),
      history = record(turn?.context)?.messages;
    if (message?.responseId !== responseId || !Array.isArray(history) || !Array.isArray(turn?.newMessages))
      throw new Error("Native completed-turn history unavailable");
    const verify = (entry: unknown): void => {
      const sdk = record(entry);
      const ids = [...this.responses].filter(([, response]) => response === sdk?.responseId).map(([id]) => id);
      if (ids.length === 0) return;
      const texts = Array.isArray(sdk?.content) ? sdk.content.filter((part) => record(part)?.type === "text") : [];
      if (sdk?.role !== "assistant" || texts.length !== ids.length)
        throw new Error("Native completed-turn content differs from raw history");
      for (const part of texts) {
        const text = record(part)!;
        const signature = typeof text.textSignature === "string" ? record(JSON.parse(text.textSignature)) : undefined;
        const raw = typeof signature?.id === "string" ? this.messages.get(signature.id) : undefined;
        if (
          signature?.v !== 1 ||
          raw === undefined ||
          !ids.includes(raw.messageId) ||
          text.text !== raw.text ||
          Object.hasOwn(signature, "phase") !== Object.hasOwn(raw, "phase") ||
          signature.phase !== raw.phase
        )
          throw new Error("Native completed-turn text or phase differs from raw history");
      }
    };
    verify(message);
    for (const entries of [history, turn.newMessages]) {
      entries.forEach(verify);
      const required = entries === history ? new Set(this.responses.values()) : new Set([responseId]);
      for (const response of required) {
        if (
          [...this.responses.values()].includes(response) &&
          entries.filter((entry) => record(entry)?.responseId === response).length !== 1
        )
          throw new Error("Native completed-turn projection lost or duplicated raw history");
      }
    }
  }

  sessionEvent(event: unknown, responseId: string): void {
    for (const id of preserveNativeWorkflowPhase(event, this.messages, responseId)) this.preserved.add(id);
  }
}
