import type { LifeOSTask } from "../types";

export function parseTaskLine(line: string, source: "open" | "done"): LifeOSTask | null {
  const match = line.trim().match(/^-\s*\[([ xX])\]\s+(.+)$/);
  if (!match) return null;

  const isDone = match[1].toLowerCase() === "x";
  const body = match[2].trim();
  const tags = Array.from(body.matchAll(/#([^\s^]+)/g)).map((item) => item[1]);
  const dateMatch = body.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const projectMatch = body.match(/\bproject:([A-Za-z0-9_-]+)/);
  const text = body
    .replace(/\s*project:[A-Za-z0-9_-]+/g, "")
    .replace(/\s*#[^\s^]+/g, "")
    .replace(/\s*\^[^\s]+$/g, "")
    .trim();

  return {
    line: line.trim(),
    text,
    tags,
    date: dateMatch?.[1],
    projectId: projectMatch?.[1],
    source,
    isDone
  };
}

export function markdownHeading(title: string): string {
  return `# ${title}\n\n`;
}

export function firstContentLines(markdown: string, limit = 4): string[] {
  return markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\r?\n/)
    .map((line) => cleanDisplayLine(line))
    .filter((line): line is string => Boolean(line))
    .slice(0, limit);
}

export function cleanDisplayLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed === "---") return null;
  if (/^#+\s*$/.test(trimmed)) return null;
  if (/^#+\s+/.test(trimmed)) return null;
  if (/^\d+[.)、]?$/.test(trimmed)) return null;
  if (/^(今天|今日|明天|状态|心情|总结|复盘|计划|备注)[:：]\s*$/.test(trimmed)) return null;
  if (/^[-*+]\s*$/.test(trimmed)) return null;
  if (/^>\s*$/.test(trimmed)) return null;
  return trimmed
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)、]\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .trim() || null;
}
