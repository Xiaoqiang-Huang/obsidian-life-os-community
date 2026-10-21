import { parseChatMarkdown, serializeChatMarkdown } from "../lifeos-logic";

export interface TranscriptMessage {
  role: "user" | "ai";
  content: string;
  at?: string;
  id?: string;
}

export interface TranscriptFallbackFrontmatter {
  date: string;
  title?: string;
  source?: string;
  channel?: string;
  projectId?: string;
  accountId?: string;
  conversationId?: string;
  senderId?: string;
  isGroup?: boolean;
  mode?: string;
  style?: string;
  length?: string;
  status?: string;
}

export interface TranscriptWriteInput {
  assistantName: string;
  messages: TranscriptMessage[];
  contextSources?: string[];
  fallbackFrontmatter: TranscriptFallbackFrontmatter;
  explicitClear?: boolean;
  now?: string;
}

export interface TranscriptAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface MergeResult {
  markdown: string;
  appended: number;
  total: number;
  existingMessages: number;
  changed: boolean;
}

const queues = new Map<string, Promise<unknown>>();

function sameMessage(a: { role: string; content: string }, b: { role: string; content: string }): boolean {
  return a.role === b.role && a.content === b.content;
}

export function mergeMessages<T extends { role: string; content: string }>(
  oldMessages: T[],
  newMessages: T[]
): { merged: T[]; appended: T[] } {
  // 1) old is a prefix of new: append the tail. A repeated "好" is a legitimate new message.
  if (newMessages.length >= oldMessages.length
    && oldMessages.every((message, index) => sameMessage(message, newMessages[index]))) {
    const appended = newMessages.slice(oldMessages.length);
    return { merged: [...oldMessages, ...appended], appended };
  }
  // 2) new is a prefix of old: the old file is already more complete.
  if (oldMessages.length >= newMessages.length
    && newMessages.every((message, index) => sameMessage(message, oldMessages[index]))) {
    return { merged: oldMessages, appended: [] };
  }
  // 3) Largest overlap between old suffix and new prefix; only append the unseen tail.
  const max = Math.min(oldMessages.length, newMessages.length);
  let overlap = 0;
  for (let k = max; k >= 1; k -= 1) {
    const oldTail = oldMessages.slice(oldMessages.length - k);
    if (oldTail.every((message, index) => sameMessage(message, newMessages[index]))) {
      overlap = k;
      break;
    }
  }
  const appended = newMessages.slice(overlap);
  return { merged: [...oldMessages, ...appended], appended };
}

export function mergeContextSources(...groups: Array<string[] | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group || []) {
      const value = String(item || "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function yamlScalar(value: string): string {
  const text = String(value ?? "");
  if (text && /^[A-Za-z0-9_./@+-]+$/u.test(text) && !/^(?:true|false|null|yes|no|on|off)$/iu.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return String(JSON.parse(trimmed)); } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function splitFrontmatter(markdown: string): { lines: string[]; body: string; hasFrontmatter: boolean } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!match) return { lines: [], body: markdown, hasFrontmatter: false };
  return { lines: match[1].split(/\r?\n/u), body: markdown.slice(match[0].length), hasFrontmatter: true };
}

function parseContextSources(lines: string[]): string[] {
  const start = lines.findIndex(line => /^context_sources:\s*/u.test(line));
  if (start < 0) return [];
  const inline = lines[start].replace(/^context_sources:\s*/u, "").trim();
  const result: string[] = [];
  if (inline && inline !== "[]") result.push(parseScalar(inline));
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s+-\s+/u.test(line)) break;
    result.push(parseScalar(line.replace(/^\s+-\s+/u, "")));
  }
  return result;
}

function buildFrontmatterLines(lines: string[], contextSources: string[], now: string, status: string): string[] {
  const result: string[] = [];
  let skippingContext = false;
  for (const line of lines) {
    if (/^context_sources:\s*/u.test(line)) { skippingContext = true; continue; }
    if (skippingContext && /^\s+-\s+/u.test(line)) continue;
    skippingContext = false;
    if (/^(?:updated_at|status):/u.test(line)) continue;
    result.push(line);
  }
  while (result.length && !result[result.length - 1].trim()) result.pop();
  result.push(`updated_at: ${yamlScalar(now)}`);
  result.push(`status: ${yamlScalar(status)}`);
  if (contextSources.length) {
    result.push(`context_sources:\n${contextSources.map(source => `  - ${yamlScalar(source)}`).join("\n")}`);
  } else {
    result.push("context_sources: []");
  }
  return result;
}

