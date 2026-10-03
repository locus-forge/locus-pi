export const meta = {
  name: "project-tour",
  description: "Read a project and explain where to start.",
  profile: "standard",
};

export default async function run({ agent, parallel, publishPrimaryArtifact }) {
  const notes = await parallel([
    () =>
      agent("Read README.md for the project purpose. Do not modify files.", {
        label: "purpose",
        title: "Read project purpose",
      }),
    () =>
      agent("Read package.json for development commands. Do not modify files.", {
        label: "commands",
        title: "Read development commands",
      }),
  ]);
  const guide = await agent(
    `Combine these complete notes into a getting-started guide. Preserve uncertainty; do not modify files.\n${notes.join("\n\n")}`,
    { label: "compose", title: "Write getting-started guide" },
  );
  return publishPrimaryArtifact("guide.md", guide);
}
