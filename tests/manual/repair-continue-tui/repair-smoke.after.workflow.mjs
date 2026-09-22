export const meta = { name: "repair-smoke", description: "Repair and continue smoke", profile: "standard" };
export default async function run(dsl, input) {
  const inventory = await dsl.agent(`Reply with exactly one word and nothing else: INVENTORY-OK. Goal: ${input}`, {
    label: "inventory",
  });
  const findings = await dsl.agent(
    `Name one short finding about this inventory: ${inventory}. One line, no preamble.`,
    {
      label: "review",
      returnVia: "tool",
      handoffs: { minItems: 1, maxItems: 2 },
    },
  );
  const report = await dsl.agent(`Reply with exactly one word and nothing else: REPORT-OK. Findings: ${findings}`, {
    label: "report",
  });
  return dsl.publishPrimaryArtifact("report.md", `${inventory}\n${findings}\n${report}\n`);
}
