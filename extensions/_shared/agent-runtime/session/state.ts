export interface AgentSessionDisplay {
  cwd?: string;
  task?: string;
  model?: string;
  thinking?: string;
  contextTokens?: number | null;
  contextWindow?: number;
  contextPercent?: number | null;
}
/** Execution-keyed state: reusing a workflow row ID cannot cancel an older execution. */
export class AgentSessionState<Execution extends object> {
  readonly #lifetimes = new Map<Execution, () => Promise<void>>();
  readonly #closing = new Map<Execution, Promise<void>>();
  #conversations = new WeakMap<
    Execution,
    { read: () => readonly unknown[]; current?: unknown; display: () => AgentSessionDisplay }
  >();

  registerLifetime(execution: Execution, exit: () => Promise<void>): () => void {
    this.#lifetimes.set(execution, exit);
    return () => {
      if (this.#lifetimes.get(execution) === exit) this.#lifetimes.delete(execution);
    };
  }
  exit(execution: Execution): Promise<void> {
    const closing = this.#closing.get(execution);
    if (closing !== undefined) return closing;
    const exit = this.#lifetimes.get(execution);
    this.#lifetimes.delete(execution);
    const pending = Promise.resolve()
      .then(() => exit?.())
      .finally(() => {
        this.#conversations.delete(execution);
        this.#closing.delete(execution);
      });
    this.#closing.set(execution, pending);
    return pending;
  }
  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [...new Set([...this.#lifetimes.keys(), ...this.#closing.keys()])].map((execution) => this.exit(execution)),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Agent shutdown failed",
      );
  }
  registerConversation(
    execution: Execution,
    read: () => readonly unknown[],
    display: () => AgentSessionDisplay = () => ({}),
  ): void {
    this.#conversations.set(execution, { read, display });
  }
  display(execution: Execution): AgentSessionDisplay {
    return this.#conversations.get(execution)?.display() ?? {};
  }
  feed(execution: Execution, event: unknown): void {
    const entry = this.#conversations.get(execution);
    if (entry && record(event) && ["message_start", "message_update", "message_end"].includes(String(event.type)))
      entry.current = event.message;
  }
  conversation(execution: Execution): readonly unknown[] | undefined {
    const entry = this.#conversations.get(execution);
    if (entry === undefined) return undefined;
    const messages = [...entry.read()];
    const current = entry.current;
    if (record(current)) {
      const last = messages.at(-1);
      if (
        last === current ||
        (record(last) &&
          last.role === current.role &&
          current.timestamp !== undefined &&
          last.timestamp === current.timestamp)
      )
        messages[messages.length - 1] = current;
      else messages.push(current);
    }
    return messages;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
