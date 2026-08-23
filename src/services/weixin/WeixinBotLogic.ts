export type WeixinSenderPolicy = "pairing" | "allowlist" | "open";
export type WeixinWritebackKind = "daily" | "knowledge" | "memory" | "project-document";

export interface WeixinInboundRequest {
  version: 1;
  channel: "weixin";
  messageId: string;
  accountId: string;
  conversationId: string;
  threadId: string;
  senderId: string;
  senderName: string;
  isGroup: boolean;
  wasMentioned: boolean;
  content: string;
  timestamp: string;
  media: unknown[];
}

export interface WeixinAssistantResponse {
  reply: string;
  projectId?: string;
  conversationPath?: string;
  writebackStatus?: string;
}

export interface WeixinAccessSettings {
  senderPolicy: WeixinSenderPolicy;
  approvedSenders: Array<string | { key?: string }>;
  allowedGroups: string[];
}

export interface WeixinAccessDecision {
  allowed: boolean;
  reason: "allowed" | "pairing-required" | "sender-not-allowed" | "group-not-allowed";
  senderKey: string;
  groupKey: string;
}

export interface WeixinCommand {
  name: "help" | "status" | "projects" | "use" | "new" | "approve" | "deny" | string;
  args: string[];
}

export type WeixinLifeOSPeriod = "today" | "week" | "month";
export type WeixinLifeOSActionSource = "command" | "natural" | "semantic";
export type WeixinLifeOSAction =
  | { kind: "diary-add"; content: string; source: WeixinLifeOSActionSource }
  | { kind: "diary-generate"; source: WeixinLifeOSActionSource }
  | { kind: "task-list"; source: WeixinLifeOSActionSource }
  | { kind: "task-add"; title: string; due?: string; source: WeixinLifeOSActionSource }
  | { kind: "task-complete"; query: string; source: WeixinLifeOSActionSource }
  | { kind: "review-generate"; period: WeixinLifeOSPeriod; source: WeixinLifeOSActionSource }
  | { kind: "summary-generate"; period: WeixinLifeOSPeriod; source: WeixinLifeOSActionSource }
  | { kind: "link-save"; url: string; title: string; source: WeixinLifeOSActionSource }
  | { kind: "knowledge-save"; title: string; content: string; source: WeixinLifeOSActionSource }
  | { kind: "reminder-add"; when: string; content: string; source: WeixinLifeOSActionSource }
  | { kind: "reminder-list"; source: WeixinLifeOSActionSource }
  | { kind: "reminder-cancel"; id: string; source: WeixinLifeOSActionSource };

export interface WeixinSkillDescriptor {
  id: string;
  name: string;
  description?: string;
  lens?: string;
}

export interface WeixinSkillInvocation {
  matched: true;
  keyword: string;
  query: string;
  skillIds: string[];
  candidates: string[];
  /** Candidate ids are exposed only for an explicit but ambiguous nickname. */
  candidateIds?: string[];
  error: "" | "not-found" | "ambiguous" | "missing-question";
}

export interface WeixinProposalDecision {
  decision: "approve" | "deny";
  id: string;
  index: number | null;
  query: string;
}

export interface WeixinImageContentPart {
  type: "image_url";
  image_url: {
    url: string;
    detail: "auto";
  };
}

export interface WeixinPendingImageStatus {
  count: number;
  expiresAt: number;
}

interface WeixinPendingImageBatch {
  createdAt: number;
  updatedAt: number;
  media: unknown[];
  messageIds: string[];
}

/** In-memory, account/sender/conversation scoped image-next-text pairing. */
export class WeixinPendingImageStore {
  private readonly batches = new Map<string, WeixinPendingImageBatch>();

  constructor(private maxImages = 4, private ttlMs = 15 * 60 * 1000) {}

  stage(request: WeixinInboundRequest, now = Date.now()): number {
    this.prune(now);
    const key = this.key(request);
    const existing = this.batches.get(key);
    if (existing?.messageIds?.includes(request.messageId)) return existing.media.length;
    const images = request.media.filter((item) => getWeixinImageContentParts([item]).length > 0);
    const media = [...(existing?.media || []), ...images].slice(-this.maxImages);
    if (media.length === 0) return existing?.media.length || 0;
    this.batches.set(key, {
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      media,
      // iLink may redeliver the same image when the acknowledgement could not
      // be sent. Remember the source message so retries do not duplicate it.
      messageIds: [...(existing?.messageIds || []), request.messageId].filter(Boolean).slice(-Math.max(8, this.maxImages * 4))
    });
    return media.length;
  }

  consume(request: WeixinInboundRequest, now = Date.now()): WeixinInboundRequest {
    this.prune(now);
    const key = this.key(request);
    const batch = this.batches.get(key);
    if (!batch) return request;
    this.batches.delete(key);
    const isImage = (item: unknown) => getWeixinImageContentParts([item]).length > 0;
    const currentImages = request.media.filter(isImage);
    const otherMedia = request.media.filter((item) => !isImage(item));
    return {
      ...request,
      media: [...batch.media, ...currentImages].slice(-this.maxImages).concat(otherMedia)
    };
  }

  inspect(request: WeixinInboundRequest, now = Date.now()): WeixinPendingImageStatus | null {
    this.prune(now);
    const batch = this.batches.get(this.key(request));
    return batch ? { count: batch.media.length, expiresAt: batch.updatedAt + this.ttlMs } : null;
  }

  clearRequest(request: WeixinInboundRequest): boolean {
    return this.batches.delete(this.key(request));
  }

  clearScope(accountId = "", senderId = ""): void {
    for (const key of this.batches.keys()) {
      if (accountId && !key.startsWith(`${accountId}\u001f`)) continue;
      if (senderId && !key.includes(`\u001f${senderId}\u001f`)) continue;
      this.batches.delete(key);
    }
  }

  prune(now = Date.now()): void {
    for (const [key, batch] of this.batches.entries()) {
      if (batch.updatedAt + this.ttlMs <= now) this.batches.delete(key);
    }
  }

  private key(request: Pick<WeixinInboundRequest, "accountId" | "senderId" | "conversationId" | "threadId">): string {
    return [request.accountId || "default", request.senderId, request.conversationId, request.threadId].join("\u001f");
  }
}

export interface WeixinWritebackEnvelope {
  kind: WeixinWritebackKind;
  title: string;
  content: string;
  target: string;
}

type UnknownRecord = Record<string, unknown>;

