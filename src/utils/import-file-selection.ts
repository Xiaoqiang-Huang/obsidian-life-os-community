import {
  classifyImportedDocument,
  isSupportedImportKind,
  type ReadableImportFile
} from "../services/DocumentImportService";

export interface ImportFileSelectionResult {
  files: File[];
  added: number;
  duplicates: number;
  skipped: File[];
  visibleFiles: File[];
  hiddenCount: number;
}

export interface ImportFileSelectionOptions {
  visibleLimit?: number;
}

export function importFileRelativePath(file: File): string {
  const relative = file.webkitRelativePath?.trim();
  return (relative || file.name).replace(/\\/g, "/").replace(/^\/+/, "");
}

export function importFileSelectionKey(file: File): string {
  return `${importFileRelativePath(file)}:${file.size}:${file.lastModified}`;
}

export function asRelativeReadableImportFile(file: File): ReadableImportFile {
  const name = importFileRelativePath(file);
  if (name === file.name) return file;
  return {
    name,
    type: file.type,
    size: file.size,
    text: () => file.text(),
    arrayBuffer: () => file.arrayBuffer()
  };
}

export function mergeSupportedImportFiles(
  existing: File[],
  incoming: FileList | File[] | null,
  options: ImportFileSelectionOptions = {}
): ImportFileSelectionResult {
  const files = [...existing];
  const seen = new Set(files.map(importFileSelectionKey));
  const skipped: File[] = [];
  let added = 0;
  let duplicates = 0;

  for (const file of Array.from(incoming ?? [])) {
    const kind = classifyImportedDocument(file.name, file.type || "");
    if (!isSupportedImportKind(kind)) {
      skipped.push(file);
      continue;
    }
    const key = importFileSelectionKey(file);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    files.push(file);
    seen.add(key);
    added += 1;
  }

  const visibleLimit = Math.max(1, options.visibleLimit ?? 80);
  return {
    files,
    added,
    duplicates,
    skipped,
    visibleFiles: files.slice(0, visibleLimit),
    hiddenCount: Math.max(0, files.length - visibleLimit)
  };
}

export function configureDirectoryInput(input: HTMLInputElement): void {
  input.setAttribute("webkitdirectory", "");
  input.setAttribute("directory", "");
  input.multiple = true;
}
