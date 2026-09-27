import { App, TFile } from "obsidian";
import { ensureFolder } from "../utils/vault";

async function digest(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), n => n.toString(16).padStart(2, "0")).join("");
}

/** One persistent approval per automatic draft. Never selects a new version on retry. */
export async function commitDraftPromotion(app: App, draftPath: string, folder: string, name: string, request: string, proposedContent: string, draftBefore: string): Promise<{ file: TFile; draftBefore: string }> {
  if (!draftPath || /[\\:\u0000-\u001f]/u.test(draftPath) || draftPath.split("/").some(p => !p || p === "." || p === "..")) throw new Error("草稿路径无效。");
  const receiptPath = `${draftPath}.promotion.json`;
  const formalPath = `${folder}/${name}-draft-${(await digest(draftPath)).slice(0, 20)}.md`;
  const requestHash = await digest(request);
  let receipt = { schemaVersion: 1, draftPath, formalPath, requestHash, content: proposedContent, contentHash: await digest(proposedContent), draftBefore, draftBeforeHash: await digest(draftBefore), stage: "prepared" };
  const previous = app.vault.getAbstractFileByPath(receiptPath);
  if (previous && !(previous instanceof TFile)) throw new Error("复盘保存凭证路径被占用。");
  if (previous instanceof TFile) {
    const parsed = JSON.parse(await app.vault.read(previous)) as typeof receipt;
    if (parsed.schemaVersion !== 1 || parsed.draftPath !== draftPath || parsed.formalPath !== formalPath || parsed.requestHash !== requestHash
      || typeof parsed.content !== "string" || await digest(parsed.content) !== parsed.contentHash
      || typeof parsed.draftBefore !== "string" || await digest(parsed.draftBefore) !== parsed.draftBeforeHash
      || !["prepared", "creating", "created"].includes(parsed.stage)) {
      throw new Error("这份草稿已有不同的保存凭证。请保留原草稿和已保存文件，核对后再操作；未创建重复版本。");
    }
    receipt = parsed;
  } else {
    const bytes = JSON.stringify(receipt, null, 2);
    try { await app.vault.create(receiptPath, bytes); }
    catch (error) {
      const acknowledged = app.vault.getAbstractFileByPath(receiptPath);
      if (!(acknowledged instanceof TFile) || await app.vault.read(acknowledged) !== bytes) throw error;
    }
  }
  const setStage = async (stage: string): Promise<void> => {
    const receiptFile = app.vault.getAbstractFileByPath(receiptPath);
    if (!(receiptFile instanceof TFile) || typeof app.vault.process !== "function") throw new Error("无法安全更新复盘保存凭证。");
    const before = JSON.stringify(receipt, null, 2), next = { ...receipt, stage }, after = JSON.stringify(next, null, 2);
    try {
      await app.vault.process(receiptFile, current => {
        if (receiptFile.path !== receiptPath || app.vault.getAbstractFileByPath(receiptPath) !== receiptFile || (current !== before && current !== after)) throw new Error("复盘保存凭证已变化，未覆盖。");
        return after;
      });
    } catch (error) {
      if (receiptFile.path !== receiptPath || app.vault.getAbstractFileByPath(receiptPath) !== receiptFile || await app.vault.read(receiptFile) !== after) throw error;
    }
    receipt = next;
  };
  await ensureFolder(app, folder);
  let file = app.vault.getAbstractFileByPath(formalPath);
  if (!file) {
    if (receipt.stage !== "prepared") throw new Error(`正式复盘目标缺失或创建状态待核对：${formalPath}。可能已被移动或删除；未重新创建，请保留凭证核对。`);
    await setStage("creating");
    try { file = await app.vault.create(formalPath, receipt.content); }
    catch (error) {
      file = app.vault.getAbstractFileByPath(formalPath);
      if (!(file instanceof TFile) || await app.vault.read(file) !== receipt.content) throw error;
    }
  }
  if (!(file instanceof TFile) || file.path !== formalPath || app.vault.getAbstractFileByPath(formalPath) !== file || await app.vault.read(file) !== receipt.content) {
    throw new Error(`正式复盘已变化或目标被占用：${formalPath}。未覆盖、未创建第二份，请先核对。`);
  }
  if (receipt.stage !== "created") await setStage("created");
  return { file, draftBefore: receipt.draftBefore };
}

export class DraftPromotionPartialError extends Error {
  constructor(public readonly file: TFile, cause: unknown) {
    super(`正式复盘已保存：${file.path}；草稿状态未完成：${cause instanceof Error ? cause.message : String(cause)}。重试只补收尾，不会新建正式版本。`);
  }
}
