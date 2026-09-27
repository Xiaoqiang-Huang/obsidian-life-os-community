import type { App } from "obsidian";
import type { AiClient } from "../ai";
import type { WritebackItem } from "../writeback-preview";
import { ReviewTagService, type ReviewTagResult } from "./ReviewTagService";
import { snapshotWritebackUndo, rememberWritebackUndo } from "./writeback-undo";

/** Extends a confirmed end-of-day write; cancellation and unrelated task saves never tag a diary. */
export async function tagConfirmedDiary(app: App, ai: AiClient, root: string, diaryPath: string, before: string,
  written: WritebackItem[]): Promise<ReviewTagResult | null> {
  const diaryItems = written.filter(item => item.targetPath === diaryPath && (item.kind === "replace" || item.kind === "append"));
  const last = diaryItems.at(-1);
  if (!last || !diaryItems.some(item => item.kind === "replace")) return null;
  const receipt = snapshotWritebackUndo(app, last.id, diaryPath);
  if (!receipt) throw new Error("日终整理已保存，但本次写入凭证不可用；顶部标签未改动。");
  const service = new ReviewTagService(app, root);
  const plan = await service.prepare(ai, diaryPath, before);
  const accepted = service.rebaseAfterConfirmedWriteback(plan, receipt.after);
  const result = await service.apply(accepted, diaryPath);
  // Extend only the exact committed result so native undo still protects subsequent manual edits.
  if (result.confirmedMarkdown) {
    rememberWritebackUndo(app, last.id, { ...receipt, after: result.confirmedMarkdown });
  }
  return result;
}