const WRITEBACK_PATTERN = /<lifeos_writeback>\s*([\s\S]*?)\s*<\/lifeos_writeback>/gi;
const VALID_WRITEBACK_KINDS: WeixinWritebackKind[] = ["daily", "knowledge", "memory", "project-document"];

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function firstText(record: UnknownRecord, keys: string[], maxLength: number): string {
  for (const key of keys) {
    const value = cleanText(record[key], maxLength);
    if (value) return value;
  }
  return "";
}

function stableHash(value: string): string {
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

function normalizeBoolean(value: unknown): boolean {
  return value === true || ["true", "1", "yes", "group"].includes(String(value ?? "").trim().toLowerCase());
}

/**
 * Normalize protocol input without ever accepting a caller-supplied channel.
 * This connector is intentionally Weixin-only.
 */
export function normalizeWeixinInboundRequest(value: unknown): WeixinInboundRequest {
  const record = asRecord(value);
  const senderId = firstText(record, ["senderId", "fromUserId", "from_user_id", "userId"], 240) || "unknown";
  const accountId = firstText(record, ["accountId", "botId", "ilinkBotId"], 240) || "default";
  const groupId = firstText(record, ["groupId", "roomId", "chatRoomId"], 240);
  const explicitConversation = firstText(record, ["conversationId", "sessionId", "chatId"], 300);
  const isGroup = normalizeBoolean(record.isGroup) || Boolean(groupId);
  const conversationId = explicitConversation || (isGroup ? `group:${groupId}` : `direct:${senderId}`);
  const timestamp = firstText(record, ["timestamp", "createdAt"], 80) || new Date().toISOString();
  const explicitMessageId = firstText(record, ["messageId", "id", "clientId"], 300);
  const content = firstText(record, ["content", "text", "body"], 300_000);
  const media = Array.isArray(record.media) ? record.media.slice(0, 20) : [];
  return {
    version: 1,
    channel: "weixin",
    messageId: explicitMessageId || `weixin-${stableHash([accountId, conversationId, senderId, timestamp, content].join("\u001f"))}`,
    accountId,
    conversationId,
    threadId: firstText(record, ["threadId", "topicId"], 240),
    senderId,
    senderName: firstText(record, ["senderName", "userName", "nickname"], 120),
    isGroup,
    wasMentioned: normalizeBoolean(record.wasMentioned ?? record.mentioned),
    content,
    timestamp,
    media
  };
}

export function weixinSenderKey(request: Pick<WeixinInboundRequest, "accountId" | "senderId">): string {
  return ["weixin", request.accountId || "default", request.senderId].join(":");
}

export function weixinConversationKey(
  request: Pick<WeixinInboundRequest, "accountId" | "conversationId" | "threadId">
): string {
  return ["weixin", request.accountId || "default", request.conversationId, request.threadId]
    .filter(Boolean)
    .join(":");
}

export function weixinReminderRouteRef(
  request: Pick<WeixinInboundRequest, "accountId" | "conversationId" | "threadId" | "senderId">
): string {
  return `WXR-${stableHash([
    request.accountId || "default",
    request.conversationId,
    request.threadId,
    request.senderId
  ].join("\u001f"))}`.toUpperCase();
}

function approvedSenderKeys(values: WeixinAccessSettings["approvedSenders"]): Set<string> {
  return new Set(values.map((value) => typeof value === "string" ? value : cleanText(value?.key, 500)).filter(Boolean));
}

export function evaluateWeixinAccess(
  settings: WeixinAccessSettings,
  request: WeixinInboundRequest
): WeixinAccessDecision {
  const senderKey = weixinSenderKey(request);
  const groupKey = request.isGroup ? weixinConversationKey(request) : "";
  const approved = approvedSenderKeys(settings.approvedSenders);
  if (request.isGroup) {
    return settings.allowedGroups.includes(groupKey)
      ? { allowed: true, reason: "allowed", senderKey, groupKey }
      : { allowed: false, reason: "group-not-allowed", senderKey, groupKey };
  }
  if (settings.senderPolicy === "open" || approved.has(senderKey)) {
    return { allowed: true, reason: "allowed", senderKey, groupKey };
  }
  return {
    allowed: false,
    reason: settings.senderPolicy === "pairing" ? "pairing-required" : "sender-not-allowed",
    senderKey,
    groupKey
  };
}

export function parseWeixinCommand(value: unknown): WeixinCommand | null {
  const source = cleanText(value, 20_000);
  const match = source.match(/^\/lifeos(?:\s+([a-z-]+))?(?:\s+([\s\S]*))?$/iu);
  if (!match) return null;
  const name = (match[1] || "help").toLowerCase();
  const args = (match[2] || "").trim().split(/\s+/u).filter(Boolean);
  return { name, args };
}

/**
 * Parse a conversational decision for the latest pending Life OS operation.
 * The caller must still verify that a pending proposal exists in this exact
 * sender/conversation scope before treating a short reply such as “可以” as
 * authorization.
 */
export function parseWeixinProposalDecision(value: unknown): WeixinProposalDecision | null {
  const source = cleanText(value, 500)
    .replace(/[。！!？?]+$/gu, "")
    .trim();
  if (!source || source.startsWith("/")) return null;
  const id = source.match(/\b(WB-\d{6})\b/iu)?.[1]?.toUpperCase() || "";
  const indexMatch = source.match(/第\s*(\d{1,2})\s*(?:个|条|项)?/u);
  const index = indexMatch ? Math.max(1, Number(indexMatch[1])) : null;
  const approve = /^(?:好(?:的)?|可以|行|没问题|同意|确认|确认执行|执行(?:吧|它)?|保存(?:吧|它)?|写入(?:吧|它)?|记入(?:吧|它)?|就这么做|按这个做|批准)(?:[，,\s]*(?:第\s*\d{1,2}\s*(?:个|条|项)?|WB-\d{6}|.+))?$/iu;
  const deny = /^(?:不用了?|算了|取消|撤销|拒绝|不同意|不要(?:了|执行|保存|写入)?|别(?:执行|保存|写入|记入))(?:[，,\s]*(?:第\s*\d{1,2}\s*(?:个|条|项)?|WB-\d{6}|.+))?$/iu;
  const decision = approve.test(source) ? "approve" : deny.test(source) ? "deny" : null;
  if (!decision) return null;
  const query = source
    .replace(/\bWB-\d{6}\b/giu, "")
    .replace(/第\s*\d{1,2}\s*(?:个|条|项)?/gu, "")
    .replace(/^(?:好(?:的)?|可以|行|没问题|同意|确认(?:执行)?|执行(?:吧|它)?|保存(?:吧|它)?|写入(?:吧|它)?|记入(?:吧|它)?|就这么做|按这个做|批准|不用了?|算了|取消|撤销|拒绝|不同意|不要(?:了|执行|保存|写入)?|别(?:执行|保存|写入|记入))[，,：:\s]*/iu, "")
    .trim();
  return { decision, id, index, query };
}

function actionPeriod(value: unknown): WeixinLifeOSPeriod | null {
  const normalized = cleanText(value, 80).toLowerCase();
  if (["today", "daily", "day", "今天", "今日", "当天"].includes(normalized)) return "today";
  if (["week", "weekly", "本周", "这周", "本星期", "本周内"].includes(normalized)) return "week";
  if (["month", "monthly", "本月", "这个月", "当月"].includes(normalized)) return "month";
  return null;
}

function splitOnce(value: string): [string, string] {
  const explicitPipe = value.match(/^([\s\S]*?)\s*(?:\||｜)\s*([\s\S]+)$/u);
  if (explicitPipe) return [explicitPipe[1].trim(), explicitPipe[2].trim()];
  const match = value.match(/^([\s\S]*?)\s*(?:：|:)\s*([\s\S]+)$/u);
  return match ? [match[1].trim(), match[2].trim()] : [value.trim(), ""];
}

function parseLinkPayload(value: string): { url: string; title: string } | null {
  const match = value.trim().match(/^(https?:\/\/[^\s]+)(?:\s+([\s\S]*))?$/iu);
  if (!match) return null;
  return {
    url: match[1].replace(/[，。；;！!？?）)】\]]+$/u, ""),
    title: cleanText(match[2], 240)
  };
}

