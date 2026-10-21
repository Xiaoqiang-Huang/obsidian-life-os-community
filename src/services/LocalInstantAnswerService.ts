import type { LifeOSTask } from "../types";
import { extractQuickRecordEntries } from "../utils/quick-records";
import type { ContextEvidence } from "./context-engine/types";

/**
 * A deterministic, local answer to a question whose evidence is already in the
 * Vault. The service never calls a model or the network; callers may use a
 * high-confidence answer directly and send everything else down the normal
 * model path.
 */
export type InstantIntent = "tasks" | "diary" | "search" | "none";

export interface InstantAnswer {
  intent: InstantIntent;
  confidence: "high" | "medium" | "low";
  text: string;
  sources: string[];
}

export interface InstantTaskSource {
  loadOpenTasks(signal?: AbortSignal): Promise<LifeOSTask[]>;
  loadDoneTasks(signal?: AbortSignal): Promise<LifeOSTask[]>;
}

export interface InstantDailySource {
  getTodayNotePath(date?: string): string;
  exists(date?: string): boolean;
  readTodayNote(date?: string): Promise<string>;
}

export interface InstantSearchSource {
  retrieveLocal(query: string, options?: { maxResults?: number; projectScopeId?: string }): Promise<ContextEvidence[]>;
}

export interface LocalInstantAnswerDependencies {
  tasks: InstantTaskSource;
  daily: InstantDailySource;
  search?: InstantSearchSource;
  openTasksPath: string;
  doneTasksPath?: string;
}

export interface InstantAnswerOptions {
  now?: Date;
  projectId?: string;
}

const CONTROL_CHARS = /[\u0000-\u0008\t\u000b-\u001f\u007f-\u009f]/gu;
const MAX_SEARCH_SNIPPET = 80;

export class LocalInstantAnswerService {
  constructor(private readonly deps: LocalInstantAnswerDependencies) {}

  async answer(question: string, options: InstantAnswerOptions = {}): Promise<InstantAnswer> {
    const value = cleanInline(question, 4000);
    if (!value) return none();

    const now = options.now instanceof Date ? options.now : new Date();
    const taskIntent = detectTaskIntent(value);
    const diaryDate = detectDiaryDate(value, now);
    const searchIntent = detectSearchIntent(value);

    // A mutation-shaped task request ("完成 X") is deliberately only medium:
    // the Weixin channel keeps those on the normal model/action path.
    if (taskIntent === "high") return this.answerTasks();
    if (diaryDate) return this.answerDiary(diaryDate, now);
    if (taskIntent === "medium") return this.answerTasks();
    if (searchIntent) return this.answerSearch(value, options);
    return none();
  }

  private async answerTasks(): Promise<InstantAnswer> {
    const [open, done] = await Promise.all([
      this.deps.tasks.loadOpenTasks(),
      this.deps.tasks.loadDoneTasks()
    ]);
    const sources = [this.deps.openTasksPath, this.deps.doneTasksPath]
      .filter((value): value is string => Boolean(value && String(value).trim()))
      .filter((value, index, all) => all.indexOf(value) === index);
    const titles = open
      .map((task) => cleanInline(task.text, 160))
      .filter(Boolean)
      .slice(0, 3);
    const openSummary = open.length === 0
      ? "目前没有未完成的任务"
      : `未完成 ${open.length} 项：${titles.map((title, index) => `${index + 1}. ${title}`).join("；")}${open.length > titles.length ? "…（仅列前 3 项）" : ""}`;
    const text = `${openSummary}。已完成 ${done.length} 项。\n\n${sourceFooter(sources)}`;
    return { intent: "tasks", confidence: "high", text, sources };
  }

  private async answerDiary(date: string, now: Date): Promise<InstantAnswer> {
    const notePath = this.deps.daily.getTodayNotePath(date);
    const sources = [notePath];
    if (!this.deps.daily.exists(date)) {
      return {
        intent: "diary",
        confidence: "high",
        text: `该日没有日记：${date}。\n\n${sourceFooter(sources)}`,
        sources
      };
    }
    const markdown = await this.deps.daily.readTodayNote(date);
    if (!cleanInline(markdown, 200000)) {
      return {
        intent: "diary",
        confidence: "high",
        text: `该日没有日记内容：${date}。\n\n${sourceFooter(sources)}`,
        sources
      };
    }
    const entries = diaryEntries(markdown).slice(0, 3);
    const text = entries.length === 0
      ? `${date} 的日记没有快速记录或待办。\n\n${sourceFooter(sources)}`
      : `${date} 日记（前 ${entries.length} 条快速记录/待办）：\n${entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}\n\n${sourceFooter(sources)}`;
    return { intent: "diary", confidence: "high", text, sources };
  }

