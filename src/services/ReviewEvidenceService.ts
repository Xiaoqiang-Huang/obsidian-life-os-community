import { App, TFile } from "obsidian";
import type { PersonalLifeSystemSettings } from "../settings";
import { readFile } from "../utils/vault";
import { DailyNoteService } from "./DailyNoteService";
import type { FileSystemService } from "./FileSystemService";

export type ReviewEvidenceKind = "daily" | "weekly" | "monthly" | "custom";
export type ReviewEvidenceTrust = "user-authored" | "confirmed-ai" | "verified-record" | "current-state";
export type ReviewEvidenceType = "daily" | "project-activity" | "completed-task" | "checkin" | "open-task";

export interface ReviewEvidenceWindow {
  start: string;
  end: string;
}

export interface ReviewDailySource {
  date: string;
  path: string;
  title: string;
  mtime: number;
  hash: string;
  content: string;
  cleanContent: string;
  duplicate: boolean;
}

export interface ReviewCompletedTask {
  title: string;
  completedAt: string;
  sourcePath: string;
  trust: "verified-record";
}

export interface ReviewOpenTask {
  title: string;
  sourcePath: string;
  trust: "current-state";
}

export interface ReviewCheckinEvidence {
  date: string;
  path: string;
  durationMinutes: number;
  tasksCompleted: number;
  primaryMetric: number;
  secondaryMetric: number;
  mood: string;
  summary: string;
  trust: "verified-record";
}

export interface ReviewProjectActivityEvidence {
  id: string;
  projectId: string;
  sessionId: string;
  sessionTitle: string;
  date: string;
  text: string;
  sourceNodeIds: string[];
  sourcePath: string;
  status: "pending" | "confirmed";
  updatedAt: string;
}

export interface ReviewEvidenceItem {
  id: string;
  type: ReviewEvidenceType;
  trust: ReviewEvidenceTrust;
  date: string;
  text: string;
  sourcePath: string;
  sourceRef: string;
  sourceNodeIds: string[];
}

export interface ReviewEvidenceBundle {
  kind: ReviewEvidenceKind;
  window: ReviewEvidenceWindow;
  dailySources: ReviewDailySource[];
  allDailyCandidates: ReviewDailySource[];
  missingDates: string[];
  completedTasks: ReviewCompletedTask[];
  openTasks: ReviewOpenTask[];
  checkins: ReviewCheckinEvidence[];
  confirmedProjectActivities: ReviewProjectActivityEvidence[];
  pendingProjectActivities: ReviewProjectActivityEvidence[];
  evidence: ReviewEvidenceItem[];
  sourceHash: string;
  generatedAt: string;
}

interface WorkspaceStateShape {
  dailyFacts?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
}

