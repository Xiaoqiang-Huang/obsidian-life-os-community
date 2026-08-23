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

const SHORT_FOLLOW_UP = /^(?:请)?(?:去|到)?(?:官网|官方网站|网上|网络|互联网)(?:查|查查|查一下|搜|搜索|检索|核实|确认)(?:一下)?(?:最新|准确)?(?:信息|资料|内容|规则|价格|来源)?[。！!？?\s]*$/u;
const REFERENTIAL_FOLLOW_UP = /^(?:那|这个|这个呢|这个问题|这件事|前面(?:那个|那条|的问题)?|刚才(?:那个|的问题)?|继续|再查一下|再核实一下|展开说说|具体呢|为什么|怎么算|如何算|怎么做)[。！!？?\s]*$/u;
const IMAGE_REFERENCE = /(?:前面|刚才|之前|上面|上一张|那张|这个|这道|该)(?:的)?(?:图片|图|截图|照片|题|题目)|(?:再|重新|继续).{0,8}(?:解|分析|看)(?:一遍|一下)?/u;
const PROJECT_TERMS = /(?:这个|当前|我的)?(?:项目|代码库|仓库|工作区|会话交接|项目上下文|项目文档|项目任务|项目进度|提交|commit|分支|文件改动)/iu;
const SAVE_LINK_INTENT = /(?:收藏|保存|存下|存一下|存入|收录|加入|放进).{0,16}(?:链接|网页|文章|网址|这个信息)|(?:链接|网页|文章|网址).{0,16}(?:收藏|保存|存下|存一下|存入|收录|加入|放进)/u;
const DESTINATION_ONLY = /^(?:就|请)?(?:存|放|保存|收录)?(?:到|进|入)?\s*([^，。！？!?]{1,40})(?:里|中|分类|目录)?[。！!？?\s]*$/u;

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

export function isWeixinContextDependentFollowUp(value: unknown): boolean {
  const text = clean(value, 500);
  if (!text) return false;
  return SHORT_FOLLOW_UP.test(text)
    || REFERENTIAL_FOLLOW_UP.test(text)
    || /^(?:去|到)?(?:官网|网上).{0,12}(?:查|搜|核实)/u.test(text)
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
