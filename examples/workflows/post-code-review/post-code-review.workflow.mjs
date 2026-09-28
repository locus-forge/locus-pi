export const meta = {
  name: "post-code-review",
  description: "Run modular code-shape review lanes and publish the code-shape decision.",
  profile: "standard",
  phases: [
    { title: "scope" },
    { title: "audit-barrier" },
    { title: "necessity" },
    { title: "synthesis" },
    { title: "publish" },
  ],
};

export default async function runWorkflow(dsl, input) {
  const keys = ["scope", "boundaries", "simplicity", "contracts", "style", "necessity", "synthesis"];

  dsl.phase("scope");
  await dsl.invokeWorkflow({
    child: "scope",
    input,
    keys,
    key: "scope",
  });

  dsl.phase("audit-barrier");
  await dsl.parallel([
    () =>
      dsl.invokeWorkflow({
        child: "boundaries",
        input,
        keys,
        key: "boundaries",
      }),
    () =>
      dsl.invokeWorkflow({
        child: "simplicity",
        input,
        keys,
        key: "simplicity",
      }),
    () =>
      dsl.invokeWorkflow({
        child: "contracts",
        input,
        keys,
        key: "contracts",
      }),
    () =>
      dsl.invokeWorkflow({
        child: "style",
        input,
        keys,
        key: "style",
      }),
  ]);

  dsl.phase("necessity");
  await dsl.invokeWorkflow({
    child: "necessity",
    input,
    keys,
    key: "necessity",
  });

  dsl.phase("synthesis");
  await dsl.invokeWorkflow({
    child: "synthesis",
    input,
    keys,
    key: "synthesis",
  });

  dsl.phase("publish");
  return dsl.publishPrimaryFile("post-code-review.md");
}
