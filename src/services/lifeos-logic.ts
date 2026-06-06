export interface DailyReviewInput {
  date: string;
  dailyContent: string;
  openTasks: string[];
  doneTasks: string[];
  checkinContent: string;
}

export interface ChatRecordInput {
  date: string;
  assistantName: string;
  mode?: string;
  style?: string;
  length?: string;
  status?: "completed" | "interrupted" | "error" | "saved" | string;
  contextSources?: string[];
  messages: Array<{ role: "user" | "ai"; content: string }>;
}

export interface MemoryCandidateInput {
  id?: string;
  content: string;
  category?: string;
  source?: string;
  created?: string;
  status?: "pending" | "confirmed" | "ignored" | string;
  importance?: "normal" | "important" | string;
  confirmed?: string;
  ignored?: string;
  lineStart?: number;
  lineEnd?: number;
  raw?: string;
}

export function buildDailyReviewMarkdown(input: DailyReviewInput): string {
  const quickLines = input.dailyContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, 8);
  const doneTasks = input.doneTasks.map(cleanTaskText);
  const openTasks = input.openTasks.map(cleanTaskText);
  const checkin = stripMarkdownTitle(input.checkinContent).slice(0, 600).trim();

  return `---\ntype: daily-summary\ndate: ${input.date}\nupdated: ${input.date}\n---\n\n# ${input.date} 复盘总结\n\n## 今日记录线索\n\n${asList(quickLines, "暂无快速记录。")}\n\n## 已完成任务\n\n${asList(doneTasks, "暂无已完成任务。")}\n\n## 未完成任务\n\n${asList(openTasks, "暂无未完成任务。")}\n\n## 学习打卡\n\n${checkin || "今日暂无学习打卡。"}\n\n## 高光时刻\n\n${doneTasks[0] ? `- ${doneTasks[0]}` : "- 等待从日记和任务中沉淀。"}\n\n## 明日建议\n\n${openTasks[0] ? `- 优先推进：${openTasks[0]}` : "- 保持轻量记录，晚上做一次 5 分钟复盘。"}\n`;
}

export function completeTaskMarkdown(openContent: string, doneContent: string, taskLine: string, completedAt = nowStamp()): {
  openContent: string;
  doneContent: string;
  doneLine: string;
} {
  const date = completedAt.slice(0, 10);
  const cleanOpenLine = taskLine.replace(/^-\s*\[[ xX]\]/, "- [ ]").trim();
  const withoutComplete = cleanOpenLine
    .replace(/\s*✅\s*20\d{2}-\d{2}-\d{2}/g, "")
    .replace(/\s+\^/, " ^")
    .trim();
  const doneLine = appendBeforeBlockId(withoutComplete.replace(/^-\s*\[ \]/, "- [x]"), `✅ ${date}`);
  const removed = removeTaskBlock(openContent, taskLine);
  if (!removed.removedLine) return { openContent, doneContent, doneLine };

  const doneBlock = [
    doneLine,
    `  - completed: ${completedAt}`,
    ...taskMetadataLines(taskLine)
  ].join("\n");
  return {
    openContent: removed.content,
    doneContent: doneContent.includes(doneLine) ? doneContent : appendLine(doneContent, doneBlock),
    doneLine
  };
}

export function undoTaskMarkdown(openContent: string, doneContent: string, originalDoneLine: string): {
  openContent: string;
  doneContent: string;
} {
  const removed = removeTaskBlock(doneContent, originalDoneLine);
  const sourceLine = removed.removedLine || originalDoneLine;
  const openLine = sourceLine
    .replace(/^-\s*\[[xX]\]/, "- [ ]")
    .replace(/\s*✅\s*20\d{2}-\d{2}-\d{2}/g, "")
    .replace(/\s+\^/, " ^")
    .trim();
  return {
    openContent: openContent.includes(openLine) ? openContent : appendLine(openContent, openLine),
    doneContent: ensureTrailingNewline(removed.content)
  };
}

