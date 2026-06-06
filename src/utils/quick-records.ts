const QUICK_RECORD_H2_RE = /^##\s+(?:快速记录|Quick Capture)\s*$/i;
const ANY_HEADING_RE = /^#{1,6}\s+/;
const QUICK_RECORD_LINE_RE = /^-\s*(?:(?:[01]\d|2[0-3]):[0-5]\d\s+)?(.+?)\s*$/;

function isPlaceholderText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^[_\s/\\.-]+$/.test(trimmed)) return true;
  if (/^(TODO|待填写|暂无|N\/A)$/i.test(trimmed)) return true;
  return false;
}

export function extractQuickRecordEntries(markdown: string): string[] {
  const lines = markdown.replace(/^---[\s\S]*?---\s*/m, "").split(/\r?\n/);
  const entries: string[] = [];
  let inQuickRecordBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (QUICK_RECORD_H2_RE.test(line)) {
      inQuickRecordBlock = true;
      continue;
    }

    if (!inQuickRecordBlock) continue;
    if (!line) continue;

    if (ANY_HEADING_RE.test(line)) {
      inQuickRecordBlock = false;
      continue;
    }

    const match = line.match(QUICK_RECORD_LINE_RE);
    if (!match) {
      inQuickRecordBlock = false;
      continue;
    }

    const text = match[1].trim();
    if (!isPlaceholderText(text)) {
      entries.push(text);
    }
  }

  return entries;
}

export function latestQuickRecord(markdown: string): string | null {
  const entries = extractQuickRecordEntries(markdown);
  return entries.length > 0 ? entries[entries.length - 1] : null;
}
