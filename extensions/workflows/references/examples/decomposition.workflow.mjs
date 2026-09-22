export const meta = {
  name: "decomposition",
  description: "Bounded discovery followed by ordered independent work",
  profile: "standard",
};

export default async function runWorkflow(dsl, input) {
  const units = await dsl.agent(
    `Discover independent complete work handoffs for this goal; no more than four units:\n${input}`,
    {
      label: "discover",
      // A real consumer contract, and the prompt says the same thing in words: this
      // workflow fans the units out and combines them, so zero units has nothing to
      // combine and a fifth unit has no worker. The bound is on the COUNT of work
      // units, never on how long one unit may be — a complete brief is accepted at
      // whatever length it needs.
      handoffs: { minItems: 1, maxItems: 4 },
    },
  );
  const results = await dsl.parallel(
    units.map((unit) => async () => dsl.agent(`Perform only this work unit:\n${unit}`, { label: "unit-worker" })),
    {
      concurrency: 2,
      title: "Independent discovered units",
    },
  );
  const result = await dsl.agent(
    `Combine the ordered results without silently dropping unresolved work.\nGoal:\n${input}\nResults:\n${results.join("\n\n")}`,
    { label: "combine" },
  );
  return dsl.publishPrimaryArtifact("result.md", result);
}