export function carryoverOpenTasks(content: string, today: string, tomorrow: string): { content: string; count: number } {
  let count = 0;
  const lines = content.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- [ ]") || trimmed.includes("🔁")) return line;
    const date = trimmed.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
    if (date && date >= today) return line;
    count += 1;
    return appendBeforeBlockId(line, `🔁 ${tomorrow}`);
  });
  return { content: lines.join("\n"), count };
}

export function serializeChatMarkdown(input: ChatRecordInput): string {
  const body = input.messages
    .map((message) => {
      const title = message.role === "user" ? "我" : input.assistantName;
      return `## ${title}\n\n${message.content.trim()}`;
    })
    .join("\n\n");
  const contextSources = input.contextSources?.length
    ? `context_sources:\n${input.contextSources.map((source) => `  - ${source}`).join("\n")}`
    : "context_sources: []";
  const frontmatter = [
    "---",
    "type: chat",
    `date: ${input.date}`,
    `mode: ${input.mode ?? "chat"}`,
    `style: ${input.style ?? ""}`,
    `length: ${input.length ?? ""}`,
    `status: ${input.status ?? "completed"}`,
    contextSources,
    "---"
  ].join("\n");
  return `${frontmatter}\n\n# ${input.assistantName} Chat ${input.date}\n\n${body}\n`;
}

export function parseChatMarkdown(markdown: string, assistantName: string): Array<{ role: "user" | "ai"; content: string }> {
  const lines = markdown.split(/\r?\n/);
  const messages: Array<{ role: "user" | "ai"; content: string }> = [];
  let currentRole: "user" | "ai" | null = null;
  let current: string[] = [];

  const flush = () => {
    if (!currentRole) return;
    const content = current.join("\n").trim();
    if (content) messages.push({ role: currentRole, content });
  };

  for (const line of lines) {
    if (line.trim() === "## 我") {
      flush();
      currentRole = "user";
      current = [];
      continue;
    }
    if (line.trim() === `## ${assistantName}` || line.trim() === "## Life OS") {
      flush();
      currentRole = "ai";
      current = [];
      continue;
    }
    if (currentRole) current.push(line);
  }
  flush();
  return messages;
}

export function parseCategoryMemories(markdown: string): Array<{ content: string; source: string; created: string; status: string }> {
  return parseMemoryBlocks(markdown).map((block) => ({
    content: block.content,
    source: block.meta.source || "",
    created: block.meta.created || block.meta.confirmed || "",
    status: "confirmed"
  }));
}

export function parseIgnoredMemories(markdown: string): Array<{ content: string; source: string; created: string; status: string }> {
  return parseMemoryBlocks(markdown)
    .filter((block) => block.checked || block.meta.status === "ignored")
    .filter((block) => block.meta.status === "ignored")
    .map((block) => ({
      content: block.content,
      source: block.meta.source || "",
      created: block.meta.created || "",
      status: "ignored"
    }));
}

export function parseMemoryBlock(block: string, fallbackCreated = nowStamp()): MemoryCandidateInput | null {
  const lines = block.split(/\r?\n/);
  const first = lines.find((line) => line.trim());
  if (!first) return null;
  const standard = first.match(/^-\s*\[([ xX])\]\s+(.+)$/);
  const legacy = first.match(/^-\s*(?!\[)(.+?)(?:（([^，）]+)，来源：(.+?)）)?\s*$/);
  if (!standard && !legacy) return null;

  const content = (standard?.[2] ?? legacy?.[1] ?? "").trim();
  if (!content || content.startsWith("#")) return null;
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const match = line.match(/^\s+-\s+([^:：]+)[:：]\s*(.+)$/);
    if (match) meta[match[1].trim()] = match[2].trim();
  }
  const status = meta.status || (standard?.[1]?.toLowerCase() === "x" ? "confirmed" : "pending");
  return {
    id: meta.id || `mem_${simpleHash(content + (meta.created || legacy?.[2] || fallbackCreated))}`,
    content,
    category: meta.category || "其他",
    source: meta.source || legacy?.[3]?.trim() || "quick-capture",
    created: meta.created || legacy?.[2]?.trim() || fallbackCreated,
    status,
    importance: normalizeImportance(meta.importance),
    confirmed: meta.confirmed || "",
    ignored: meta.ignored || "",
    raw: block
  };
}

