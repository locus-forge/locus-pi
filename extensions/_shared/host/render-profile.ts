import { readFileSync } from "node:fs";

/**
 * Calm-rendering resolution for live TUI surfaces.
 *
 * Throttling (render-scheduler.ts) bounds how OFTEN a live surface repaints.
 * It cannot help when every repaint itself blinks — which is what a slow
 * console does when a line is cleared and rewritten across the WSL pipe
 * boundary. The only guaranteed lever left in extension code is to stop
 * producing new frames at all while nothing meaningful changes: freeze the
 * spinner animation, coarsen elapsed counters so their text holds still for
 * whole buckets, and drop the per-second tool timer. Combined with the
 * frame-identity gates, a calm surface writes to the terminal only on real
 * state transitions — seconds to minutes apart — instead of every second.
 *
 * Calm mode is presentation only; it changes no cadence of the underlying
 * store, no liveness semantics, and no data shown on state transitions.
 *
 * Resolution order:
 *   - `LOCUS_PS_CALM=1` forces calm on, `LOCUS_PS_CALM=0` forces it off;
 *   - otherwise calm defaults ON under WSL (`WSL_DISTRO_NAME`/`WSL_INTEROP`,
 *     or a `microsoft` kernel string in /proc/version) — the environment where
 *     per-repaint blinking is endemic — and OFF everywhere else.
 */
export interface RenderProfile {
  /** Freeze animation and coarsen time text so idle frames stay byte-identical. */
  calm: boolean;
}

export interface RenderProfileInputs {
  env?: Record<string, string | undefined>;
  /** Kernel identity, normally the /proc/version content; `undefined` when unreadable. */
  procVersion?: string;
}

/** Pure resolution — the testable core. */
export function resolveRenderProfile(inputs: RenderProfileInputs): RenderProfile {
  const env = inputs.env ?? {};
  const override = (env["LOCUS_PS_CALM"] ?? "").trim();
  if (override === "1") return { calm: true };
  if (override === "0") return { calm: false };
  return { calm: isWslEnvironment(env, inputs.procVersion) };
}

/** Runtime entry point: resolve from the live process environment. */
export function defaultRenderProfile(): RenderProfile {
  const procVersion = readProcVersion();
  return resolveRenderProfile({ env: process.env, ...(procVersion === undefined ? {} : { procVersion }) });
}

function isWslEnvironment(env: Record<string, string | undefined>, procVersion: string | undefined): boolean {
  if ((env["WSL_DISTRO_NAME"] ?? "") !== "" || (env["WSL_INTEROP"] ?? "") !== "") return true;
  return (procVersion ?? "").toLowerCase().includes("microsoft");
}

function readProcVersion(): string | undefined {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return undefined; // non-Linux hosts and restricted sandboxes
  }
}

/**
 * The optional slice of Pi's theme a live surface actually styles with.
 *
 * Distinct from `pi-api.ts#ThemeLike` on purpose: that one is the shape Pi
 * hands a widget factory (every method present), this one is what survives
 * `coerceTheme` — a host may pass a partial object, no object at all, or
 * methods that return something other than a string, and a renderer must stay
 * legible in each case.
 */
export interface ThemeLike {
  fg?: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold?: (s: string) => string;
}

/**
 * Narrow an untrusted host theme to the methods that are actually callable.
 *
 * Each retained method is re-bound to the original theme object, so a Pi theme
 * whose `fg`/`bg`/`bold` read instance state keeps working after extraction;
 * calling the raw reference would lose `this`. The return is coerced with
 * `String(...)` because a host is free to return a non-string.
 */
export function coerceTheme(t: unknown): ThemeLike {
  if (typeof t !== "object" || t === null) return {};
  const theme = t as { fg?: unknown; bg?: unknown; bold?: unknown };
  const result: ThemeLike = {};
  if (typeof theme.fg === "function") {
    const fg = theme.fg as (this: unknown, color: string, text: string) => unknown;
    result.fg = (color: string, text: string) => String(fg.call(theme, color, text));
  }
  if (typeof theme.bold === "function") {
    const bold = theme.bold as (this: unknown, s: string) => unknown;
    result.bold = (s: string) => String(bold.call(theme, s));
  }
  if (typeof theme.bg === "function") {
    const bg = theme.bg as (this: unknown, color: string, text: string) => unknown;
    result.bg = (color: string, text: string) => String(bg.call(theme, color, text));
  }
  return result;
}
