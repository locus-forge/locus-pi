import { afterEach, describe, expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  clamp,
  clearViewerExternalRows,
  clipLines,
  fitLine,
  padLine,
  setViewerExternalRows,
  terminalRows,
  viewerExternalRows,
  viewerRows,
} from "../../../extensions/_shared/operator/viewer-geometry.js";

afterEach(() => {
  clearViewerExternalRows("test-a");
  clearViewerExternalRows("test-b");
});

describe("focused viewer external-row reservations", () => {
  it("shares and sums current host rows without retaining cleared owners", () => {
    setViewerExternalRows("test-a", 3);
    setViewerExternalRows("test-b", 2.9);
    expect(viewerExternalRows()).toBe(5);

    setViewerExternalRows("test-a", 1);
    clearViewerExternalRows("test-b");
    expect(viewerExternalRows()).toBe(1);

    setViewerExternalRows("test-a", 0);
    expect(viewerExternalRows()).toBe(0);
  });
});

describe("clamp", () => {
  it("confines a value to the inclusive range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("terminalRows", () => {
  it("floors a reported height and holds it at the caller's minimum", () => {
    expect(terminalRows({ terminal: { rows: 40.7 } }, 3, 24)).toBe(40);
    expect(terminalRows({ terminal: { rows: 1 } }, 3, 24)).toBe(3);
  });

  it("falls back when the host reports nothing usable", () => {
    expect(terminalRows({}, 3, 24)).toBe(24);
    expect(terminalRows({ terminal: {} }, 3, 24)).toBe(24);
    expect(terminalRows({ terminal: { rows: Number.NaN } }, 3, 24)).toBe(24);
  });
});

describe("viewerRows", () => {
  const options = { minimumRows: 3, fallbackRows: 24, hostFooterRows: 3 } as const;

  it("subtracts the host footer from the usable terminal height", () => {
    expect(viewerRows({ terminal: { rows: 40 } }, options)).toBe(37);
  });

  it("uses the caller's fallback when the terminal reports nothing", () => {
    expect(viewerRows({}, options)).toBe(21);
  });

  it("also subtracts rows another surface has reserved", () => {
    setViewerExternalRows("test-a", 4);
    expect(viewerRows({ terminal: { rows: 40 } }, options)).toBe(33);
  });

  it("never drops below one row, however much is reserved", () => {
    setViewerExternalRows("test-a", 100);
    expect(viewerRows({ terminal: { rows: 40 } }, options)).toBe(1);
  });
});

describe("fitLine", () => {
  it("leaves a line that fits untouched, short and unpadded", () => {
    expect(fitLine("abc", 10)).toBe("abc");
  });

  it("ellipsises a line wider than the budget", () => {
    // `truncateToWidth` brackets the ellipsis it appends with resets, so the
    // visible text is compared stripped and the budget separately.
    expect(stripTerminalSequences(fitLine("abcdefgh", 5))).toBe("abcd…");
    expect(visibleWidth(fitLine("abcdefgh", 5))).toBe(5);
  });

  it("never exceeds the budget at the widths a frame degrades to", () => {
    for (const width of [0, 1, 2, 3]) {
      expect(visibleWidth(fitLine("日本語テキスト", width))).toBeLessThanOrEqual(width);
      expect(visibleWidth(fitLine("abcdefgh", width))).toBeLessThanOrEqual(width);
    }
  });
});

describe("padLine", () => {
  it("pads a short line out to exactly the budget", () => {
    expect(padLine("abc", 6)).toBe("abc   ");
  });

  it("ellipsises a long line to exactly the budget", () => {
    expect(stripTerminalSequences(padLine("abcdefgh", 5))).toBe("abcd…");
    expect(visibleWidth(padLine("abcdefgh", 5))).toBe(5);
  });

  it("keeps every row the same visible width, which is what a frame edge needs", () => {
    for (const value of ["", "abc", "abcdefgh", "日本語テキスト"]) {
      expect(visibleWidth(padLine(value, 8))).toBe(8);
    }
  });
});

describe("clipLines", () => {
  it("clips to the granted rows and fits each one, without padding rows up", () => {
    expect(clipLines(["one", "two", "three"], 2, 4)).toEqual(["one", "two"]);
    expect(clipLines(["alpha", "beta"], 2, 4).map(stripTerminalSequences)).toEqual(["alp…", "beta"]);
  });

  it("returns fewer rows than granted rather than filling the height", () => {
    expect(clipLines(["only"], 5, 10)).toEqual(["only"]);
    expect(clipLines([], 5, 10)).toEqual([]);
  });
});
