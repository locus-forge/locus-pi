export const meta = { name: "fixed", description: "One declared worker; no semantic retry", profile: "standard" };

export default async function runWorkflow(dsl, input) {
  const result = await dsl.agent(`Complete this fixed scope and return the exact output:\n${input}`, {
    label: "worker",
  });
  return dsl.publishPrimaryArtifact("result.md", result);
}