function parseNaturalLinkSavePayload(value: string): { url: string; title: string } | null {
  const source = cleanText(value, 100_000);
  const urlMatch = source.match(/https?:\/\/[^\s]+/iu);
  if (!urlMatch) return null;
  const hasSaveIntent = /(?:收藏|保存|存入|存到|收录|加入|放进)/u.test(source);
  const hasLinkTarget = /(?:链接|网址|网页|文章|知识库|收藏夹)/u.test(source);
  if (!hasSaveIntent || !hasLinkTarget) return null;

  const url = urlMatch[0].replace(/[，。；;！!？?）)】\]]+$/u, "");
  const title = source
    .replace(urlMatch[0], " ")
    .replace(/^(?:帮我把|请把|麻烦把|帮我|麻烦|请|把)\s*/u, "")
    .replace(/(?:这个|这篇|该)?(?:链接|网址|网页|文章)/gu, " ")
    .replace(/(?:收藏|保存|存入|存到|收录|加入|放进)(?:到|至|进)?(?:我的)?(?:知识库|收藏夹)?(?:里|中)?/gu, " ")
    .replace(/[：:,，。；;！!？?（）()【】\[\]]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return { url, title: cleanText(title, 240) };
}

function commandAction(source: string): WeixinLifeOSAction | null {
  if (/^\/lifeos\s+diary\s+(?:generate|summary)\s*$/iu.test(source)) {
    return { kind: "diary-generate", source: "command" };
  }
  let match = source.match(/^\/lifeos\s+diary(?:\s+([\s\S]+))?$/iu);
  if (match) return { kind: "diary-add", content: cleanText(match[1], 100_000), source: "command" };

  match = source.match(/^\/lifeos\s+todo(?:\s+(list|add|done))?(?:\s+([\s\S]+))?$/iu);
  if (match) {
    const operation = (match[1] || "list").toLowerCase();
    const payload = cleanText(match[2], 100_000);
    if (operation === "add") {
      const [title, due] = splitOnce(payload);
      return due
        ? { kind: "task-add", title, due, source: "command" }
        : { kind: "task-add", title, source: "command" };
    }
    if (operation === "done") return { kind: "task-complete", query: payload, source: "command" };
    return { kind: "task-list", source: "command" };
  }

  match = source.match(/^\/lifeos\s+(review|summary)(?:\s+([^\s]+))?$/iu);
  if (match) {
    const period = actionPeriod(match[2] || "today");
    if (!period) return null;
    return match[1].toLowerCase() === "review"
      ? { kind: "review-generate", period, source: "command" }
      : { kind: "summary-generate", period, source: "command" };
  }

  match = source.match(/^\/lifeos\s+save-link(?:\s+([\s\S]+))?$/iu);
  if (match) {
    const payload = parseLinkPayload(cleanText(match[1], 100_000));
    return payload ? { kind: "link-save", ...payload, source: "command" } : null;
  }

  match = source.match(/^\/lifeos\s+knowledge(?:\s+([\s\S]+))?$/iu);
  if (match) {
    const [title, content] = splitOnce(cleanText(match[1], 100_000));
    return { kind: "knowledge-save", title, content, source: "command" };
  }

  match = source.match(/^\/lifeos\s+remind(?:\s+([\s\S]+))?$/iu);
  if (match) {
    const [when, content] = splitOnce(cleanText(match[1], 100_000));
    return { kind: "reminder-add", when, content, source: "command" };
  }
  if (/^\/lifeos\s+reminders\s*$/iu.test(source)) return { kind: "reminder-list", source: "command" };
  match = source.match(/^\/lifeos\s+cancel-reminder(?:\s+([^\s]+))?\s*$/iu);
  if (match) return { kind: "reminder-cancel", id: cleanText(match[1], 80).toUpperCase(), source: "command" };
  return null;
}

/**
 * Parse only strong, user-authored Life OS actions. Ordinary discussion that
 * merely mentions a feature intentionally falls through to normal Q&A.
 */
