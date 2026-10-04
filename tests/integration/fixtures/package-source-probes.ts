// Source fixtures exercised through the native checker in a real installed package.
export function installedStandardSource(run: string, declarations = ""): string {
  return [
    'export const meta = { name: "installed-probe", profile: "standard", description: "Installed probe." };',
    declarations,
    run,
  ]
    .filter(Boolean)
    .join("\n");
}

export const RETIRED_DSL_PROBES = [
  ...["outputDir", "publishPrimaryFile"].flatMap((method) => [
    {
      accepted: false,
      name: `retired-${method}-direct`,
      source: installedStandardSource(`export default function run(dsl) { return dsl.${method}("x.md"); }`),
    },
    {
      accepted: false,
      name: `retired-${method}-destructured`,
      source: installedStandardSource(`export default function run({ ${method} }) { return ${method}("x.md"); }`),
    },
  ]),
  ...["direct", "destructured"].map((form) => ({
    accepted: false,
    name: `retired-workflow-source-overload-${form}`,
    source: installedStandardSource(
      form === "direct"
        ? 'export default function run(dsl) { return dsl.publishPrimaryArtifact("workflow.mjs", { workflowSource: "source" }); }'
        : 'export default function run({ publishPrimaryArtifact }) { return publishPrimaryArtifact("workflow.mjs", { workflowSource: "source" }); }',
    ),
  })),
] as const;
