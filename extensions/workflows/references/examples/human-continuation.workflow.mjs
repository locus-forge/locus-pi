// Reviewed compatibility example: reading a verified host artifact is not the standard opaque-text profile.
// awaitOperator declares a terminal disposition; it does not suspend this JavaScript function.
export const meta = { name: "human-continuation", description: "Two runs joined by an explicit operator handoff" };

export default async function runWorkflow(dsl, input) {
  const previous = dsl.continuationArtifacts();
  if (previous.length === 0) {
    const proposal = await dsl.agent(
      `Prepare a proposal and a precise question requiring the operator's decision:\n${input}`,
      { label: "prepare" },
    );
    const handoff = dsl.publishArtifact("handoff.md", `Original goal:\n${input}\nProposal and evidence:\n${proposal}`);
    dsl.awaitOperator({
      reason: "The next stage needs an operator decision",
      operatorHandoff: {
        title: "Authorize continuation",
        questions: [{ kind: "text", id: "decision", prompt: "Which decision authorizes the next stage?" }],
        continuationArtifactRefs: [handoff],
      },
    });
    return handoff;
  }
  const result = await dsl.agent(
    `Continue from this verified state:\n${previous[0].consumedArtifact.text}\nOperator answer:\n${input}`,
    { label: "continue" },
  );
  return dsl.publishPrimaryArtifact("result.md", result);
}
