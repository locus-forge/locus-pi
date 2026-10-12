import { describe, expect, it } from "vitest";
import { parseRunCommand } from "../../../../extensions/workflows/command/command-parser.js";

describe("typed slash input uses JSON syntax rather than shell quoting", () => {
  it.each([
    '{"mode":"compact","context":"  exact text  "}',
    '  { "mode": "compact", "context": "  exact text  " }  ',
    '\n{\n"mode": "compact",\n"context": "  exact text  "\n}\n',
  ])("parses the whole raw JSON tail with surrounding whitespace: %s", (tail) => {
    expect(parseRunCommand(`run typed --input-json ${tail}`)).toEqual({
      scriptRef: "typed",
      inputValue: { mode: "compact", context: "  exact text  " },
    });
  });

  it.each(['\'{"mode":"compact"}\'', "'\"a JSON string\"'"])(
    "rejects literal outer single quotes instead of stripping shell syntax: %s",
    (tail) => {
      expect(parseRunCommand(`run typed --input-json ${tail}`)).toEqual({
        scriptRef: "typed",
        inputJSONError: "--input-json requires one complete JSON value as the entire remaining tail",
      });
    },
  );

  it("preserves a valid JSON string as a string for later schema admission", () => {
    const value = '{"mode":"compact"}';
    expect(parseRunCommand(`run typed --input-json ${JSON.stringify(value)}`)).toEqual({
      scriptRef: "typed",
      inputValue: value,
    });
  });
});
