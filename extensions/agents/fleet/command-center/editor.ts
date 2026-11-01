import { CustomEditor, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, EditorFactory } from "../../../_shared/host/pi-api.js";

/** Editor-local hook: modal/overlay focus and nonempty cursor navigation remain Pi-owned. */
export function installCommandCenterEditor(ctx: ExtensionContext, open: () => void): () => void {
  if (ctx.ui.setEditorComponent === undefined) return () => {};
  const previous = ctx.ui.getEditorComponent?.();
  const factory: EditorFactory = (tui, theme, keys) => {
    const editor = (previous?.(tui, theme, keys) ??
      new CustomEditor(
        tui as ConstructorParameters<typeof CustomEditor>[0],
        { ...theme, selectList: getSelectListTheme() },
        keys as ConstructorParameters<typeof CustomEditor>[2],
      )) as CustomEditor;
    guardCommandCenterInput(editor, open);
    return editor;
  };
  ctx.ui.setEditorComponent(factory);
  return () => {
    if (ctx.ui.getEditorComponent?.() === factory) ctx.ui.setEditorComponent?.(previous);
  };
}

/** Shared by main and child editors; unknown custom editors fail closed to /ps. */
export function guardCommandCenterInput(
  editor: {
    handleInput(data: string): void;
    getExpandedText?(): string;
    isShowingAutocomplete?(): boolean;
  },
  open: () => void,
): void {
  const handle = editor.handleInput.bind(editor);
  let pasting = false;
  editor.handleInput = (data) => {
    if (data.includes("\x1b[200~")) pasting = true;
    if (
      !pasting &&
      data === "\x1b[D" &&
      editor.getExpandedText?.() === "" &&
      editor.isShowingAutocomplete?.() === false
    ) {
      open();
      return;
    }
    handle(data);
    if (data.includes("\x1b[201~")) pasting = false;
  };
}
