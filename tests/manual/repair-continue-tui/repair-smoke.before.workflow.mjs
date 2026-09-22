export const meta = { name: "repair-smoke", description: "Repair and continue smoke", profile: "standard" };
export default async function run(dsl, input) {
  await dsl.agent(`Reply with exactly one word and nothing else: INVENTORY-OK. Goal: ${input}`, { label: "inventory" });
  throw new Error("repair-smoke: the review stage is unimplemented on purpose");
}
