import { App, TFile } from "obsidian";
import { type AiClient } from "../../ai";
import type { PersonalLifeSystemSettings } from "../../settings";
import { formatDate } from "../../utils/dates";
import { ensureFile, readFile } from "../../utils/vault";
import { redactWorkspaceSecrets } from "../ai-workspace/logic";
import { DailyNoteService } from "../DailyNoteService";
import { FileSystemService } from "../FileSystemService";
import { PeriodReviewService, type PeriodReviewFacts } from "../PeriodReviewService";
import {
  getWeixinDailyCaptureText,
  type WeixinInboundRequest
} from "./WeixinBotLogic";

const INPUT_START = "<!-- lifeos-weixin-daily-inputs:start -->";
const INPUT_END = "<!-- lifeos-weixin-daily-inputs:end -->";
const DIGEST_START = "<!-- lifeos-weixin-daily-digest:start -->";
const DIGEST_END = "<!-- lifeos-weixin-daily-digest:end -->";
const DELIVERY_STALE_MS = 5 * 60 * 1000;
const DELIVERY_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface WeixinDailyDigest {
  date: string;
  draft: string;
  sourceHash: string;
  generatedAt: string;
  savedPath: string;
  reused: boolean;
  qualityWarnings: string[];
}

type WeixinDigestDeliveryStatus = "sending" | "delivered" | "failed";

interface WeixinDigestDeliveryState {
  status: WeixinDigestDeliveryStatus;
  attempts: number;
  updatedAt: string;
  deliveredAt: string;
  nextAttemptAt: string;
  lastError: string;
}

interface WeixinDailyDigestDayState {
  activeRouteRefs: string[];
  sourceHash: string;
  digest: string;
  generatedAt: string;
  savedPath: string;
  deliveries: Record<string, WeixinDigestDeliveryState>;
}

interface WeixinDailyDigestState {
  version: 1;
  days: Record<string, WeixinDailyDigestDayState>;
}

function emptyDayState(): WeixinDailyDigestDayState {
  return {
    activeRouteRefs: [],
    sourceHash: "",
    digest: "",
    generatedAt: "",
    savedPath: "",
    deliveries: {}
  };
}

function normalizeLine(value: string, max = 2_000): string {
  const clean = redactWorkspaceSecrets(value)
    .replace(/<!--/gu, "＜!--")
    .replace(/-->/gu, "--＞")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function insertBeforeDeepThought(markdown: string, block: string): string {
  const anchor = /^##\s+深度思考\s*$/mu;
  const match = anchor.exec(markdown);
  if (!match) return `${markdown.trimEnd()}\n\n${block}\n`;
  const before = markdown.slice(0, match.index).trimEnd();
  const after = markdown.slice(match.index).trimStart();
  return `${before}\n\n${block}\n\n${after}`;
}

/** Append one idempotent, user-authored Weixin input to the managed diary block. */
export function appendWeixinDailyInputBlock(markdown: string, line: string, entryId: string): string {
  const normalized = normalizeLine(line, 3_000);
  const safeId = entryId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 80);
  if (!normalized || !safeId) return markdown;
  const marker = `<!-- lifeos-weixin-input:${safeId} -->`;
  if (markdown.includes(marker)) return markdown;
  const entry = `- ${normalized} ${marker}`;
  const start = markdown.indexOf(INPUT_START);
  const end = markdown.indexOf(INPUT_END);
  if (start >= 0 && end > start) {
    const before = markdown.slice(0, end).trimEnd();
    const after = markdown.slice(end);
    return `${before}\n${entry}\n${after}`;
  }
  const block = [
    INPUT_START,
    "## 微信对话输入",
    "> 自动收集已授权私聊中的用户输入，供今日日记和复盘使用；AI 回复不会被当作已完成事实。",
    "",
    entry,
    INPUT_END
  ].join("\n");
  return insertBeforeDeepThought(markdown, block);
}

