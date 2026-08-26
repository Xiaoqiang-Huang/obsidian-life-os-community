import { App, TFile } from "obsidian";
import { ensureFile, ensureFolder, readFile } from "../../utils/vault";
import { FileSystemService } from "../FileSystemService";
import { getWeixinImageContentParts, type WeixinInboundRequest } from "./WeixinBotLogic";

export interface WeixinStoredImage {
  id: string;
  vaultPath: string;
  mimeType: string;
  name: string;
  createdAt: string;
  sourceMessageId: string;
}

export interface WeixinPendingOperation {
  kind: "link-save";
  url: string;
  title: string;
  collection: string;
  createdAt: string;
  expiresAt: string;
}

export interface WeixinConversationState {
  version: 1;
  updatedAt: string;
  lastStandaloneQuery: string;
  /**
   * Last user turn that carries the actual topic rather than a capability
   * complaint or a referential follow-up such as “你不能联网搜索吗”. Keeping
   * this separately prevents a second follow-up from overwriting the subject
   * needed to rewrite the next retrieval query.
   */
  lastSubstantiveQuery: string;
  lastSkillIds: string[];
  recentImages: WeixinStoredImage[];
  pendingOperation: WeixinPendingOperation | null;
}

const MAX_STORED_IMAGES = 8;
const IMAGE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const PENDING_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function emptyState(): WeixinConversationState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    lastStandaloneQuery: "",
    lastSubstantiveQuery: "",
    lastSkillIds: [],
    recentImages: [],
    pendingOperation: null
  };
}

