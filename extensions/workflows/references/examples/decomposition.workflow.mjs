export const meta = {
  name: "decomposition",
  description: "Caller-owned independent work units run in parallel and combined in order",
  profile: "standard",
};

export default async function runWorkflow(dsl, input) {
  // The caller owns the work units: launch with one complete brief per item. A model
  // answer never decides how many workers start, so discovery belongs to an earlier
  // run or stage that writes a named file the operator turns into items.
  const units = dsl.items();
  if (units.length === 0)
    return { ok: false, status: "blocked", summary: "Supply one complete independent work unit per item." };
  const results = await dsl.parallel(
    units.map(
      (unit) => async () =>
        dsl.agent(`Perform only this work unit for the goal below.\nGoal:\n${input}\nWork unit:\n${unit}`, {
          label: "unit-worker",
        }),
    ),
    {
      concurrency: 2,
      title: "Independent caller-supplied units",
    },
  );
  const result = await dsl.agent(
    `Combine the ordered results without silently dropping unresolved work.\nGoal:\n${input}\nResults:\n${results.join("\n\n")}`,
    { label: "combine" },
  );
  return dsl.publishPrimaryArtifact("result.md", result);
}
