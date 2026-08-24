import type { WeixinSkillDescriptor } from "./WeixinBotLogic";

export interface WeixinHistoryLike {
  role: "user" | "ai" | "assistant" | "system";
  content: string;
}

export interface WeixinLinkFollowUp {
  url: string;
  title: string;
  collection: string;
}

export type WeixinExecutionRoute =
  | "greeting"
  | "web-grounded"
  | "hybrid-grounded"
  | "vision-skill"
  | "vision"
  | "skill"
  | "personal-context"
  | "general";

export interface WeixinExecutionPlan {
  route: WeixinExecutionRoute;
  useWebContext: boolean;
  useLocalContext: boolean;
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
  hasUserConstraints?: boolean;
}

export interface WeixinModelFailureClassification {
  retryable: boolean;
  userMessage: string;
}

export interface WeixinAgentToolDescriptor {
  id: string;
  mode: "read" | "write" | "reason";
  description: string;
}

/**
 * Single capability registry shared by semantic routing and user-facing Agent
 * descriptions. Adding a Life OS operation here makes the router aware of it
 * without creating another vendor- or question-specific branch.
 */
export const WEIXIN_AGENT_TOOL_REGISTRY: readonly WeixinAgentToolDescriptor[] = [
  { id: "web-search", mode: "read", description: "搜索多个公开网页来源并读取正文，适合最新外部事实、官网、新闻和公开资料" },
  { id: "lifeos-search", mode: "read", description: "混合检索 Life OS 日记、任务、记忆、项目、知识库和 LLM Wiki" },
  { id: "diary-read", mode: "read", description: "读取指定日期的日记" },
  { id: "diary-add", mode: "write", description: "把用户记录追加到日记" },
  { id: "diary-generate", mode: "write", description: "根据当日微信输入和 Life OS 事实生成今日日记" },
  { id: "task-list", mode: "read", description: "查看待办" },
  { id: "task-add", mode: "write", description: "新建待办" },
  { id: "task-update", mode: "write", description: "修改待办" },
  { id: "task-complete", mode: "write", description: "完成待办" },
  { id: "task-delete", mode: "write", description: "删除待办" },
  { id: "review-generate", mode: "write", description: "生成日、周、月或自定义日期复盘" },
  { id: "summary-generate", mode: "write", description: "汇总指定周期事实" },
  { id: "link-save", mode: "write", description: "读取链接正文并收藏到指定知识分类" },
  { id: "knowledge-save", mode: "write", description: "把文本保存到知识库" },
  { id: "reminder-add", mode: "write", description: "创建主动微信提醒" },
  { id: "reminder-list", mode: "read", description: "查看提醒" },
  { id: "reminder-cancel", mode: "write", description: "取消提醒" },
  { id: "skill-select", mode: "reason", description: "按人物、昵称或方法语义选择已安装 Skill" },
  { id: "vision", mode: "reason", description: "理解当前或会话中最近保存的图片" }
];

const SHORT_FOLLOW_UP = /^(?:请)?(?:去|到)?(?:官网|官方网站|网上|网络|互联网)(?:查|查查|查一下|搜|搜索|检索|核实|确认)(?:一下)?(?:最新|准确)?(?:信息|资料|内容|规则|价格|来源)?[。！!？?\s]*$/u;
const REFERENTIAL_FOLLOW_UP = /^(?:那|这个|这个呢|这个问题|这件事|前面(?:那个|那条|的问题)?|刚才(?:那个|的问题)?|继续|再查一下|再核实一下|展开说说|具体呢|为什么|怎么算|如何算|怎么做|(?:那(?:这个|前面那个)?|这个|它|前面那个|刚才那个)?(?:是)?(?:怎么|如何)(?:算|做|判断|理解|解释)(?:的)?)[。！!？?\s]*$/u;
const IMAGE_REFERENCE = /(?:前面|刚才|之前|上面|上一张|那张|这个|这道|该)(?:的)?(?:图片|图|截图|照片|题|题目)|(?:再|重新|继续).{0,8}(?:解|分析|看)(?:一遍|一下)?/u;
const PROJECT_TERMS = /(?:(?:这个|当前|我的|本)(?:项目|代码库|仓库|工作区|分支)|(?:会话交接|项目上下文|项目文档|项目任务|项目进度)|(?:这个|当前|最近|刚才|今天).{0,6}(?:提交|commit|文件改动|分支))/iu;
const PERSONAL_CONTEXT_TERMS = /(?:(?:我的|我(?:今天|昨天|最近|之前)?|当前|这个|本地|Life\s*OS).{0,10}(?:知识库|记忆|日记|日报|复盘|待办|任务|项目)|(?:查|找|读取|打开|看看).{0,8}(?:知识库|记忆|日记|日报|复盘|待办|任务|项目)|(?:之前|过去)(?:记录|保存|聊过))/iu;
const SAVE_LINK_INTENT = /(?:收藏|保存|存下|存一下|存入|收录|加入|放进).{0,16}(?:链接|网页|文章|网址|这个信息)|(?:链接|网页|文章|网址).{0,16}(?:收藏|保存|存下|存一下|存入|收录|加入|放进)/u;
const DESTINATION_ONLY = /^(?:就|请)?(?:存|放|保存|收录)?(?:到|进|入)?\s*([^，。！？!?]{1,40})(?:里|中|分类|目录)?[。！!？?\s]*$/u;
const SIMPLE_GREETING = /^(?:你好|您好|嗨|哈喽|哈啰|hello|hi|早上好|上午好|中午好|下午好|晚上好|在吗|在不在)[，,。.!！?？\s]*$/iu;
const KNOWLEDGE_PROBE_INTENT = /(?:什么|怎么|如何|为什么|哪个|哪些|是否|有没有|讲讲|解释|分析|比较|对比|结论|结果|进展|方案|规则|价格|版本|资料|文档|知识|研究|实验|论文|报告|数据|之前|过去|提到|讨论|保存|回顾|回忆|查找|找到|\?|？|\b(?:what|why|how|which|compare|explain|result|status|progress|research|report|api|sdk)\b)/iu;

function clean(value: unknown, max = 8_000): string {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, max);
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
 * Run a local, model-free RAG probe for substantive questions even when the
 * user does not explicitly say “查知识库”. The caller must still reject weak
 * retrieval matches before injecting any Life OS content, which avoids the
 * old behaviour where an unrelated default project contaminated every reply.
 */
export function shouldProbeWeixinKnowledge(value: unknown): boolean {
  const text = clean(value, 6_000);
  if (!text || text.length < 4 || getWeixinFastReply(text)) return false;
  return KNOWLEDGE_PROBE_INTENT.test(text);
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
      requireGrounding: false,
      allowQualityRepair: Boolean(input.hasUserConstraints),
      reasoningEffort: "high",
      maxModelCalls: input.hasUserConstraints ? 2 : 1
    };
  }
  if (input.hasExplicitSkill) {
    return {
      route: "skill",
      useWebContext: false,
      useLocalContext: false,
      requireGrounding: false,
      allowQualityRepair: true,
      reasoningEffort: "medium",
      maxModelCalls: 2
    };
  }
  if (input.hasRelevantContext) {
    return {
      route: "personal-context",
      useWebContext: false,
      useLocalContext: true,
      requireGrounding: true,
      allowQualityRepair: true,
      reasoningEffort: "medium",
      maxModelCalls: 2
    };
  }
  return {
    route: "general",
    useWebContext: false,
    useLocalContext: false,
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
  if (SHORT_FOLLOW_UP.test(current) || /(?:官网|官方网站)/u.test(current)) {
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
