import type { WeixinSkillDescriptor } from "./WeixinBotLogic";
import { formatInstantAnswerForWeixin, type InstantAnswer } from "../LocalInstantAnswerService";
/** User's explicit current-turn offline instruction beats keyword routing.
 * A later explicit change in the same message may restore normal auto search. */
export function weixinRequestWebSearchMode(content: string): "off" | "auto" {
  let mode: "off" | "auto" = "auto";
  for (const clause of String(content || "").split(/[，。！？；;,.!?\n]+/u)) {
    if (/(?:不要|禁止|不许|勿|不需要|无需|别)[^，。！？；;,.!?\n]{0,16}(?:联网|上网|搜索|检索)/u.test(clause) || /(?:只用|仅用)本地|离线(?:回答|处理|模式)/u.test(clause)) mode = "off";
    else if (/^\s*(?:但|但是|不过)?\s*(?:现在|改为|改成|可以|允许|请|要|需要|开启)[^，。！？；;,.!?\n]{0,16}(?:联网|上网|搜索|检索)/u.test(clause)) mode = "auto";
  }
  return mode;
}
export function weixinSdkFailureReply(error: string | undefined, stopReason: string, delivered?: string, linkNotice?: string): string {
  const code = error && /^(?:sdk|agent-outbox)-[a-z-]{1,80}$/.test(error) ? error : "sdk-channel-stopped";
  // KB-13B: a turn that died right after the user's own link could not be read
  // gets an actionable notice built from the real tool results instead of the
  // fixed copy. The notice is multi-line by contract (newlines are content,
  // not control characters); an empty, over-long or control-character notice
  // still degrades to the delivered copy / fixed copy below.
  const notice = String(linkNotice ?? "").trim();
  if (notice && notice.length <= 1200 && !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(notice)) return notice;
  // F-02/F-03: the SDK adapter can already have produced an actionable host
  // delivery (fixed copy + reason code) with `ok === false`. Replacing it with a
  // generic "check your configuration" line would throw away the only thing the
  // user can act on. Only our own code-tagged copy is passed through; a provider
  // body or an unrecognised error still degrades to the fixed copy and is never
  // echoed.
  const actionable = String(delivered ?? "").trim();
  if (stopReason === "tool-failure" && actionable.length <= 1200 && !/[\u0000-\u001f]/u.test(actionable)
    && /(?:SDK_EXECUTION|SDK_BOOTSTRAP|SDK_ORDINARY)_[A-Z][A-Z_]*/u.test(actionable)) {
    return actionable;
  }
  return stopReason === "aborted"
    ? `本次 SDK 请求已停止，已保留消息；不会自动重复调用模型。中断用量可能未知，请先核对执行记录。（${code}）`
    : `本次 SDK 文字请求未完成，已保留消息；不会自动重跑或切换到原 AI API。请在 Life OS 的 Agent SDK 设置中核对配置与执行记录，再明确发起新请求。（${code}）`;
}
import { hasUnavailableWebBody } from "../context-engine/WebEvidenceBody";
import {
  LIFEOS_AGENT_TOOL_REGISTRY,
  type LifeOSAgentToolDescriptor
} from "../LifeOSAgentToolRegistry";

/**
 * KB-13B: one failed user link as seen by the Weixin reply layer. The channel
 * adapter forwards `LifeOSAgentRunResult.toolResults`; this structural shape
 * keeps the decision logic independent from the Agent types.
 */
export interface WeixinWebToolResultLike {
  toolId?: string;
  ok?: boolean;
  output?: unknown;
  error?: unknown;
}

const WEB_READ_TOOL_ID = "web-page-read";
const LINK_READ_MARK = "【链接无法读取】";
const LINK_SEARCH_MARK = "【按链接自动搜索的结果】";
const LINK_NOTICE_MAX_CHARS = 1200;
const LINK_SEARCH_BLOCK_MAX_CHARS = 800;
const LINK_NOTICE_SEARCH_NOTE = "以下为按链接自动搜索的公开线索，未逐篇核对：";
const LINK_NOTICE_ALTERNATIVES = "请把链接里的关键段落直接粘贴给我，或发一张相关截图；也可以换一个能公开访问的来源（官网、公开文档）再发一次。";
const LINK_URL_PATTERN = /https?:\/\/[^\s<>"'“”‘’（）()【】\[\]]+/giu;
const LINK_URL_TRAILING_PUNCTUATION = /[)\]}>）】，。；：、！？!?"'“”‘’]+$/gu;
const NOTICE_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

function stripNoticeControlChars(value: string): string {
  return String(value ?? "").replace(NOTICE_CONTROL_CHARS, "");
}

function normalizeNoticeUrl(value: string): string {
  return String(value || "").trim().replace(LINK_URL_TRAILING_PUNCTUATION, "").replace(/\/+$/u, "").toLocaleLowerCase();
}

function noticeUrlsIn(value: unknown): string[] {
  return Array.from(new Set((String(value || "").match(LINK_URL_PATTERN) || []).map(normalizeNoticeUrl).filter(Boolean)));
}

/** The URL in `text` as it was written, matched against the user's normalized set. */
function displayUrlMatching(text: unknown, normalizedUrls: string[]): string {
  for (const item of String(text || "").match(LINK_URL_PATTERN) || []) {
    if (normalizedUrls.includes(normalizeNoticeUrl(item))) {
      return item.replace(LINK_URL_TRAILING_PUNCTUATION, "").replace(/\/+$/u, "");
    }
  }
  return "";
}

