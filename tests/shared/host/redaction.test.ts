import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../extensions/_shared/host/redaction.js";
import { OUTPUT_DEFAULTS, truncateOutput } from "../../../extensions/_shared/host/safe-output.js";

describe("redaction and truncation", () => {
  it("preserves legacy redaction and truncation coverage", () => {
    expect(redactSecrets("token=abcdefghijklmnopqrstuvwxyz1234567890SECRET").text).toContain("[REDACTED:api-key]");
    const truncated = truncateOutput("x".repeat(100), 20, 20);
    expect(truncated.truncated).toBe(true);
  });

  /**
   * The bounds themselves, applied through the call that OMITS them.
   *
   * Every other truncation test passes explicit limits, so the defaults were never
   * exercised at all: a default silently stopping being applied would have shipped
   * green. These two cases drive the line bound and the byte bound separately, each
   * just past its declared edge with the other bound slack, so exactly one rule can
   * fire per case.
   *
   * What they pin is that each default is APPLIED, not what its value is -- both read
   * the constant rather than a literal, so changing 2000 or 64 KiB keeps them green.
   * That is deliberate: a test asserting the numbers would be a change-detector for a
   * tuning knob, while wiring that stops honouring a default is a real defect. If a
   * specific bound ever becomes a contract someone depends on, pin it where that
   * contract lives, not here.
   */
  it("applies its declared line default when no line limit is passed", () => {
    // One line past the bound, and well inside the byte bound so only the line rule can fire.
    const oneLineOver = `${"y\n".repeat(OUTPUT_DEFAULTS.maxLines)}y`;
    expect(Buffer.byteLength(oneLineOver, "utf8")).toBeLessThan(OUTPUT_DEFAULTS.maxBytes);

    const truncated = truncateOutput(oneLineOver);

    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toContain("[TRUNCATED:lines 1]");
    expect(truncateOutput("y\n".repeat(OUTPUT_DEFAULTS.maxLines - 1)).truncated).toBe(false);
  });

  it("applies its declared byte default when no byte limit is passed", () => {
    // One byte past the bound on a single line, so only the byte rule can fire.
    const truncated = truncateOutput("z".repeat(OUTPUT_DEFAULTS.maxBytes + 1));

    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toContain("[TRUNCATED:bytes");
    expect(Buffer.byteLength(truncated.text, "utf8")).toBeLessThanOrEqual(OUTPUT_DEFAULTS.maxBytes);
    expect(truncateOutput("z".repeat(OUTPUT_DEFAULTS.maxBytes - 1)).truncated).toBe(false);
  });
});
