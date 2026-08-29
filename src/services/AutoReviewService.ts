import { App, TFile } from "obsidian";
import type { AiClient } from "../ai";
import type { PersonalLifeSystemSettings } from "../settings";
import { formatDate } from "../utils/dates";
import { ensureFile, ensureFolder, readFile } from "../utils/vault";
import type { FileSystemService } from "./FileSystemService";
import {
  extractPeriodReviewRegions,
  PeriodReviewService,
  replacePeriodReviewAiRegion,
  replacePeriodReviewUserNotesRegion,
  type PeriodReviewFacts,
  type PeriodReviewKind,
  type PeriodReviewWindow
} from "./PeriodReviewService";
import type { ReviewQualityReport } from "./ReviewQualityService";

export type AutoReviewTrigger = "timer" | "startup" | "manual";
export type AutoReviewRunStatus =
  | "created"
  | "unchanged"
  | "stale"
  | "disabled"
  | "not-due"
  | "not-configured"
  | "unauthorized"
  | "no-evidence"
  | "busy";

export interface AutoReviewRunResult {
  status: AutoReviewRunStatus;
  date?: string;
  path?: string;
  message: string;
}

export interface AutoReviewDraft {
  path: string;
  title: string;
  status: "pending" | "stale" | "saved" | "dismissed";
  kind: PeriodReviewKind;
  window: PeriodReviewWindow;
  sourceHash: string;
  generatedAt: string;
  qualityStatus: "pass" | "warning";
  qualityScore: number;
  draft: string;
  userNotes: string;
  formalPath: string;
  modifiedAt: number;
}

export interface AutoReviewServiceOptions {
  now?: () => Date;
  hasEntitlement?: () => boolean;
  onDraftCreated?: (draft: AutoReviewDraft) => void;
}

interface AutoReviewAttempt {
  date: string;
  sourceHash: string;
  attemptedAt: string;
  result: "created" | "failed" | "no-evidence";
}

interface AutoReviewState {
  schemaVersion: 1;
  lastStartupCatchUpOn?: string;
  attempts: AutoReviewAttempt[];
}

/**
 * 自动复盘只负责生成待确认草稿。它从不写入 Daily，也不会把草稿静默提升为正式复盘。
 */
export class AutoReviewService {
  private running = false;
  private readonly periodReviews: PeriodReviewService;
  private readonly now: () => Date;
  private readonly hasEntitlement: () => boolean;

  constructor(
    private app: App,
    private fs: FileSystemService,
    private settings: PersonalLifeSystemSettings,
    private ai: AiClient,
    private options: AutoReviewServiceOptions = {}
  ) {
    this.periodReviews = new PeriodReviewService(app, fs, settings);
    this.now = options.now ?? (() => new Date());
    this.hasEntitlement = options.hasEntitlement ?? (() => false);
  }

  async runDue(trigger: AutoReviewTrigger = "timer"): Promise<AutoReviewRunResult> {
    if (this.running) return { status: "busy", message: "自动复盘正在运行。" };
    if (!this.settings.autoReviewEnabled) return { status: "disabled", message: "自动复盘未开启。" };
    if (!this.ai.isConfigured()) return { status: "not-configured", message: "AI 尚未配置，未生成自动复盘草稿。" };
    if (!this.hasEntitlement()) return { status: "unauthorized", message: "当前授权不包含 AI 复盘生成。" };

    const now = this.now();
    const today = formatDate(now);
    if (trigger === "startup" && !this.settings.autoReviewCatchUp) {
      return { status: "not-due", message: "启动补生成已关闭。" };
    }
    if (trigger === "timer" && localTime(now) < normalizeAutoReviewTime(this.settings.autoReviewTime)) {
      return { status: "not-due", date: today, message: `尚未到自动复盘时间 ${normalizeAutoReviewTime(this.settings.autoReviewTime)}。` };
    }

    this.running = true;
    try {
      const state = await this.loadState();
      if (trigger === "startup" && state.lastStartupCatchUpOn === today) {
        return { status: "unchanged", message: "今天已检查过上一日自动复盘。" };
      }
      const date = trigger === "startup" ? formatDate(addDays(now, -1)) : today;
      const result = await this.generateForDate(
        date,
        state,
        trigger === "manual",
        trigger === "startup"
      );
      // 只有本次补生成流程完整返回后才记录“已检查”。如果 AI 或文件写入抛错，
      // 下次启动仍可重试，而不是被一个过早写入的状态永久跳过。
      if (trigger === "startup") {
        state.lastStartupCatchUpOn = today;
        await this.saveState(state);
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  async listDrafts(includeHistory = false): Promise<AutoReviewDraft[]> {
    const prefix = `${this.draftsRoot()}/`;
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix));
    const drafts = (await Promise.all(files.map((file) => this.readDraftFile(file))))
      .filter((item): item is AutoReviewDraft => Boolean(item));
    return drafts
      .filter((item) => includeHistory || item.status === "pending" || item.status === "stale")
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || b.modifiedAt - a.modifiedAt);
  }