export function parseWeixinLifeOSAction(value: unknown): WeixinLifeOSAction | null {
  const source = cleanText(value, 100_000);
  if (!source) return null;
  const command = commandAction(source);
  if (command) return command;

  if (
    /^(?:请|帮我|麻烦)?\s*(?:根据|用)?(?:今天|今日|当天)?(?:的)?(?:微信)?(?:里|上)?(?:此前|之前|已经)?(?:的)?(?:对话|聊天|聊天记录|对话内容|聊过的内容)(?:来|去)?(?:生成|整理(?:成|为)?)(?:今天|今日|当天)?(?:的)?日记\s*$/u.test(source)
    || /^(?:请|帮我|麻烦)?\s*把(?:今天|今日|当天)?(?:的)?(?:微信)?(?:对话|聊天|聊天记录|对话内容|聊过的内容)(?:生成|整理)(?:成|为)?(?:今天|今日|当天)?(?:的)?日记\s*$/u.test(source)
    || /^(?:请|帮我|麻烦)?\s*(?:生成|整理)(?:一下)?(?:今天|今日|当天)?(?:的)?日记\s*$/u.test(source)
  ) {
    return { kind: "diary-generate", source: "natural" };
  }

  let match = source.match(/^(?:记日记|写日记|记录到日记|把(?:这段|下面|这些)?(?:内容)?记到日记(?:里)?|帮我记(?:到)?日记)\s*[：:,，]?\s*([\s\S]+)$/u);
  if (match) return { kind: "diary-add", content: match[1].trim(), source: "natural" };
  match = source.match(/^(?:添加|新建|创建|帮我加|记下)(?:一个|一条)?(?:待办|任务)\s*[：:,，]?\s*([\s\S]+)$/u);
  if (match) {
    const [title, due] = splitOnce(match[1]);
    return due
      ? { kind: "task-add", title, due, source: "natural" }
      : { kind: "task-add", title, source: "natural" };
  }
  if (/^(?:查看|列出|显示|看看|告诉我)(?:我的|当前|未完成|还有哪些)?(?:待办|任务)(?:有哪些|列表)?\s*$/u.test(source)) {
    return { kind: "task-list", source: "natural" };
  }
  match = source.match(/^(?:完成|勾选|标记完成)(?:这个|这条)?(?:待办|任务)\s*[：:,，]?\s*([\s\S]+)$/u);
  if (match) return { kind: "task-complete", query: match[1].trim(), source: "natural" };

  match = source.match(/^(?:帮我|请)?\s*(复盘|总结)\s*(今天|今日|本周|这周|本月|这个月)(?:的(?:工作|进展|情况))?\s*$/u);
  if (match) {
    const period = actionPeriod(match[2]) || "today";
    return match[1] === "复盘"
      ? { kind: "review-generate", period, source: "natural" }
      : { kind: "summary-generate", period, source: "natural" };
  }

  match = source.match(/^(?:帮我)?(?:收藏|保存|收录)(?:这个|这篇)?(?:链接|文章|网页)(?:到知识库)?\s*[：:,，]?\s*([\s\S]+)$/u);
  if (match) {
    const payload = parseLinkPayload(match[1]);
    return payload ? { kind: "link-save", ...payload, source: "natural" } : null;
  }
  const naturalLink = parseNaturalLinkSavePayload(source);
  if (naturalLink) return { kind: "link-save", ...naturalLink, source: "natural" };
  match = source.match(/^(?:把|帮我把)?(?:这段|这些|下面的)?(?:内容|资料|笔记)?\s*(?:存入|保存到|加入|放进)(?:我的)?知识库(?:里)?\s*[：:,，]?\s*([\s\S]+)$/u);
  if (match) {
    const [title, content] = splitOnce(match[1]);
    return { kind: "knowledge-save", title, content, source: "natural" };
  }
  const reminder = parseNaturalReminderAction(source);
  if (reminder) return reminder;
  if (/^(?:查看|列出|显示)(?:我的)?提醒\s*$/u.test(source)) return { kind: "reminder-list", source: "natural" };
  match = source.match(/^(?:取消|删除)提醒\s*[：:]?\s*(WR-\d{6})\s*$/iu);
  if (match) return { kind: "reminder-cancel", id: match[1].toUpperCase(), source: "natural" };
  return null;
}

/**
 * Return the user-authored conversational material that should become part of
 * today's diary evidence. Meaningful natural-language mutations remain part
 * of the record even when their canonical task / diary / knowledge / reminder
 * write also succeeds: Weixin is an input surface for Life OS, not merely a
 * remote control. Confirmation, list/query, generation and diagnostic traffic
 * are controls rather than life records and are omitted.
 */
export function getWeixinDailyCaptureText(value: unknown): string {
  const source = cleanText(value, 12_000);
  if (!source) return "";
  if (parseWeixinProposalDecision(source)) return "";
  const action = parseWeixinLifeOSAction(source);
  if (action?.source === "command") return "";
  if (action && [
    "diary-generate",
    "task-list",
    "review-generate",
    "summary-generate",
    "reminder-list"
  ].includes(action.kind)) return "";
  if (parseWeixinCommand(source)) return "";
  if (/^(?:取消|清除|丢弃)(?:这批|这些|当前)?图片\s*$/u.test(source)) return "";
  if (/^(?:查看|看看)(?:当前)?(?:暂存)?图片(?:状态)?\s*$/u.test(source)) return "";
  return source;
}

/** Commands that should inspect state without consuming a pending image batch. */
export function weixinCommandKeepsPendingImages(value: unknown): boolean {
  const action = parseWeixinLifeOSAction(value);
  if (action) return !["diary-add", "task-add", "knowledge-save"].includes(action.kind);
  const command = parseWeixinCommand(value);
  if (!command) return false;
  // Only commands whose result can meaningfully consume visual input take the
  // batch. State/permission commands and typos leave it untouched.
  return command.name !== "skill";
}

export interface WeixinReminderTimeResult {
  dueAt: string;
  label: string;
  error: string;
}

const NATURAL_REMINDER_TIME = "(?:今天|今晚|今夜|明天|明晚|后天|后晚|周[一二三四五六日天]|星期[一二三四五六日天])?(?:早上|上午|中午|下午|傍晚|晚上|夜里|凌晨)?\\s*(?:\\d{1,2}(?::|[.．])\\d{1,2}|\\d{1,2}点半|\\d{1,2}点(?:\\d{1,2}分?)?)|\\d{1,4}\\s*(?:分钟|小时|天)后";

