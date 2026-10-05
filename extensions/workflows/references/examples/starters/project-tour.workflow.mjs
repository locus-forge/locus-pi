export const meta = {
  name: "project-tour",
  description: "Read a project and explain where to start.",
  profile: "standard",
};

export default async function run({ agent, parallel }, input) {
  const context = `Use the verified working context and exact file assignments below.
Missing or ambiguous paths are blockers; never guess or write native runtime files.`;
  const notes = await parallel([
    () =>
      agent(
        `${context}\nWhole caller input:\n${input}\nRead README.md; write only assigned purpose.md. Return a short status and exact path.`,
        {
          label: "purpose",
          title: "Read project purpose",
        },
      ),
    () =>
      agent(
        `${context}\nWhole caller input:\n${input}\nRead package.json; write only assigned commands.md. Return a short status and exact path.`,
        {
          label: "commands",
          title: "Read development commands",
        },
      ),
  ]);
  return agent(
    `${context}\nWhole caller input:\n${input}\nBoth readers finished. Reopen assigned purpose.md and commands.md, preserving uncertainty.
You alone merge them into assigned guide.md; read it back. Missing reports are blockers, never reconstruct
reports from these short statuses. Return only a short status and guide path. Reader statuses:\n${notes.join("\n\n")}`,
    { label: "compose", title: "Write getting-started guide" },
  );
}
