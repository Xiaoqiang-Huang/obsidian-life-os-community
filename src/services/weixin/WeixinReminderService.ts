import { App, TFile } from "obsidian";
import { ensureFile, ensureFolder } from "../../utils/vault";
import { FileSystemService } from "../FileSystemService";

export type WeixinReminderStatus = "pending" | "sending" | "delivered" | "cancelled";

export interface WeixinReminderRecord {
  id: string;
  routeRef: string;
  status: WeixinReminderStatus;
  dueAt: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt: string;
  deliveredAt: string;
  lastError: string;
  clientId: string;
}

const STALE_SENDING_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

export class WeixinReminderService {
  constructor(private app: App, private fs: FileSystemService) {}

  async create(routeRef: string, dueAt: string, content: string, requestedId = ""): Promise<WeixinReminderRecord> {
    const normalizedRoute = routeRef.trim().toUpperCase();
    const normalizedContent = content.replace(/\u0000/g, "").trim().slice(0, 20_000);
    const due = new Date(dueAt);
    if (!/^WXR-[0-9A-F]{16}$/u.test(normalizedRoute)) throw new Error("提醒路由无效。");
    if (!normalizedContent) throw new Error("提醒内容不能为空。");
    if (!Number.isFinite(due.getTime()) || due.getTime() <= Date.now()) throw new Error("提醒时间必须晚于现在。");
    const now = new Date().toISOString();
    const id = requestedId ? requestedId.trim().toUpperCase() : this.allocateId();
    if (!/^WR-\d{6}$/u.test(id)) throw new Error("提醒编号无效。");
    const existing = await this.read(id);
    if (existing) {
      if (existing.routeRef === normalizedRoute && existing.dueAt === due.toISOString() && existing.content === normalizedContent) {
        return existing;
      }
      throw new Error("提醒编号发生冲突，请重新创建提醒。");
    }
    const reminder: WeixinReminderRecord = {
      id,
      routeRef: normalizedRoute,
      status: "pending",
      dueAt: due.toISOString(),
      content: normalizedContent,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      nextAttemptAt: due.toISOString(),
      deliveredAt: "",
      lastError: "",
      clientId: `lifeos-reminder-${id.toLowerCase()}`
    };
    await this.write(reminder);
    return reminder;
  }

  async list(routeRef: string, includeCompleted = false): Promise<WeixinReminderRecord[]> {
    const records = await this.readAll();
    return records
      .filter((item) => item.routeRef === routeRef.trim().toUpperCase())
      .filter((item) => includeCompleted || item.status === "pending" || item.status === "sending")
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
  }

  async cancel(routeRef: string, id: string): Promise<WeixinReminderRecord | null> {
    const reminder = await this.read(id);
    if (!reminder || reminder.routeRef !== routeRef.trim().toUpperCase()) return null;
    if (reminder.status === "delivered" || reminder.status === "cancelled") return reminder;
    reminder.status = "cancelled";
    reminder.updatedAt = new Date().toISOString();
    reminder.nextAttemptAt = "";
    await this.write(reminder);
    return reminder;
  }

  /** Atomically mark due reminders as sending before network delivery. */
  async claimDue(now = new Date()): Promise<WeixinReminderRecord[]> {
    const nowMs = now.getTime();
    const claimed: WeixinReminderRecord[] = [];
    for (const reminder of await this.readAll()) {
      const staleSending = reminder.status === "sending"
        && Date.parse(reminder.updatedAt) + STALE_SENDING_MS <= nowMs;
      const eligible = reminder.status === "pending" || staleSending;
      const attemptAt = Date.parse(reminder.nextAttemptAt || reminder.dueAt);
      if (!eligible || !Number.isFinite(attemptAt) || attemptAt > nowMs) continue;
      reminder.status = "sending";
      reminder.attempts = Math.max(0, reminder.attempts) + 1;
      reminder.updatedAt = now.toISOString();
      reminder.lastError = "";
      await this.write(reminder);
      claimed.push(reminder);
    }
    return claimed;
  }

  async markDelivered(id: string, deliveredAt = new Date()): Promise<WeixinReminderRecord | null> {
    const reminder = await this.read(id);
    if (!reminder) return null;
    reminder.status = "delivered";
    reminder.deliveredAt = deliveredAt.toISOString();
    reminder.updatedAt = reminder.deliveredAt;
    reminder.nextAttemptAt = "";
    reminder.lastError = "";
    await this.write(reminder);
    return reminder;
  }

