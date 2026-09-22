import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface WorkflowReturnRenderContext {
  expanded: boolean;
}

/** Viewer-only call projection. Pi still owns the tool shell and lifecycle. */
export function renderWorkflowReturnCall(
  args: unknown,
  theme: Theme,
  context: WorkflowReturnRenderContext,
  markdownTheme?: MarkdownTheme,
): Component {
  return new WorkflowReturnCallComponent(args, theme, context.expanded, markdownTheme);
}

class WorkflowReturnCallComponent implements Component {
  constructor(
    private readonly args: unknown,
    private readonly theme: Theme,
    private readonly expanded: boolean,
    private readonly markdownTheme?: MarkdownTheme,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    try {
      const title = this.theme.fg("toolTitle", this.theme.bold("workflow_return"));
      const value = workflowReturnValue(this.args);
      const body =
        this.expanded || !value.ok
          ? renderPlain(safeJson(this.args), 0, safeWidth, this.theme)
          : renderValue(this.args, 0, safeWidth, this.theme, this.markdownTheme, new WeakSet<object>());
      return [truncateToWidth(title, safeWidth), ...body];
    } catch {
      return [
        truncateToWidth("workflow_return", safeWidth),
        ...renderPlain(safeJson(this.args), 0, safeWidth, undefined),
      ];
    }
  }

  invalidate(): void {}
}

function workflowReturnValue(args: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(args, "value")) return { ok: false };
  return { ok: true, value: (args as Record<string, unknown>).value };
}

function renderValue(
  value: unknown,
  indent: number,
  width: number,
  theme: Theme,
  markdownTheme: MarkdownTheme | undefined,
  ancestors: WeakSet<object>,
): string[] {
  if (typeof value === "string") return renderString(value, indent, width, theme, markdownTheme);
  if (typeof value !== "object" || value === null) return renderPlain(safeJson(value), indent, width, theme);
  if (ancestors.has(value)) return renderPlain("[circular]", indent, width, theme);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length === 0) return renderPlain("[]", indent, width, theme);
      return value.flatMap((item, index) => [
        ...renderLabel(`[${index}]:`, indent, width, theme),
        ...renderValue(item, indent + 2, width, theme, markdownTheme, ancestors),
      ]);
    }
    const entries = Object.entries(value);
    if (entries.length === 0) return renderPlain("{}", indent, width, theme);
    return entries.flatMap(([key, item]) => [
      ...renderLabel(`${JSON.stringify(key)}:`, indent, width, theme),
      ...renderValue(item, indent + 2, width, theme, markdownTheme, ancestors),
    ]);
  } finally {
    ancestors.delete(value);
  }
}

function renderString(
  value: string,
  indent: number,
  width: number,
  theme: Theme,
  markdownTheme: MarkdownTheme | undefined,
): string[] {
  const safeValue = terminalSafeMarkdown(value);
  if (markdownTheme === undefined) return renderPlain(safeValue, indent, width, theme);
  const prefix = " ".repeat(indent);
  const available = Math.max(1, width - visibleWidth(prefix));
  const component = new Markdown(safeValue, 0, 0, markdownTheme, {
    color: (text) => theme.fg("toolOutput", text),
  });
  return component.render(available).map((line) => truncateToWidth(`${prefix}${line}`, width));
}

function terminalSafeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "�");
}

function renderLabel(value: string, indent: number, width: number, theme: Theme): string[] {
  return renderPlain(value, indent, width, theme, true);
}

function renderPlain(value: string, indent: number, width: number, theme?: Theme, bold = false): string[] {
  const prefix = " ".repeat(indent);
  const available = Math.max(1, width - visibleWidth(prefix));
  return value.split("\n").flatMap((line) => {
    const wrapped = line === "" ? [""] : wrapTextWithAnsi(line, available);
    return wrapped.map((part) => {
      const styled = theme === undefined ? part : theme.fg("toolOutput", bold ? theme.bold(part) : part);
      return truncateToWidth(`${prefix}${styled}`, width);
    });
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unrenderable arguments]";
    }
  }
}
