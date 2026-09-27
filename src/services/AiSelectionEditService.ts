import type { App } from "obsidian";
import type { AiEditTarget } from "../ui/AiEditPopover";
import { saveGuardedDocument } from "./GuardedDocumentService";

/** Called only after explicit preview acceptance and the existing write permission check. */
export async function applyAiSelectionEdit(app: App, target: AiEditTarget, path: string, preview: string): Promise<void> {
  if (target.file.path !== path || app.vault.getAbstractFileByPath(path) !== target.file) throw new Error("来源文件已移动或删除，请重新选择。");
  if (target.kind === "readonly-selection") throw new Error("阅读模式不直接替换原文；请复制预览，或切到编辑模式重新选择。");
  if (target.kind === "selection") {
    const currentView = app.workspace.getLeavesOfType("markdown").some(leaf => {
      const view = leaf.view as unknown as { editor?: unknown; file?: unknown };
      return view.editor === target.editor && view.file === target.file;
    });
    if (!currentView || target.editor.getRange(target.from, target.to) !== target.text) throw new Error("选区或当前文档已经变化，请重新选择后再应用。");
    target.editor.replaceRange(preview, target.from, target.to);
  } else {
    await saveGuardedDocument(app, path, target.text, preview);
  }
}
