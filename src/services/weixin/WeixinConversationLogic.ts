import type { WeixinSkillDescriptor } from "./WeixinBotLogic";
import {
  LIFEOS_AGENT_TOOL_REGISTRY,
  type LifeOSAgentToolDescriptor
} from "../LifeOSAgentToolRegistry";

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

export function shouldReuseWeixinImages(value: unknown, hasExplicitSkill = false): boolean {
  const text = clean(value, 2_000);
  return hasExplicitSkill || IMAGE_REFERENCE.test(text);
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
  const text = clean(value, 100_000);
  return /(?:待读取正文|正文(?:尚未|未能|无法|没有)(?:读取|获取|访问)|当前无法访问|链接读取失败|抓取失败|内容不可用|未获取到正文|仅保存了链接)/u.test(text);
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
