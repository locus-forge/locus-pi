import { describe, expect, it } from "vitest";
import { packagedWorkflowNames } from "../../../extensions/workflows/runtime/workflow-discovery.js";
import { publicCatalogs, workflowDocs } from "../helpers/package-contract.js";

describe("Package workflow catalog contract", () => {
  it("resolves exactly the workflow names the generated catalog publishes", () => {
    // The examples directory is the registry; `dist/public-catalogs.json` is its reviewed snapshot.
    // A workflow file added or removed without `npm run build:catalogs` fails here and in check:generated.
    expect(packagedWorkflowNames()).toEqual(publicCatalogs.workflows.map(({ name }) => name));
  });

  it("keeps a group-only namespace out of the runnable names and explained in the guide", () => {
    expect(publicCatalogs.workflows.map(({ name }) => name)).not.toContain("task");
    expect(publicCatalogs.workflows.filter(({ namespace }) => namespace === "task").length).toBeGreaterThan(0);
    expect(workflowDocs).toContain("`task` is a group-only namespace");
  });
});