/** Durable, per-conversation state for cross-turn Weixin behavior. */
export class WeixinConversationStateService {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private app: App, private fs: FileSystemService) {}

  async prepareInbound(request: WeixinInboundRequest): Promise<WeixinInboundRequest> {
    const persistedMedia: unknown[] = [];
    const storedImages: WeixinStoredImage[] = [];
    for (let index = 0; index < request.media.length; index += 1) {
      const media = asRecord(request.media[index]);
      const dataUrl = String(media.dataUrl || "");
      if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,/iu.test(dataUrl)) {
        persistedMedia.push(request.media[index]);
        continue;
      }
      const stored = await this.persistImage(request, media, dataUrl, index);
      persistedMedia.push({ ...media, vaultPath: stored.vaultPath });
      storedImages.push(stored);
    }
    if (storedImages.length > 0) {
      await this.update(request, (state) => {
        const existing = new Map(state.recentImages.map((item) => [item.id, item]));
        storedImages.forEach((item) => existing.set(item.id, item));
        state.recentImages = Array.from(existing.values())
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          .slice(-MAX_STORED_IMAGES);
      });
    }
    return { ...request, media: persistedMedia };
  }

  async hydrateRecentImages(request: WeixinInboundRequest): Promise<WeixinInboundRequest> {
    if (getWeixinImageContentParts(request.media).length > 0) return request;
    const state = await this.load(request);
    const latest = state.recentImages[state.recentImages.length - 1];
    // Rehydrate the latest message batch, not every image seen in the last
    // three days. This keeps “用另一种 Skill 解前面那道题” deterministic and
    // avoids silently mixing unrelated screenshots from older turns.
    const images = latest
      ? state.recentImages.filter((item) => item.sourceMessageId === latest.sourceMessageId).slice(-4)
      : [];
    const hydrated: unknown[] = [];
    for (const image of images) {
      const media = await this.hydrateImage(image).catch(() => null);
      if (media) hydrated.push(media);
    }
    return hydrated.length > 0 ? { ...request, media: [...hydrated, ...request.media] } : request;
  }

  async hydratePersistedMedia(request: WeixinInboundRequest): Promise<WeixinInboundRequest> {
    const media: unknown[] = [];
    for (const item of request.media) {
      const record = asRecord(item);
      if (String(record.dataUrl || "")) {
        media.push(item);
        continue;
      }
      const vaultPath = String(record.vaultPath || "");
      if (!vaultPath) {
        media.push(item);
        continue;
      }
      const hydrated = await this.hydrateImage({
        id: this.stableHash(vaultPath),
        vaultPath,
        mimeType: String(record.mimeType || "image/png"),
        name: String(record.name || "微信图片"),
        createdAt: this.safeTimestamp(request.timestamp),
        sourceMessageId: request.messageId
      }).catch(() => null);
      media.push(hydrated || item);
    }
    return { ...request, media };
  }

  async clearImages(request: WeixinInboundRequest): Promise<boolean> {
    let changed = false;
    await this.update(request, (state) => {
      changed = state.recentImages.length > 0;
      state.recentImages = [];
    });
    return changed;
  }

  async rememberStandaloneQuery(
    request: WeixinInboundRequest,
    query: string,
    options: { substantive?: boolean } = {}
  ): Promise<void> {
    const clean = String(query || "").trim().slice(0, 12_000);
    if (!clean) return;
    await this.update(request, (state) => {
      state.lastStandaloneQuery = clean;
      if (options.substantive !== false) state.lastSubstantiveQuery = clean;
    });
  }

  async rememberSkills(request: WeixinInboundRequest, skillIds: string[]): Promise<void> {
    const ids = Array.from(new Set(skillIds.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 8);
    await this.update(request, (state) => {
      state.lastSkillIds = ids;
    });
  }

  async setPendingOperation(request: WeixinInboundRequest, pending: Omit<WeixinPendingOperation, "createdAt" | "expiresAt">): Promise<void> {
    const now = new Date();
    await this.update(request, (state) => {
      state.pendingOperation = {
        ...pending,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + PENDING_OPERATION_TTL_MS).toISOString()
      };
    });
  }

  async clearPendingOperation(request: WeixinInboundRequest): Promise<void> {
    await this.update(request, (state) => {
      state.pendingOperation = null;
    });
  }

  async load(request: WeixinInboundRequest): Promise<WeixinConversationState> {
    const path = this.statePath(request);
    await this.queues.get(path)?.catch(() => undefined);
    const source = await readFile(this.app, path);
    let state = emptyState();
    try {
      const parsed = JSON.parse(source || "{}") as Partial<WeixinConversationState>;
      if (parsed.version === 1) {
        state = {
          version: 1,
          updatedAt: String(parsed.updatedAt || state.updatedAt),
          lastStandaloneQuery: String(parsed.lastStandaloneQuery || "").slice(0, 12_000),
          lastSubstantiveQuery: String(parsed.lastSubstantiveQuery || parsed.lastStandaloneQuery || "").slice(0, 12_000),
          lastSkillIds: Array.isArray(parsed.lastSkillIds)
            ? parsed.lastSkillIds.map(String).filter(Boolean).slice(0, 8)
            : [],
          recentImages: Array.isArray(parsed.recentImages)
            ? parsed.recentImages.map((item) => this.normalizeStoredImage(item)).filter((item): item is WeixinStoredImage => Boolean(item))
            : [],
          pendingOperation: this.normalizePendingOperation(parsed.pendingOperation)
        };
      }
    } catch {
      state = emptyState();
    }
    return this.pruneState(state);
  }

  private async persistImage(
    request: WeixinInboundRequest,
    media: Record<string, unknown>,
    dataUrl: string,
    index: number
  ): Promise<WeixinStoredImage> {
    const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/iu);
    if (!match) throw new Error("微信图片不是受支持的 data URL。");
    const mimeType = match[1].toLowerCase();
    const binary = this.decodeBase64(match[2]);
    if (binary.byteLength > MAX_IMAGE_BYTES) throw new Error("微信图片超过 20 MB 的持久化上限。");
    const date = this.safeDate(request.timestamp);
    const id = this.stableHash([request.accountId, request.conversationId, request.senderId, request.messageId, String(index)].join("\u001f"));
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1].replace("jpeg", "jpg");
    const folder = this.fs.path("Chat", "Weixin", "Attachments", date);
    const vaultPath = `${folder}/${id}.${extension}`;
    await ensureFolder(this.app, folder);
    const existing = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(existing instanceof TFile)) await this.app.vault.createBinary(vaultPath, binary);
    return {
      id,
      vaultPath,
      mimeType,
      name: String(media.name || `微信图片-${index + 1}.${extension}`).slice(0, 160),
      createdAt: this.safeTimestamp(request.timestamp),
      sourceMessageId: String(request.messageId || "").slice(0, 300)
    };
  }

  private async hydrateImage(image: WeixinStoredImage): Promise<Record<string, unknown> | null> {
    const root = `${this.fs.path("Chat", "Weixin", "Attachments")}/`;
    if (!image.vaultPath.startsWith(root)) return null;
    const file = this.app.vault.getAbstractFileByPath(image.vaultPath);
    if (!(file instanceof TFile)) return null;
    const binary = await this.app.vault.readBinary(file);
    if (binary.byteLength > MAX_IMAGE_BYTES) return null;
    return {
      type: "图片",
      mimeType: image.mimeType,
      name: image.name,
      size: binary.byteLength,
      vaultPath: image.vaultPath,
      dataUrl: `data:${image.mimeType};base64,${this.encodeBase64(binary)}`,
      persisted: true
    };
  }

  private async update(request: WeixinInboundRequest, change: (state: WeixinConversationState) => void): Promise<void> {
    const path = this.statePath(request);
    const previous = this.queues.get(path) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const state = await this.loadWithoutQueue(path);
      change(state);
      state.updatedAt = new Date().toISOString();
      const next = this.pruneState(state);
      const file = await ensureFile(this.app, path, "");
      await this.app.vault.modify(file, `${JSON.stringify(next, null, 2)}\n`);
    });
    const tracked = operation.catch(() => undefined);
    this.queues.set(path, tracked);
    try {
      await operation;
    } finally {
      if (this.queues.get(path) === tracked) this.queues.delete(path);
    }
  }

  private async loadWithoutQueue(path: string): Promise<WeixinConversationState> {
    const source = await readFile(this.app, path);
    if (!source.trim()) return emptyState();
    try {
      const parsed = JSON.parse(source) as Partial<WeixinConversationState>;
      if (parsed.version !== 1) return emptyState();
      return this.pruneState({
        version: 1,
        updatedAt: String(parsed.updatedAt || new Date(0).toISOString()),
        lastStandaloneQuery: String(parsed.lastStandaloneQuery || "").slice(0, 12_000),
        lastSubstantiveQuery: String(parsed.lastSubstantiveQuery || parsed.lastStandaloneQuery || "").slice(0, 12_000),
        lastSkillIds: Array.isArray(parsed.lastSkillIds) ? parsed.lastSkillIds.map(String).filter(Boolean).slice(0, 8) : [],
        recentImages: Array.isArray(parsed.recentImages)
          ? parsed.recentImages.map((item) => this.normalizeStoredImage(item)).filter((item): item is WeixinStoredImage => Boolean(item))
          : [],
        pendingOperation: this.normalizePendingOperation(parsed.pendingOperation)
      });
    } catch {
      return emptyState();
    }
  }

  private pruneState(state: WeixinConversationState): WeixinConversationState {
    const now = Date.now();
    state.recentImages = state.recentImages
      .filter((item) => Date.parse(item.createdAt) + IMAGE_RETENTION_MS > now)
      .slice(-MAX_STORED_IMAGES);
    if (state.pendingOperation && Date.parse(state.pendingOperation.expiresAt) <= now) state.pendingOperation = null;
    return state;
  }

  private normalizeStoredImage(value: unknown): WeixinStoredImage | null {
    const record = asRecord(value);
    const vaultPath = String(record.vaultPath || "");
    const mimeType = String(record.mimeType || "");
    const createdAt = String(record.createdAt || "");
    if (!vaultPath || !/^image\//iu.test(mimeType) || !Number.isFinite(Date.parse(createdAt))) return null;
    return {
      id: String(record.id || this.stableHash(vaultPath)).slice(0, 80),
      vaultPath,
      mimeType,
      name: String(record.name || "微信图片").slice(0, 160),
      createdAt,
      sourceMessageId: String(record.sourceMessageId || "").slice(0, 300)
    };
  }

  private normalizePendingOperation(value: unknown): WeixinPendingOperation | null {
    const record = asRecord(value);
    if (record.kind !== "link-save") return null;
    const expiresAt = String(record.expiresAt || "");
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) return null;
    return {
      kind: "link-save",
      url: String(record.url || "").slice(0, 2_000),
      title: String(record.title || "").slice(0, 200),
      collection: String(record.collection || "").slice(0, 40),
      createdAt: String(record.createdAt || new Date().toISOString()),
      expiresAt
    };
  }

  private statePath(request: WeixinInboundRequest): string {
    const key = this.stableHash([request.accountId || "default", request.senderId, request.conversationId, request.threadId].join("\u001f"));
    return this.fs.path("Chat", "Weixin", "State", `${key}.json`);
  }

  private safeDate(value: string): string {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  }

  private safeTimestamp(value: string): string {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  private decodeBase64(value: string): ArrayBuffer {
    const decoded = atob(value.replace(/\s+/gu, ""));
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return bytes.buffer;
  }

  private encodeBase64(value: ArrayBuffer): string {
    const bytes = new Uint8Array(value);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      binary += String.fromCharCode(...Array.from(chunk));
    }
    return btoa(binary);
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