function parseNaturalReminderAction(source: string): Extract<WeixinLifeOSAction, { kind: "reminder-add" }> | null {
  if (!/(?:提醒我|记得提醒我|到时提醒我|别忘了提醒我)/u.test(source)) return null;
  const timePattern = new RegExp(`(${NATURAL_REMINDER_TIME})`, "u");
  const timeMatch = source.match(timePattern);
  if (!timeMatch?.[1]) return null;
  let when = timeMatch[1].trim();
  let contextualPrefix = "";
  if (/^\d{1,2}(?::|[.．])\d{1,2}$/u.test(when)) {
    const contextualDay = source.match(/(?:今天|今晚|今夜|明天|明晚|后天|后晚)/u)?.[0] || "";
    const contextualPeriod = source.match(/(?:早上|上午|中午|下午|傍晚|晚上|夜里|凌晨)/u)?.[0] || "";
    contextualPrefix = `${contextualDay}${contextualPeriod}`;
    if (contextualPrefix) when = `${contextualPrefix} ${when}`;
  }
  const contentSource = contextualPrefix ? source.replace(contextualPrefix, " ") : source;
  const trailingContent = source
    .slice((timeMatch.index || 0) + timeMatch[0].length)
    .replace(/^[\s，,。；;：:|｜]+|[\s，,。；;：:|｜]+$/gu, "")
    .trim();
  let content = (trailingContent || contentSource
    .replace(/(?:提醒我|记得提醒我|到时提醒我|别忘了提醒我)/u, " ")
    .replace(timeMatch[0], " ")
    .replace(/^[\s，,。；;：:|｜]+|[\s，,。；;：:|｜]+$/gu, "")
    .replace(/^(?:要|去|做|一下|这件事)\s*/u, "")
    .trim());
  if (!content) content = "处理提醒事项";
  return { kind: "reminder-add", when, content, source: "natural" };
}

function validLocalDate(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

function setClock(date: Date, hour: number, minute: number): Date | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const result = new Date(date);
  result.setHours(hour, minute, 0, 0);
  return result;
}

/** Parse practical local reminder expressions without sending date parsing to AI. */
export function parseWeixinReminderTime(value: unknown, now = new Date()): WeixinReminderTimeResult {
  const source = cleanText(value, 120)
    .replace(/(\d{1,2})[.．](\d{1,2})/u, "$1:$2")
    .replace(/(\d{1,2})点(\d{1,2})分/u, "$1:$2")
    .replace(/点半/u, ":30")
    .replace(/点/u, ":00")
    .replace(/分(?:钟)?/u, "分")
    .replace(/\s+/gu, " ");
  const fail = (error: string): WeixinReminderTimeResult => ({ dueAt: "", label: source, error });
  if (!source || !validLocalDate(now)) return fail("请提供提醒时间，例如：明天 09:00、30 分钟后、周一 18:30。");

  let match = source.match(/^(\d{1,4})\s*(分钟|分|小时|天)后$/u);
  if (match) {
    const count = Number(match[1]);
    const unit = match[2];
    const multiplier = unit === "天" ? 86_400_000 : unit === "小时" ? 3_600_000 : 60_000;
    const due = new Date(now.getTime() + count * multiplier);
    return count > 0 && validLocalDate(due)
      ? { dueAt: due.toISOString(), label: source, error: "" }
      : fail("提醒时间必须晚于现在。");
  }

  match = source.match(/^(今天|今晚|今夜|明天|明晚|后天|后晚)(?:\s*(早上|上午|中午|下午|傍晚|晚上|夜里|凌晨))?(?:\s*(\d{1,2})(?::(\d{1,2}))?)?$/u);
  if (match) {
    const day = match[1];
    const offset = ["今天", "今晚", "今夜"].includes(day) ? 0 : ["明天", "明晚"].includes(day) ? 1 : 2;
    const base = new Date(now);
    base.setDate(base.getDate() + offset);
    const period = match[2] || (/晚|夜/u.test(day) ? "晚上" : "");
    let hour = Number(match[3] ?? (period === "中午" ? 12 : ["下午", "傍晚", "晚上", "夜里"].includes(period) ? 19 : 9));
    const minute = Number(match[4] ?? 0);
    if (["下午", "傍晚", "晚上", "夜里"].includes(period) && hour > 0 && hour < 12) hour += 12;
    // “今晚 12:30 / 凌晨 12:30” in ordinary speech means the coming
    // midnight, not today's noon. Move it into the next calendar day.
    if ((period === "凌晨" || /今晚|今夜/u.test(day)) && hour === 12) {
      hour = 0;
      base.setDate(base.getDate() + 1);
    }
    const due = setClock(base, hour, minute);
    if (!due) return fail("时间格式不正确，请使用 0:00 到 23:59。");
    if (due.getTime() <= now.getTime()) return fail("提醒时间必须晚于现在。");
    return { dueAt: due.toISOString(), label: source, error: "" };
  }

  match = source.match(/^(?:周|星期)([一二三四五六日天])(?:\s*(早上|上午|中午|下午|傍晚|晚上|夜里|凌晨))?(?:\s*(\d{1,2})(?::(\d{1,2}))?)?$/u);
  if (match) {
    const weekday = "日一二三四五六".indexOf(match[1] === "天" ? "日" : match[1]);
    const base = new Date(now);
    let offset = (weekday - base.getDay() + 7) % 7;
    const period = match[2] || "";
    let hour = Number(match[3] ?? (period === "中午" ? 12 : ["下午", "傍晚", "晚上", "夜里"].includes(period) ? 19 : 9));
    if (["下午", "傍晚", "晚上", "夜里"].includes(period) && hour > 0 && hour < 12) hour += 12;
    if (period === "凌晨" && hour === 12) hour = 0;
    const candidate = setClock(base, hour, Number(match[4] ?? 0));
    if (!candidate) return fail("时间格式不正确，请使用 0:00 到 23:59。");
    if (offset === 0 && candidate.getTime() <= now.getTime()) offset = 7;
    candidate.setDate(candidate.getDate() + offset);
    return { dueAt: candidate.toISOString(), label: source, error: "" };
  }

  match = source.match(/^(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2})(?::(\d{1,2}))?)?$/u);
  if (match) {
    const year = Number(match[1] ?? now.getFullYear());
    const month = Number(match[2]);
    const day = Number(match[3]);
    const due = new Date(year, month - 1, day, Number(match[4] ?? 9), Number(match[5] ?? 0), 0, 0);
    if (due.getFullYear() !== year || due.getMonth() !== month - 1 || due.getDate() !== day) return fail("日期不存在，请重新输入。");
    if (due.getTime() <= now.getTime()) return fail("提醒时间必须晚于现在。");
    return { dueAt: due.toISOString(), label: source, error: "" };
  }

  match = source.match(/^(\d{1,2}):(\d{1,2})$/u);
  if (match) {
    const due = setClock(now, Number(match[1]), Number(match[2]));
    if (!due) return fail("时间格式不正确，请使用 0:00 到 23:59。");
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
    return { dueAt: due.toISOString(), label: source, error: "" };
  }

  const parsed = new Date(source.replace(" ", "T"));
  if (validLocalDate(parsed) && parsed.getTime() > now.getTime()) {
    return { dueAt: parsed.toISOString(), label: source, error: "" };
  }
  return fail("无法识别提醒时间。可使用：明天 09:00、30 分钟后、周一 18:30、2026-08-23 09:00。");
}