  private async answerSearch(question: string, options: InstantAnswerOptions): Promise<InstantAnswer> {
    if (!this.deps.search) return noSearchHit();
    const query = searchQuery(question);
    const evidence = await this.deps.search.retrieveLocal(query, {
      maxResults: 6,
      projectScopeId: options.projectId
    });
    const picked: ContextEvidence[] = [];
    const seenPaths = new Set<string>();
    for (const item of evidence || []) {
      const sourcePath = cleanPath(item?.source?.path);
      if (!sourcePath || seenPaths.has(sourcePath)) continue;
      seenPaths.add(sourcePath);
      picked.push(item);
      if (picked.length >= 3) break;
    }
    if (picked.length === 0) return noSearchHit();

    const lines = picked.map((item, index) => {
      const title = cleanInline(item.source.title || item.source.path, 120) || "未命名资料";
      const snippet = snippetOf(item.source.excerpt || item.content || "");
      return `${index + 1}. ${title} — ${snippet} — ${cleanPath(item.source.path)}`;
    });
    const sources = picked.map((item) => cleanPath(item.source.path));
    return {
      intent: "search",
      confidence: "high",
      text: `找到 ${picked.length} 条相关资料：\n${lines.join("\n")}\n\n${sourceFooter(sources)}`,
      sources
    };
  }
}

/** Build the Weixin delivery text; never formats a non-high-confidence answer. */
export function formatInstantAnswerForWeixin(answer: InstantAnswer, maxChars = 1200): string {
  if (!answer || answer.intent === "none" || answer.confidence !== "high") return "";
  const raw = String(answer.text || "").replace(/\r\n?/gu, "\n").replace(CONTROL_CHARS, "").trim();
  const sources = Array.from(new Set((answer.sources || [])
    .map((value) => String(value || "").replace(CONTROL_CHARS, "").trim())
    .filter(Boolean)));
  if (!raw) return "";

  // Keep the citation block even when the body has to be truncated: reserve
  // room for the sources first, then bound the prose. An existing source footer
  // is replaced so a truncated body can never orphan or duplicate it.
  let core = raw;
  const marker = core.lastIndexOf("来自本地资料");
  if (marker > 0) core = core.slice(0, marker).trimEnd();
  if (!core) core = raw;
  const suffix = sources.length > 0
    ? `\n\n来自本地资料：\n${sources.map((source) => `- ${source}`).join("\n")}`
    : "";
  const header = core.includes("来自本地资料") ? "" : "来自本地资料（本地速答，未调用模型）：\n";
  const fixedChars = Array.from(header).length + Array.from(suffix).length;
  const budget = Math.max(1, maxChars - fixedChars);
  const coreChars = Array.from(core);
  if (coreChars.length > budget) core = coreChars.slice(0, Math.max(0, budget - 1)).join("") + "…";
  const text = `${header}${core}${suffix}`.replace(/\n{3,}/gu, "\n\n").trim();
  return Array.from(text).length > maxChars
    ? Array.from(text).slice(0, Math.max(0, maxChars - 1)).join("") + "…"
    : text;
}

function none(): InstantAnswer {
  return { intent: "none", confidence: "low", text: "", sources: [] };
}

function noSearchHit(): InstantAnswer {
  return {
    intent: "search",
    confidence: "low",
    text: "没有找到直接相关资料。",
    sources: []
  };
}

function sourceFooter(sources: string[]): string {
  return sources.length > 0
    ? `来自本地资料：\n${sources.map((source) => `- ${source}`).join("\n")}`
    : "来自本地资料：未找到可引用文件";
}

/**
 * Task questions are only allowed to bypass the model when they clearly ask
 * about the user's own task state. A bare "完成/任务" in a how-to question is
 * medium so the channel keeps its normal answer path.
 */