/** Replace only the AI-owned digest region, preserving all user-edited diary text. */
export function upsertWeixinDailyDigestBlock(
  markdown: string,
  digest: string,
  meta: { date: string; sourceHash: string; generatedAt: string }
): string {
  const body = digest.trim().replace(/^##\s+/gmu, "### ");
  if (!body) return markdown;
  const block = [
    DIGEST_START,
    "## Life OS 日终整理",
    "> 根据当天微信输入、日记正文、任务、打卡和已确认项目事实生成。重新生成只更新本区块，不覆盖手写内容。",
    `<!-- date:${meta.date} source:${meta.sourceHash} generated:${meta.generatedAt} -->`,
    "",
    body,
    DIGEST_END
  ].join("\n");
  const pattern = /<!-- lifeos-weixin-daily-digest:start -->[\s\S]*?<!-- lifeos-weixin-daily-digest:end -->/u;
  if (pattern.test(markdown)) return markdown.replace(pattern, block);
  return insertBeforeDeepThought(markdown, block);
}

export function stripWeixinDailyDigestBlock(markdown: string): string {
  return markdown
    .replace(/<!-- lifeos-weixin-daily-digest:start -->[\s\S]*?<!-- lifeos-weixin-daily-digest:end -->/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function weixinLocalDate(value: string | Date | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  return formatDate(Number.isFinite(date.getTime()) ? date : new Date());
}

function localTime(value: string | Date | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  return `${String(safe.getHours()).padStart(2, "0")}:${String(safe.getMinutes()).padStart(2, "0")}`;
}

export class WeixinDailyJournalService {
  private stateQueue: Promise<void> = Promise.resolve();

  constructor(
    private app: App,
    private fs: FileSystemService,
    private settings: PersonalLifeSystemSettings
  ) {}

  /**
   * Record every authorized private conversation as a day-level input source.
   * Meaningful natural-language mutations are retained as user-authored day
   * evidence as well as being written to their canonical Life OS destination.
   * This keeps Weixin usable as a complete Life OS input surface while never
   * treating an assistant reply as proof that work was completed.
   */
  async captureInput(request: WeixinInboundRequest, routeRef: string): Promise<{ captured: boolean; path: string }> {
    const date = weixinLocalDate(request.timestamp);
    if (!request.isGroup && routeRef) await this.markRouteActive(date, routeRef);
    if (
      request.isGroup
      || !this.settings.weixinCaptureToDailyEnabled
      || this.settings.weixinPermissionMode === "read-only"
    ) {
      return { captured: false, path: "" };
    }
    const capture = getWeixinDailyCaptureText(request.content);
    const mediaCount = request.media.length;
    if (!capture && mediaCount === 0) return { captured: false, path: "" };
    const daily = new DailyNoteService(this.app, this.fs, this.settings);
    const file = await daily.ensureTodayNote(date);
    const identity = normalizeLine(request.senderName, 40);
    const userInput = capture || `发送了 ${mediaCount} 个附件，等待后续说明`;
    const line = [
      `${localTime(request.timestamp)} 微信${identity ? `（${identity}）` : ""}：${userInput}`,
      capture && mediaCount > 0 ? `（含 ${mediaCount} 个附件）` : ""
    ].filter(Boolean).join(" ");
    const entryId = this.stableHash([
      request.accountId || "default",
      request.conversationId,
      request.senderId,
      request.messageId
    ].join("\u001f"));
    await this.processFile(file, (current) => appendWeixinDailyInputBlock(current, line, entryId));
    return { captured: true, path: file.path };
  }

  async generateDigest(ai: AiClient, date: string): Promise<WeixinDailyDigest | null> {
    const period = new PeriodReviewService(this.app, this.fs, this.settings);
    const facts = await period.collectFacts("daily", { start: date, end: date });
    if (!this.hasSubstantiveEvidence(facts)) return null;
    const cached = await this.readStateAfterQueue();
    const day = cached.days[date];
    if (day?.sourceHash === facts.sourceHash && day.digest.trim()) {
      return {
        date,
        draft: day.digest,
        sourceHash: day.sourceHash,
        generatedAt: day.generatedAt,
        savedPath: day.savedPath,
        reused: true,
        qualityWarnings: []
      };
    }
    const generated = await period.generateDraftWithQuality(ai, facts, [
      "这是 Life OS 微信日终日记整理，不是泛泛建议。",
      "以用户当天在微信中的输入和日记正文为主线，任务、打卡、已确认项目活动只用于核对。",
      "用户提出的问题可以写成当天关注或讨论的主题，但不能据此声称相关工作已经完成。",
      "适合微信阅读：结论优先、短段落，同时保留可追溯来源和明确的下一步。"
    ].join("\n"));
    return {
      date,
      draft: generated.draft,
      sourceHash: facts.sourceHash,
      generatedAt: new Date().toISOString(),
      savedPath: "",
      reused: false,
      qualityWarnings: [...generated.quality.errors, ...generated.quality.warnings].slice(0, 5)
    };
  }

  async currentSourceHash(date: string): Promise<string> {
    const facts = await new PeriodReviewService(this.app, this.fs, this.settings)
      .collectFacts("daily", { start: date, end: date });
    return facts.sourceHash;
  }

  async saveDigest(digest: WeixinDailyDigest): Promise<string> {
    const currentHash = await this.currentSourceHash(digest.date);
    if (currentHash !== digest.sourceHash) throw new Error("日记来源在生成后发生变化，请重新生成日终整理。");
    const daily = new DailyNoteService(this.app, this.fs, this.settings);
    const file = await daily.ensureTodayNote(digest.date);
    await this.processFile(file, (current) => upsertWeixinDailyDigestBlock(current, digest.draft, {
      date: digest.date,
      sourceHash: digest.sourceHash,
      generatedAt: digest.generatedAt
    }));
    await this.updateState((state) => {
      const current = state.days[digest.date] || emptyDayState();
      const sourceChanged = Boolean(current.sourceHash && current.sourceHash !== digest.sourceHash);
      state.days[digest.date] = {
        ...current,
        sourceHash: digest.sourceHash,
        digest: digest.draft,
        generatedAt: digest.generatedAt,
        savedPath: file.path,
        deliveries: sourceChanged ? {} : current.deliveries
      };
    });
    digest.savedPath = file.path;
    return file.path;
  }

  async activeRouteRefs(date: string): Promise<string[]> {
    const state = await this.readStateAfterQueue();
    return Array.from(new Set(state.days[date]?.activeRouteRefs || []));
  }

  async claimDelivery(date: string, routeRef: string, now = new Date()): Promise<boolean> {
    let claimed = false;
    await this.updateState((state) => {
      const day = state.days[date];
      if (!day?.digest.trim()) return;
      const existing = day.deliveries[routeRef];
      if (existing?.status === "delivered") return;
      if (existing?.status === "sending" && Date.parse(existing.updatedAt) + DELIVERY_STALE_MS > now.getTime()) return;
      if (existing?.nextAttemptAt && Date.parse(existing.nextAttemptAt) > now.getTime()) return;
      day.deliveries[routeRef] = {
        status: "sending",
        attempts: Math.max(0, existing?.attempts || 0) + 1,
        updatedAt: now.toISOString(),
        deliveredAt: existing?.deliveredAt || "",
        nextAttemptAt: "",
        lastError: ""
      };
      claimed = true;
    });
    return claimed;
  }

  async markDelivered(date: string, routeRef: string, deliveredAt = new Date()): Promise<void> {
    await this.updateState((state) => {
      const delivery = state.days[date]?.deliveries[routeRef];
      if (!delivery) return;
      delivery.status = "delivered";
      delivery.updatedAt = deliveredAt.toISOString();
      delivery.deliveredAt = delivery.updatedAt;
      delivery.nextAttemptAt = "";
      delivery.lastError = "";
    });
  }

  async markFailed(date: string, routeRef: string, error: unknown, now = new Date()): Promise<void> {
    await this.updateState((state) => {
      const delivery = state.days[date]?.deliveries[routeRef];
      if (!delivery || delivery.status === "delivered") return;
      const delay = DELIVERY_RETRY_MS[Math.min(Math.max(0, delivery.attempts - 1), DELIVERY_RETRY_MS.length - 1)];
      delivery.status = "failed";
      delivery.updatedAt = now.toISOString();
      delivery.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
      delivery.lastError = String(error instanceof Error ? error.message : error || "发送失败").slice(0, 500);
    });
  }

  private hasSubstantiveEvidence(facts: PeriodReviewFacts): boolean {
    return facts.evidence.some((item) => item.type !== "open-task" && item.text.trim() && !/^资料不足/u.test(item.text.trim()));
  }

  private async markRouteActive(date: string, routeRef: string): Promise<void> {
    await this.updateState((state) => {
      const day = state.days[date] || emptyDayState();
      day.activeRouteRefs = Array.from(new Set([...day.activeRouteRefs, routeRef])).slice(-100);
      state.days[date] = day;
    });
  }

  private statePath(): string {
    return this.fs.path("Chat", "Weixin", "Daily", ".daily-digest-state.json");
  }

  private async readStateAfterQueue(): Promise<WeixinDailyDigestState> {
    await this.stateQueue.catch(() => undefined);
    return this.readState();
  }

  private async readState(): Promise<WeixinDailyDigestState> {
    const source = await readFile(this.app, this.statePath());
    if (!source.trim()) return { version: 1, days: {} };
    try {
      const parsed = JSON.parse(source) as Partial<WeixinDailyDigestState>;
      return parsed.version === 1 && parsed.days && typeof parsed.days === "object"
        ? { version: 1, days: parsed.days }
        : { version: 1, days: {} };
    } catch {
      return { version: 1, days: {} };
    }
  }

  private async updateState(change: (state: WeixinDailyDigestState) => void): Promise<void> {
    const operation = this.stateQueue.then(async () => {
      const state = await this.readState();
      change(state);
      const dates = Object.keys(state.days).sort();
      dates.slice(0, Math.max(0, dates.length - 120)).forEach((date) => delete state.days[date]);
      const file = await ensureFile(this.app, this.statePath(), "");
      await this.app.vault.modify(file, `${JSON.stringify(state, null, 2)}\n`);
    });
    this.stateQueue = operation.catch(() => undefined);
    return operation;
  }

  private async processFile(file: TFile, change: (content: string) => string): Promise<void> {
    const vault = this.app.vault as typeof this.app.vault & {
      process?: (target: TFile, fn: (current: string) => string) => Promise<string>;
    };
    if (typeof vault.process === "function") {
      await vault.process(file, change);
      return;
    }
    const current = await this.app.vault.read(file);
    const next = change(current);
    if (next !== current) await this.app.vault.modify(file, next);
  }

  private stableHash(value: string): string {
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
}
