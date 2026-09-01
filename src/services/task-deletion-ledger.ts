const TASK_DELETION_MARKER_PREFIX = "pls-task-deleted:v1";
const TASK_DELETION_MARKER_PATTERN = /<!--\s*pls-task-deleted:v1:([a-f0-9]{16}):([^\s>]+)\s*-->/giu;

/**
 * Builds a stable identity from the user-visible part of a task. Runtime
 * metadata that changes during completion or carryover is intentionally
 * removed so a deleted task cannot be recreated with a fresh block id/date.
 */
export function normalizeTaskDeletionIdentity(taskLine: string): string {
  return taskLine
    .trim()
    .replace(/^-\s*\[[ xX]\]\s+/u, "")
    .replace(/\s*[📅✅📌🔁]\s*20\d{2}-\d{2}-\d{2}/gu, "")
    .replace(/\s+(?:project|source):[^\s^]+/giu, "")
    .replace(/\s*#[^\s^]+/gu, "")
    .replace(/\s*\^[^\s]+\s*$/gu, "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

export function taskDeletionFingerprint(taskLine: string): string {
  const value = normalizeTaskDeletionIdentity(taskLine);
  let primary = 2166136261;
  let secondary = 2166136261 ^ 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    primary = Math.imul(primary ^ code, 16777619);
    secondary = Math.imul(secondary ^ code, 2246822519);
  }
  return [primary, secondary]
    .map((hash) => (hash >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

export function parseTaskDeletionFingerprints(content: string): Set<string> {
  const fingerprints = new Set<string>();
  for (const match of content.matchAll(TASK_DELETION_MARKER_PATTERN)) {
    fingerprints.add(match[1].toLowerCase());
  }
  return fingerprints;
}

export function appendTaskDeletionMarkers(
  content: string,
  taskLines: string[],
  deletedAt = new Date().toISOString()
): { content: string; added: number } {
  const existing = parseTaskDeletionFingerprints(content);
  const additions: string[] = [];
  for (const taskLine of taskLines) {
    if (!normalizeTaskDeletionIdentity(taskLine)) continue;
    const fingerprint = taskDeletionFingerprint(taskLine);
    if (existing.has(fingerprint)) continue;
    existing.add(fingerprint);
    additions.push(`<!-- ${TASK_DELETION_MARKER_PREFIX}:${fingerprint}:${deletedAt} -->`);
  }
  if (additions.length === 0) return { content, added: 0 };
  const separator = content && !content.endsWith("\n") ? "\n" : "";
  return {
    content: `${content}${separator}${additions.join("\n")}\n`,
    added: additions.length
  };
}

export function removeTaskDeletionMarker(
  content: string,
  taskLine: string
): { content: string; removed: boolean } {
  const fingerprint = taskDeletionFingerprint(taskLine);
  let removed = false;
  const next = content.replace(TASK_DELETION_MARKER_PATTERN, (full, current: string) => {
    if (String(current).toLowerCase() !== fingerprint) return full;
    removed = true;
    return "";
  });
  return {
    content: removed ? next.replace(/\n{3,}/gu, "\n\n") : content,
    removed
  };
}

export function filterSuppressedTaskLines(taskLines: string[], ledgerContent: string): string[] {
  const suppressed = parseTaskDeletionFingerprints(ledgerContent);
  if (suppressed.size === 0) return [...taskLines];
  return taskLines.filter((line) => !suppressed.has(taskDeletionFingerprint(line)));
}