function detectTaskIntent(question: string): "high" | "medium" | null {
  const highPatterns = [
    /(?:我的|当前|目前|现在|今天|今日|本周|这周|还有|剩余|未完成|已完成).{0,10}(?:任务|待办)/u,
    /(?:任务|待办).{0,10}(?:有哪些|多少|几项|几条|列表|情况|进度|状态|完成|未完成|还剩|剩余)/u,
    /(?:还有|剩余|未完成|已完成|完成了|做完|完成了几|完成了多少).{0,8}(?:任务|待办|项|条)/u,
    /^(?:查看|列出|显示|看看|告诉我).{0,8}(?:任务|待办)/u,
    /(?:今天|今日)(?:要|需要|得)?(?:做|完成|干)(?:什么|哪些|啥)/u,
    /(?:今天|今日).{0,6}(?:完成了?|做完).{0,6}(?:什么|哪些|多少|几)/u,
    /待办事项/u,
    /(?:任务|待办)(?:完成|进度|概览|清单)/u
  ];
  if (highPatterns.some((pattern) => pattern.test(question))) return "high";
  if (/(?:任务|待办|完成)/u.test(question)) return "medium";
  return null;
}

/**
 * Returns the diary date when the question is explicitly about diary content,
 * a relative day, or a standalone ISO date. Task wording wins in answer().
 */
function detectDiaryDate(question: string, now: Date): string | null {
  const explicit = question.match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\b/u);
  if (explicit && !/(?:任务|待办)/u.test(question)) {
    const date = validDate(Number(explicit[1]), Number(explicit[2]), Number(explicit[3]));
    if (date) return date;
  }
  if (/(?:日记|今天写了什么|今日写了什么|记录了什么)/u.test(question)
    || /(?:昨天|昨日|前天).{0,8}(?:写了|做了|记录|日记|发生)/u.test(question)) {
    if (/(?:前天)/u.test(question)) return shiftDate(now, -2);
    if (/(?:昨天|昨日)/u.test(question)) return shiftDate(now, -1);
    if (/(?:今天|今日)/u.test(question)) return shiftDate(now, 0);
    return shiftDate(now, 0);
  }
  if (/(?:昨天|昨日)/u.test(question) && !/(?:任务|待办)/u.test(question)) return shiftDate(now, -1);
  if (/(?:前天)/u.test(question) && !/(?:任务|待办)/u.test(question)) return shiftDate(now, -2);
  return null;
}

function detectSearchIntent(question: string): boolean {
  if (/(?:找一下|帮我找|帮忙找|搜索一下|搜索|搜一下|查一下|查查|查找|检索)/u.test(question)) return true;
  if (/关于.{1,80}?的?(?:资料|笔记|记录|内容|文档|信息)/u.test(question)) return true;
  if (/(?:有没有|是否有).{0,60}?(?:资料|笔记|记录|相关内容|文档|提到|写过)/u.test(question)) return true;
  return false;
}

function searchQuery(question: string): string {
  const about = question.match(/关于(.{1,80}?)的?(?:资料|笔记|记录|内容|文档|信息)/u);
  if (about) return cleanInline(about[1], 200) || question;
  const query = question
    .replace(/^(?:请问|麻烦|帮我|帮忙|请)?[，,：:\s]*/u, "")
    .replace(/(?:帮我|帮忙)?(?:找一下|找找|搜索一下|搜索|搜一下|查一下|查查|查找|检索)/gu, " ")
    .replace(/^(?:有没有|是否有)/u, " ")
    .replace(/(?:的)?(?:资料|笔记|记录|内容|文档|信息)(?:吗|呢|？|\?)*$/u, " ")
    .replace(/[？?！!。.\s]+$/u, "")
    .trim();
  return query || question;
}

function diaryEntries(markdown: string): string[] {
  const quick = extractQuickRecordEntries(markdown)
    .map((entry) => cleanInline(entry, 240))
    .filter(Boolean);
  if (quick.length > 0) return Array.from(new Set(quick));
  const fallback = String(markdown || "")
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^-\s*\[[ xX]\]\s+(.+)$/u)?.[1] || "")
    .map((entry) => cleanInline(entry, 240))
    .filter(Boolean);
  return Array.from(new Set(fallback));
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return formatLocalDate(date);
}

function shiftDate(date: Date, days: number): string {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return formatLocalDate(next);
}

function formatLocalDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function snippetOf(value: string): string {
  const text = cleanInline(value, 4000);
  if (!text) return "（无可用片段）";
  const chars = Array.from(text);
  if (chars.length <= MAX_SEARCH_SNIPPET) return text;
  return chars.slice(0, MAX_SEARCH_SNIPPET - 1).join("") + "…";
}

function cleanInline(value: string, limit: number): string {
  const text = String(value || "")
    .replace(CONTROL_CHARS, " ")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/u, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gmu, "")
    .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/gmu, "")
    .replace(/[*_`>#]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit).join("") : text;
}

/** File paths are citable evidence: only remove control characters, never Markdown. */
function cleanPath(value: string): string {
  return String(value || "").replace(CONTROL_CHARS, "").trim();
}
