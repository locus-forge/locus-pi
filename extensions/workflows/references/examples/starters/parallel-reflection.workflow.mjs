export const meta = {
  name: "parallel-reflection",
  description: "Combine parallel investigation with synthesis, critique and editorial revision",
  profile: "standard",
};

export default async function run({ agent, parallel, publishArtifact, publishPrimaryArtifact }, input) {
  const notes = await parallel([
    () =>
      agent(
        `Investigate the requested explanation's factual basis. Read the supplied sources, preserve evidence and uncertainty, and return complete findings. Do not modify sources. Request:\n${input}`,
        { label: "facts", title: "Investigate facts and evidence" },
      ),
    () =>
      agent(
        `Investigate the intended reader's questions, relevant examples and limitations using the supplied sources. Return complete findings; do not modify sources. Request:\n${input}`,
        { label: "reader", title: "Investigate reader needs and limitations" },
      ),
  ]);
  const draft = await agent(
    `Write a complete explanatory document from both investigations. Preserve disagreements, source evidence and uncertainty. Do not modify sources. ` +
      `Request:\n${input}\nComplete investigations, in declared order:\n${notes.join("\n\n")}`,
    { label: "synthesize", title: "Synthesize the investigations into a document" },
  );
  publishArtifact("draft.md", draft);
  const critique = await agent(
    `Critique the complete document against the request, sources and both investigations. Give actionable changes for unsupported claims, omissions and unclear explanations. ` +
      `Preserve disagreements; do not modify sources. This is editorial feedback, not independent product acceptance. ` +
      `Request:\n${input}\nComplete investigations:\n${notes.join("\n\n")}\nComplete draft:\n${draft}`,
    { label: "critique", title: "Critique the synthesis against both investigations" },
  );
  publishArtifact("critique.md", critique);
  const revised = await agent(
    `Return the complete revised document, applying critique where the sources support it. Preserve evidence, disagreements and uncertainty. Do not modify sources. ` +
      `Request:\n${input}\nComplete investigations:\n${notes.join("\n\n")}\nComplete draft:\n${draft}\nComplete critique:\n${critique}`,
    { label: "revise", title: "Revise the synthesis using the critique" },
  );
  return publishPrimaryArtifact("document.md", revised);
}