export function parsePendingMemories(markdown: string, fallbackCreated = nowStamp()): MemoryCandidateInput[] {
  const blocks = splitMemoryCandidateBlocks(markdown);
  const entries: MemoryCandidateInput[] = [];
  for (const block of blocks) {
    const parsed = parseMemoryBlock(block.raw, fallbackCreated);
    if (!parsed || !parsed.content || parsed.status !== "pending") continue;
    entries.push({ ...parsed, lineStart: block.lineStart, lineEnd: block.lineEnd, raw: block.raw });
  }
  return entries;
}

export function formatMemoryCandidate(input: MemoryCandidateInput, status = input.status || "pending"): string {
  const checked = status === "pending" ? " " : "x";
  const lines = [
    `- [${checked}] ${input.content.trim()}`,
    `  - id: ${input.id || `mem_${simpleHash(input.content + (input.created || ""))}`}`,
    `  - category: ${input.category || "其他"}`,
    `  - source: ${input.source || "quick-capture"}`,
    `  - created: ${input.created || nowStamp()}`
  ];
  if (status === "confirmed") lines.push(`  - confirmed: ${input.confirmed || nowStamp()}`);
  if (status === "ignored") lines.push(`  - ignored: ${input.ignored || nowStamp()}`);
  lines.push(`  - status: ${status}`);
  lines.push(`  - importance: ${normalizeImportance(input.importance)}`);
  return `${lines.join("\n")}\n`;
}

export function updateMemoryStatus(
  markdown: string,
  entries: MemoryCandidateInput[],
  status: "confirmed" | "ignored",
  timestamp = nowStamp()
): string {
  const lines = markdown.split(/\r?\n/);
  const blocks = splitMemoryCandidateBlocks(markdown);
  const targets = new Set(entries.map((entry) => entry.id).filter(Boolean));
  const contentTargets = new Set(entries.map((entry) => entry.content.trim()));
  for (const block of [...blocks].reverse()) {
    const parsed = parseMemoryBlock(block.raw, timestamp);
    if (!parsed) continue;
    if (!targets.has(parsed.id || "") && !contentTargets.has(parsed.content.trim())) continue;
    const edited = entries.find((entry) => entry.id === parsed.id || entry.content.trim() === parsed.content.trim()) ?? parsed;
    const next = formatMemoryCandidate({
      ...parsed,
      ...edited,
      status,
      confirmed: status === "confirmed" ? timestamp : parsed.confirmed,
      ignored: status === "ignored" ? timestamp : parsed.ignored
    }, status).trimEnd().split(/\r?\n/);
    lines.splice(block.lineStart, block.lineEnd - block.lineStart + 1, ...next);
  }
  return ensureTrailingNewline(lines.join("\n"));
}

export function appendConfirmedMemory(markdown: string, entry: MemoryCandidateInput, timestamp = nowStamp()): string {
  const block = [
    `- ${entry.content.trim()}`,
    `  - id: ${entry.id || `mem_${simpleHash(entry.content + (entry.created || ""))}`}`,
    `  - category: ${entry.category || "其他"}`,
    `  - source: ${entry.source || "quick-capture"}`,
    `  - created: ${entry.created || timestamp}`,
    `  - confirmed: ${timestamp}`,
    "  - status: confirmed",
    `  - importance: ${normalizeImportance(entry.importance)}`
  ].join("\n");
  return appendLine(markdown, block);
}

function parseMemoryBlocks(markdown: string): Array<{
  content: string;
  checked: boolean;
  meta: Record<string, string>;
}> {
  const lines = markdown.split(/\r?\n/);
  const blocks: Array<{ content: string; checked: boolean; meta: Record<string, string> }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^-\s*(?:\[([ xX])\]\s*)?(.+)$/);
    if (!match) continue;
    const meta: Record<string, string> = {};
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const metaMatch = lines[cursor].match(/^\s+-\s+([^:：]+)[:：]\s*(.+)$/);
      if (!metaMatch) break;
      meta[metaMatch[1].trim()] = metaMatch[2].trim();
      index = cursor;
    }
    blocks.push({
      content: match[2].trim(),
      checked: (match[1] || "").toLowerCase() === "x",
      meta
    });
  }
  return blocks;
}