const TEMPLATE_ONLY_LINE = /^(?:[-*]\s*)?(?:\d+[.、]\s*)?(?:今天[：:]?|精力[：:]?_*\/?10|情绪[：:]?_*|睡眠[：:]?_*h?|来自昨天的[：:]?_*|明天要做[：:]?_*|#(?:科研|求职|备考|学习|健康|社交|其他)(?:\s+#\S+)*|_+|暂无)$/u;
const MANAGED_DAILY_BLOCKS = [
  /<!--\s*pls-daily-archive:start\s*-->[\s\S]*?<!--\s*pls-daily-archive:end\s*-->/giu,
  /<!--\s*lifeos-ai-workspace:start\s*-->[\s\S]*?<!--\s*lifeos-ai-workspace:end\s*-->/giu,
  /<!--\s*lifeos-weixin-daily-digest:start\s*-->[\s\S]*?<!--\s*lifeos-weixin-daily-digest:end\s*-->/giu
];
const WEIXIN_DAILY_INPUT_BLOCK = /<!--\s*lifeos-weixin-daily-inputs:start\s*-->([\s\S]*?)<!--\s*lifeos-weixin-daily-inputs:end\s*-->/giu;

/**
 * 统一日、周、月复盘使用的事实入口。所有 AI 生成都必须先经过这里，
 * 避免页面各自拼接日报、任务和项目会话而产生冲突或重复。
 */
export class ReviewEvidenceService {
  constructor(
    private app: App,
    private fs: FileSystemService,
    private settings: PersonalLifeSystemSettings
  ) {}

  async collect(
    kind: ReviewEvidenceKind,
    window: ReviewEvidenceWindow,
    selectedPaths?: Set<string>
  ): Promise<ReviewEvidenceBundle> {
    const candidates = await this.collectDailyCandidates(window);
    const selected = selectedPaths ?? this.defaultSelectedPaths(candidates);
    const dailySources = candidates.filter((source) => selected.has(source.path));
    const [completedTasks, openTasks, checkins, projectActivities] = await Promise.all([
      this.collectCompletedTasks(window),
      this.collectOpenTasks(),
      this.collectCheckins(window),
      this.collectProjectActivities(window)
    ]);
    const confirmedProjectActivities = projectActivities.filter((item) => item.status === "confirmed");
    const pendingProjectActivities = projectActivities.filter((item) => item.status === "pending");
    const evidence = this.buildEvidenceItems(
      dailySources,
      confirmedProjectActivities,
      completedTasks,
      checkins,
      openTasks
    );
    const datesWithSource = new Set(dailySources.map((source) => source.date));
    return {
      kind,
      window,
      dailySources,
      allDailyCandidates: candidates,
      missingDates: this.eachDate(window).filter((date) => !datesWithSource.has(date)),
      completedTasks,
      openTasks,
      checkins,
      confirmedProjectActivities,
      pendingProjectActivities,
      evidence,
      sourceHash: reviewEvidenceHash(evidence),
      generatedAt: new Date().toISOString()
    };
  }

  defaultSelectedPaths(candidates: ReviewDailySource[]): Set<string> {
    const preferred = new Map<string, ReviewDailySource>();
    for (const source of candidates) {
      const current = preferred.get(source.date);
      if (!current || source.mtime > current.mtime || (source.mtime === current.mtime && source.path < current.path)) {
        preferred.set(source.date, source);
      }
    }
    return new Set(Array.from(preferred.values()).map((source) => source.path));
  }

  private async collectDailyCandidates(window: ReviewEvidenceWindow): Promise<ReviewDailySource[]> {
    const dailyNotes = new DailyNoteService(this.app, this.fs, this.settings).listDailyNotes()
      .filter((file) => file.basename >= window.start && file.basename <= window.end);
    const sources = await Promise.all(dailyNotes.map(async (file) => {
      const content = await this.app.vault.read(file);
      return {
        date: file.basename,
        path: file.path,
        title: file.basename,
        mtime: file.stat.mtime,
        hash: stableReviewHash(content),
        content,
        cleanContent: cleanReviewDailyContent(content),
        duplicate: false
      };
    }));
    const counts = new Map<string, number>();
    for (const source of sources) counts.set(source.date, (counts.get(source.date) ?? 0) + 1);
    return sources
      .map((source) => ({ ...source, duplicate: (counts.get(source.date) ?? 0) > 1 }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path));
  }

  private async collectCompletedTasks(window: ReviewEvidenceWindow): Promise<ReviewCompletedTask[]> {
    const sourcePath = this.fs.path("Tasks", "done.md");
    const lines = (await readFile(this.app, sourcePath)).split(/\r?\n/);
    const tasks: ReviewCompletedTask[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/^\s*-\s*\[[xX]\]/.test(line)) continue;
      const block: string[] = [line];
      let cursor = index + 1;
      while (cursor < lines.length && /^\s{2,}-\s+/.test(lines[cursor])) {
        block.push(lines[cursor]);
        cursor += 1;
      }
      const completedAt = block.join("\n").match(/\bcompleted:\s*(20\d{2}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/i)?.[1]
        ?? line.match(/[✔✅]\s*(20\d{2}-\d{2}-\d{2})/)?.[1]
        ?? "";
      const date = completedAt.slice(0, 10);
      if (date >= window.start && date <= window.end) {
        tasks.push({
          title: cleanTaskTitle(line, true),
          completedAt,
          sourcePath,
          trust: "verified-record"
        });
      }
      index = cursor - 1;
    }
    return tasks.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.title.localeCompare(b.title));
  }

  private async collectOpenTasks(): Promise<ReviewOpenTask[]> {
    const sourcePath = this.fs.path("Tasks", "open.md");
    return (await readFile(this.app, sourcePath)).split(/\r?\n/)
      .filter((line) => /^\s*-\s*\[ \]/.test(line))
      .map((line) => ({ title: cleanTaskTitle(line, false), sourcePath, trust: "current-state" as const }))
      .filter((item) => Boolean(item.title));
  }

  private async collectCheckins(window: ReviewEvidenceWindow): Promise<ReviewCheckinEvidence[]> {
    const prefix = `${this.fs.path("Exam", "Checkins")}/`;
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix));
    const records: ReviewCheckinEvidence[] = [];
    for (const file of files) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      const date = String(frontmatter.date ?? file.basename);
      if (date < window.start || date > window.end) continue;
      records.push({
        date,
        path: file.path,
        durationMinutes: numberValue(frontmatter.duration_minutes),
        tasksCompleted: numberValue(frontmatter.tasks_completed),
        primaryMetric: numberValue(frontmatter.xingce_questions),
        secondaryMetric: numberValue(frontmatter.interview_practice),
        mood: String(frontmatter.mood ?? "").trim(),
        summary: String(frontmatter.summary ?? "").trim(),
        trust: "verified-record"
      });
    }
    return records.sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path));
  }

  private async collectProjectActivities(window: ReviewEvidenceWindow): Promise<ReviewProjectActivityEvidence[]> {
    const raw = await readFile(this.app, this.fs.path("Projects", "AIWorkspace", "index.json"));
    if (!raw.trim()) return [];
    let state: WorkspaceStateShape;
    try {
      state = JSON.parse(raw) as WorkspaceStateShape;
    } catch {
      return [];
    }
    const sessions = new Map((state.sessions ?? []).map((item) => [String(item.id ?? ""), item]));
    return (state.dailyFacts ?? []).flatMap((rawFact): ReviewProjectActivityEvidence[] => {
      const status = rawFact.status === "confirmed" ? "confirmed" : rawFact.status === "pending" ? "pending" : null;
      const date = String(rawFact.date ?? "");
      const text = String(rawFact.text ?? "").trim();
      if (!status || !text || date < window.start || date > window.end) return [];
      const sessionId = String(rawFact.sessionId ?? "");
      const session = sessions.get(sessionId);
      const sourceNodeIds = Array.isArray(rawFact.sourceNodeIds)
        ? rawFact.sourceNodeIds.map(String).filter(Boolean)
        : [];
      return [{
        id: String(rawFact.id || `project-${stableReviewHash(`${sessionId}:${date}:${text}`)}`),
        projectId: String(rawFact.projectId ?? ""),
        sessionId,
        sessionTitle: String(session?.title ?? (sessionId || "项目会话")),
        date,
        text,
        sourceNodeIds,
        sourcePath: String(session?.notePath ?? this.fs.path("Projects", "AIWorkspace", "index.json")),
        status,
        updatedAt: String(rawFact.updatedAt ?? rawFact.confirmedAt ?? rawFact.createdAt ?? "")
      }];
    }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }

  private buildEvidenceItems(
    dailySources: ReviewDailySource[],
    projectActivities: ReviewProjectActivityEvidence[],
    completedTasks: ReviewCompletedTask[],
    checkins: ReviewCheckinEvidence[],
    openTasks: ReviewOpenTask[]
  ): ReviewEvidenceItem[] {
    const items: ReviewEvidenceItem[] = [];
    for (const source of dailySources) {
      items.push(this.evidenceItem({
        type: "daily",
        trust: "user-authored",
        date: source.date,
        text: source.cleanContent || "资料不足：这篇日报没有识别到用户填写的正文。",
        sourcePath: source.path,
        sourceRef: source.date,
        sourceNodeIds: []
      }));
    }
    for (const activity of projectActivities) {
      items.push(this.evidenceItem({
        type: "project-activity",
        trust: "confirmed-ai",
        date: activity.date,
        text: activity.text,
        sourcePath: activity.sourcePath,
        sourceRef: `${activity.date} / ${activity.sessionTitle}${activity.sourceNodeIds.length ? ` / ${activity.sourceNodeIds.join(",")}` : ""}`,
        sourceNodeIds: activity.sourceNodeIds
      }));
    }
    for (const task of completedTasks) {
      items.push(this.evidenceItem({
        type: "completed-task",
        trust: task.trust,
        date: task.completedAt.slice(0, 10),
        text: task.title,
        sourcePath: task.sourcePath,
        sourceRef: `${task.completedAt} / 已完成任务`,
        sourceNodeIds: []
      }));
    }
    for (const checkin of checkins) {
      const metrics = [
        `学习时长 ${checkin.durationMinutes} 分钟`,
        `打卡自填完成任务 ${checkin.tasksCompleted} 项`,
        `训练指标 ${checkin.primaryMetric}/${checkin.secondaryMetric}`,
        checkin.mood ? `状态 ${checkin.mood}` : "",
        checkin.summary ? `总结 ${checkin.summary}` : ""
      ].filter(Boolean).join("；");
      items.push(this.evidenceItem({
        type: "checkin",
        trust: checkin.trust,
        date: checkin.date,
        text: metrics,
        sourcePath: checkin.path,
        sourceRef: `${checkin.date} / 学习打卡`,
        sourceNodeIds: []
      }));
    }
    for (const task of openTasks) {
      items.push(this.evidenceItem({
        type: "open-task",
        trust: task.trust,
        date: "current",
        text: task.title,
        sourcePath: task.sourcePath,
        sourceRef: "当前未完成任务",
        sourceNodeIds: []
      }));
    }
    return items;
  }

  private evidenceItem(input: Omit<ReviewEvidenceItem, "id">): ReviewEvidenceItem {
    return {
      ...input,
      id: `review-${stableReviewHash([input.type, input.date, input.sourcePath, input.text, input.sourceNodeIds.join(",")].join("\u001f"))}`
    };
  }

  private eachDate(window: ReviewEvidenceWindow): string[] {
    const dates: string[] = [];
    const current = localDate(window.start);
    const end = localDate(window.end);
    while (current <= end) {
      dates.push(formatLocalDate(current));
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }
}

export function cleanReviewDailyContent(content: string): string {
  let clean = content.replace(/^---\s*\n[\s\S]*?\n---\s*/u, "");
  clean = clean.replace(WEIXIN_DAILY_INPUT_BLOCK, (_block, body: string) => body
    .split(/\r?\n/u)
    .filter((line) => /^\s*-\s+\S/u.test(line))
    .join("\n"));
  clean = clean.replace(/<!--\s*lifeos-weixin-input:[^>]+-->/giu, "");
  for (const pattern of MANAGED_DAILY_BLOCKS) clean = clean.replace(pattern, "");
  const lines = clean.split(/\r?\n/);
  const filtered: string[] = [];
  let previousHeading = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^<!--[\s\S]*-->$/u.test(trimmed)) continue;
    if (/^\*创建日期：|^\*日记版本：|^>\s*用四圣谏言/u.test(trimmed)) continue;
    if (trimmed && TEMPLATE_ONLY_LINE.test(trimmed)) continue;
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim() ?? "";
    if (heading && heading === previousHeading) continue;
    if (heading) previousHeading = heading;
    else if (trimmed) previousHeading = "";
    filtered.push(line);
  }
  const withoutEmptyHeadings = filtered.filter((line, index) => {
    if (!/^#{1,6}\s+/u.test(line.trim())) return true;
    for (let cursor = index + 1; cursor < filtered.length; cursor += 1) {
      const next = filtered[cursor].trim();
      if (/^#{1,6}\s+/u.test(next)) break;
      if (next && next !== "---") return true;
    }
    return false;
  });
  return withoutEmptyHeadings.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function reviewEvidenceHash(evidence: ReviewEvidenceItem[]): string {
  const canonical = evidence
    .map((item) => [
      item.id,
      item.type,
      item.trust,
      item.date,
      item.sourcePath,
      item.sourceRef,
      item.sourceNodeIds.join(","),
      item.text
    ].join("\u001f"))
    .sort()
    .join("\u001e");
  return stableReviewHash(canonical);
}

export function stableReviewHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cleanTaskTitle(line: string, done: boolean): string {
  const marker = done ? /^\s*-\s*\[[xX]\]\s*/u : /^\s*-\s*\[ \]\s*/u;
  return line.replace(marker, "")
    .replace(/\s+(?:#\S+|project:\S+|source:\S+|\^\S+|[✔✅]\s*20\d{2}-\d{2}-\d{2}|📅\s*20\d{2}-\d{2}-\d{2})/gu, "")
    .trim();
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function localDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function formatLocalDate(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0")
  ].join("-");
}
