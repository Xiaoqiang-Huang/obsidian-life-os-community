import type {
  AiWorkspaceFileReference,
  AiWorkspaceImportOptions,
  AiWorkspaceMessage,
  AiWorkspaceParsedSession,
  AiWorkspaceSessionAnalysis,
  AiWorkspaceSourceCandidate
} from "./types";

const FILE_REFERENCE_PATTERN = /(?:(?:[A-Za-z]:[\\/])|(?:\.{0,2}[\\/]))?[A-Za-z0-9_\-.\u4e00-\u9fff]+(?:[\\/][A-Za-z0-9_\-.\u4e00-\u9fff]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|css|scss|html|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|yaml|yml|toml|sql|sh|ps1|txt|csv|docx?|pdf)\b/giu;
const QUOTED_FILE_REFERENCE_PATTERN = /[`"']((?:(?:[A-Za-z]:[\\/])|(?:\.{1,2}[\\/]))[^`"'\r\n]+?\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|css|scss|html|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|yaml|yml|toml|sql|sh|ps1|txt|csv|docx?|pdf)(?::(\d+))?)[`"']/giu;
const IMPORTANT_PATTERN = /(?:结论|决定|已完成|完成了|下一步|待办|todo|修复|失败|错误|阻塞|方案|验收|发布|commit|merged?|resolved?)/iu;
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|ak)[-_][A-Za-z0-9_-]{16,}\b/giu,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/gu,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^"'\s]{8,}/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu
];

interface JsonRecord {
  [key: string]: unknown;
}

interface RawParentMap {
  [sourceId: string]: string | undefined;
}

export function stableTextHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function normalizeWorkspacePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function pathsBelongTogether(left: string, right: string): boolean {
  const a = normalizeWorkspacePath(left);
  const b = normalizeWorkspacePath(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function parseCodexSessionNames(content: string): Map<string, string> {
  const records = new Map<string, { name: string; updatedAt: number; line: number }>();
  content.split(/\r?\n/gu).forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let row: JsonRecord;
    try {
      row = objectValue(JSON.parse(trimmed));
    } catch {
      return;
    }
    const id = compactText(row.id);
    const name = compactText(row.thread_name || row.name);
    if (!id || !name) return;
    const parsedTime = Date.parse(compactText(row.updated_at));
    const updatedAt = Number.isFinite(parsedTime) ? parsedTime : -1;
    const previous = records.get(id);
    if (
      !previous
      || updatedAt > previous.updatedAt
      || (updatedAt === previous.updatedAt && lineIndex > previous.line)
    ) {
      records.set(id, { name, updatedAt, line: lineIndex });
    }
  });
  return new Map(Array.from(records, ([id, record]) => [id, record.name]));
}

export function redactWorkspaceSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[已脱敏]"), value);
}

export function extractWorkspaceFileReferences(value: string): AiWorkspaceFileReference[] {
  const seen = new Set<string>();
  const references: AiWorkspaceFileReference[] = [];
  const append = (raw: string, line?: number): void => {
    const path = raw.replace(/:\d+$/, "").replace(/[),.;:'"`]+$/g, "").replace(/\\/g, "/");
    const key = path.toLowerCase();
    if (!path || seen.has(key)) return;
    seen.add(key);
    references.push({ path, line, kind: "reference" });
  };
  for (const match of value.matchAll(QUOTED_FILE_REFERENCE_PATTERN)) {
    append(match[1], match[2] ? Number(match[2]) : undefined);
  }
  const unquoted = value.replace(QUOTED_FILE_REFERENCE_PATTERN, " ");
  for (const match of unquoted.match(FILE_REFERENCE_PATTERN) ?? []) {
    append(match);
  }
  return references.slice(0, 80);
}

function compactText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isoTimestamp(value: unknown, fallback = ""): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value.trim() : date.toISOString();
  }
  return fallback;
}

function makeMessage(input: {
  id: string;
  sourceId: string;
  parentId?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  sequence: number;
  kind?: "message" | "tool";
  toolName?: string;
  includeFileReferences: boolean;
  redactSecrets: boolean;
}): AiWorkspaceMessage | null {
  const content = input.redactSecrets ? redactWorkspaceSecrets(input.content) : input.content.trim();
  if (!content) return null;
  const fileReferences = input.includeFileReferences ? extractWorkspaceFileReferences(content) : [];
  return {
    id: input.id,
    sourceId: input.sourceId,
    parentId: input.parentId,
    role: input.role,
    content,
    timestamp: input.timestamp,
    sequence: input.sequence,
    kind: input.kind ?? "message",
    toolName: input.toolName,
    fileReferences,
    important: IMPORTANT_PATTERN.test(content) || fileReferences.length > 0,
    contentHash: stableTextHash(`${input.role}\n${content}`)
  };
}