function formatMessage(message: TranscriptMessage, assistantName: string): string {
  return `## ${message.role === "user" ? "我" : assistantName}\n\n${String(message.content || "").trim()}`;
}

export function mergeTranscriptMarkdown(existing: string | null, input: TranscriptWriteInput): MergeResult {
  const assistantName = input.assistantName || "Life OS";
  const now = input.now || new Date().toISOString();
  const status = input.fallbackFrontmatter.status || "active";
  const contextSources = mergeContextSources(input.contextSources);
  if (input.explicitClear) {
    const markdown = serializeChatMarkdown({
      ...input.fallbackFrontmatter,
      assistantName,
      updatedAt: now,
      status,
      contextSources,
      messages: input.messages
    });
    return { markdown, appended: input.messages.length, total: input.messages.length, existingMessages: 0, changed: Boolean(existing) || input.messages.length > 0 };
  }
  if (!existing || !existing.trim()) {
    const markdown = serializeChatMarkdown({
      ...input.fallbackFrontmatter,
      assistantName,
      updatedAt: now,
      status,
      contextSources,
      messages: input.messages
    });
    return { markdown, appended: input.messages.length, total: input.messages.length, existingMessages: 0, changed: true };
  }
  const { lines, body, hasFrontmatter } = splitFrontmatter(existing);
  const oldMessages = parseChatMarkdown(existing, assistantName);
  const { appended } = mergeMessages(oldMessages, input.messages);
  const oldSources = parseContextSources(lines);
  const mergedSources = mergeContextSources(oldSources, contextSources);
  const sourcesChanged = mergedSources.length !== oldSources.length;
  if (!appended.length && !sourcesChanged) {
    return { markdown: existing, appended: 0, total: oldMessages.length, existingMessages: oldMessages.length, changed: false };
  }
  const nextLines = hasFrontmatter ? buildFrontmatterLines(lines, mergedSources, now, status) : [];
  const frontmatter = hasFrontmatter ? `---\n${nextLines.join("\n")}\n---\n\n` : "";
  const sections = appended.map(message => formatMessage(message, assistantName)).join("\n\n");
  const trimmedBody = body.replace(/\s+$/u, "");
  const nextBody = [trimmedBody, sections].filter(Boolean).join("\n\n");
  const markdown = `${frontmatter}${nextBody}${nextBody ? "\n" : ""}`;
  return {
    markdown,
    appended: appended.length,
    total: oldMessages.length + appended.length,
    existingMessages: oldMessages.length,
    changed: true
  };
}

export async function withTranscriptLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  queues.set(key, next.then(() => undefined, () => undefined));
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}

async function writeAtomic(adapter: TranscriptAdapter, path: string, markdown: string): Promise<void> {
  const temp = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    await adapter.write(temp, markdown);
    await adapter.rename(temp, path);
  } catch (error) {
    await adapter.remove(temp).catch(() => undefined);
    throw error;
  }
}

export async function saveTranscriptMerged(
  adapter: TranscriptAdapter,
  path: string,
  input: TranscriptWriteInput
): Promise<{ path: string; appended: number; total: number; atomic: boolean; preservedOld: boolean; changed: boolean }> {
  return withTranscriptLock(path, async () => {
    let existing: string | null = null;
    let readFailed = false;
    try {
      existing = await adapter.exists(path) ? await adapter.read(path) : null;
    } catch {
      readFailed = true;
    }
    if (readFailed && existing === null) {
      const assistantName = input.assistantName || "Life OS";
      const sections = input.messages.filter(message => String(message.content || "").trim()).map(message => formatMessage(message, assistantName)).join("\n\n");
      if (sections) await adapter.append(path, `\n\n${sections}\n`);
      return { path, appended: input.messages.length, total: input.messages.length, atomic: false, preservedOld: true, changed: Boolean(sections) };
    }
    const result = mergeTranscriptMarkdown(existing, input);
    if (!result.changed) return { path, appended: 0, total: result.total, atomic: true, preservedOld: false, changed: false };
    await writeAtomic(adapter, path, result.markdown);
    return { path, appended: result.appended, total: result.total, atomic: true, preservedOld: false, changed: true };
  });
}