function splitMemoryCandidateBlocks(markdown: string): Array<{ raw: string; lineStart: number; lineEnd: number }> {
  const lines = markdown.split(/\r?\n/);
  const blocks: Array<{ raw: string; lineStart: number; lineEnd: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^-\s+(?:\[[ xX]\]\s+)?/.test(line)) continue;
    const start = index;
    let end = index;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^-\s+(?:\[[ xX]\]\s+)?/.test(lines[cursor])) break;
      if (lines[cursor].trim() && !/^\s+-\s+/.test(lines[cursor])) break;
      end = cursor;
    }
    blocks.push({ raw: lines.slice(start, end + 1).join("\n"), lineStart: start, lineEnd: end });
    index = end;
  }
  return blocks;
}

function removeTaskBlock(content: string, taskLine: string): { content: string; removedLine: string } {
  const lines = content.split(/\r?\n/);
  const targetId = taskLine.match(/\^([A-Za-z0-9_-]+)/)?.[1];
  const targetTrimmed = taskLine.trim();
  const targetComparable = comparableTaskLine(taskLine);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^-\s*\[[ xX]\]/.test(line.trim())) continue;
    const id = line.match(/\^([A-Za-z0-9_-]+)/)?.[1];
    const matches = targetId ? id === targetId : line.trim() === targetTrimmed || comparableTaskLine(line) === targetComparable;
    if (!matches) continue;
    let end = index;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^-\s*\[[ xX]\]/.test(lines[cursor].trim())) break;
      if (lines[cursor].trim() && !/^\s+-\s+/.test(lines[cursor])) break;
      end = cursor;
    }
    const removedLine = line.trim();
    lines.splice(index, end - index + 1);
    return { content: ensureTrailingNewline(lines.join("\n")), removedLine };
  }
  return { content, removedLine: "" };
}

function comparableTaskLine(line: string): string {
  return line
    .replace(/^-\s*\[[ xX]\]/, "")
    .replace(/\s*✅\s*20\d{2}-\d{2}-\d{2}/g, "")
    .replace(/\s*\^[^\s]+/g, "")
    .trim();
}

function taskMetadataLines(taskLine: string): string[] {
  const lines: string[] = [];
  const source = taskLine.match(/\bsource:([^\s]+)/)?.[1];
  const project = taskLine.match(/\bproject:([A-Za-z0-9_-]+)/)?.[1];
  const priority = taskLine.match(/#priority\/([^\s^]+)/)?.[1];
  if (source) lines.push(`  - source: ${source}`);
  if (project) lines.push(`  - project: ${project}`);
  if (priority) lines.push(`  - priority: ${priority}`);
  return lines;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function normalizeImportance(value = "normal"): string {
  const normalized = String(value || "normal").trim().toLowerCase();
  return normalized === "重要" || normalized === "important" || normalized === "high" ? "important" : "normal";
}

function nowStamp(): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function simpleHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

function cleanTaskText(line: string): string {
  return line
    .replace(/^-\s*\[[ xX]\]\s*/, "")
    .replace(/\s*#\S+/g, "")
    .replace(/\s*\^\S+$/g, "")
    .trim();
}

function asList(lines: string[], empty: string): string {
  const clean = lines.map((line) => line.trim()).filter(Boolean);
  return clean.length ? clean.map((line) => `- ${line.replace(/^-\s*/, "")}`).join("\n") : empty;
}

function appendLine(content: string, line: string): string {
  return `${content.trimEnd()}\n${line}\n`;
}

function appendBeforeBlockId(line: string, addition: string): string {
  const match = line.match(/\s+\^(\S+)$/);
  if (!match) return `${line} ${addition}`;
  return `${line.slice(0, match.index)} ${addition}${match[0]}`;
}

function stripMarkdownTitle(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();
}
