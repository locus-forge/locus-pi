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
  const outputDir = dsl.outputDir();

  dsl.phase("scope");
  await dsl.invokeWorkflow({
    child: "scope",
    input,
    keys,
    key: "scope",
    outputDir,
  });

  dsl.phase("audit-barrier");
  await dsl.parallel([
    () =>
      dsl.invokeWorkflow({
        child: "boundaries",
        input,
        keys,
        key: "boundaries",
        outputDir,
      }),
    () =>
      dsl.invokeWorkflow({
        child: "simplicity",
        input,
        keys,
        key: "simplicity",
        outputDir,
      }),
    () =>
      dsl.invokeWorkflow({
        child: "contracts",
        input,
        keys,
        key: "contracts",
        outputDir,
      }),
    () =>
      dsl.invokeWorkflow({
        child: "style",
        input,
        keys,
        key: "style",
        outputDir,
      }),
  ]);

  dsl.phase("necessity");
  await dsl.invokeWorkflow({
    child: "necessity",
    input,
    keys,
    key: "necessity",
    outputDir,
  });

  dsl.phase("synthesis");
  await dsl.invokeWorkflow({
    child: "synthesis",
    input,
    keys,
    key: "synthesis",
    outputDir,
  });

  dsl.phase("publish");
  return dsl.publishPrimaryFile("post-code-review.md");
}
