import { paintStatusLines } from "../../_shared/agent-runtime/status-line-render.js";
import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export interface AgentPickerEntry {
  id: string;
  label: string;
}
/** Temporary unfiltered selector: text/draft belongs to the editor, never this picker. */
export class AgentPicker implements Component {
  #selected: string;
  constructor(
    private readonly entries: () => AgentPickerEntry[],
    active: string,
    private readonly choose: (id: string) => void,
    private readonly dismiss: () => void,
    private readonly repaint: () => void,
  ) {
    this.#selected = active;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const entries = this.entries();
    const index = entries.findIndex((entry) => entry.id === this.#selected);
    const start = Math.max(0, Math.min(index - 2, entries.length - 6));
    const lines = [
      index < 0
        ? "Agent no longer available · ↑↓ choose · Esc/Backspace close"
        : "Agents · ↑↓ select · Enter switch · Esc/Backspace close",
      ...entries
        .slice(start, start + 6)
        .map((entry, offset) => `${start + offset === index ? "›" : " "} ${entry.label}  ${entry.id}`),
    ].map((line) => truncateToWidth(line, width));
    return paintStatusLines(lines, width).map((line, row) => (row === index - start + 1 ? `\u001b[1m${line}` : line));
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
      this.dismiss();
      return;
    }
    const entries = this.entries();
    let index = entries.findIndex((entry) => entry.id === this.#selected);
    if (index < 0 && matchesKey(data, "enter")) {
      this.repaint();
      return;
    }
    if (matchesKey(data, "up")) index = (index + entries.length - 1) % entries.length;
    else if (matchesKey(data, "down")) index = (index + 1) % entries.length;
    else if (matchesKey(data, "enter")) {
      const chosen = entries[index];
      if (chosen !== undefined) this.choose(chosen.id);
      return;
    }
    this.#selected = entries[index]?.id ?? "main";
    this.repaint();
  }
}
