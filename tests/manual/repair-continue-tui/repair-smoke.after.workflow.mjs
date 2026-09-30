export const meta = { name: "repair-smoke", description: "Repair and continue smoke", profile: "standard" };
export default async function run(dsl, input) {
  const inventory = await dsl.agent(`Reply with exactly one word and nothing else: INVENTORY-OK. Goal: ${input}`, {
    label: "inventory",
  });
  const review = await dsl.agent(`Decide whether this inventory reply is clean or has a finding: ${inventory}`, {
    label: "review",
    choice: ["clean", "finding"],
  });
  const report = await dsl.agent(`Reply with exactly one word and nothing else: REPORT-OK. Review: ${review}`, {
    label: "report",
  });
  return dsl.publishPrimaryArtifact("report.md", `${inventory}\n${review}\n${report}\n`);
}