function normalizedSkillAlias(value: unknown): string {
  return cleanText(value, 240)
    .toLowerCase()
    .replace(/\.skill$/iu, "")
    .replace(/[-_\s]+skill$/iu, "")
    .replace(/[\s._·•《》「」『』【】()（）\[\]{}]+/gu, "");
}

const SKILL_SUBJECT_SUFFIX_RE = /(?:[-_·•\s]*)?(?:判断推理|资料分析|数量关系|言语理解|逻辑填空|行测言语|判断|数量|言语|申论|面试|常识|公基|方法论|分析框架|解题框架|框架|视角|perspective)$/iu;

function pushSkillAlias(target: string[], value: unknown): void {
  const alias = cleanText(value, 240).replace(/\.skill$/iu, "").trim();
  if (!alias || normalizedSkillAlias(alias).length < 2) return;
  if (!target.some((item) => normalizedSkillAlias(item) === normalizedSkillAlias(alias))) target.push(alias);
}

/**
 * Build user-facing aliases from the actual installed Skill name. This keeps
 * imported Skills usable without a second alias database: e.g. three Skills
 * named “小P判断推理 / 小P数量 / 小P资料分析” all expose the nickname “小P”,
 * while their full names remain available for exact routing.
 */
export function getWeixinSkillAliases(skill: WeixinSkillDescriptor): string[] {
  const aliases: string[] = [];
  const name = cleanText(skill.name, 240).replace(/\.skill$/iu, "").trim();
  const id = cleanText(skill.id, 240).replace(/[-_]?skill$/iu, "").trim();
  pushSkillAlias(aliases, name);
  pushSkillAlias(aliases, id);

  let shortName = name;
  for (let pass = 0; pass < 2; pass += 1) {
    const shortened = shortName.replace(SKILL_SUBJECT_SUFFIX_RE, "").replace(/[-_·•\s]+$/gu, "").trim();
    if (!shortened || shortened === shortName) break;
    shortName = shortened;
    pushSkillAlias(aliases, shortName);
  }
  if (/^公考/u.test(name)) pushSkillAlias(aliases, name.replace(/^公考/u, ""));
  if (/花生十三/u.test(name)) {
    pushSkillAlias(aliases, "花生十三");
    pushSkillAlias(aliases, "花生");
  }
  return aliases;
}

interface WeixinSkillCandidateScore {
  id: string;
  score: number;
}

const WEIXIN_SKILL_TOPIC_RULES: Array<{ candidate: RegExp; query: RegExp; weight: number }> = [
  {
    candidate: /资料分析/u,
    query: /(?:资料分析|增长率|同比|环比|比重|占比|百分点|基期|现期|平均数|倍数|年均|统计图|统计表|亿元|万人|营业收入)/u,
    weight: 12
  },
  {
    candidate: /(?:数量关系|数量|数学运算)/u,
    query: /(?:数量关系|数学运算|工程问题|行程|排列组合|概率|几何|方程|利润|浓度|容斥|数列|年龄|钟表|统筹|最值)/u,
    weight: 12
  },
  {
    candidate: /(?:判断推理|判断)/u,
    query: /(?:判断推理|图形推理|定义判断|类比推理|逻辑判断|削弱|加强|假设|真假|命题|论证)/u,
    weight: 12
  },
  {
    candidate: /(?:言语理解|行测言语|言语|逻辑填空)/u,
    query: /(?:言语理解|选词填空|逻辑填空|片段阅读|主旨|意在说明|语句排序|病句|成语)/u,
    weight: 12
  },
  {
    candidate: /申论/u,
    query: /(?:申论|概括题|公文|贯彻执行|综合分析|提出对策|大作文|议论文)/u,
    weight: 12
  },
  { candidate: /面试/u, query: /(?:结构化面试|无领导|面试题|答题框架)/u, weight: 12 },
  { candidate: /(?:常识|公基)/u, query: /(?:常识判断|公共基础|公基|时政常识)/u, weight: 12 }
];

/**
 * Deterministically narrow nickname collisions before spending an AI call.
 * It returns a single id only when one candidate has a clear subject match.
 */
