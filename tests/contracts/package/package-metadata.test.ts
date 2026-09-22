import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extensionIdFromEntrypoint, pkg, publicCatalogs, root } from "../helpers/package-contract.js";

describe("package metadata contract", () => {
  it("activates exactly the extensions the generated catalog publishes", () => {
    // The catalog is generated from this same list, so a divergence means the artifact was not
    // regenerated after an entrypoint moved. `npm run build:catalogs` is the fix.
    expect(pkg.pi.extensions.map(extensionIdFromEntrypoint)).toEqual(publicCatalogs.extensions.map(({ id }) => id));
    expect(pkg.files.some((file) => file.startsWith("extensions/beta/"))).toBe(false);
  });

  it("binds the MIT package to the clean repository identity", () => {
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
      name: string;
      packages: { "": { name: string } };
    };

    expect(pkg.name).toBe("@locus-forge/locus-pi");
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toBe("git+https://github.com/locus-forge/locus-pi.git");
    expect(pkg.homepage).toBe("https://github.com/locus-forge/locus-pi#readme");
    expect(pkg.bugs.url).toBe("https://github.com/locus-forge/locus-pi/issues");
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[""].name).toBe(pkg.name);
  });
});
