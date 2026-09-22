import { describe, expect, it } from "vitest";
import { coerceTheme, resolveRenderProfile } from "../../../extensions/_shared/host/render-profile.js";

describe("resolveRenderProfile", () => {
  it("defaults calm off in a plain Linux environment", () => {
    expect(resolveRenderProfile({ env: {}, procVersion: "Linux version 6.8.0-generic" })).toEqual({ calm: false });
    expect(resolveRenderProfile({ env: {} })).toEqual({ calm: false });
  });

  it("defaults calm on under WSL environment markers", () => {
    expect(resolveRenderProfile({ env: { WSL_DISTRO_NAME: "Ubuntu" } })).toEqual({ calm: true });
    expect(resolveRenderProfile({ env: { WSL_INTEROP: "/run/WSL/1_interop" } })).toEqual({ calm: true });
  });

  it("defaults calm on when the kernel identifies as Microsoft", () => {
    expect(
      resolveRenderProfile({
        env: {},
        procVersion: "Linux version 5.15.167.4-microsoft-standard-WSL2 (root@...)",
      }),
    ).toEqual({ calm: true });
    expect(resolveRenderProfile({ env: {}, procVersion: "Linux version 4.4.0-Microsoft" })).toEqual({ calm: true });
  });

  it("honours the explicit override in both directions", () => {
    // Force ON on a fast terminal…
    expect(resolveRenderProfile({ env: { LOCUS_PS_CALM: "1" } })).toEqual({ calm: true });
    // …and force OFF under WSL (e.g. Windows Terminal, which repaints cleanly).
    expect(resolveRenderProfile({ env: { LOCUS_PS_CALM: "0", WSL_DISTRO_NAME: "Ubuntu" } })).toEqual({ calm: false });
  });

  it("ignores unrecognized override values and falls back to detection", () => {
    expect(resolveRenderProfile({ env: { LOCUS_PS_CALM: "yes", WSL_DISTRO_NAME: "Ubuntu" } })).toEqual({ calm: true });
    expect(resolveRenderProfile({ env: { LOCUS_PS_CALM: "" } })).toEqual({ calm: false });
  });
});

describe("coerceTheme", () => {
  it("returns an empty theme for anything that is not an object", () => {
    for (const value of [undefined, null, "theme", 7, true, () => "x"]) {
      expect(coerceTheme(value)).toEqual({});
    }
  });

  it("keeps only the methods the host actually provides", () => {
    const coerced = coerceTheme({ fg: (color: string, text: string) => `${color}:${text}`, bg: "not a function" });
    expect(coerced.fg?.("dim", "hello")).toBe("dim:hello");
    expect(coerced.bold).toBeUndefined();
    expect(coerced.bg).toBeUndefined();
  });

  it("calls each method with the original theme as `this`", () => {
    // A real Pi theme reads instance state; a detached function reference would
    // lose it and either throw or silently style with the wrong palette.
    const theme = {
      palette: "violet",
      fg(this: { palette: string }, color: string, text: string) {
        return `${this.palette}/${color}/${text}`;
      },
      bg(this: { palette: string }, color: string, text: string) {
        return `bg-${this.palette}/${color}/${text}`;
      },
      bold(this: { palette: string }, text: string) {
        return `bold-${this.palette}/${text}`;
      },
    };
    const coerced = coerceTheme(theme);
    expect(coerced.fg?.("accent", "row")).toBe("violet/accent/row");
    expect(coerced.bg?.("rail", "row")).toBe("bg-violet/rail/row");
    expect(coerced.bold?.("header")).toBe("bold-violet/header");
  });

  it("coerces a non-string return into a string", () => {
    const coerced = coerceTheme({ fg: () => 42, bold: () => undefined });
    expect(coerced.fg?.("dim", "x")).toBe("42");
    expect(coerced.bold?.("x")).toBe("undefined");
  });
});
