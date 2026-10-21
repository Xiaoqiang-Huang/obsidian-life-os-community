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

/** Per-file outcome of one batch import job; retry selection depends only on this status. */
export type ImportFileJobStatus = "imported" | "duplicate" | "versioned" | "failed" | "preflight-failed";

export interface ImportFileJobOutcome {
  /** Stable job identity: `importFileSelectionKey`, i.e. relative path + size + lastModified. */
  key: string;
  status: ImportFileJobStatus;
  message: string;
}

const IMPORT_FILE_STATUS_LABELS: Record<ImportFileJobStatus, string> = {
  imported: "已导入",
  duplicate: "重复：已指向已有资料",
  versioned: "已保存为新版本",
  failed: "失败，可重试",
  "preflight-failed": "未通过预检，未保存原件"
};

export function importFileStatusLabel(status: ImportFileJobStatus): string {
  return IMPORT_FILE_STATUS_LABELS[status] ?? String(status);
}

export function isImportFileJobFailure(status: ImportFileJobStatus): boolean {
  return status === "failed" || status === "preflight-failed";
}

/**
 * Remembers the last attempt of every selected file so a batch import can isolate failures and
 * retry only what failed, keyed by the stable `importFileSelectionKey` identity.
 */
export class ImportFileJob {
  private outcomes = new Map<string, ImportFileJobOutcome>();

  record(outcome: ImportFileJobOutcome): void {
    this.outcomes.set(outcome.key, outcome);
  }

  recordAll(outcomes: ImportFileJobOutcome[]): void {
    for (const outcome of outcomes) this.record(outcome);
  }

  forget(file: File): void {
    this.outcomes.delete(importFileSelectionKey(file));
  }

  outcomeFor(file: File): ImportFileJobOutcome | undefined {
    return this.outcomes.get(importFileSelectionKey(file));
  }

  /** Files that were never attempted or whose last attempt failed (the retry selection). */
  pendingFiles(files: File[]): File[] {
    return files.filter((file) => {
      const outcome = this.outcomeFor(file);
      return !outcome || isImportFileJobFailure(outcome.status);
    });
  }

  failedFiles(files: File[]): File[] {
    return files.filter((file) => {
      const outcome = this.outcomeFor(file);
      return outcome !== undefined && isImportFileJobFailure(outcome.status);
    });
  }

  failedCount(): number {
    let count = 0;
    for (const outcome of this.outcomes.values()) {
      if (isImportFileJobFailure(outcome.status)) count += 1;
    }
    return count;
  }

  counts(): Record<ImportFileJobStatus, number> {
    const counts: Record<ImportFileJobStatus, number> = {
      imported: 0,
      duplicate: 0,
      versioned: 0,
      failed: 0,
      "preflight-failed": 0
    };
    for (const outcome of this.outcomes.values()) counts[outcome.status] += 1;
    return counts;
  }
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
