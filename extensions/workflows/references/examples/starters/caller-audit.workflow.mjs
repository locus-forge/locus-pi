export const meta = {
  name: "caller-audit",
  description: "Pipeline caller-owned source audits, then synthesize and review the complete account",
  profile: "standard",
};

export default async function run({ agent, items, pipeline, publishArtifact, publishPrimaryArtifact }, input) {
  const units = items();
  if (units.length === 0) return { ok: false, status: "incomplete", reason: "missing_caller_items" };
  const reports = await pipeline(
    units,
    (unit, inspectIndex) =>
      agent(
        `Inspect this caller-supplied source against the audit request. Return complete findings with evidence and the original unit's source location so the verifier can inspect it. ` +
          `Do not modify product files. Request:\n${input}\nComplete unit:\n${unit}`,
        { label: "inspect", title: `Inspect source at pipeline slot ${inspectIndex}`, result: "report" },
      ),
    (finding, verifyIndex) =>
      agent(
        `Verify this complete inspection report against the required caller sources and audit request. Preserve every finding and its disposition, and all failed, missing or skipped checks. ` +
          `A report without source identity remains an unassigned failure; inspect the original caller sources as needed without guessing from the pipeline slot. ` +
          `Disclose optional unavailable coverage; required missing evidence remains unmet. Do not modify product files. Request:\n${input}\nComplete required caller units:\n${units.join("\n\n")}\nComplete inspection report:\n${finding}`,
        { label: "verify", title: `Verify findings at pipeline slot ${verifyIndex}`, result: "report" },
      ),
  );
  const candidate = await agent(
    `Synthesize the complete audit account from these verified reports in caller order. Compare coverage with every original caller unit; retain unassigned failures, every finding's disposition, disagreements, required residuals and optional coverage limitations. ` +
      `Do not turn a failed or skipped check into success. Request:\n${input}\nComplete required caller units:\n${units.join("\n\n")}\nComplete reports:\n${reports.join("\n\n")}`,
    { label: "synthesize", title: "Synthesize the complete audit account" },
  );
  const evidence = publishArtifact("audit-candidate.md", candidate);
  const decision = await agent(
    `Check the candidate against the original audit request, every original caller unit, actual source evidence and all complete reports. Retain failures without source identity as unassigned. Replace findings.md in the workflow workspace with evidence, findings and the full check inventory. ` +
      `Choose accept only when required coverage and evidence are established; optional unavailability alone is disclosed without refusal. Choose incomplete for unmet required outcomes. ` +
      `Do not edit the candidate or product source. Request:\n${input}\nComplete required caller units:\n${units.join("\n\n")}\nComplete reports:\n${reports.join("\n\n")}\nComplete candidate:\n${candidate}`,
    { label: "review", title: "Check complete audit coverage", choice: ["accept", "incomplete"] },
  );
  if (decision === "incomplete")
    return { ok: false, status: "incomplete", evidence, candidate, findings: "findings.md" };
  return publishPrimaryArtifact("audit.md", candidate);
}