export function resolveWeixinSkillCandidateByQuery(
  query: unknown,
  candidates: WeixinSkillDescriptor[]
): string | null {
  const source = cleanText(query, 100_000);
  if (!source || candidates.length === 0) return null;
  const scored: WeixinSkillCandidateScore[] = candidates.map((skill) => {
    const descriptor = [skill.name, skill.description, skill.lens].filter(Boolean).join(" ");
    let score = 0;
    for (const rule of WEIXIN_SKILL_TOPIC_RULES) {
      if (rule.query.test(source) && rule.candidate.test(descriptor)) score += rule.weight;
    }
    const descriptorTerms = descriptor
      .split(/[\s/|｜,，、·•;；:：()（）\[\]【】_-]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && item.length <= 12);
    for (const term of descriptorTerms) {
      if (source.includes(term)) score += Math.min(4, Math.max(1, term.length - 1));
    }
    return { id: skill.id, score };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (scored[0]?.score < 6) return null;
  if (scored[1] && scored[0].score <= scored[1].score + 2) return null;
  return scored[0].id;
}

function invocationPrefix(value: string): { rest: string; naturalKeyword?: string; naturalQuery?: string } | null {
  const natural = value.match(/^使用\s*(.+?)\s*skill\s*[：:]\s*([\s\S]*)$/iu);
  if (natural) return { rest: "", naturalKeyword: natural[1].trim(), naturalQuery: natural[2].trim() };
  const prefixed = value.match(/^(?:\/lifeos\s+skill\b|\/skill\b|skill\s*[：:]|技能\s*[：:]|@)\s*([\s\S]*)$/iu);
  return prefixed ? { rest: prefixed[1].trim() } : null;
}

/**
 * Resolve an explicit, message-local Skill invocation.
 *
 * Supported examples:
 * - /skill 费曼 请解释这个概念
 * - /lifeos skill 费曼 请解释这个概念
 * - @费曼 请解释这个概念
 * - skill:费曼 请解释这个概念
 * - 使用费曼 skill：请解释这个概念
 */
export function parseWeixinSkillInvocation(
  value: unknown,
  skills: WeixinSkillDescriptor[]
): WeixinSkillInvocation | null {
  const source = cleanText(value, 100_000);
  const available = skills
    .filter((skill) => cleanText(skill.id, 240) && cleanText(skill.name, 240))
    .map((skill) => ({ skill, aliases: getWeixinSkillAliases(skill) }));
  let prefix = invocationPrefix(source);
  if (!prefix) {
    const naturalMatches = available.flatMap(({ skill, aliases }) => aliases.flatMap((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = source.match(new RegExp(`^(?:(?:我想|我要|想请|请你|麻烦你?|能不能)\\s*)?(?:用|让|按照|采用|调用|交给)\\s*[“\"「『]?${escaped}[”\"」』]?(?:老师|教练)?(?:的)?(?:方法|思路|框架|视角|技能|skill)?\\s*(?:来|帮我|给我)?\\s*[：:,，]?\\s*([\\s\\S]+)$`, "iu"));
      return match ? [{ skill, alias, query: match[1].trim() }] : [];
    })).sort((a, b) => b.alias.length - a.alias.length);
    if (naturalMatches.length > 0) {
      prefix = {
        rest: "",
        naturalKeyword: naturalMatches[0].alias,
        naturalQuery: naturalMatches[0].query
      };
    }
  }
  if (!prefix) {
    const bareMatches = available.flatMap(({ skill, aliases }) => aliases.flatMap((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = source.match(new RegExp(`^[“\"「『]?${escaped}[”\"」』]?(?:老师|教练)?[。.!！]?$`, "iu"));
      return match ? [{ skill, alias }] : [];
    })).sort((a, b) => b.alias.length - a.alias.length);
    if (bareMatches.length > 0) {
      prefix = {
        rest: "",
        naturalKeyword: bareMatches[0].alias,
        naturalQuery: ""
      };
    }
  }
  if (!prefix) {
    const addressedMatches = available.flatMap(({ skill, aliases }) => aliases.flatMap((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = source.match(new RegExp(`^[“\"「『]?${escaped}[”\"」』]?(?:老师|教练)?\\s*(?:[：:,，、]|来|请|帮我|给我)\\s*([\\s\\S]+)$`, "iu"));
      return match ? [{ skill, alias, query: match[1].trim() }] : [];
    })).sort((a, b) => b.alias.length - a.alias.length);
    if (addressedMatches.length > 0) {
      prefix = {
        rest: "",
        naturalKeyword: addressedMatches[0].alias,
        naturalQuery: addressedMatches[0].query
      };
    }
  }
  if (!prefix) return null;
  let keyword = cleanText(prefix.naturalKeyword, 240);
  let query = cleanText(prefix.naturalQuery, 100_000);

  if (!keyword) {
    const rest = prefix.rest.trim();
    const prefixMatches = available.flatMap(({ skill, aliases }) => aliases.flatMap((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = rest.match(new RegExp(`^${escaped}(?=$|[\\s|：:,，、])`, "iu"));
      return match ? [{ skill, alias: match[0] }] : [];
    })).sort((a, b) => b.alias.length - a.alias.length);
    if (prefixMatches.length > 0) {
      const longest = prefixMatches[0];
      keyword = longest.alias.trim();
      query = rest.slice(longest.alias.length).replace(/^[\s|：:,，、]+/u, "").trim();
    } else {
      const fallback = rest.match(/^([^\s|：:,，、]+)(?:[\s|：:,，、]+([\s\S]*))?$/u);
      keyword = cleanText(fallback?.[1], 240);
      query = cleanText(fallback?.[2], 100_000);
    }
  }

  const normalizedKeyword = normalizedSkillAlias(keyword);
  const exact = available.filter(({ skill, aliases }) =>
    normalizedSkillAlias(skill.id) === normalizedKeyword
    || normalizedSkillAlias(skill.name) === normalizedKeyword
    || aliases.some((alias) => normalizedSkillAlias(alias) === normalizedKeyword)
  );
  const fuzzy = exact.length > 0 ? exact : available.filter(({ skill, aliases }) => {
    if (!normalizedKeyword) return false;
    return [skill.id, skill.name, ...aliases].some((alias) => {
      const normalized = normalizedSkillAlias(alias);
      return normalized.includes(normalizedKeyword) || normalizedKeyword.includes(normalized);
    });
  });
  const unique = Array.from(new Map(fuzzy.map((item) => [item.skill.id, item.skill])).values());
  const candidates = unique.map((skill) => skill.name);
  const error: WeixinSkillInvocation["error"] = unique.length === 0
    ? "not-found"
    : unique.length > 1
      ? "ambiguous"
      : !query
        ? "missing-question"
        : "";
  return {
    matched: true,
    keyword,
    query,
    skillIds: error === "" || error === "missing-question" ? unique.map((skill) => skill.id) : [],
    candidates: error === "ambiguous" ? candidates : [],
    ...(error === "ambiguous" ? { candidateIds: unique.map((skill) => skill.id) } : {}),
    error
  };
}

function readBraced(value: string, start: number): { content: string; end: number } | null {
  if (value[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    else if (value[index] === "}") {
      depth -= 1;
      if (depth === 0) return { content: value.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function replaceLatexFractions(value: string): string {
  let result = value;
  for (let pass = 0; pass < 24; pass += 1) {
    const match = /\\(?:d|t)?frac\s*\{/iu.exec(result);
    if (!match || match.index === undefined) break;
    const numeratorStart = result.indexOf("{", match.index);
    const numerator = readBraced(result, numeratorStart);
    if (!numerator) break;
    let denominatorStart = numerator.end;
    while (/\s/u.test(result[denominatorStart] || "")) denominatorStart += 1;
    const denominator = readBraced(result, denominatorStart);
    if (!denominator) break;
    const replacement = `(${normalizeLatexMath(numerator.content)})/(${normalizeLatexMath(denominator.content)})`;
    result = `${result.slice(0, match.index)}${replacement}${result.slice(denominator.end)}`;
  }
  return result;
}

function replaceLatexBracedCommand(value: string, command: RegExp, wrap: (content: string) => string): string {
  let result = value;
  for (let pass = 0; pass < 24; pass += 1) {
    const match = command.exec(result);
    if (!match || match.index === undefined) break;
    const brace = result.indexOf("{", match.index);
    const group = readBraced(result, brace);
    if (!group) break;
    result = `${result.slice(0, match.index)}${wrap(normalizeLatexMath(group.content))}${result.slice(group.end)}`;
  }
  return result;
}

function normalizeLatexMath(value: string): string {
  let result = replaceLatexFractions(value);
  result = replaceLatexBracedCommand(result, /\\sqrt\s*\{/iu, (content) => `sqrt(${content})`);
  result = replaceLatexBracedCommand(result, /\\(?:text|mathrm|mathbf|operatorname)\s*\{/iu, (content) => content);
  result = result
    .replace(/\\(?:left|right)\b/giu, "")
    .replace(/\\(?:times|cdot|ast)\b/giu, " * ")
    .replace(/\\div\b/giu, " / ")
    .replace(/\\pm\b/giu, " +/- ")
    .replace(/\\approx\b/giu, " 约等于 ")
    .replace(/\\(?:leq?|lesssim)\b/giu, " <= ")
    .replace(/\\(?:geq?|gtrsim)\b/giu, " >= ")
    .replace(/\\neq?\b/giu, " != ")
    .replace(/\\(?:to|rightarrow)\b/giu, " -> ")
    .replace(/\\infty\b/giu, "无穷大")
    .replace(/\\alpha\b/giu, "alpha")
    .replace(/\\beta\b/giu, "beta")
    .replace(/\\gamma\b/giu, "gamma")
    .replace(/\\theta\b/giu, "theta")
    .replace(/\\lambda\b/giu, "lambda")
    .replace(/\\mu\b/giu, "mu")
    .replace(/\\pi\b/giu, "pi")
    .replace(/\\sigma\b/giu, "sigma")
    .replace(/\\Delta\b/gu, "Delta")
    .replace(/\^\{([^{}]+)\}/gu, (_whole, exponent: string) => ` 的 ${exponent.trim()} 次方`)
    .replace(/_\{([^{}]+)\}/gu, (_whole, index: string) => `(${index.trim()})`)
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
  return result;
}

function normalizeInlineDollarMath(whole: string, math: string): string {
  const compact = math.trim();
  const looksLikeMath = /\\|[=+*/^_<>]|\d/u.test(compact)
    || /^[A-Za-z]$/u.test(compact);
  return looksLikeMath ? normalizeLatexMath(compact) : whole;
}

/** Final channel guard: Weixin displays formulas as readable plain text, never TeX markup. */
export function formatWeixinPlainTextReply(value: unknown): string {
  let result = String(value ?? "");
  result = result
    .replace(/\$\$([\s\S]*?)\$\$/gu, (_whole, math: string) => normalizeLatexMath(math))
    .replace(/\\\[([\s\S]*?)\\\]/gu, (_whole, math: string) => normalizeLatexMath(math))
    .replace(/\\\(([\s\S]*?)\\\)/gu, (_whole, math: string) => normalizeLatexMath(math))
    .replace(/\$([^$\n]+)\$/gu, (whole: string, math: string) => normalizeInlineDollarMath(whole, math));
  result = normalizeLatexMath(result)
    .replace(/\\[()[\]]/gu, "")
    .replace(/\$\$/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return result;
}

function safeMediaReference(value: unknown): string {
  const record = asRecord(value);
  const type = firstText(record, ["type", "kind", "mediaType", "mimeType"], 80) || "媒体";
  const name = firstText(record, ["name", "fileName", "filename", "title"], 240);
  const transcript = firstText(record, ["transcript", "text", "caption", "description"], 12_000);
  const error = firstText(record, ["error"], 500);
  const hasVisionData = /^data:image\/(?:png|jpe?g|webp|gif);base64,/iu.test(cleanText(record.dataUrl, 30_000_000));
  const size = Number(record.size || record.fileSize || 0);
  const details = [name, Number.isFinite(size) && size > 0 ? `${Math.round(size / 1024)} KB` : ""].filter(Boolean).join(" · ");
  return `${type}${details ? `（${details}）` : ""}${hasVisionData ? "（已传入视觉模型）" : ""}${transcript ? `\n  已提取文字：${transcript}` : ""}${error ? `\n  读取状态：${error}` : ""}`;
}

export function formatWeixinMediaContext(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.slice(0, 20).map((item, index) => `附件 ${index + 1}：${safeMediaReference(item)}`).join("\n");
}

export function getWeixinImageContentParts(value: unknown): WeixinImageContentPart[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).flatMap((item): WeixinImageContentPart[] => {
    const record = asRecord(item);
    const dataUrl = cleanText(record.dataUrl, 30_000_000);
    if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/iu.test(dataUrl)) return [];
    return [{ type: "image_url", image_url: { url: dataUrl, detail: "auto" } }];
  });
}

export function extractWeixinWritebackEnvelope(value: unknown): {
  visibleText: string;
  envelope: WeixinWritebackEnvelope | null;
} {
  const source = String(value ?? "");
  let envelope: WeixinWritebackEnvelope | null = null;
  const visibleText = source.replace(WRITEBACK_PATTERN, (_whole, json: string) => {
    if (!envelope) {
      try {
        const parsed = asRecord(JSON.parse(json));
        const kind = cleanText(parsed.kind, 80) as WeixinWritebackKind;
        const title = cleanText(parsed.title, 300);
        const content = cleanText(parsed.content, 300_000);
        const target = cleanText(parsed.target, 500);
        if (VALID_WRITEBACK_KINDS.includes(kind) && content) envelope = { kind, title, content, target };
      } catch {
        // Invalid control data is hidden and never executed.
      }
    }
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { visibleText, envelope };
}

export function sanitizeWeixinRelativePath(value: unknown, fallback: string): string {
  const safeFallback = cleanText(fallback, 240).replace(/[<>:"|?*]/g, "-") || "handoff.md";
  const raw = cleanText(value, 500).replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-z]:\//i.test(raw)) return safeFallback;
  const segments = raw.split("/").map((segment) => segment.trim()).filter(Boolean);
  if (
    segments.length === 0
    || segments.some((segment) => segment === ".." || segment === "." || segment.startsWith("."))
    || segments.some((segment) => /[<>:"|?*\u0000-\u001f]/.test(segment))
  ) return safeFallback;
  return segments.join("/").slice(0, 500) || safeFallback;
}
