export const meta = {
  name: "project-tour",
  description: "Read a project and explain where to start.",
  profile: "standard",
};

export default async function run({ agent, parallel }, input) {
  const notes = await parallel([
    () =>
      agent(`Read README.md for the project purpose. Do not modify files.\nWhole caller input:\n${input}`, {
        label: "purpose",
        title: "Read project purpose",
      }),
    () =>
      agent(`Read package.json for development commands. Do not modify files.\nWhole caller input:\n${input}`, {
        label: "commands",
        title: "Read development commands",
      }),
  ]);
  const guide = await agent(
    `Combine notes into a guide; preserve uncertainty. Write only the exact guide.md path assigned in input using tools; missing/ambiguous path means failure, never guess.
Return the complete guide too. Whole input:\n${input}\nComplete notes:\n${notes.join("\n\n")}`,
    { label: "compose", title: "Write getting-started guide" },
  );
  return guide;
}
