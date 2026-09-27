import { App, TFile } from "obsidian";
import type { PersonalLifeSystemSettings } from "../settings";
import { applyExperienceTheme } from "./theme";
import { ensureFolder } from "../utils/vault";

export function isDocumentBackgroundPath(value: string): boolean {
  const p = value.trim();
  return Boolean(p && !/^[\/\\]|[\\:\u0000-\u001f]/u.test(p)
    && !p.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".obsidian")
    && /\.(?:png|jpe?g|webp)$/iu.test(p));
}

export function documentBackgroundUrl(app: App, value: string): string | null {
  if (!isDocumentBackgroundPath(value)) return null;
  const file = app.vault.getAbstractFileByPath(value.trim());
  if (!(file instanceof TFile)) return null;
  return app.vault.getResourcePath(file);
}

/** A user-selected local raster only. Does not fetch URLs or replace an existing asset. */
export async function importDocumentBackground(app: App, root: string, name: string, data: ArrayBuffer): Promise<TFile> {
  const bytes = new Uint8Array(data);
  if (bytes.length > 8 * 1024 * 1024 || bytes.length < 12) throw new Error("请选择 8 MB 以内的 PNG、JPEG 或 WebP 图片。");
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
  const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  const ext = png ? "png" : jpg ? "jpg" : webp ? "webp" : "";
  if (!ext) throw new Error("文件内容不是支持的图片格式，未导入。");
  const folder = `${root.replace(/\/+$/u, "")}/Attachments/Backgrounds`;
  if (!isDocumentBackgroundPath(`${folder}/test.png`)) throw new Error("背景图片目录无效。");
  const stem = name.replace(/\.[^.]+$/u, "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-").trim().slice(0, 64) || "background";
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), n => n.toString(16).padStart(2, "0")).join("");
  await ensureFolder(app, folder);
  return app.vault.createBinary(`${folder}/${stem}-${random}.${ext}`, data);
}

export function applyDocumentAppearance(element: HTMLElement, settings: PersonalLifeSystemSettings, imageUrl: string | null): void {
  // Do not put .lifeos-v3 on CodeMirror: its control-layout reset is not an editor stylesheet.
  if (!element.hasClass("lifeos-reader")) element.addClass("lifeos-reader");
  applyExperienceTheme(element, settings);
  const background = imageUrl ? `url(${JSON.stringify(imageUrl)})` : "none";
  if (element.style.getPropertyValue("--lifeos-reader-image") !== background) element.style.setProperty("--lifeos-reader-image", background);
  if (element.hasClass("lifeos-reader-image") !== Boolean(imageUrl)) element.toggleClass("lifeos-reader-image", Boolean(imageUrl));
}

export function clearDocumentAppearance(element: HTMLElement): void {
  if (!element.hasClass("lifeos-reader")) return;
  element.removeClass("lifeos-reader", "lifeos-reader-image");
  element.style.removeProperty("--lifeos-reader-image");
  for (const name of Array.from(element.style)) if (name.startsWith("--v3-theme-")) element.style.removeProperty(name);
  delete element.dataset.appearance; delete element.dataset.density; delete element.dataset.themeDark; delete element.dataset.themeMaterial;
}