function uniqueFileReferences(messages: AiWorkspaceMessage[]): AiWorkspaceFileReference[] {
  const seen = new Set<string>();
  const output: AiWorkspaceFileReference[] = [];
  for (const message of messages) {
    for (const reference of message.fileReferences) {
      const key = `${reference.path.toLowerCase()}:${reference.line ?? ""}:${reference.kind ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(reference);
    }
  }
  return output.slice(0, 500);
}

function titleFromMessages(candidate: AiWorkspaceSourceCandidate, messages: AiWorkspaceMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  return workspaceSessionDisplayTitle(
    candidate.title,
    firstUser?.content ?? "",
    `${candidate.tool} 会话 ${candidate.sourceSessionId.slice(0, 8)}`
  );
}

export function buildRuleSessionAnalysis(messages: AiWorkspaceMessage[]): AiWorkspaceSessionAnalysis {
  const visible = messages.filter((message) => message.kind === "message");
  const important = visible.filter((message) => message.important);
  const outlineSource = visible.length <= 120
    ? visible
    : Array.from(new Map([
        ...visible.slice(0, 12),
        ...important,
        ...visible.slice(-36)
      ].map((message) => [message.id, message])).values()).slice(0, 120);
  const outline = outlineSource.map((message, index) => ({
    nodeId: message.id,
    title: `${String(index + 1).padStart(2, "0")} · ${workspaceNodePurposeLabel(message.content, message.role)}`,
    description: workspaceNodeDescription(message.content, message.role, 84)
  }));
  const conclusions = important
    .filter((message) => message.role === "assistant" && /(?:结论|决定|建议|已完成|完成了|修复|方案)/iu.test(message.content))
    .slice(-12)
    .map((message) => ({
      text: cleanWorkspaceDisplayText(message.content, 220),
      nodeIds: [message.id],
      status: "candidate" as const
    }));
  const tasks = important
    .filter((message) => /(?:下一步|待办|todo|需要|应当|计划|继续)/iu.test(message.content))
    .slice(-12)
    .map((message) => ({
      text: cleanWorkspaceDisplayText(message.content, 180),
      nodeIds: [message.id],
      status: "candidate" as const
    }));
  const lastAssistant = [...visible].reverse().find((message) => message.role === "assistant");
  return {
    summary: lastAssistant
      ? cleanWorkspaceDisplayText(lastAssistant.content, 360)
      : visible.length > 0
        ? cleanWorkspaceDisplayText(visible[visible.length - 1].content, 360)
        : "尚未提取到可读对话。",
    outline,
    conclusions,
    tasks,
    promptCandidates: [],
    generatedAt: new Date().toISOString(),
    method: "rules"
  };
}

export function summarizeWorkspaceNode(
  value: string,
  role: AiWorkspaceMessage["role"],
  maxChars = 96
): string {
  const plain = cleanWorkspaceDisplayText(value, Math.max(maxChars * 2, 160));
  const firstSentence = plain.match(/^.*?[。！？!?；;]/u)?.[0] ?? plain;
  const label = workspaceNodePurposeLabel(plain, role);
  const clipped = previewText(firstSentence || "未提供可读内容", Math.max(24, maxChars - label.length - 2));
  return `${label}：${clipped}`;
}

function workspaceNodeDescription(
  value: string,
  role: AiWorkspaceMessage["role"],
  maxChars: number
): string {
  const summary = summarizeWorkspaceNode(value, role, maxChars);
  const separator = summary.indexOf("：");
  return separator >= 0 ? summary.slice(separator + 1).trim() : summary;
}

function workspaceNodePurposeLabel(value: string, role: AiWorkspaceMessage["role"]): string {
  const text = cleanWorkspaceDisplayText(value, 220);
  if (role === "tool") {
    if (/(?:test|check|lint|build|编译|测试|校验|验证)/iu.test(text)) return "运行验证";
    if (/(?:write|patch|apply|edit|修改|写入|保存)/iu.test(text)) return "修改文件";
    if (/(?:read|open|cat|search|find|rg\b|读取|搜索|检查)/iu.test(text)) return "读取信息";
    return "执行工具";
  }
  if (role === "user") {
    if (/[？?]|(?:为什么|怎么|是否|能否|请问)/u.test(text)) return "提出问题";
    if (/(?:修复|优化|改进|调整|实现|增加|删除|生成|设计|检查|验证|导入)/u.test(text)) return "提出需求";
    if (/(?:补充|还有|另外|同时|改为|我希望)/u.test(text)) return "补充要求";
    return "说明目标";
  }
  const hasNegatedProblem = /(?:无|没有|未发现|未出现|不存在|已解决|已排除)(?:新增)?(?:问题|错误|异常|失败|阻塞)|(?:no|without)\s+(?:new\s+)?(?:issues?|errors?|failures?|blocks?)/iu.test(text);
  if (!hasNegatedProblem && /(?:失败|错误|异常|阻塞|无法|未通过|error|fail)/iu.test(text)) return "发现问题";
  if (/(?:下一步|接下来|待办|仍需|还需要|计划|todo)/iu.test(text)) return "安排下一步";
  if (/(?:已完成|完成了|已实现|已修复|已更新|已生成|通过|成功|done|fixed|completed)/iu.test(text)) return "报告进展";
  if (/(?:结论|决定|建议|方案|判断|原因)/u.test(text)) return "给出结论";
  return "分析回应";
}

export function cleanWorkspaceDisplayText(value: string, maxChars = 240): string {
  const source = String(value ?? "");
  const embeddedMessages = Array.from(source.matchAll(/<message(?:\s[^>]*)?>([\s\S]*?)<\/message>/giu))
    .map((match) => match[1].trim())
    .filter(Boolean);
  const base = embeddedMessages.length > 0 ? embeddedMessages.join(" ") : source;
  const plain = base
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/```[\s\S]*?```/gu, " 提供了一段代码或配置 ")
    .replace(/`([^`\r\n]{1,160})`/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\btext\s+id\s*=\s*"[^"]*"/giu, " ")
    .replace(/^\s*#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/^\s*\d+[.)]\s+/gmu, "")
    .replace(/[*_~]{2,}/gu, "")
    .replace(/\s*\|\s*/gu, " · ")
    .replace(/\s+/gu, " ")
    .trim();
  return previewText(plain || "未提取到可读内容。", maxChars);
}

export function workspaceSessionDisplayTitle(
  title: string,
  summary = "",
  fallback = "未命名会话",
  maxChars = 72
): string {
  const cleanedTitle = cleanWorkspaceDisplayText(title, Math.max(maxChars * 3, 180));
  const titleIsSystemNoise = /^(?:Caveat:\s*The messages below|API Error:|未提取到可读内容)/iu.test(cleanedTitle);
  const source = titleIsSystemNoise
    ? cleanWorkspaceDisplayText(summary, Math.max(maxChars * 2, 140))
    : cleanedTitle;
  const firstSentence = source.match(/^.*?[。！？!?；;]/u)?.[0] ?? source;
  const titleCandidate = titleIsSystemNoise && firstSentence.length < 12 ? source : firstSentence;
  const readable = titleCandidate && !/^未提取到可读内容/u.test(titleCandidate) ? titleCandidate : fallback;
  return previewText(readable, maxChars);
}

function previewText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 3))}...` : compact;
}

export class CodexTranscriptParser {
  private messages: AiWorkspaceMessage[] = [];
  private lineNumber = 0;
  private lastVisibleId = "";

  constructor(
    private candidate: AiWorkspaceSourceCandidate,
    private options: AiWorkspaceImportOptions
  ) {}

  consume(line: string): void {
    this.lineNumber += 1;
    let row: JsonRecord;
    try {
      row = objectValue(JSON.parse(line));
    } catch {
      return;
    }
    const payload = objectValue(row.payload);
    const timestamp = isoTimestamp(row.timestamp, this.candidate.updatedAt);
    if (row.type === "session_meta") {
      this.candidate.sourceSessionId = compactText(payload.session_id || payload.id) || this.candidate.sourceSessionId;
      this.candidate.cwd = compactText(payload.cwd) || this.candidate.cwd;
      this.candidate.model = compactText(payload.model || payload.model_provider) || this.candidate.model;
      return;
    }
    if (row.type === "event_msg") {
      const eventType = compactText(payload.type);
      if (eventType === "user_message" || eventType === "agent_message") {
        const content = compactText(payload.message);
        const role = eventType === "user_message" ? "user" : "assistant";
        this.pushMessage(makeMessage({
          id: `codex-${this.lineNumber}-${stableTextHash(`${timestamp}\n${content}`)}`,
          sourceId: compactText(payload.client_id) || `line-${this.lineNumber}`,
          parentId: this.lastVisibleId || undefined,
          role,
          content,
          timestamp,
          sequence: this.messages.length,
          includeFileReferences: this.options.includeFileReferences,
          redactSecrets: this.options.redactSecrets
        }));
      }
      return;
    }
    if (!this.options.includeToolCalls || row.type !== "response_item") return;
    const itemType = compactText(payload.type);
    if (!["function_call", "custom_tool_call"].includes(itemType)) return;
    const toolName = compactText(payload.name || payload.tool_name) || "tool";
    const input = compactText(payload.arguments || payload.input);
    this.pushMessage(makeMessage({
      id: `codex-tool-${this.lineNumber}-${stableTextHash(`${toolName}\n${input}`)}`,
      sourceId: compactText(payload.call_id || payload.id) || `line-${this.lineNumber}`,
      parentId: this.lastVisibleId || undefined,
      role: "tool",
      content: input ? `${toolName}\n${input}` : toolName,
      timestamp,
      sequence: this.messages.length,
      kind: "tool",
      toolName,
      includeFileReferences: this.options.includeFileReferences,
      redactSecrets: this.options.redactSecrets
    }));
  }

  finish(): AiWorkspaceParsedSession {
    this.candidate.title = titleFromMessages(this.candidate, this.messages);
    return {
      source: this.candidate,
      messages: this.messages,
      fileReferences: uniqueFileReferences(this.messages),
      ruleAnalysis: buildRuleSessionAnalysis(this.messages)
    };
  }

  private pushMessage(message: AiWorkspaceMessage | null): void {
    if (!message) return;
    this.messages.push(message);
    this.lastVisibleId = message.id;
  }
}

export class ClaudeTranscriptParser {
  private messages: AiWorkspaceMessage[] = [];
  private lineNumber = 0;
  private lastVisibleId = "";
  private rawParents: RawParentMap = {};
  private visibleByRawId = new Map<string, string>();

  constructor(
    private candidate: AiWorkspaceSourceCandidate,
    private options: AiWorkspaceImportOptions
  ) {}

  consume(line: string): void {
    this.lineNumber += 1;
    let row: JsonRecord;
    try {
      row = objectValue(JSON.parse(line));
    } catch {
      return;
    }
    const type = compactText(row.type);
    if (type !== "user" && type !== "assistant") return;
    const rawId = compactText(row.uuid) || `line-${this.lineNumber}`;
    const rawParent = compactText(row.parentUuid) || undefined;
    this.rawParents[rawId] = rawParent;
    this.candidate.sourceSessionId = compactText(row.sessionId) || this.candidate.sourceSessionId;
    this.candidate.cwd = compactText(row.cwd) || this.candidate.cwd;
    const message = objectValue(row.message);
    this.candidate.model = compactText(message.model) || this.candidate.model;
    const timestamp = isoTimestamp(row.timestamp, this.candidate.updatedAt);
    const content = message.content;
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : arrayValue(content).map(objectValue);
    let previousPartId = "";
    parts.forEach((part, partIndex) => {
      const partType = compactText(part.type) || "text";
      if (partType === "thinking") return;
      if (partType === "tool_result" && !this.options.includeToolCalls) return;
      if (partType === "tool_use" && !this.options.includeToolCalls) return;
      if (!["text", "tool_use", "tool_result"].includes(partType)) return;
      const role = partType === "text" ? type : "tool";
      const toolName = compactText(part.name) || (partType === "tool_result" ? "tool-result" : undefined);
      const text = partType === "text"
        ? compactText(part.text)
        : partType === "tool_use"
          ? `${toolName ?? "tool"}\n${compactText(part.input)}`
          : `${toolName ?? "tool-result"}\n${compactText(part.content)}`;
      const id = `claude-${rawId}-${partIndex}`;
      const parentId = previousPartId || this.resolveVisibleParent(rawParent) || this.lastVisibleId || undefined;
      const normalized = makeMessage({
        id,
        sourceId: rawId,
        parentId,
        role,
        content: text,
        timestamp,
        sequence: this.messages.length,
        kind: role === "tool" ? "tool" : "message",
        toolName,
        includeFileReferences: this.options.includeFileReferences,
        redactSecrets: this.options.redactSecrets
      });
      if (!normalized) return;
      this.messages.push(normalized);
      previousPartId = normalized.id;
      this.lastVisibleId = normalized.id;
      this.visibleByRawId.set(rawId, normalized.id);
    });
  }

  finish(): AiWorkspaceParsedSession {
    this.candidate.title = titleFromMessages(this.candidate, this.messages);
    return {
      source: this.candidate,
      messages: this.messages,
      fileReferences: uniqueFileReferences(this.messages),
      ruleAnalysis: buildRuleSessionAnalysis(this.messages)
    };
  }

  private resolveVisibleParent(rawId: string | undefined): string {
    let current = rawId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const visible = this.visibleByRawId.get(current);
      if (visible) return visible;
      current = this.rawParents[current];
    }
    return "";
  }
}

function visibleContentText(
  value: unknown,
  acceptedTypes: ReadonlySet<string>
): string {
  if (typeof value === "string") return value.trim();
  return arrayValue(value)
    .map(objectValue)
    .filter((part) => acceptedTypes.has(compactText(part.type)))
    .map((part) => compactText(part.text || part.content))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function stripBuddyInjectedContext(value: string): string {
  return value
    .replace(/<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/giu, " ")
    .replace(/<local-command-caveat(?:\s[^>]*)?>[\s\S]*?<\/local-command-caveat>/giu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * CodeBuddy and WorkBuddy currently persist the same append-only JSONL family.
 * Keep this parser source-aware so either vendor can evolve independently later.
 */
export class BuddyTranscriptParser {
  private messages: AiWorkspaceMessage[] = [];
  private lineNumber = 0;
  private lastVisibleId = "";
  private rawParents: RawParentMap = {};
  private visibleByRawId = new Map<string, string>();
  private explicitTitle = "";

  constructor(
    private candidate: AiWorkspaceSourceCandidate,
    private options: AiWorkspaceImportOptions
  ) {}

  consume(line: string): void {
    this.lineNumber += 1;
    let row: JsonRecord;
    try {
      row = objectValue(JSON.parse(line));
    } catch {
      return;
    }
    const type = compactText(row.type);
    const rawId = compactText(row.id) || `line-${this.lineNumber}`;
    const rawParent = compactText(row.parentId) || undefined;
    this.rawParents[rawId] = rawParent;
    this.candidate.sourceSessionId = compactText(row.sessionId) || this.candidate.sourceSessionId;
    this.candidate.cwd = compactText(row.cwd) || this.candidate.cwd;
    const provider = objectValue(row.providerData);
    this.candidate.model = compactText(
      provider.requestModelName || provider.model || provider.requestModelId
    ) || this.candidate.model;
    const timestamp = isoTimestamp(row.timestamp, this.candidate.updatedAt);

    if (type === "ai-title") {
      this.explicitTitle = compactText(row.aiTitle);
      return;
    }
    if (type === "message") {
      const role = compactText(row.role);
      if (role !== "user" && role !== "assistant") return;
      const accepted = role === "user"
        ? new Set(["input_text", "text"])
        : new Set(["output_text", "text"]);
      const rawText = visibleContentText(row.content, accepted);
      const content = role === "user" ? stripBuddyInjectedContext(rawText) : rawText;
      this.pushMessage(rawId, rawParent, makeMessage({
        id: `${this.candidate.tool}-${rawId}`,
        sourceId: rawId,
        parentId: this.resolveVisibleParent(rawParent) || this.lastVisibleId || undefined,
        role,
        content,
        timestamp,
        sequence: this.messages.length,
        includeFileReferences: this.options.includeFileReferences,
        redactSecrets: this.options.redactSecrets
      }));
      return;
    }
    if (!this.options.includeToolCalls) return;
    if (type === "function_call") {
      const toolName = compactText(row.name) || "tool";
      const callId = compactText(row.callId) || rawId;
      const input = compactText(row.argumentsDisplayText || row.arguments);
      this.pushMessage(rawId, rawParent, makeMessage({
        id: `${this.candidate.tool}-tool-${callId}-${this.lineNumber}`,
        sourceId: `${callId}:call`,
        parentId: this.resolveVisibleParent(rawParent) || this.lastVisibleId || undefined,
        role: "tool",
        content: input ? `${toolName}\n${input}` : toolName,
        timestamp,
        sequence: this.messages.length,
        kind: "tool",
        toolName,
        includeFileReferences: this.options.includeFileReferences,
        redactSecrets: this.options.redactSecrets
      }));
      return;
    }
    if (type === "function_call_result") {
      const toolName = compactText(row.name) || "tool-result";
      const callId = compactText(row.callId) || rawId;
      const output = compactText(row.output);
      const status = compactText(row.status);
      this.pushMessage(rawId, rawParent, makeMessage({
        id: `${this.candidate.tool}-result-${callId}-${this.lineNumber}`,
        sourceId: `${callId}:result`,
        parentId: this.resolveVisibleParent(rawParent) || this.lastVisibleId || undefined,
        role: "tool",
        content: [toolName, status ? `状态：${status}` : "", output].filter(Boolean).join("\n"),
        timestamp,
        sequence: this.messages.length,
        kind: "tool",
        toolName,
        includeFileReferences: this.options.includeFileReferences,
        redactSecrets: this.options.redactSecrets
      }));
    }
  }

  finish(): AiWorkspaceParsedSession {
    if (this.explicitTitle) this.candidate.title = this.explicitTitle;
    this.candidate.title = titleFromMessages(this.candidate, this.messages);
    return {
      source: this.candidate,
      messages: this.messages,
      fileReferences: uniqueFileReferences(this.messages),
      ruleAnalysis: buildRuleSessionAnalysis(this.messages)
    };
  }

  private pushMessage(
    rawId: string,
    _rawParent: string | undefined,
    message: AiWorkspaceMessage | null
  ): void {
    if (!message) return;
    this.messages.push(message);
    this.lastVisibleId = message.id;
    this.visibleByRawId.set(rawId, message.id);
  }

  private resolveVisibleParent(rawId: string | undefined): string {
    let current = rawId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const visible = this.visibleByRawId.get(current);
      if (visible) return visible;
      current = this.rawParents[current];
    }
    return "";
  }
}

export class PiTranscriptParser {
  private messages: AiWorkspaceMessage[] = [];
  private lineNumber = 0;
  private lastVisibleId = "";
  private rawParents: RawParentMap = {};
  private visibleByRawId = new Map<string, string>();
  private explicitTitle = "";

  constructor(
    private candidate: AiWorkspaceSourceCandidate,
    private options: AiWorkspaceImportOptions
  ) {}

  consume(line: string): void {
    this.lineNumber += 1;
    let row: JsonRecord;
    try {
      row = objectValue(JSON.parse(line));
    } catch {
      return;
    }
    const type = compactText(row.type);
    if (type === "session") {
      this.candidate.sourceSessionId = compactText(row.id) || this.candidate.sourceSessionId;
      this.candidate.cwd = compactText(row.cwd) || this.candidate.cwd;
      const parentSession = compactText(row.parentSession);
      if (parentSession) {
        const match = parentSession.match(/[0-9a-f]{8}-[0-9a-f-]{20,}/iu);
        this.candidate.parentSessionId = match?.[0] || parentSession;
      }
      return;
    }
    const rawId = compactText(row.id) || `line-${this.lineNumber}`;
    const rawParent = compactText(row.parentId) || undefined;
    this.rawParents[rawId] = rawParent;
    if (type === "session_info") {
      this.explicitTitle = compactText(row.name) || this.explicitTitle;
      return;
    }
    if (type === "model_change") {
      this.candidate.model = compactText(row.modelId || row.model) || this.candidate.model;
      return;
    }
    if (type !== "message") return;

    const message = objectValue(row.message);
    const role = compactText(message.role);
    const timestamp = isoTimestamp(row.timestamp || message.timestamp, this.candidate.updatedAt);
    this.candidate.model = compactText(message.model) || this.candidate.model;
    const parts = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : arrayValue(message.content).map(objectValue);
    let parentId = this.resolveVisibleParent(rawParent) || this.lastVisibleId || undefined;

    if (role === "user" || role === "assistant") {
      const text = parts
        .filter((part) => compactText(part.type) === "text")
        .map((part) => compactText(part.text))
        .filter(Boolean)
        .join("\n\n");
      const error = role === "assistant" ? compactText(message.errorMessage) : "";
      const normalized = makeMessage({
        id: `pi-${rawId}`,
        sourceId: rawId,
        parentId,
        role,
        content: text || (error ? `请求失败：${error}` : ""),
        timestamp,
        sequence: this.messages.length,
        includeFileReferences: this.options.includeFileReferences,
        redactSecrets: this.options.redactSecrets
      });
      if (normalized) {
        this.messages.push(normalized);
        parentId = normalized.id;
        this.lastVisibleId = normalized.id;
        this.visibleByRawId.set(rawId, normalized.id);
      }
      if (role === "assistant" && this.options.includeToolCalls) {
        parts
          .filter((part) => compactText(part.type) === "toolCall")
          .forEach((part, partIndex) => {
            const toolName = compactText(part.name) || "tool";
            const callId = compactText(part.id) || `${rawId}-${partIndex}`;
            const tool = makeMessage({
              id: `pi-tool-${callId}`,
              sourceId: `${callId}:call`,
              parentId,
              role: "tool",
              content: `${toolName}\n${compactText(part.arguments)}`,
              timestamp,
              sequence: this.messages.length,
              kind: "tool",
              toolName,
              includeFileReferences: this.options.includeFileReferences,
              redactSecrets: this.options.redactSecrets
            });
            if (!tool) return;
            this.messages.push(tool);
            parentId = tool.id;
            this.lastVisibleId = tool.id;
            this.visibleByRawId.set(rawId, tool.id);
          });
      }
      return;
    }
    if (!this.options.includeToolCalls || (role !== "toolResult" && role !== "bashExecution")) return;
    const toolName = compactText(message.toolName) || (role === "bashExecution" ? "bash" : "tool-result");
    const text = visibleContentText(message.content, new Set(["text"]));
    const tool = makeMessage({
      id: `pi-result-${rawId}`,
      sourceId: `${compactText(message.toolCallId) || rawId}:result`,
      parentId,
      role: "tool",
      content: `${toolName}\n${text || compactText(message.output)}`,
      timestamp,
      sequence: this.messages.length,
      kind: "tool",
      toolName,
      includeFileReferences: this.options.includeFileReferences,
      redactSecrets: this.options.redactSecrets
    });
    if (!tool) return;
    this.messages.push(tool);
    this.lastVisibleId = tool.id;
    this.visibleByRawId.set(rawId, tool.id);
  }

  finish(): AiWorkspaceParsedSession {
    if (this.explicitTitle) this.candidate.title = this.explicitTitle;
    this.candidate.title = titleFromMessages(this.candidate, this.messages);
    return {
      source: this.candidate,
      messages: this.messages,
      fileReferences: uniqueFileReferences(this.messages),
      ruleAnalysis: buildRuleSessionAnalysis(this.messages)
    };
  }

  private resolveVisibleParent(rawId: string | undefined): string {
    let current = rawId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const visible = this.visibleByRawId.get(current);
      if (visible) return visible;
      current = this.rawParents[current];
    }
    return "";
  }
}

export interface OpenCodeSessionRecord {
  id: string;
  parent_id?: string | null;
  directory?: string;
  title?: string;
  version?: string;
  time_created?: number;
  time_updated?: number;
}

export interface OpenCodeMessageRecord {
  id: string;
  session_id: string;
  time_created: number;
  data: string | JsonRecord;
}

export interface OpenCodePartRecord {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string | JsonRecord;
}

export function parseOpenCodeRecords(
  candidate: AiWorkspaceSourceCandidate,
  session: OpenCodeSessionRecord,
  messageRows: OpenCodeMessageRecord[],
  partRows: OpenCodePartRecord[],
  options: AiWorkspaceImportOptions
): AiWorkspaceParsedSession {
  const partsByMessage = new Map<string, OpenCodePartRecord[]>();
  for (const part of partRows) {
    const parts = partsByMessage.get(part.message_id) ?? [];
    parts.push(part);
    partsByMessage.set(part.message_id, parts);
  }
  const messages: AiWorkspaceMessage[] = [];
  const visibleByMessage = new Map<string, string>();
  const messageParent = new Map<string, string>();
  const sorted = [...messageRows].sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id));

  for (const row of sorted) {
    const data = parseRecord(row.data);
    const roleValue = compactText(data.role);
    if (roleValue !== "user" && roleValue !== "assistant") continue;
    const parentSource = compactText(data.parentID);
    if (parentSource) messageParent.set(row.id, parentSource);
    const parts = (partsByMessage.get(row.id) ?? [])
      .sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id))
      .map((part) => ({ row: part, data: parseRecord(part.data) }));
    const text = parts
      .filter(({ data: part }) => compactText(part.type) === "text")
      .map(({ data: part }) => compactText(part.text))
      .filter(Boolean)
      .join("\n\n");
    const fileReferences = parts
      .filter(({ data: part }) => compactText(part.type) === "file")
      .map(({ data: part }) => ({ path: compactText(objectValue(part.source).path || part.filename || part.url), kind: "reference" as const }))
      .filter((item) => item.path);
    const parentId = resolveOpenCodeVisibleParent(parentSource, visibleByMessage, messageParent)
      || messages[messages.length - 1]?.id;
    const normalized = makeMessage({
      id: `opencode-${row.id}`,
      sourceId: row.id,
      parentId,
      role: roleValue,
      content: text,
      timestamp: isoTimestamp(row.time_created, candidate.updatedAt),
      sequence: messages.length,
      includeFileReferences: options.includeFileReferences,
      redactSecrets: options.redactSecrets
    });
    if (normalized) {
      if (options.includeFileReferences) normalized.fileReferences.push(...fileReferences);
      messages.push(normalized);
      visibleByMessage.set(row.id, normalized.id);
    }
    if (!options.includeToolCalls) continue;
    for (const { row: partRow, data: part } of parts) {
      if (compactText(part.type) !== "tool") continue;
      const toolName = compactText(part.tool) || "tool";
      const state = objectValue(part.state);
      const toolText = [
        toolName,
        compactText(state.input),
        compactText(state.output || state.error)
      ].filter(Boolean).join("\n");
      const toolMessage = makeMessage({
        id: `opencode-${partRow.id}`,
        sourceId: partRow.id,
        parentId: messages[messages.length - 1]?.id,
        role: "tool",
        content: toolText,
        timestamp: isoTimestamp(partRow.time_created, candidate.updatedAt),
        sequence: messages.length,
        kind: "tool",
        toolName,
        includeFileReferences: options.includeFileReferences,
        redactSecrets: options.redactSecrets
      });
      if (toolMessage) messages.push(toolMessage);
    }
  }

  candidate.sourceSessionId = session.id || candidate.sourceSessionId;
  candidate.cwd = session.directory || candidate.cwd;
  candidate.title = workspaceSessionDisplayTitle(
    session.title || "",
    messages.find((message) => message.role === "user")?.content ?? "",
    titleFromMessages(candidate, messages)
  );
  candidate.createdAt = isoTimestamp(session.time_created, candidate.createdAt);
  candidate.updatedAt = isoTimestamp(session.time_updated, candidate.updatedAt);
  candidate.parentSessionId = session.parent_id || candidate.parentSessionId;
  return {
    source: candidate,
    messages,
    fileReferences: uniqueFileReferences(messages),
    ruleAnalysis: buildRuleSessionAnalysis(messages)
  };
}

export function parseOpenCodeExport(
  candidate: AiWorkspaceSourceCandidate,
  payload: unknown,
  options: AiWorkspaceImportOptions
): AiWorkspaceParsedSession {
  const root = objectValue(payload);
  const info = objectValue(root.info || root.session);
  const session: OpenCodeSessionRecord = {
    id: compactText(info.id) || candidate.sourceSessionId,
    parent_id: compactText(info.parentID || info.parent_id) || null,
    directory: compactText(info.directory || objectValue(info.path).cwd) || candidate.cwd,
    title: compactText(info.title) || candidate.title,
    version: compactText(info.version),
    time_created: Number(objectValue(info.time).created || info.time_created || 0),
    time_updated: Number(objectValue(info.time).updated || info.time_updated || 0)
  };
  const messageRows: OpenCodeMessageRecord[] = [];
  const partRows: OpenCodePartRecord[] = [];
  for (const item of arrayValue(root.messages || root.data)) {
    const entry = objectValue(item);
    const messageInfo = objectValue(entry.info || entry.message || entry);
    const id = compactText(messageInfo.id) || `message-${messageRows.length + 1}`;
    const created = Number(objectValue(messageInfo.time).created || messageInfo.time_created || messageRows.length);
    messageRows.push({
      id,
      session_id: session.id,
      time_created: created,
      data: messageInfo
    });
    for (const partValue of arrayValue(entry.parts)) {
      const part = objectValue(partValue);
      partRows.push({
        id: compactText(part.id) || `part-${partRows.length + 1}`,
        message_id: id,
        session_id: session.id,
        time_created: Number(objectValue(part.time).start || created),
        data: part
      });
    }
  }
  return parseOpenCodeRecords(candidate, session, messageRows, partRows, options);
}

export function parseLifeOsConversationExport(
  candidate: AiWorkspaceSourceCandidate,
  payload: unknown,
  options: AiWorkspaceImportOptions
): AiWorkspaceParsedSession {
  const root = objectValue(payload);
  if (compactText(root.schema) !== "lifeos-ai-conversation-v1") {
    throw new Error("文件不是 Life OS 标准会话导出格式。");
  }
  const session = objectValue(root.session);
  const rawMessages = arrayValue(root.messages).map(objectValue);
  const messages: AiWorkspaceMessage[] = [];
  const visibleBySourceId = new Map<string, string>();
  let lastVisibleId = "";
  rawMessages.forEach((row, index) => {
    const roleValue = compactText(row.role);
    if (roleValue !== "user" && roleValue !== "assistant" && roleValue !== "tool") return;
    if (roleValue === "tool" && !options.includeToolCalls) return;
    const sourceId = compactText(row.id) || `message-${index + 1}`;
    const rawParentId = compactText(row.parentId);
    const normalized = makeMessage({
      id: `lifeos-${stableTextHash(`${candidate.sourceSessionId}:${sourceId}`)}`,
      sourceId,
      parentId: visibleBySourceId.get(rawParentId) || lastVisibleId || undefined,
      role: roleValue,
      content: compactText(row.content),
      timestamp: isoTimestamp(row.timestamp, candidate.updatedAt),
      sequence: messages.length,
      kind: roleValue === "tool" ? "tool" : "message",
      toolName: compactText(row.toolName) || undefined,
      includeFileReferences: options.includeFileReferences,
      redactSecrets: options.redactSecrets
    });
    if (!normalized) return;
    if (options.includeFileReferences) {
      const explicit = arrayValue(row.fileReferences)
        .map((item) => typeof item === "string" ? { path: item } : objectValue(item))
        .map((item) => ({
          path: compactText(item.path),
          line: Number.isFinite(Number(item.line)) ? Number(item.line) : undefined,
          kind: ["read", "write", "patch", "reference"].includes(compactText(item.kind))
            ? compactText(item.kind) as AiWorkspaceFileReference["kind"]
            : "reference" as const
        }))
        .filter((item) => item.path);
      const seen = new Set(normalized.fileReferences.map((item) => item.path.toLowerCase()));
      normalized.fileReferences.push(...explicit.filter((item) => {
        const key = item.path.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }));
    }
    messages.push(normalized);
    visibleBySourceId.set(sourceId, normalized.id);
    lastVisibleId = normalized.id;
  });
  candidate.sourceSessionId = compactText(session.id) || candidate.sourceSessionId;
  candidate.title = workspaceSessionDisplayTitle(
    compactText(session.title),
    messages.find((message) => message.role === "user")?.content ?? "",
    titleFromMessages(candidate, messages)
  );
  candidate.cwd = compactText(session.cwd) || candidate.cwd;
  candidate.createdAt = isoTimestamp(session.createdAt, candidate.createdAt);
  candidate.updatedAt = isoTimestamp(session.updatedAt, candidate.updatedAt);
  candidate.parentSessionId = compactText(session.parentSessionId) || candidate.parentSessionId;
  candidate.model = compactText(session.model) || candidate.model;
  candidate.sourcePlatform = compactText(session.platform) || candidate.sourcePlatform;
  candidate.sourceUrl = compactText(session.url) || candidate.sourceUrl;
  return {
    source: candidate,
    messages,
    fileReferences: uniqueFileReferences(messages),
    ruleAnalysis: buildRuleSessionAnalysis(messages)
  };
}

function parseRecord(value: string | JsonRecord): JsonRecord {
  if (typeof value !== "string") return objectValue(value);
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return {};
  }
}

function resolveOpenCodeVisibleParent(
  sourceId: string,
  visibleByMessage: Map<string, string>,
  messageParent: Map<string, string>
): string {
  let current = sourceId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const visible = visibleByMessage.get(current);
    if (visible) return visible;
    current = messageParent.get(current) ?? "";
  }
  return "";
}

export function compareWorkspaceMessages(
  existing: Array<Pick<AiWorkspaceMessage, "sourceId" | "contentHash">>,
  incoming: Array<Pick<AiWorkspaceMessage, "sourceId" | "contentHash">>
): { overlapCount: number; newMessageCount: number; changedMessageCount: number } {
  const current = new Map(existing.map((message) => [message.sourceId, message.contentHash]));
  let overlapCount = 0;
  let newMessageCount = 0;
  let changedMessageCount = 0;
  for (const message of incoming) {
    const hash = current.get(message.sourceId);
    if (hash === undefined) {
      newMessageCount += 1;
    } else if (hash === message.contentHash) {
      overlapCount += 1;
    } else {
      changedMessageCount += 1;
    }
  }
  return { overlapCount, newMessageCount, changedMessageCount };
}

export function mergeWorkspaceMessages(
  existing: AiWorkspaceMessage[],
  incoming: AiWorkspaceMessage[]
): AiWorkspaceMessage[] {
  const seen = new Set(existing.map((message) => `${message.sourceId}:${message.contentHash}`));
  const merged = [...existing];
  for (const message of incoming) {
    const key = `${message.sourceId}:${message.contentHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...message, sequence: merged.length, parentId: message.parentId || merged[merged.length - 1]?.id });
  }
  return merged;
}

