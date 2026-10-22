import type { ContextSource } from "./types";
import { splitSentenceFragments } from "../../utils/sentence-split";

type WebSourceText = Pick<ContextSource, "title" | "excerpt">;
const UI_LINES = new Set([
  "网易首页", "新浪网", "应用", "申请入驻", "关注", "确定 取消", "确定不再关注此人吗",
  "举报", "分享至好友和朋友圈", "北京", "登录", "注册", "打开APP", "打开 App", "-->",
  "点击展开全文", "展开全文", "收起全文", "返回首页"
]);

/** Only removes common title/site decoration; never infers an article's event. */
export function normalizedWebHeadline(title: string): string {
  const pieces = title.trim().replace(/^#{1,6}\s+/u, "").split(/[|｜_]/u);
  const tail = pieces[pieces.length - 1].trim();
  // A suffix describing another event is not a website decoration.
  const site = tail.length <= 20 && /(?:新闻站|新闻网|新闻|资讯|频道|网站|网)$/u.test(tail)
    && !/发布|公布|宣布|推出|合作|投资|收购|融资|增长|下降/u.test(tail);
  if (pieces.length > 1 && site) {
    pieces.pop();
    while (pieces.length > 1 && /^(?:科技|新闻|资讯|财经|教育|视频|热点|项目|检索)$/u.test(pieces[pieces.length - 1].trim())) pieces.pop();
  }
  return pieces.join(" ").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Keep article text as data; strip reader envelopes and known website furniture. */
export function extractReadableWebBody(source: WebSourceText): string {
  const title = String(source.title || "").trim();
  const titles = new Set([title, title.split("|")[0].trim()].filter(Boolean));
  const headline = normalizedWebHeadline(title);
  const undecorated = title.split(/[|｜_·]/u)[0].trim().replace(/[\s\p{P}\p{S}]/gu, "").toLocaleLowerCase();
  const output: string[] = [];
  for (const raw of String(source.excerpt || "").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(?:Source|Title|Reader fallback|Direct fetch note|URL|Markdown Content):/iu.test(line)) continue;
    if (titles.has(line) || UI_LINES.has(line)) continue;
    // Reader output sometimes flattens the title and navigation into one line.
    // Remove site furniture, not article sentences that merely mention a menu.
    if (/跳到主要内容|skip to (?:main )?content/iu.test(line)
      && /菜单|订阅|话题|\bmenu\b|subscribe/iu.test(line)) continue;
    if (undecorated.length >= 8 && normalizedWebHeadline(line) === undecorated) continue;
    const plainHeadline = title.trim().replace(/^#{1,6}\s+/u, "").split(/[|｜_]/u)[0]
      .toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
    const lineHeadline = normalizedWebHeadline(line);
    if (headline.length >= 8 && lineHeadline === headline) continue;
    // Title-prefix removal applies only to an explicitly marked Markdown heading.
    if (/^#{1,6}\s/u.test(line) && plainHeadline.length >= 8 && lineHeadline === plainHeadline) continue;
    if (/^(?:特别声明[:：]|免责声明[:：]|版权声明[:：]|相关新闻\s*$|推荐阅读\s*$|相关推荐\s*$|相关阅读\s*$|猜你喜欢\s*$|跟贴\s*\d|网友评论\s*$|全部评论\s*$)/u.test(line)) break;
    if (/^https?:\/\/\S+$/iu.test(line)) continue;
    if (!output.includes(line)) output.push(line);
  }
  return output.join("\n");
}

function isBodyParagraph(line: string): boolean {
  if (line.length < 20) return false;
  if (/^(?:发布时间|发布日期|发布于|来源|作者|编辑|责任编辑|Published|Updated|Author|By)\s*[:：]/iu.test(line)) return false;
  if (/^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}\.\d{1,2})\s+(?:\d{1,2}:\d{2}|来源[:：])/u.test(line)) return false;
  return /[。！？.!?；;]/u.test(line) || line.length >= 45;
}

export function hasReadableWebBody(source: WebSourceText): boolean {
  return extractReadableWebBody(source).split("\n").some(isBodyParagraph);
}

/** Shared unavailable-body sentinel; status text is not article evidence. */
export function hasUnavailableWebBody(value: unknown): boolean {
  const text = String(value ?? "").trim().slice(0, 100_000);
  return /^(?:正文不可用|未取得正文|未读取正文|没有读取到正文|无法访问)(?:[:：。\s]|$)/u.test(text)
    || /(?:待读取正文|正文(?:尚未|未能|无法|没有)(?:读取|获取|访问)|当前无法访问|链接读取失败|抓取失败|内容不可用|未获取到正文|仅保存了链接)/u.test(text);
}

/** Bounded verbatim evidence: lead plus question-relevant paragraphs and adjacent qualifications. */
export function selectReadableWebEvidence(source: WebSourceText, query = "", maxChars = 1_500): string {
  const body = extractReadableWebBody(source);
  const budget = Math.max(0, Math.min(6_000, Math.floor(maxChars)));
  if (!budget || !body) return "";
  if (!query.trim() || body.length <= budget) return body.slice(0, budget);
  const terms = (query.replace(/(?:查一下|搜一下|搜索|查询|帮我|最新消息|最新|近期|最近|新闻|正文)/gu, " ")
    .match(/[\u3400-\u9fff]{2,}|[a-z][a-z0-9_.-]{2,}/giu) || [])
    .map((s) => s.replace(/的$/u, "").toLocaleLowerCase()).filter(Boolean);
  const paragraphs = body.split("\n");
  const ranked = paragraphs.map((text, index) => ({ index,
    score: terms.filter((s) => text.toLocaleLowerCase().includes(s)).length
  })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ranked.length) return body.slice(0, budget);
  const picked = new Map<number, string>();
  let remaining = budget;
  const clip = (text: string, cap: number): string => {
    if (text.length <= cap) return text;
    // Keep complete source sentences, with attribution/negation reserved first.
    // An over-budget unbroken assertion is omitted, never shown as a cut prefix.
    const sentences = splitSentenceFragments(text);
    const reserved = new Set<number>();
    let left = cap;
    const keep = (i: number): void => {
      if (reserved.has(i) || sentences[i].length + 1 > left) return;
      reserved.add(i); left -= sentences[i].length + 1;
    };
    sentences.forEach((s, i) => { if (/匿名|知情人士|据传|传闻|尚未|未.{0,5}(?:确认|证实)|不能确认|可能|拟(?:投资|合作)|但|然而|\b(?:anonymous|alleged|reportedly|unconfirmed|however|not confirmed|may|might|considering)\b/iu.test(s)) keep(i); });
    sentences.forEach((_s, i) => keep(i));
    return Array.from(reserved).sort((a, b) => a - b).map((i) => sentences[i]).join("");
  };
  const add = (index: number, cap = remaining): void => {
    if (index < 0 || index >= paragraphs.length || remaining <= 1) return;
    const prior = picked.get(index) || "";
    const available = Math.max(0, Math.min(cap, remaining + prior.length - 1));
    const text = clip(paragraphs[index], available);
    if (text.length <= prior.length) return;
    if (!text) return;
    picked.set(index, text); remaining -= text.length - prior.length + (prior ? 0 : 1);
  };
  add(0, Math.min(500, Math.floor(budget / 5)));
  // Reserve the best match and its context before spending the budget on secondary matches.
  for (const { index } of ranked) {
    add(index, remaining + (picked.get(index)?.length || 0));
    add(index + 1);
    add(index - 1);
    if (remaining <= 1) break;
  }
  return Array.from(picked).sort((a, b) => a[0] - b[0]).map((s) => s[1]).join("\n");
}

/** Select narrative paragraphs rather than the first characters of a metadata envelope. */
export function selectReadableWebParagraph(source: WebSourceText, query = "", maxChars = 450): string {
  const body = extractReadableWebBody(source);
  const queryText = query.replace(/(?:查一下|搜一下|搜索|查询|帮我|最新消息|最新|近期|最近|新闻|正文)/gu, " ");
  const terms = (queryText.match(/[\u3400-\u9fff]{2,}|[a-z][a-z0-9_.-]{2,}/giu) || [])
    .map((term) => term.replace(/的$/u, "").toLocaleLowerCase()).filter(Boolean);
  const paragraphs = body.split("\n").filter(isBodyParagraph).map((text, index) => {
    const lower = text.toLocaleLowerCase();
    return { text, index, score: terms.filter((term) => lower.includes(term)).length * 10 };
  });
  paragraphs.sort((a, b) => b.score - a.score || a.index - b.index);
  return String(paragraphs[0]?.text || "").slice(0, Math.max(20, Math.min(maxChars, 1_000)));
}
