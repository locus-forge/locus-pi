import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agents from "../../../../extensions/agents/index.js";
import {
  AGENT_CATALOG_HINT_MAX_DESCRIPTION_CHARS,
  AGENT_CATALOG_HINT_MAX_ENTRIES,
  discoverAgentDefinitions,
  formatAgentCatalogHint,
  type AgentDefinition,
  type AgentSource,
} from "../../../../extensions/_shared/agent-runtime/agents.js";
import { createHarness, emit } from "../../../test-harness.js";

// The catalog hint is a schema/description contract; no child session is spawned
// here, so the SDK host stays absent exactly as in agents-discovery.test.ts.
vi.mock("@earendil-works/pi-coding-agent", () => ({}));

const tempRoots: string[] = [];

beforeEach(() => {
  vi.stubEnv("HOME", tempRoot("locus-pi-hint-home"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = path.join(tmpdir(), `${prefix}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function writeAgent(root: string, fileName: string, name: string, description: string): void {
  const dir = path.join(root, ".agents", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), `---\nname: ${name}\ndescription: ${description}\ntools: read\n---\nBody.`);
}

function definition(name: string, description: string, source: AgentSource): AgentDefinition {
  return { name, description, allowedTools: ["read"], risk: "low", readOnly: true, source };
}

/** The injected description as the model receives it on both spawn tools. */
function injectedAgentDescription(parameters: unknown): string {
  const schema = parameters as { properties: { agent: { description?: string } } };
  return schema.properties.agent.description ?? "";
}

function catalogLines(description: string): string[] {
  const heading = description.indexOf("Available agents (name — description):");
  if (heading < 0) return [];
  return description
    .slice(heading)
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "");
}

describe("agent catalog hint formatting", () => {
  it("emits one name-description line per resolved agent", () => {
    const hint = formatAgentCatalogHint([
      definition("explore", "Fast read-only codebase scout", "user"),
      definition("task", "Full-tool worker", "user"),
    ]);

    expect(hint).toBe(["explore — Fast read-only codebase scout", "task — Full-tool worker"].join("\n"));
  });

  it("clamps each description to the per-entry cap", () => {
    const hint = formatAgentCatalogHint([definition("verbose", "x".repeat(400), "user")]);
    const [line = ""] = hint.split("\n");
    const description = line.slice("verbose — ".length);

    expect(description).toHaveLength(AGENT_CATALOG_HINT_MAX_DESCRIPTION_CHARS);
    expect(description.endsWith("...")).toBe(true);
  });

  it("caps the number of entries and states the overflow instead of hiding it", () => {
    const many = Array.from({ length: AGENT_CATALOG_HINT_MAX_ENTRIES + 5 }, (_unused, index) =>
      definition(`agent-${String(index).padStart(2, "0")}`, `Agent ${index}`, "user"),
    );

    const lines = formatAgentCatalogHint(many).split("\n");

    expect(lines).toHaveLength(AGENT_CATALOG_HINT_MAX_ENTRIES + 1);
    expect(lines.at(-1)).toBe("+5 more — /agent list");
    // The overflow drops the tail, never the head, so ordering decides visibility.
    expect(lines[0]).toBe("agent-00 — Agent 0");
  });

  it("orders project before user so a local agent is never the one dropped", () => {
    const hint = formatAgentCatalogHint(
      [
        definition("zeta", "User zeta", "user"),
        definition("alpha", "User alpha", "user"),
        definition("omega", "Project omega", "project"),
      ],
      { maxEntries: 2 },
    );

    expect(hint.split("\n")).toEqual(["omega — Project omega", "alpha — User alpha", "+1 more — /agent list"]);
  });

  it("reflects the resolved first-match-wins set, not raw discovery order", () => {
    const project = tempRoot("locus-pi-hint-project");
    const userHome = tempRoot("locus-pi-hint-user");
    writeAgent(project, "explore.md", "explore", "Project scout wins");
    writeAgent(userHome, "explore.md", "explore", "User scout loses");
    writeAgent(userHome, "task.md", "task", "User worker");

    const discovered = discoverAgentDefinitions(project, { userHome });
    const lines = formatAgentCatalogHint(discovered.definitions).split("\n");

    expect(lines).toEqual(["explore — Project scout wins", "task — User worker"]);
  });

  it("returns an empty hint when nothing is loaded", () => {
    expect(formatAgentCatalogHint([])).toBe("");
  });
});

describe("agent catalog hint injection", () => {
  it("publishes the bounded catalog on the agent parameter of both spawn tools", async () => {
    const project = tempRoot("locus-pi-hint-inject");
    vi.stubEnv("HOME", tempRoot("locus-pi-hint-home"));
    writeAgent(project, "shipper.md", "shipper", "Project release runner");
    // Multiple project agents exercise dynamic catalog injection.
    writeAgent(project, "zz-one.md", "zz-one", "Filler one");
    writeAgent(project, "zz-two.md", "zz-two", "Filler two");
    const h = createHarness(project);
    agents(h.pi);

    await emit(h, "before_agent_start", { systemPrompt: "BASE" });

    const description = injectedAgentDescription(h.tools.get("spawn_agent")!.parameters);
    expect(description).toContain("Optional project/user agent catalog name.");
    expect(description).toContain("Available agents (name — description):");
    expect(description).toContain("shipper — Project release runner");
    expect(h.tools.has("task")).toBe(false);

    const lines = catalogLines(description);
    const entries = lines.filter((line) => !line.startsWith("+"));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(AGENT_CATALOG_HINT_MAX_ENTRIES);
    for (const line of entries) {
      const [, text = ""] = line.split(" — ");
      expect(text.length).toBeLessThanOrEqual(AGENT_CATALOG_HINT_MAX_DESCRIPTION_CHARS);
    }
    expect(entries[0]).toBe("shipper — Project release runner");
  });

  it("refreshes the catalog per turn instead of capturing it at registration", async () => {
    const project = tempRoot("locus-pi-hint-refresh");
    vi.stubEnv("HOME", tempRoot("locus-pi-hint-refresh-home"));
    writeAgent(project, "first.md", "first", "First project agent");
    const h = createHarness(project);
    agents(h.pi);

    await emit(h, "before_agent_start", {});
    expect(injectedAgentDescription(h.tools.get("spawn_agent")!.parameters)).not.toContain("second —");

    writeAgent(project, "second.md", "second", "Added after registration");
    await emit(h, "before_agent_start", {});

    const description = injectedAgentDescription(h.tools.get("spawn_agent")!.parameters);
    expect(description).toContain("second — Added after registration");
    expect(description).toContain("first — First project agent");
  });
});