const DAILY_BLOCK_START = "<!-- lifeos-ai-workspace:start -->";
const DAILY_BLOCK_END = "<!-- lifeos-ai-workspace:end -->";

export function upsertAiWorkspaceDailyBlock(markdown: string, lines: string[]): string {
  const uniqueLines = Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean)));
  if (uniqueLines.length === 0) return markdown;
  const blockPattern = new RegExp(
    `${escapeRegExp(DAILY_BLOCK_START)}[\\s\\S]*?${escapeRegExp(DAILY_BLOCK_END)}`,
    "m"
  );
  const existingBlock = markdown.match(blockPattern)?.[0] ?? "";
  const existingLines = existingBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line));
  const marker = /<!--\s*lifeos-ai-workspace-fact:([A-Za-z0-9_-]+)\s*-->/u;
  const keyed = new Map<string, string>();
  const unkeyed: string[] = [];
  for (const line of [...existingLines, ...uniqueLines]) {
    const id = line.match(marker)?.[1];
    if (id) keyed.set(id, line);
    else if (!unkeyed.includes(line)) unkeyed.push(line);
  }
  const mergedLines = [...unkeyed, ...keyed.values()];
  const nextBlock = [
    DAILY_BLOCK_START,
    "## 项目活动",
    "",
    ...mergedLines,
    DAILY_BLOCK_END
  ].join("\n");
  if (existingBlock) return markdown.replace(blockPattern, nextBlock);
  const trimmed = markdown.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}${nextBlock}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