  async markFailed(id: string, error: unknown, now = new Date()): Promise<WeixinReminderRecord | null> {
    const reminder = await this.read(id);
    if (!reminder || reminder.status === "cancelled" || reminder.status === "delivered") return reminder;
    const delay = RETRY_DELAYS_MS[Math.min(Math.max(0, reminder.attempts - 1), RETRY_DELAYS_MS.length - 1)];
    reminder.status = "pending";
    reminder.updatedAt = now.toISOString();
    reminder.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
    reminder.lastError = String(error instanceof Error ? error.message : error || "发送失败").slice(0, 500);
    await this.write(reminder);
    return reminder;
  }

  private folder(): string {
    return this.fs.path("Tasks", "Reminders");
  }

  private path(id: string): string {
    return `${this.folder()}/${id.toUpperCase()}.md`;
  }

  allocateId(): string {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      const number = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
      const id = `WR-${String(100000 + (number % 900000))}`;
      if (!this.app.vault.getAbstractFileByPath(this.path(id))) return id;
    }
    throw new Error("暂时无法生成唯一提醒编号，请稍后重试。");
  }

  private async readAll(): Promise<WeixinReminderRecord[]> {
    const prefix = `${this.folder()}/`;
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix) && /^WR-\d{6}\.md$/iu.test(file.name));
    const records = await Promise.all(files.map((file) => this.readFile(file)));
    return records.filter((item): item is WeixinReminderRecord => Boolean(item));
  }

  private async read(id: string): Promise<WeixinReminderRecord | null> {
    const normalized = id.trim().toUpperCase();
    if (!/^WR-\d{6}$/u.test(normalized)) return null;
    const file = this.app.vault.getAbstractFileByPath(this.path(normalized));
    return file instanceof TFile ? this.readFile(file) : null;
  }

  private async readFile(file: TFile): Promise<WeixinReminderRecord | null> {
    const source = await this.app.vault.read(file);
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n/u)?.[1] || "";
    const field = (key: string): string => {
      const raw = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "mu"))?.[1]?.trim() || "";
      if (!raw) return "";
      try { return String(JSON.parse(raw)); } catch { return raw; }
    };
    const status = field("status") as WeixinReminderStatus;
    const content = source.match(/<!-- lifeos-reminder:content:start -->\s*\n([\s\S]*?)\n<!-- lifeos-reminder:content:end -->/u)?.[1]?.trim() || "";
    const record: WeixinReminderRecord = {
      id: field("id").toUpperCase(),
      routeRef: field("route_ref").toUpperCase(),
      status,
      dueAt: field("due_at"),
      content,
      createdAt: field("created_at"),
      updatedAt: field("updated_at"),
      attempts: Math.max(0, Number(field("attempts") || 0)),
      nextAttemptAt: field("next_attempt_at"),
      deliveredAt: field("delivered_at"),
      lastError: field("last_error"),
      clientId: field("client_id")
    };
    if (!/^WR-\d{6}$/u.test(record.id) || !/^WXR-[0-9A-F]{16}$/u.test(record.routeRef)) return null;
    if (!["pending", "sending", "delivered", "cancelled"].includes(record.status)) return null;
    if (!record.content || !Number.isFinite(Date.parse(record.dueAt))) return null;
    return record;
  }

  private async write(reminder: WeixinReminderRecord): Promise<void> {
    await ensureFolder(this.app, this.folder());
    const file = await ensureFile(this.app, this.path(reminder.id), "");
    const q = (value: string) => JSON.stringify(value || "");
    const markdown = [
      "---",
      "type: lifeos-weixin-reminder",
      `id: ${q(reminder.id)}`,
      `route_ref: ${q(reminder.routeRef)}`,
      `status: ${q(reminder.status)}`,
      `due_at: ${q(reminder.dueAt)}`,
      `created_at: ${q(reminder.createdAt)}`,
      `updated_at: ${q(reminder.updatedAt)}`,
      `attempts: ${Math.max(0, Math.floor(reminder.attempts))}`,
      `next_attempt_at: ${q(reminder.nextAttemptAt)}`,
      `delivered_at: ${q(reminder.deliveredAt)}`,
      `last_error: ${q(reminder.lastError)}`,
      `client_id: ${q(reminder.clientId)}`,
      "---",
      "",
      `# 微信提醒 ${reminder.id}`,
      "",
      `- 到期：${reminder.dueAt}`,
      `- 状态：${reminder.status}`,
      "",
      "<!-- lifeos-reminder:content:start -->",
      reminder.content,
      "<!-- lifeos-reminder:content:end -->",
      ""
    ].join("\n");
    await this.app.vault.modify(file, markdown);
  }
}