  async readDraft(path: string): Promise<AutoReviewDraft | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? this.readDraftFile(file) : null;
  }

  async updateDraft(path: string, draft: string, userNotes: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("自动复盘草稿已不存在。");
    await this.processFile(file, (content) => replacePeriodReviewUserNotesRegion(
      replacePeriodReviewAiRegion(content, draft),
      `## 用户补充\n\n${userNotes.trim()}`
    ));
  }

  async refreshDraft(
    path: string,
    facts: PeriodReviewFacts,
    draft: string,
    userNotes: string,
    quality: ReviewQualityReport,
    instruction = ""
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("自动复盘草稿已不存在。");
    let content = this.periodReviews.buildReviewMarkdown(facts, draft, instruction, userNotes, "pending")
      .replace("type: period-review", "type: period-review-draft");
    content = setFrontmatterValue(content, "auto_generated", "true");
    content = setFrontmatterValue(content, "quality_status", quality.ok ? "pass" : "warning");
    content = setFrontmatterValue(content, "quality_score", String(quality.score));
    await this.app.vault.modify(file, content);
  }

  async setDraftStatus(path: string, status: AutoReviewDraft["status"], formalPath = ""): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("自动复盘草稿已不存在。");
    await this.processFile(file, (content) => {
      let next = setFrontmatterValue(content, "status", status);
      if (formalPath) next = setFrontmatterValue(next, "formal_path", formalPath);
      return next;
    });
  }

  async promoteDraft(
    path: string,
    draft: string,
    userNotes: string,
    instruction = "",
    currentFacts?: PeriodReviewFacts
  ): Promise<TFile> {
    const record = await this.readDraft(path);
    if (!record) throw new Error("自动复盘草稿已不存在。");
    const facts = currentFacts ?? await this.periodReviews.collectFacts(record.kind, record.window);
    if (facts.sourceHash !== record.sourceHash) {
      await this.setDraftStatus(path, "stale");
      throw new Error("来源已变化，请刷新事实并重新生成后再保存。旧草稿已标记为过期。");
    }
    const quality = this.periodReviews.validateDraft(draft, facts);
    if (!quality.ok) throw new Error(`草稿尚未通过质量检查：${quality.errors[0] ?? "请检查结构和来源"}`);
    const formal = await this.periodReviews.saveReview(facts, draft, instruction, userNotes);
    await this.updateDraft(path, draft, userNotes);
    await this.setDraftStatus(path, "saved", formal.path);
    return formal;
  }

  private async generateForDate(
    date: string,
    state: AutoReviewState,
    force: boolean,
    retryFailedAttempt = false
  ): Promise<AutoReviewRunResult> {
    const window = { start: date, end: date };
    const facts = await this.periodReviews.collectFacts("daily", window);
    const drafts = (await this.listDrafts(true)).filter((item) => item.window.start === date && item.window.end === date);
    const exact = drafts.find((item) => item.sourceHash === facts.sourceHash && item.status !== "dismissed");
    if (exact && !force) {
      return { status: "unchanged", date, path: exact.path, message: "相同来源的自动复盘草稿已经存在。" };
    }
    const activeDifferent = drafts.filter((item) => item.status === "pending" && item.sourceHash !== facts.sourceHash);
    if (activeDifferent.length > 0 && !force) {
      for (const item of activeDifferent) await this.setDraftStatus(item.path, "stale");
      return { status: "stale", date, path: activeDifferent[0].path, message: "来源已变化，旧草稿已标记为过期；不会自动再次调用 AI。" };
    }
    const staleDifferent = drafts.find((item) => item.status === "stale" && item.sourceHash !== facts.sourceHash);
    if (staleDifferent && !force) {
      return { status: "stale", date, path: staleDifferent.path, message: "来源已变化，等待用户手动刷新草稿；不会自动再次调用 AI。" };
    }
    if (!hasSubstantiveEvidence(facts)) {
      this.recordAttempt(state, date, facts.sourceHash, "no-evidence");
      await this.saveState(state);
      return { status: "no-evidence", date, message: "当天没有足够的已确认内容，未调用 AI。" };
    }
    const priorAttempt = state.attempts.find((item) => item.date === date && item.sourceHash === facts.sourceHash);
    if (!force && priorAttempt && (priorAttempt.result !== "failed" || !retryFailedAttempt)) {
      return { status: "unchanged", date, message: "同一日期和来源今天已经尝试生成过，不重复调用 AI。" };
    }

    this.recordAttempt(state, date, facts.sourceHash, "failed");
    await this.saveState(state);
    const generated = await this.periodReviews.generateDraftWithQuality(this.ai, facts);
    const path = await this.writeDraft(facts, generated.draft, generated.quality);
    const attempt = state.attempts.find((item) => item.date === date && item.sourceHash === facts.sourceHash);
    if (attempt) attempt.result = "created";
    await this.saveState(state);
    const draft = await this.readDraft(path);
    if (draft) this.options.onDraftCreated?.(draft);
    return { status: "created", date, path, message: "已生成一份待确认复盘草稿。" };
  }

  private async writeDraft(facts: PeriodReviewFacts, draft: string, quality: ReviewQualityReport): Promise<string> {
    await ensureFolder(this.app, this.draftsRoot());
    const base = `daily-${facts.window.start}-${facts.sourceHash}`;
    let path = `${this.draftsRoot()}/${base}.md`;
    let version = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = `${this.draftsRoot()}/${base}-v${version}.md`;
      version += 1;
    }
    let content = this.periodReviews.buildReviewMarkdown(facts, draft, "自动生成，等待用户确认", "", "pending")
      .replace("type: period-review", "type: period-review-draft");
    content = setFrontmatterValue(content, "auto_generated", "true");
    content = setFrontmatterValue(content, "quality_status", quality.ok ? "pass" : "warning");
    content = setFrontmatterValue(content, "quality_score", String(quality.score));
    const file = await ensureFile(this.app, path, "");
    await this.app.vault.modify(file, content);
    return path;
  }

  private async readDraftFile(file: TFile): Promise<AutoReviewDraft | null> {
    const content = await this.app.vault.read(file);
    const frontmatter = parseFrontmatter(content);
    if (frontmatter.type !== "period-review-draft") return null;
    const status = ["pending", "stale", "saved", "dismissed"].includes(frontmatter.status)
      ? frontmatter.status as AutoReviewDraft["status"]
      : "pending";
    const kind = ["daily", "weekly", "monthly", "custom"].includes(frontmatter.review_kind)
      ? frontmatter.review_kind as PeriodReviewKind
      : "daily";
    const regions = extractPeriodReviewRegions(content);
    return {
      path: file.path,
      title: file.basename,
      status,
      kind,
      window: { start: frontmatter.start_date || file.basename.slice(6, 16), end: frontmatter.end_date || file.basename.slice(6, 16) },
      sourceHash: frontmatter.source_hash || "",
      generatedAt: frontmatter.generated_at || "",
      qualityStatus: frontmatter.quality_status === "pass" ? "pass" : "warning",
      qualityScore: Number(frontmatter.quality_score) || 0,
      draft: regions.ai.trim(),
      userNotes: regions.userNotes.replace(/^\s*## 用户补充\s*/u, "").replace(/<!--[^]*?-->/gu, "").trim(),
      formalPath: frontmatter.formal_path || "",
      modifiedAt: file.stat.mtime
    };
  }

  private async loadState(): Promise<AutoReviewState> {
    await ensureFolder(this.app, this.draftsRoot());
    const raw = await readFile(this.app, this.statePath());
    if (!raw.trim()) return { schemaVersion: 1, attempts: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<AutoReviewState>;
      return {
        schemaVersion: 1,
        lastStartupCatchUpOn: typeof parsed.lastStartupCatchUpOn === "string" ? parsed.lastStartupCatchUpOn : undefined,
        attempts: Array.isArray(parsed.attempts) ? parsed.attempts.slice(-120) : []
      };
    } catch {
      return { schemaVersion: 1, attempts: [] };
    }
  }

  private async saveState(state: AutoReviewState): Promise<void> {
    const file = await ensureFile(this.app, this.statePath(), "");
    const content = JSON.stringify({ ...state, attempts: state.attempts.slice(-120) }, null, 2);
    await this.app.vault.modify(file, content);
  }

  private recordAttempt(state: AutoReviewState, date: string, sourceHash: string, result: AutoReviewAttempt["result"]): void {
    const existing = state.attempts.find((item) => item.date === date && item.sourceHash === sourceHash);
    if (existing) {
      existing.attemptedAt = this.now().toISOString();
      existing.result = result;
      return;
    }
    state.attempts.push({ date, sourceHash, attemptedAt: this.now().toISOString(), result });
  }

  private draftsRoot(): string {
    return this.fs.path("Reviews", "Drafts");
  }

  private statePath(): string {
    return `${this.draftsRoot()}/.auto-review-state.json`;
  }

  private async processFile(file: TFile, change: (content: string) => string): Promise<void> {
    const vault = this.app.vault as typeof this.app.vault & { process?: (file: TFile, fn: (content: string) => string) => Promise<string> };
    if (typeof vault.process === "function") {
      await vault.process(file, change);
      return;
    }
    await this.app.vault.modify(file, change(await this.app.vault.read(file)));
  }
}

export function normalizeAutoReviewTime(value: string | undefined | null): string {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{1,2})$/u);
  if (!match) return "22:30";
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function hasSubstantiveEvidence(facts: PeriodReviewFacts): boolean {
  return facts.evidence.some((item) => item.type !== "daily" || !/^资料不足/u.test(item.text));
}

function localTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function addDays(value: Date, amount: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + amount);
  return next;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/u);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
  }
  return result;
}

function setFrontmatterValue(content: string, key: string, value: string): string {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/u);
  if (!frontmatter) return content;
  const keyPattern = new RegExp(`^${escapeRegex(key)}:\\s*.*$`, "mu");
  const body = keyPattern.test(frontmatter[1])
    ? frontmatter[1].replace(keyPattern, `${key}: ${value}`)
    : `${frontmatter[1]}\n${key}: ${value}`;
  return content.replace(frontmatter[0], `---\n${body}\n---`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
