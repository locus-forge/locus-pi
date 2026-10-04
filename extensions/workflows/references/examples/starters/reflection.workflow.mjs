export const meta = {
  name: "reflection",
  description: "Draft, critique and revise a low-risk explanatory document",
  profile: "standard",
};

export default async function run({ agent, publishArtifact, publishPrimaryArtifact }, input) {
  const draft = await agent(
    `Create a complete explanatory document from the supplied sources. Read named sources with your tools; do not modify them. Preserve uncertainty and identify unsupported claims. Request:\n${input}`,
    { label: "draft", title: "Create the first complete document" },
  );
  publishArtifact("draft.md", draft);
  const critique = await agent(
    `Critique this document against the original request and sources. Identify concrete inaccuracies, unsupported claims, omissions and unclear explanations; give actionable changes. ` +
      `Do not modify the sources. This is editorial feedback, not independent product acceptance. Request:\n${input}\nComplete draft:\n${draft}`,
    { label: "critique", title: "Critique content against its sources" },
  );
  publishArtifact("critique.md", critique);
  const revised = await agent(
    `Write the complete revised document through ordinary tools at the exact final path assigned in the whole request; missing or ambiguous assignment is non-success without fallback. Return the complete revised document, applying critique where source evidence supports it. Preserve facts and explicit uncertainty; do not modify the sources. ` +
      `Request:\n${input}\nComplete draft:\n${draft}\nComplete critique:\n${critique}`,
    { label: "revise", title: "Revise the document using actionable critique" },
  );
  return publishPrimaryArtifact("document.md", revised);
}
