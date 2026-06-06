import { App, TFile } from "obsidian";

export function formatDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function sanitizeFolderPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

export function joinPath(...parts: string[]): string {
  return parts
    .map((part) => sanitizeFolderPath(part))
    .filter(Boolean)
    .join("/");
}

export function renderTemplate(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    return values[key] ?? "";
  });
}

export async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const cleanPath = sanitizeFolderPath(folderPath);
  if (!cleanPath) {
    return;
  }

  const parts = cleanPath.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

export async function ensureFile(
  app: App,
  filePath: string,
  content: string
): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) {
    return existing;
  }

  const folder = filePath.split("/").slice(0, -1).join("/");
  await ensureFolder(app, folder);
  return app.vault.create(filePath, content);
}

export async function appendToFile(
  app: App,
  filePath: string,
  content: string
): Promise<TFile> {
  const file = await ensureFile(app, filePath, "");
  await app.vault.append(file, content);
  return file;
}

export function makeId(prefix: string, date = new Date()): string {
  const time = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${time}-${rand}`;
}

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json|markdown|md|text)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

export function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "刚刚";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return new Date(isoString).toLocaleDateString("zh-CN");
}

export function extractJsonArray(text: string): unknown[] | null {
  const cleaned = stripCodeFences(text);
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
