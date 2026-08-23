import { App, TFile } from "obsidian";
import { ensureFile, readFile } from "../../utils/vault";
import { FileSystemService } from "../FileSystemService";
import type { WeixinAssistantResponse, WeixinInboundRequest } from "./WeixinBotLogic";

export type WeixinInboundStatus = "pending" | "processing" | "responded" | "delivered" | "failed";

export interface WeixinInboundQueueEntry {
  version: 2;
  id: string;
  status: WeixinInboundStatus;
  attempts: number;
  receivedAt: string;
  updatedAt: string;
  lastError: string;
  request: WeixinInboundRequest;
  response: WeixinAssistantResponse | null;
}

export interface WeixinRecoveredMessage {
  request: WeixinInboundRequest;
  response: WeixinAssistantResponse;
}

const MAX_RECOVERY_ATTEMPTS = 4;
const RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_LEASE_MS = 15_000;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Vault-backed inbox/outbox queue. “responded” is intentionally distinct from
 * “delivered”: after a crash, a generated but unsent reply can be sent again
 * with the same stable iLink client id instead of silently losing the message.
 */
export class WeixinInboundQueueService {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private app: App, private fs: FileSystemService) {}

  async stage(request: WeixinInboundRequest): Promise<WeixinInboundQueueEntry> {
    const path = this.pathFor(request);
    const previous = this.queues.get(path) || Promise.resolve();
    let result: WeixinInboundQueueEntry | null = null;
    const operation = previous.catch(() => undefined).then(async () => {
      const existing = await this.read(path);
      if (existing && existing.request.messageId === request.messageId) {
        result = existing;
        return;
      }
      const entry = this.createEntry(request);
      await this.writeDirect(path, entry);
      result = entry;
    });
    const tracked = operation.catch(() => undefined);
    this.queues.set(path, tracked);
    try {
      await operation;
      if (!result) throw new Error("微信可靠收件箱写入后未能读取消息。");
      return result;
    } finally {
      if (this.queues.get(path) === tracked) this.queues.delete(path);
    }
  }

  async markProcessing(request: WeixinInboundRequest): Promise<void> {
    await this.update(request, (entry) => {
      if (entry.status === "delivered") return;
      entry.status = "processing";
      entry.attempts += 1;
      entry.lastError = "";
    });
  }

  async markResponded(request: WeixinInboundRequest, response: WeixinAssistantResponse): Promise<void> {
    await this.update(request, (entry) => {
      if (entry.status === "delivered") return;
      entry.status = "responded";
      entry.response = {
        reply: String(response.reply || "").slice(0, 200_000),
        projectId: response.projectId,
        conversationPath: response.conversationPath,
        writebackStatus: response.writebackStatus
      };
      entry.lastError = "";
    });
  }

  async markDelivered(request: WeixinInboundRequest): Promise<void> {
    await this.update(request, (entry) => {
      entry.status = "delivered";
      entry.lastError = "";
    });
  }

  async markDeliveryFailed(request: WeixinInboundRequest, error: unknown): Promise<void> {
    await this.update(request, (entry) => {
      // Keep a generated response replayable; only processing failures become
      // “failed”. Transport failures remain “responded”.
      entry.status = entry.response ? "responded" : "failed";
      entry.lastError = this.errorMessage(error).slice(0, 1_000);
    });
  }

  async recover(accountId = ""): Promise<WeixinInboundQueueEntry[]> {
    const root = `${this.fs.path("Chat", "Weixin", "Inbox")}/`;
    const now = Date.now();
    const entries: WeixinInboundQueueEntry[] = [];
    const files = this.app.vault.getFiles()
      .filter((file) => file.path.startsWith(root) && file.extension.toLowerCase() === "json")
      .sort((a, b) => a.stat.mtime - b.stat.mtime);
    for (const file of files) {
      const entry = await this.read(file.path);
      if (!entry || entry.status === "delivered") continue;
      if (accountId && entry.request.accountId !== accountId) continue;
      if (entry.attempts >= MAX_RECOVERY_ATTEMPTS && entry.status !== "responded") continue;
      if (Date.parse(entry.receivedAt) + RECOVERY_RETENTION_MS <= now) continue;
      const updatedAt = Date.parse(entry.updatedAt);
      if (entry.status === "pending" && updatedAt + PENDING_LEASE_MS > now) continue;
      if (entry.status === "processing" && updatedAt + PROCESSING_LEASE_MS > now) continue;
      entries.push(entry);
    }
    return entries.slice(0, 100);
  }

  private async update(request: WeixinInboundRequest, change: (entry: WeixinInboundQueueEntry) => void): Promise<void> {
    const path = this.pathFor(request);
    const previous = this.queues.get(path) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const entry = await this.read(path) || this.createEntry(request);
      change(entry);
      entry.updatedAt = new Date().toISOString();
      await this.writeDirect(path, entry);
    });
    const tracked = operation.catch(() => undefined);
    this.queues.set(path, tracked);
    try {
      await operation;
    } finally {
      if (this.queues.get(path) === tracked) this.queues.delete(path);
    }
  }

  private async writeDirect(path: string, entry: WeixinInboundQueueEntry): Promise<void> {
    const file = await ensureFile(this.app, path, "");
    await this.app.vault.modify(file, `${JSON.stringify(entry, null, 2)}\n`);
  }

  private async read(path: string): Promise<WeixinInboundQueueEntry | null> {
    const source = await readFile(this.app, path);
    if (!source.trim()) return null;
    try {
      const parsed = asRecord(JSON.parse(source));
      if (Number(parsed.version) !== 2) return null;
      const request = this.normalizeRequest(parsed.request);
      if (!request.messageId) return null;
      const responseRecord = asRecord(parsed.response);
      const response = String(responseRecord.reply || "").trim()
        ? {
          reply: String(responseRecord.reply).slice(0, 200_000),
          projectId: String(responseRecord.projectId || "") || undefined,
          conversationPath: String(responseRecord.conversationPath || "") || undefined,
          writebackStatus: String(responseRecord.writebackStatus || "") || undefined
        }
        : null;
      const status = ["pending", "processing", "responded", "delivered", "failed"].includes(String(parsed.status))
        ? String(parsed.status) as WeixinInboundStatus
        : "pending";
      return {
        version: 2,
        id: String(parsed.id || this.entryId(request)).slice(0, 100),
        status,
        attempts: Math.max(0, Number(parsed.attempts || 0)),
        receivedAt: this.safeTimestamp(String(parsed.receivedAt || request.timestamp), new Date().toISOString()),
        updatedAt: this.safeTimestamp(String(parsed.updatedAt || request.timestamp), new Date().toISOString()),
        lastError: String(parsed.lastError || "").slice(0, 1_000),
        request,
        response
      };
    } catch {
      return null;
    }
  }

  private sanitizeRequest(request: WeixinInboundRequest): WeixinInboundRequest {
    return {
      ...request,
      content: String(request.content || "").slice(0, 200_000),
      media: request.media.map((item) => {
        const record = asRecord(item);
        return {
          type: String(record.type || ""),
          mimeType: String(record.mimeType || ""),
          name: String(record.name || "").slice(0, 200),
          size: Math.max(0, Number(record.size || 0)),
          vaultPath: String(record.vaultPath || "").slice(0, 1_000),
          error: String(record.error || "").slice(0, 500)
        };
      })
    };
  }

  private createEntry(request: WeixinInboundRequest): WeixinInboundQueueEntry {
    const now = new Date().toISOString();
    return {
      version: 2,
      id: this.entryId(request),
      status: "pending",
      attempts: 0,
      receivedAt: this.safeTimestamp(request.timestamp, now),
      updatedAt: now,
      lastError: "",
      request: this.sanitizeRequest(request),
      response: null
    };
  }

  private normalizeRequest(value: unknown): WeixinInboundRequest {
    const record = asRecord(value);
    return {
      version: 1,
      channel: "weixin",
      messageId: String(record.messageId || "").slice(0, 300),
      accountId: String(record.accountId || "default").slice(0, 240),
      conversationId: String(record.conversationId || "").slice(0, 300),
      threadId: String(record.threadId || "").slice(0, 300),
      senderId: String(record.senderId || "").slice(0, 240),
      senderName: String(record.senderName || "").slice(0, 160),
      isGroup: record.isGroup === true,
      wasMentioned: record.wasMentioned === true,
      content: String(record.content || "").slice(0, 200_000),
      timestamp: this.safeTimestamp(String(record.timestamp || ""), new Date().toISOString()),
      media: Array.isArray(record.media) ? record.media.slice(0, 20) : []
    };
  }

  private pathFor(request: WeixinInboundRequest): string {
    const readable = String(request.messageId || "message").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "message";
    return this.fs.path("Chat", "Weixin", "Inbox", `${this.entryId(request)}-${readable}.json`);
  }

  private entryId(request: WeixinInboundRequest): string {
    return this.stableHash(["weixin", request.accountId || "default", request.messageId].join("\u001f"));
  }

  private safeTimestamp(value: string, fallback: string): string {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || "未知错误");
  }

  private stableHash(value: string): string {
    let primary = 2166136261;
    let secondary = 2166136261 ^ 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      primary = Math.imul(primary ^ code, 16777619);
      secondary = Math.imul(secondary ^ code, 2246822519);
    }
    return [primary, secondary].map((hash) => (hash >>> 0).toString(16).padStart(8, "0")).join("");
  }
}