function webToolResultText(result: WeixinWebToolResultLike | undefined): string {
  if (!result) return "";
  return [result.error, result.output]
    .map((value) => (typeof value === "string" ? value : ""))
    .filter((value) => value.trim().length > 0)
    .join("\n");
}

/** Prefer a concrete HTTP status; the full reader-fallback text is noisy. */
function webReadFailureReason(value: string): string {
  const source = String(value || "");
  const marked = source.match(/【链接无法读取】[^（(\n]{1,300}[（(]([^）)\n]{1,180})[）)]/u);
  const remembered = source.match(/本轮已读取失败[（(]([^）)\n]{1,180})[）)]/u);
  const reason = stripNoticeControlChars((marked?.[1] || remembered?.[1] || source).replace(/\s+/gu, " ")).trim();
  const http = reason.match(/HTTP\s*\d{3}/iu);
  return http ? http[0].replace(/\s+/gu, " ").trim() : reason.slice(0, 80) || "读取失败";
}

/** The fallback search excerpt between its marker and the tool guidance line. */
function webReadSearchBlock(value: string): string {
  const source = String(value || "");
  const marker = source.indexOf(LINK_SEARCH_MARK);
  if (marker < 0) return "";
  const after = source.slice(marker + LINK_SEARCH_MARK.length);
  const stop = after.search(/\n\s*(?:如仍不足|【链接无法读取】)/u);
  const block = stripNoticeControlChars((stop >= 0 ? after.slice(0, stop) : after).trim());
  if (!block) return "";
  if (block.length <= LINK_SEARCH_BLOCK_MAX_CHARS) return block;
  return `${block.slice(0, LINK_SEARCH_BLOCK_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * KB-13B: the actionable copy for "the link you sent could not be read". It is
 * built only from what the turn actually observed — a web-page-read failure
 * whose URL is one the user pasted this turn — and never claims the link
 * content was read. The primary evidence is a failed (`ok === false`) read;
 * the KB-13 A1 tool layer also delivers the first failure as combined marker
 * text before later retries fail, and that shape is accepted too.
 */
export function buildWeixinLinkFailureNotice(
  toolResults: readonly WeixinWebToolResultLike[] | undefined,
  userTurnText: unknown
): string | undefined {
  const userUrls = noticeUrlsIn(userTurnText);
  if (userUrls.length === 0) return undefined;
  const results: readonly WeixinWebToolResultLike[] = Array.isArray(toolResults) ? toolResults : [];
  if (results.length === 0) return undefined;
  const tiesToUser = (text: string): boolean =>
    noticeUrlsIn(text).some((url) => userUrls.includes(url));
  const readResults = results.filter((result) => result && result.toolId === WEB_READ_TOOL_ID);
  if (readResults.length === 0) return undefined;
  const failedRead = readResults.find((result) => result.ok === false && tiesToUser(webToolResultText(result)));
  const markedRead = results.find((result) => webToolResultText(result).includes(LINK_READ_MARK) && tiesToUser(webToolResultText(result)));
  const source = failedRead || markedRead;
  if (!source) return undefined;
  const sourceText = webToolResultText(source);
  const url = displayUrlMatching(sourceText, userUrls);
  const reason = webReadFailureReason(sourceText);
  const searchBlock = results
    .map((result) => webReadSearchBlock(webToolResultText(result)))
    .find(Boolean) || "";
  const head = [`你发来的链接无法读取（${reason}）。`, url ? `链接：${url}` : ""].filter(Boolean);
  const compose = (block: string): string => [
    ...head,
    ...(block ? ["", LINK_NOTICE_SEARCH_NOTE, block] : []),
    "",
    LINK_NOTICE_ALTERNATIVES
  ].join("\n");
  let block = searchBlock;
  let notice = stripNoticeControlChars(compose(block));
  if (notice.length > LINK_NOTICE_MAX_CHARS && block) {
    const excess = notice.length - LINK_NOTICE_MAX_CHARS;
    block = `${block.slice(0, Math.max(block.length - excess - 1, 0)).trimEnd()}…`;
    notice = stripNoticeControlChars(compose(block));
  }
  if (notice.length > LINK_NOTICE_MAX_CHARS) {
    notice = stripNoticeControlChars(compose("")).slice(0, LINK_NOTICE_MAX_CHARS);
  }
  return notice.slice(0, LINK_NOTICE_MAX_CHARS);
}

/** KB-13B: failed web-page-read calls this turn (input for the footnote). */
export function countWeixinWebReadFailures(toolResults: readonly WeixinWebToolResultLike[] | undefined): number {
  return (Array.isArray(toolResults) ? toolResults : [])
    .filter((result) => result && result.toolId === WEB_READ_TOOL_ID && result.ok === false)
    .length;
}

/**
 * KB-13B: append the read-failure footnote once, after the reply is final.
 * An existing footnote (any count) is left alone so the sentence never repeats.
 */
export function appendWeixinReadFailureFootnote(text: string, failureCount: number): string {
  const body = String(text ?? "");
  const count = Math.floor(Number(failureCount));
  if (!Number.isFinite(count) || count <= 0) return body;
  if (/本轮另有\s*\d+\s*个网页读取失败/u.test(body)) return body;
  const note = `（本轮另有 ${count} 个网页读取失败，其内容未纳入。）`;
  const trimmed = body.replace(/\s+$/u, "");
  return trimmed ? `${trimmed}\n\n${note}` : note;
}

function weixinReplyBlockContent(block: string): string {
  return block.replace(/^(?:[ \t]{0,3}#{1,6}[^\n]*\n?)+/u, "");
}

function weixinReplyBlocks(text: string): string[] {
  // Blank lines and heading starts both begin a new block; a heading keeps the
  // content that immediately follows it inside the same block.
  const blocks: string[] = [];
  for (const span of text.split(/\n{2,}/u)) {
    let current: string[] = [];
    for (const line of span.split("\n")) {
      const heading = /^[ \t]{0,3}#{1,6}\s+\S/u.test(line);
      if (heading && current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) blocks.push(current.join("\n"));
  }
  return blocks.filter((block) => block.trim().length > 0);
}

/**
 * KB-13B: remove repeated paragraphs/sections from a Weixin reply (the real
 * accident repeated one paragraph under `## 简要总结` and `## 国考`). Only
 * blocks whose normalized content is ≥60 chars are compared; short
 * acknowledgements and differently-cited variants ([S1] vs [S2]) stay. A
 * duplicate section loses its heading too, so no empty `## 标题` survives.
 */
export function dedupeWeixinReply(text: string): string {
  const source = String(text ?? "");
  if (!source.trim()) return source;
  const blocks = weixinReplyBlocks(source.replace(/\r\n?/gu, "\n"));
  if (blocks.length <= 1) return source;
  const seen = new Set<string>();
  const kept: string[] = [];
  let dropped = false;
  for (const block of blocks) {
    const normalized = weixinReplyBlockContent(block).replace(/\s+/gu, " ").trim();
    if (normalized.length >= 60 && seen.has(normalized)) {
      if (kept.length > 0 && weixinReplyBlockContent(kept[kept.length - 1]).trim().length === 0) kept.pop();
      dropped = true;
      continue;
    }
    if (normalized.length >= 60) seen.add(normalized);
    kept.push(block);
  }
  if (!dropped) return source;
  return kept.join("\n\n");
}

export interface WeixinHistoryLike {
  role: "user" | "ai" | "assistant" | "system";
  content: string;
}

export interface WeixinLinkFollowUp {
  url: string;
  title: string;
  collection: string;
}

export interface WeixinProjectLike {
  id: string;
  name: string;
}

export interface WeixinContextSourceLike {
  path: string;
  title?: string;
  heading?: string;
  excerpt?: string;
  score?: number;
  type?: string;
}

export type WeixinExecutionRoute =
  | "greeting"
  | "web-grounded"
  | "hybrid-grounded"
  | "vision-skill"
  | "vision"
  | "skill"
  | "local-augmented"
  | "personal-context"
  | "general";

export type WeixinGroundingMode = "none" | "augment" | "strict";

export interface WeixinExecutionPlan {
  route: WeixinExecutionRoute;
  useWebContext: boolean;
  useLocalContext: boolean;
  groundingMode: WeixinGroundingMode;
  requireGrounding: boolean;
  allowQualityRepair: boolean;
  reasoningEffort: "low" | "medium" | "high";
  /**
   * Upper bound for answer-generation calls after deterministic routing.
   * A web route may separately spend one bounded query-planning call while
   * deterministic search is already running. A repair is only spent when a
   * deterministic quality check finds a concrete problem.
   */
  maxModelCalls: number;
}

export interface WeixinExecutionPlanInput {
  content: unknown;
  forceWebSearch?: boolean;
  hasImages?: boolean;
  hasExplicitSkill?: boolean;
  hasRelevantContext?: boolean;
  requiresStrictGrounding?: boolean;
  hasUserConstraints?: boolean;
}

export interface WeixinModelFailureClassification {
  retryable: boolean;
  userMessage: string;
}

export type WeixinAgentToolDescriptor = LifeOSAgentToolDescriptor;

/**
 * Single capability registry shared by semantic routing and user-facing Agent
 * descriptions. Adding a Life OS operation here makes the router aware of it
 * without creating another vendor- or question-specific branch.
 */
export const WEIXIN_AGENT_TOOL_REGISTRY: readonly WeixinAgentToolDescriptor[] = LIFEOS_AGENT_TOOL_REGISTRY;

const SHORT_FOLLOW_UP = /^(?:请)?(?:去|到)?(?:官网|官方网站|网上|网络|互联网)(?:查|查查|查一下|搜|搜索|检索|核实|确认)(?:一下)?(?:最新|准确)?(?:信息|资料|内容|规则|价格|来源)?[。！!？?\s]*$/u;
const REFERENTIAL_FOLLOW_UP = /^(?:那|这个|这个呢|这个问题|这件事|前面(?:那个|那条|的问题)?|刚才(?:那个|的问题)?|继续|再查一下|再核实一下|展开说说|具体呢|为什么|怎么算|如何算|怎么做|(?:那(?:这个|前面那个)?|这个|它|前面那个|刚才那个)?(?:是)?(?:怎么|如何)(?:算|做|判断|理解|解释)(?:的)?)[。！!？?\s]*$/u;
const WEB_CAPABILITY_FOLLOW_UP = /^(?:你)?(?:(?:不能|不会|没(?:有)?|怎么没|为什么没)(?:给我)?(?:联网|上网|网络|网页)(?:搜索|检索|查找|查|搜)?(?:吗|么|呢|？|\?)?|(?:再|重新)(?:联网|上网|网络|网页)(?:搜索|检索|查找|查|搜)(?:一下)?)[。！!？?\s]*$/u;
const PROJECT_CONTEXT_FOLLOW_UP = /^(?:这个|当前|刚才|前面)?(?:内容|资料|进展|记录)?(?:在|从)?(?:项目上下文|项目记忆|会话记录|工作记录)(?:里|中|里面)?(?:可以|应该|能够|能)?(?:看到|找到|查到|读到|有)(?:的|啊|呀|吧|吗)?[。！!？?\s]*$/u;
const IMAGE_REFERENCE = /(?:前面|刚才|之前|上面|上一张|那张|这个|这道|该)(?:的)?(?:图片|图|截图|照片|题|题目)|(?:再|重新|继续).{0,8}(?:解|分析|看)(?:一遍|一下)?/u;
const PENDING_IMAGE_INSTRUCTION = /(?:图片|截图|照片|图中|看图|识图|读图|这道题|这个题|题目|OCR|文字识别|提取文字|识别文字|分析(?:一下)?(?:这|该)?(?:张)?图|解(?:一下)?(?:这|该)?(?:道)?题)/iu;
const PROJECT_TERMS = /(?:(?:这个|当前|我的|本)(?:项目|代码库|仓库|工作区|分支)|(?:会话交接|项目上下文|项目记忆|项目文档|项目任务|项目进度|会话记录|工作记录)|(?:这个|当前|最近|刚才|今天).{0,6}(?:提交|commit|文件改动|分支))/iu;
const PERSONAL_CONTEXT_TERMS = /(?:(?:我的|我(?:今天|昨天|最近|之前)?|当前|这个|本地|Life\s*OS).{0,12}(?:知识库|记忆|日记|日报|复盘|待办|任务|项目|科研|工作|学习|进展|成果|会话|上下文)|(?:查|找|读取|打开|看看|看一下).{0,10}(?:我的)?(?:知识库|记忆|日记|日报|复盘|待办|任务|项目|科研|工作记录|会话记录|项目上下文)|(?:项目上下文|项目记忆|会话记录|工作记录).{0,10}(?:看到|找到|查到|读到|有)|(?:之前|过去)(?:记录|保存|聊过))/iu;
const SAVE_LINK_INTENT = /(?:收藏|保存|存下|存一下|存入|收录|加入|放进).{0,16}(?:链接|网页|文章|网址|这个信息)|(?:链接|网页|文章|网址).{0,16}(?:收藏|保存|存下|存一下|存入|收录|加入|放进)/u;
const DESTINATION_ONLY = /^(?:就|请)?(?:存|放|保存|收录)?(?:到|进|入)?\s*([^，。！？!?]{1,40})(?:里|中|分类|目录)?[。！!？?\s]*$/u;
const SIMPLE_GREETING = /^(?:你好|您好|嗨|哈喽|哈啰|hello|hi|早上好|上午好|中午好|下午好|晚上好|在吗|在不在)[，,。.!！?？\s]*$/iu;
const EXPLICIT_LIFEOS_EVIDENCE_CUE = /(?:我的|我(?:今天|昨天|最近|之前)|Life\s*OS|知识库|项目上下文|项目记忆|会话记录|工作记录|日记|日报|复盘|待办|之前保存|过去记录|以前聊过|最终结论|实验结果|项目进展|当前状态)/iu;
const SPECIFIC_RESULT_CUE = /(?:结论|结果|进展|状态|版本|规则|价格|报告|数据|论文|实验|benchmark|评测|指标)/iu;
const SPECIFIC_LOCAL_RESULT_CUE = /(?:结论|结果|进展|实验结果|benchmark|评测|指标)/iu;
const SPECIFIC_ENTITY = /(?:\b[a-z][a-z0-9._+/#-]{2,}\b|[A-Z]{2,}(?:[-_][A-Z0-9]+)+)/u;
const STRICT_PROJECT_STATE_CUE = /(?:(?:项目|科研|研究|实验|论文).{0,16}(?:最近|当前|今天|昨天|本周|进展|状态|完成|修改|变更|更新|做了什么)|(?:最近|当前|今天|昨天|本周).{0,16}(?:项目|科研|研究|实验|论文).{0,12}(?:进展|状态|完成|修改|变更|更新|做了什么))/iu;
const STRICT_SOURCE_REQUEST_CUE = /(?:读取|查看|打开|查找|检索|核对|总结|提取).{0,18}(?:我的)?(?:日记|日报|复盘|待办|任务|记录|文档|资料|知识库|会话|项目上下文|项目记忆)/iu;

function clean(value: unknown, max = 8_000): string {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, max);
}

/** Extract stable semantic anchors without treating generic action words as facts. */
export function extractWeixinSemanticTerms(value: unknown): string[] {
  const text = clean(value, 6_000).toLowerCase();
  const terms = new Set<string>();
  const englishStop = /^(?:what|why|how|which|compare|explain|result|results|status|progress|latest|current|official|the|and|with|from|this|that|api|sdk|project|context)$/iu;
  (text.match(/[a-z][a-z0-9._+/#-]{2,}/giu) || [])
    .filter((term) => !englishStop.test(term))
    .forEach((term) => terms.add(term));

  const stripped = text.replace(
    /(?:请|麻烦|帮我|给我|替我|能不能|可以|看一下|看看|看下|查一下|查查|查询|查找|读取|打开|告诉我|总结|分析|解释|当前|现在|今天|昨天|最近|之前|过去|这个|那个|我的|我|项目上下文|项目记忆|会话记录|工作记录|项目|上下文|里面|当中|可以|能够|看到|找到|进展|状态|情况|结果|结论|资料|内容|一下|是什么|怎么样|有哪些|如何|为什么)/gu,
    " "
  );
  const generic = new Set(["项目", "上下文", "进展", "状态", "情况", "结果", "结论", "资料", "内容", "任务", "日记", "复盘"]);
  for (const run of stripped.match(/[\u3400-\u9fff]{2,}/gu) || []) {
    if (generic.has(run)) continue;
    terms.add(run);
    const maxSize = Math.min(6, run.length);
    for (let size = maxSize; size >= 2 && terms.size < 40; size -= 1) {
      for (let index = 0; index + size <= run.length && terms.size < 40; index += 1) {
        const term = run.slice(index, index + size);
        if (!generic.has(term)) terms.add(term);
      }
    }
  }
  return Array.from(terms);
}

/**
 * Resolve a read-context project from explicit names or high-scoring retrieved
 * project assets. The configured default is only a tie-breaker; it never wins
 * merely because it exists, which prevents every Weixin question entering the
 * same unrelated project.
 */
export function resolveWeixinProjectFromContext(
  value: unknown,
  projects: WeixinProjectLike[],
  sources: WeixinContextSourceLike[],
  configuredProjectId = ""
): string {
  const query = clean(value, 6_000).toLowerCase();
  const terms = extractWeixinSemanticTerms(query);
  const scores = new Map<string, number>();
  const explicit = new Set<string>();
  const add = (id: string, score: number) => scores.set(id, (scores.get(id) || 0) + score);

  for (const project of projects) {
    const id = clean(project.id, 160);
    const name = clean(project.name, 160).toLowerCase();
    if (!id) continue;
    if ((name && query.includes(name)) || query.includes(id.toLowerCase())) {
      add(id, 120);
      explicit.add(id);
    }
  }

  for (const source of sources) {
    if (source.type === "url") continue;
    const path = clean(source.path, 2_000).replace(/\\/gu, "/").toLowerCase();
    const haystack = [source.title, source.heading, source.path, source.excerpt].map((item) => clean(item, 8_000)).join("\n").toLowerCase();
    const termHits = terms.filter((term) => haystack.includes(term));
    if (termHits.length === 0) continue;
    for (const project of projects) {
      const id = clean(project.id, 160);
      if (!id) continue;
      const lowerId = id.toLowerCase();
      const idPattern = new RegExp(`(?:^|/)${lowerId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:/|$)`, "u");
      const projectAsset = idPattern.test(path)
        || new RegExp(`project[_-]?id\\s*[:=]\\s*${lowerId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u").test(haystack);
      if (!projectAsset) continue;
      const retrievalScore = Number.isFinite(source.score) ? Math.max(0, Math.min(1, Number(source.score))) : 0;
      add(id, 24 + Math.min(termHits.length, 4) * 6 + retrievalScore * 10);
    }
  }

  if (configuredProjectId && scores.has(configuredProjectId)) add(configuredProjectId, 0.25);
  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return "";
  if (explicit.has(ranked[0][0])) return ranked[0][0];
  if (ranked[0][1] < 20) return "";
  if (ranked[1] && ranked[0][1] - ranked[1][1] < 5) return "";
  return ranked[0][0];
}

/**
 * A conversation binding is a useful default for phrases such as “这个项目”,
 * but it must not override a new semantic domain such as “我的科研进展”. In the
 * latter case the caller should first run a global Life OS probe and let
 * retrieved project assets select the matching project. This keeps a Weixin
 * chat that was once bound to 公考 from hiding the user's research workspace.
 */
export function shouldUseWeixinBoundProject(value: unknown, projectName = ""): boolean {
  const text = clean(value, 6_000);
  if (!text) return false;
  const normalizedName = clean(projectName, 160).toLowerCase();
  if (normalizedName && text.toLowerCase().includes(normalizedName)) return true;
  if (!isWeixinPersonalContextQuery(text)) return isWeixinProjectRelevantQuery(text, projectName);
  return extractWeixinSemanticTerms(text).length === 0;
}

function recentUserMessages(history: WeixinHistoryLike[], limit = 6): string[] {
  return history
    .filter((item) => item.role === "user")
    .map((item) => clean(item.content))
    .filter(Boolean)
    .slice(-limit);
}

/**
 * Short social turns should never pay the cost of project retrieval, Skill
 * composition, or a remote model request. Keep this deliberately strict so a
 * substantive request beginning with “你好” still reaches normal routing.
 */
export function getWeixinFastReply(value: unknown): string {
  const text = clean(value, 120);
  if (!SIMPLE_GREETING.test(text)) return "";
  return "你好，我在。今天想记录、查询，还是处理一件事？";
}

export interface WeixinInstantAnswerGate {
  mode: "auto" | "off";
  hasImages: boolean;
  question: string;
  answer: (question: string) => Promise<InstantAnswer>;
}

/**
 * Channel gate for deterministic local answers. Only a high-confidence local
 * hit may bypass the model; a disabled switch, a failed/empty answer, images,
 * or any exception falls through to the original model chain without blocking
 * it. Delivery is plain text, control-character free and bounded.
 */
export async function tryWeixinInstantAnswer(input: WeixinInstantAnswerGate): Promise<string | null> {
  if (!input || input.mode === "off" || input.hasImages) return null;
  const question = clean(input.question, 6_000);
  if (!question) return null;
  try {
    const answer = await input.answer(question);
    if (!answer || answer.intent === "none" || answer.confidence !== "high") return null;
    return formatInstantAnswerForWeixin(answer) || null;
  } catch {
    return null;
  }
}

/**
 * Run a local, model-free RAG probe only when the request contains a personal
 * evidence cue or a specific entity/result question. General explanations and
 * advice remain directly answerable; this keeps RAG an augmentation tool
 * instead of turning every “怎么/如何” question into a mandatory citation task.
 */
export function shouldProbeWeixinKnowledge(value: unknown): boolean {
  const text = clean(value, 6_000);
  if (!text || text.length < 4 || getWeixinFastReply(text)) return false;
  if (isWeixinPersonalContextQuery(text) || isWeixinProjectRelevantQuery(text)) return true;
  if (EXPLICIT_LIFEOS_EVIDENCE_CUE.test(text)) return true;
  return SPECIFIC_ENTITY.test(text) && SPECIFIC_RESULT_CUE.test(text);
}

/**
 * Strict grounding is reserved for answers whose value depends on the user's
 * private state or a named local artifact. A project/topic name by itself is
 * only a personalization hint and must never prevent a generally useful
 * answer when local retrieval or citation formatting is imperfect.
 */
export function requiresWeixinStrictGrounding(value: unknown): boolean {
  const text = clean(value, 6_000);
  if (!text) return false;
  return isWeixinPersonalContextQuery(text)
    || STRICT_PROJECT_STATE_CUE.test(text)
    || STRICT_SOURCE_REQUEST_CUE.test(text)
    || (SPECIFIC_ENTITY.test(text) && SPECIFIC_LOCAL_RESULT_CUE.test(text));
}

/**
 * Decide the expensive parts of a Weixin turn before loading Vault context.
 * This prevents an unrelated default project from contaminating general or
 * image/Skill questions, and makes the number of model calls auditable.
 */
export function buildWeixinExecutionPlan(input: WeixinExecutionPlanInput): WeixinExecutionPlan {
  if (getWeixinFastReply(input.content)) {
    return {
      route: "greeting",
      useWebContext: false,
      useLocalContext: false,
      groundingMode: "none",
      requireGrounding: false,
      allowQualityRepair: false,
      reasoningEffort: "low",
      maxModelCalls: 0
    };
  }
  if (input.forceWebSearch) {
    return {
      route: input.hasRelevantContext ? "hybrid-grounded" : "web-grounded",
      useWebContext: true,
      useLocalContext: Boolean(input.hasRelevantContext),
      groundingMode: "strict",
      requireGrounding: true,
      allowQualityRepair: true,
      reasoningEffort: "medium",
      maxModelCalls: 2
    };
  }
  if (input.hasImages && input.hasExplicitSkill) {
    return {
      route: "vision-skill",
      useWebContext: false,
      useLocalContext: false,
      groundingMode: "none",
      requireGrounding: false,
      allowQualityRepair: true,
      reasoningEffort: "high",
      maxModelCalls: 2
    };
  }
  if (input.hasImages) {
    return {
      route: "vision",
      useWebContext: false,
      useLocalContext: false,
      groundingMode: "none",
      requireGrounding: false,
      allowQualityRepair: Boolean(input.hasUserConstraints),
      reasoningEffort: "high",
      maxModelCalls: input.hasUserConstraints ? 2 : 1
    };
  }
  if (input.hasExplicitSkill) {
    const groundingMode: WeixinGroundingMode = input.hasRelevantContext
      ? input.requiresStrictGrounding ? "strict" : "augment"
      : "none";
    return {
      route: "skill",
      useWebContext: false,
      useLocalContext: Boolean(input.hasRelevantContext),
      groundingMode,
      requireGrounding: groundingMode === "strict",
      allowQualityRepair: true,
      reasoningEffort: "medium",
      maxModelCalls: 2
    };
  }
  if (input.hasRelevantContext) {
    const strict = input.requiresStrictGrounding === true;
    return {
      route: strict ? "personal-context" : "local-augmented",
      useWebContext: false,
      useLocalContext: true,
      groundingMode: strict ? "strict" : "augment",
      requireGrounding: strict,
      allowQualityRepair: true,
      reasoningEffort: "medium",
      maxModelCalls: 2
    };
  }
  return {
    route: "general",
    useWebContext: false,
    useLocalContext: false,
    groundingMode: "none",
    requireGrounding: false,
    allowQualityRepair: Boolean(input.hasUserConstraints),
    reasoningEffort: "low",
    maxModelCalls: input.hasUserConstraints ? 2 : 1
  };
}

/**
 * Provider billing/auth/configuration failures do not become healthy by
 * replaying the same inbound message after every restart. Network pressure and
 * rate limits remain recoverable and stay in the durable retry queue.
 */
export function classifyWeixinModelFailure(value: unknown): WeixinModelFailureClassification {
  const text = value instanceof Error
    ? `${value.name}: ${value.message}`
    : typeof value === "string"
      ? value
      : JSON.stringify(value || "");
  if (/(?:\b402\b|payment\s*required|insufficient\s*(?:balance|credits?)|余额不足|欠费|计费状态)/iu.test(text)) {
    return {
      retryable: false,
      userMessage: "AI 服务商拒绝了本次请求（余额、额度或计费状态异常）。请在 Life OS 设置中检查该模型账号；这条消息不会反复重试。"
    };
  }
  if (/(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid\s*(?:api\s*)?key|鉴权失败|密钥无效)/iu.test(text)) {
    return {
      retryable: false,
      userMessage: "AI 服务商拒绝了身份验证。请在 Life OS 设置中检查 API Key 和模型权限；这条消息不会反复重试。"
    };
  }
  if (/(?:\b404\b|model\s*(?:not\s*found|does\s*not\s*exist)|unknown\s*model|模型不存在)/iu.test(text)) {
    return {
      retryable: false,
      userMessage: "当前配置的 AI 模型不可用。请在 Life OS 设置中重新选择模型；这条消息不会反复重试。"
    };
  }
  return {
    retryable: true,
    userMessage: "AI 服务暂时不可用，Life OS 会保留这条消息并稍后重试。"
  };
}

export function isWeixinContextDependentFollowUp(value: unknown): boolean {
  const text = clean(value, 500);
  if (!text) return false;
  return SHORT_FOLLOW_UP.test(text)
    || REFERENTIAL_FOLLOW_UP.test(text)
    || WEB_CAPABILITY_FOLLOW_UP.test(text)
    || PROJECT_CONTEXT_FOLLOW_UP.test(text)
    || /^(?:去|到)?(?:官网|网上).{0,12}(?:查|搜|核实)/u.test(text)
    || /^(?:继续|再|重新).{0,12}(?:解释|分析|回答|计算|解).{0,12}(?:前面|刚才|之前|上面).{0,8}(?:问题|题|题目|内容)/u.test(text)
    || /(?:前面|刚才|之前|上面|那个|这个|它|其)(?:的)?(?:问题|内容|规则|价格|资料|说法|结果|题目)/u.test(text);
}

/**
 * Deterministic fallback for follow-ups. An AI rewriter may improve this, but
 * retrieval must never receive a context-free command such as “去官网查一下”.
 */
export function buildWeixinStandaloneQuery(
  value: unknown,
  history: WeixinHistoryLike[],
  lastStandaloneQuery = ""
): string {
  const current = clean(value);
  if (!current || !isWeixinContextDependentFollowUp(current)) return current;
  const candidates = [...recentUserMessages(history).reverse(), clean(lastStandaloneQuery)]
    .filter(Boolean)
    .filter((item) => item !== current)
    .filter((item) => !isWeixinContextDependentFollowUp(item));
  const subject = candidates[0] || "";
  if (!subject) return current;
  if (SHORT_FOLLOW_UP.test(current) || WEB_CAPABILITY_FOLLOW_UP.test(current) || /(?:官网|官方网站)/u.test(current)) {
    return `${subject}\n请检索并核对官方网站的最新信息，优先使用官方来源。`;
  }
  return `${subject}\n用户追问：${current}`;
}

export function isWeixinProjectRelevantQuery(value: unknown, projectName = ""): boolean {
  const text = clean(value);
  if (!text) return false;
  const normalizedProject = clean(projectName, 120).toLowerCase();
  if (normalizedProject && text.toLowerCase().includes(normalizedProject)) return true;
  return PROJECT_TERMS.test(text);
}

export function isWeixinPersonalContextQuery(value: unknown): boolean {
  return PERSONAL_CONTEXT_TERMS.test(clean(value, 2_000));
}

export function shouldReuseWeixinImages(value: unknown, _hasExplicitSkill = false): boolean {
  const text = clean(value, 2_000);
  return IMAGE_REFERENCE.test(text);
}

/**
 * Decide whether a separately-sent image batch belongs to the current text
 * turn. A named Skill alone is deliberately insufficient: “用小P解释言语
 * 理解” must not silently inherit the previous screenshot, while “用小P解
 * 这道题” is an explicit attachment instruction and should bind it.
 */
export function shouldBindPendingWeixinImages(value: unknown): boolean {
  const text = clean(value, 2_000);
  if (!text) return false;
  return IMAGE_REFERENCE.test(text) || PENDING_IMAGE_INSTRUCTION.test(text);
}

/**
 * A named Skill belongs to the Weixin conversation, not to the desktop-wide
 * selector. Reuse it only for a genuine follow-up (including references to a
 * previous image); an unrelated new question must return to the neutral Skill.
 */
export function resolveWeixinConversationSkillIds(
  currentSkillIds: string[] | undefined,
  rememberedSkillIds: string[] | undefined,
  availableSkillIds: string[],
  value: unknown
): string[] {
  const available = new Set(availableSkillIds.map((item) => clean(item, 240)).filter(Boolean));
  const filterAvailable = (values: string[] | undefined) => Array.from(new Set(
    (values || []).map((item) => clean(item, 240)).filter((item) => available.has(item))
  )).slice(0, 8);
  const current = filterAvailable(currentSkillIds);
  if (current.length > 0) return current;
  if (!isWeixinContextDependentFollowUp(value) && !shouldReuseWeixinImages(value, false)) return [];
  return filterAvailable(rememberedSkillIds);
}

export function findRecentWeixinUrl(value: unknown, history: WeixinHistoryLike[]): string {
  const inputs = [clean(value), ...recentUserMessages(history, 12).reverse()];
  for (const input of inputs) {
    const match = input.match(/https?:\/\/[^\s<>()]+/iu);
    if (match) return match[0].replace(/[，。；;！!？?）)】\]]+$/u, "");
  }
  return "";
}

export function isWeixinLinkSaveIntent(value: unknown): boolean {
  return SAVE_LINK_INTENT.test(clean(value));
}

export function parseWeixinLinkDestination(value: unknown): string {
  const text = clean(value, 200);
  const explicit = text.match(/(?:存|放|保存|收录|加入)(?:到|进|入)\s*([^，。！？!?]{1,40})(?:里|中|分类|目录)?/u)?.[1];
  if (explicit) return clean(explicit, 40);
  const only = text.match(DESTINATION_ONLY)?.[1] || "";
  if (!only || /^(?:这里|那里|知识库|收藏|一下|这个信息)$/u.test(only)) return "";
  return clean(only, 40);
}

export function resolveWeixinLinkFollowUp(
  value: unknown,
  history: WeixinHistoryLike[],
  pending?: { url?: string; title?: string; collection?: string } | null
): WeixinLinkFollowUp | null {
  const text = clean(value);
  const explicitIntent = isWeixinLinkSaveIntent(text);
  const destination = parseWeixinLinkDestination(text) || clean(pending?.collection, 40);
  const url = findRecentWeixinUrl(text, history) || clean(pending?.url, 2_000);
  if (!url) return null;
  if (!explicitIntent && !pending) return null;
  const title = clean(pending?.title, 200);
  return { url, title, collection: destination };
}

export function hasUnavailableWeixinEvidence(value: unknown): boolean {
  return hasUnavailableWebBody(clean(value, 100_000));
}

export function allWeixinEvidenceUnavailable(values: unknown[]): boolean {
  const usable = values.map((item) => clean(item, 20_000)).filter(Boolean);
  return usable.length > 0 && usable.every((item) => hasUnavailableWeixinEvidence(item));
}

export function extractWeixinUserConstraints(value: unknown, history: WeixinHistoryLike[]): string[] {
  const candidates = [...recentUserMessages(history, 5), clean(value, 2_000)];
  const constraints: string[] = [];
  for (const candidate of candidates) {
    for (const sentence of candidate.split(/[。！？!?；;\n]+/u)) {
      const trimmed = clean(sentence, 300);
      if (!trimmed || !/(?:不要|不想|不用|避免|只要|只需|希望|请直接|别再)/u.test(trimmed)) continue;
      if (!constraints.includes(trimmed)) constraints.push(trimmed);
    }
  }
  return constraints.slice(-6);
}

/**
 * Detect only concrete, inexpensive constraint violations. This is not a
 * second model review: it catches direct contradictions such as “不要精算”
 * followed by “下面逐项精算”, so a repair call is spent only when needed.
 */
export function findWeixinConstraintViolations(answer: unknown, constraints: string[]): string[] {
  const response = clean(answer, 100_000);
  if (!response || constraints.length === 0) return [];
  const violations: string[] = [];
  const add = (constraint: string) => {
    if (constraint && !violations.includes(constraint)) violations.push(constraint);
  };
  for (const raw of constraints) {
    const constraint = clean(raw, 500);
    if (!constraint) continue;
    const target = constraint.match(/(?:不要|不想|不用|无需|避免|别(?:再)?)(?:再|做|进行|使用|采用|输出|展示|提及|写)?\s*([^，。！？；;]{1,32})/u)?.[1]
      ?.replace(/^(?:用|做|进行|使用|采用|输出|展示|提及|写)\s*/u, "")
      .trim();
    if (target && target.length >= 2) {
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const mentions = new RegExp(escaped, "u");
      const respectful = new RegExp(`(?:不必|不用|无需|不需要|避免|不要|不会|不再).{0,6}${escaped}`, "u");
      if (mentions.test(response) && !respectful.test(response)) {
        add(constraint);
        continue;
      }
    }
    if (/(?:不要|不想|不用|无需|避免).{0,8}(?:精算|复杂计算|详细计算|计算过程)/u.test(constraint)) {
      const operations = response.match(/\d+(?:\.\d+)?\s*%?\s*[+*/-]\s*\d+(?:\.\d+)?/gu) || [];
      if (/(?:逐项|详细|继续|下面).{0,6}(?:精算|计算)/u.test(response) || operations.length >= 2) add(constraint);
    }
    if (/(?:不要|不用|避免).{0,8}(?:表格|Markdown\s*表格)/iu.test(constraint)
      && /\|[^\n|]+\|[^\n|]+\|/u.test(response)) add(constraint);
  }
  return violations.slice(0, 6);
}

export function unselectedWeixinSkillMentions(
  answer: unknown,
  selectedSkillIds: string[],
  skills: WeixinSkillDescriptor[]
): string[] {
  const text = clean(answer, 100_000).replace(/\s+/gu, "").toLowerCase();
  const selected = new Set(selectedSkillIds);
  return skills
    .filter((skill) => !selected.has(skill.id))
    .filter((skill) => {
      const name = clean(skill.name, 120).replace(/\s+/gu, "").toLowerCase();
      return name.length >= 2 && text.includes(name);
    })
    .map((skill) => skill.name)
    .slice(0, 8);
}
