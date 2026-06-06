import { App, TFile, TFolder } from "obsidian";

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

export function joinPath(...parts: string[]): string {
  return parts.map(normalizePath).filter(Boolean).join("/");
}

export async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const clean = normalizePath(folderPath);
  if (!clean) return;

  const parts = clean.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) {
      continue;
    }
    if (existing instanceof TFile) {
      throw new Error(`Cannot create folder "${current}" because a file already exists at that path.`);
    }
    try {
      await app.vault.createFolder(current);
    } catch (error) {
      const afterCreate = app.vault.getAbstractFileByPath(current);
      if (afterCreate instanceof TFolder) {
        continue;
      }
      throw error;
    }
  }
}

export async function ensureFile(app: App, filePath: string, content = ""): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) return existing;
  if (existing instanceof TFolder) {
    throw new Error(`Cannot create file "${filePath}" because a folder already exists at that path.`);
  }

  const folder = filePath.split("/").slice(0, -1).join("/");
  await ensureFolder(app, folder);
  return app.vault.create(filePath, content);
}

export async function readFile(app: App, filePath: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return "";
  return app.vault.read(file);
}

export async function writeFile(app: App, filePath: string, content: string): Promise<TFile> {
  const file = await ensureFile(app, filePath, "");
  await app.vault.modify(file, content);
  return file;
}

export async function appendFile(app: App, filePath: string, content: string): Promise<TFile> {
  const file = await ensureFile(app, filePath, "");
  await app.vault.append(file, content);
  return file;
}
