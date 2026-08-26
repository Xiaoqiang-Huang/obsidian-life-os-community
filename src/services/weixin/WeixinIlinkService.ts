import { App, Platform, requestUrl } from "obsidian";
import * as QRCode from "qrcode";
import { formatWeixinPlainTextReply, type WeixinAssistantResponse, type WeixinInboundRequest } from "./WeixinBotLogic";

declare const require: NodeRequire;

const DEFAULT_API_BASE = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "2.4.6";
const ILINK_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const QR_TTL_MS = 5 * 60_000;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;
const SOFT_LONG_POLL_RETRY_DELAY_MS = 250;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 40_000;
const LONG_POLL_TIMEOUT_GRACE_MS = 5_000;
const REGULAR_API_TIMEOUT_MS = 15_000;
const PRESENCE_API_TIMEOUT_MS = 10_000;
const PRESENCE_RETRY_INTERVAL_MS = 15_000;
const PRESENCE_REFRESH_MS = 10 * 60_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 20_000;
const SEND_RETRY_DELAYS_MS = [0, 750, 2_000] as const;
const MAX_RECENT_MESSAGE_IDS = 500;
const MAX_REPLY_CHARS = 1_800;
const MAX_INBOUND_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INBOUND_IMAGES = 4;

export type WeixinConnectionPhase =
  | "unavailable"
  | "disconnected"
  | "requesting-qr"
  | "waiting-scan"
  | "scanned"
  | "verification-required"
  | "connected"
  | "reconnecting"
  | "expired"
  | "error";

export interface WeixinConnectionStatus {
  phase: WeixinConnectionPhase;
  connected: boolean;
  message: string;
  accountId: string;
  userId: string;
  qrDataUrl: string;
  qrExpiresAt: number;
  lastPollAt: number;
  lastInboundAt: number;
  lastReplyAt: number;
  lastError: string;
  accountCount: number;
  accounts: WeixinAccountConnectionStatus[];
}
export interface WeixinAccountConnectionStatus {
  phase: "connected" | "reconnecting" | "expired" | "disconnected" | "error";
  connected: boolean;
  message: string;
  accountId: string;
  userId: string;
  savedAt: string;
  lastPollAt: number;
  lastInboundAt: number;
  lastReplyAt: number;
  lastError: string;
}

export interface WeixinStoredAccount {
  version: 1;
  token: string;
  accountId: string;
  userId: string;
  baseUrl: string;
  savedAt: string;
  getUpdatesBuf: string;
  contextTokens: Record<string, string>;
  recentMessageIds: string[];
}

interface WeixinStoredStateV2 {
  version: 2;
  accounts: WeixinStoredAccount[];
}

type LifeOsTimerHandle = number | ReturnType<typeof globalThis.setTimeout>;

interface LegacyWeixinStoredState extends Partial<WeixinStoredAccount> {
  version?: 1;
}

interface ActiveLogin {
  qrcode: string;
  qrcodeContent: string;
  baseUrl: string;
  startedAt: number;
  verifyCode: string;
}

interface WeixinMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string; playtime?: number };
  file_item?: { file_name?: string; len?: string };
  image_item?: WeixinImageItem;
  video_item?: { media?: WeixinCdnMedia };
  ref_msg?: { title?: string; message_item?: WeixinMessageItem };
}

interface WeixinCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
}

export interface WeixinImageItem {
  media?: WeixinCdnMedia;
  thumb_media?: WeixinCdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface WeixinDownloadedImage {
  dataUrl: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
}

interface WeixinMessage {
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  room_id?: string;
  chat_room_id?: string;
  message_type?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

type StatusListener = (status: WeixinConnectionStatus) => void;

interface WeixinAccountRuntime {
  stored: WeixinStoredAccount;
  monitorGeneration: number;
  longPollTimeoutMs: number;
  lastPresenceAt: number;
  lastPresenceAttemptAt: number;
  presenceInFlight: boolean;
  presenceRetryTimer: LifeOsTimerHandle | null;
  status: WeixinAccountConnectionStatus;
  messageQueues: Map<string, Promise<void>>;
  processingMessageIds: Set<string>;
  preparedMessages: Map<string, WeixinInboundRequest>;
  recoveryStarted: boolean;
  lastRecoveryAt: number;
}

function clean(value: unknown, maxLength = 500): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function scheduleTimer(callback: () => void, ms: number): LifeOsTimerHandle {
  const browserTimer = typeof window !== "undefined" && typeof window.setTimeout === "function"
    ? window.setTimeout.bind(window)
    : null;
  return (browserTimer || globalThis.setTimeout)(callback, ms) as LifeOsTimerHandle;
}

function clearTimer(timer: LifeOsTimerHandle): void {
  if (typeof window !== "undefined" && typeof window.clearTimeout === "function") {
    window.clearTimeout(timer as number);
    return;
  }
  globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => scheduleTimer(resolve, ms));
}

function errorRecords(error: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      records.push(record);
      current = record.cause;
    } else {
      records.push({ message: String(current) });
      break;
    }
  }
  return records;
}

function errorCode(error: unknown): string {
  for (const record of errorRecords(error)) {
    const code = clean(record.code || record.causeCode, 120);
    if (code) return code;
  }
  return "";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  const code = errorCode(error);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/** Long-poll boundaries are expected control flow and must not create a 30 second outage. */
export function isWeixinLongPollSoftTimeout(error: unknown): boolean {
  return errorRecords(error).some((record) => {
    const code = clean(record.code || record.causeCode, 120).toUpperCase();
    const name = clean(record.name || record.causeName, 120).toLowerCase();
    const message = clean(record.message || record.causeMessage, 500).toLowerCase();
    return code === "LIFEOS_WEIXIN_LONG_POLL_TIMEOUT"
      || code === "UND_ERR_HEADERS_TIMEOUT"
      || name === "aborterror"
      || name === "headerstimeouterror"
      || message.includes("headers timeout");
  });
}

function requestTimeoutError(label: string, timeoutMs: number): Error {
  const error = new Error(`${label} 超过 ${Math.ceil(timeoutMs / 1_000)} 秒未返回`) as Error & { code: string };
  error.name = "TimeoutError";
  error.code = label === "getUpdates"
    ? "LIFEOS_WEIXIN_LONG_POLL_TIMEOUT"
    : "LIFEOS_WEIXIN_REQUEST_TIMEOUT";
  return error;
}

async function withRequestTimeout<T>(request: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return request;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = scheduleTimer(() => {
      if (settled) return;
      settled = true;
      reject(requestTimeoutError(label, timeoutMs));
    }, timeoutMs);
    request.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(error);
      }
    );
  });
}

function normalizedLongPollTimeout(value: unknown): number {
  const suggested = Number(value);
  if (!Number.isFinite(suggested) || suggested <= 0) return DEFAULT_LONG_POLL_TIMEOUT_MS;
  return Math.max(15_000, Math.min(65_000, Math.round(suggested) + LONG_POLL_TIMEOUT_GRACE_MS));
}

function reconnectDelayMs(consecutiveFailures: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * (2 ** Math.max(0, consecutiveFailures - 1)));
}

function isNonRetryableWeixinError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "-14" || code === "-2") return true;
  return /HTTP\s+(?:400|401|403|404)\b|登录已失效|session timeout/iu.test(errorMessage(error));
}

function loadDesktopModule<T>(specifier: string): T {
  if (!Platform.isDesktopApp || typeof require !== "function") {
    throw new Error("微信连接仅支持 Obsidian 桌面端");
  }
  return require(specifier) as T;
}

function normalizeStoredAccount(value: unknown): WeixinStoredAccount | null {
  const record = value && typeof value === "object" ? value as Partial<WeixinStoredAccount> : {};
  const token = clean(record.token, 8_000);
  const accountId = clean(record.accountId, 240);
  if (!token || !accountId) return null;
  const contextTokens = record.contextTokens && typeof record.contextTokens === "object"
    ? Object.fromEntries(Object.entries(record.contextTokens).flatMap(([key, item]) => {
      const safeKey = clean(key, 500);
      const safeValue = clean(item, 20_000);
      return safeKey && safeValue ? [[safeKey, safeValue]] : [];
    }).slice(0, 2_000))
    : {};
  return {
    version: 1,
    token,
    accountId,
    userId: clean(record.userId, 240),
    baseUrl: safeApiBase(record.baseUrl),
    savedAt: clean(record.savedAt, 80) || new Date().toISOString(),
    getUpdatesBuf: clean(record.getUpdatesBuf, 1_000_000),
    contextTokens,
    recentMessageIds: Array.isArray(record.recentMessageIds)
      ? record.recentMessageIds.map((item) => clean(item, 300)).filter(Boolean).slice(-MAX_RECENT_MESSAGE_IDS)
      : []
  };
}

/** Migrate the original one-account file and normalize the multi-account v2 file. */
export function normalizeWeixinStoredAccounts(value: unknown): WeixinStoredAccount[] {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const source: unknown[] = Number(record.version) === 2 && Array.isArray(record.accounts)
    ? record.accounts
    : [record];
  const unique = new Map<string, WeixinStoredAccount>();
  source.forEach((item) => {
    const account = normalizeStoredAccount(item);
    if (account) unique.set(account.accountId, account);
  });
  return Array.from(unique.values()).slice(-20);
}

export function upsertWeixinStoredAccount(
  accounts: WeixinStoredAccount[],
  next: WeixinStoredAccount
): WeixinStoredAccount[] {
  const normalized = normalizeStoredAccount(next);
  if (!normalized) return normalizeWeixinStoredAccounts({ version: 2, accounts });
  return [
    ...normalizeWeixinStoredAccounts({ version: 2, accounts }).filter((item) => item.accountId !== normalized.accountId),
    normalized
  ].slice(-20);
}

function safeApiBase(value: unknown, fallback = DEFAULT_API_BASE): string {
  try {
    const parsed = new URL(clean(value, 1_000) || fallback);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !(host === "weixin.qq.com" || host.endsWith(".weixin.qq.com"))) {
      throw new Error("微信服务返回了不受信任的跳转地址");
    }
    return parsed.origin;
  } catch {
    if (fallback !== DEFAULT_API_BASE) return safeApiBase(DEFAULT_API_BASE);
    return DEFAULT_API_BASE;
  }
}

function safeWeixinMediaUrl(value: unknown): string {
  const raw = clean(value, 8_000);
  if (!raw) return "";
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !(host === "weixin.qq.com" || host.endsWith(".weixin.qq.com"))) {
    throw new Error("微信图片使用了不受信任的下载地址");
  }
  return parsed.toString();
}

function mediaDownloadUrl(image: WeixinImageItem): string {
  const fullUrl = clean(image.media?.full_url || image.url, 8_000);
  if (fullUrl) return safeWeixinMediaUrl(fullUrl);
  const query = clean(image.media?.encrypt_query_param, 8_000);
  if (!query) throw new Error("微信图片缺少下载引用");
  return `${DEFAULT_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(query)}`;
}

function imageAesKey(image: WeixinImageItem): Uint8Array | null {
  const bufferModule = loadDesktopModule<typeof import("buffer")>("buffer");
  const BufferCtor = bufferModule.Buffer;
  const rawHex = clean(image.aeskey, 128);
  if (rawHex) {
    if (!/^[0-9a-f]{32}$/iu.test(rawHex)) throw new Error("微信图片 AES 密钥格式无效");
    return BufferCtor.from(rawHex, "hex");
  }
  const encoded = clean(image.media?.aes_key, 500);
  if (!encoded) return null;
  const decoded = BufferCtor.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/iu.test(decoded.toString("ascii"))) {
    return BufferCtor.from(decoded.toString("ascii"), "hex");
  }
  throw new Error("微信图片 AES 密钥长度无效");
}

function detectImageMime(value: Uint8Array): WeixinDownloadedImage["mimeType"] {
  if (value.length >= 8 && value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47) return "image/png";
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return "image/jpeg";
  if (value.length >= 6) {
    const bufferModule = loadDesktopModule<typeof import("buffer")>("buffer");
    const header = bufferModule.Buffer.from(value.subarray(0, 12)).toString("ascii");
    if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
    if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  }
  // iLink currently delivers JPEG most often. Rejecting an otherwise valid
  // decrypted image would make the attachment unusable, so use JPEG as the
  // conservative vision-provider fallback.
  return "image/jpeg";
}

/** Download and decrypt one iLink image into an in-memory vision data URL. */
export async function downloadWeixinImageDataUrl(image: WeixinImageItem): Promise<WeixinDownloadedImage> {
  if (!Platform.isDesktopApp) throw new Error("微信图片读取仅支持 Obsidian 桌面端");
  const response = await withRequestTimeout(
    requestUrl({ url: mediaDownloadUrl(image), method: "GET" }),
    IMAGE_DOWNLOAD_TIMEOUT_MS,
    "微信图片下载"
  );
  if (response.status < 200 || response.status >= 300) throw new Error(`微信图片下载失败：HTTP ${response.status}`);
  const bufferModule = loadDesktopModule<typeof import("buffer")>("buffer");
  const encrypted = bufferModule.Buffer.from(response.arrayBuffer);
  if (encrypted.length === 0) throw new Error("微信图片内容为空");
  if (encrypted.length > MAX_INBOUND_IMAGE_BYTES + 16) throw new Error("微信图片超过 20 MB 限制");
  const key = imageAesKey(image);
  let plain = encrypted;
  if (key) {
    const cryptoModule = loadDesktopModule<typeof import("crypto")>("crypto");
    const decipher = cryptoModule.createDecipheriv("aes-128-ecb", key, null);
    plain = bufferModule.Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
  if (plain.length === 0 || plain.length > MAX_INBOUND_IMAGE_BYTES) throw new Error("微信图片解密后的大小无效");
  const mimeType = detectImageMime(plain);
  return {
    dataUrl: `data:${mimeType};base64,${plain.toString("base64")}`,
    mimeType,
    size: plain.length
  };
}

function randomWechatUin(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value = (((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0;
  return btoa(String(value));
}

function randomClientId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `lifeos-${Date.now()}-${suffix}`;
}

function stableClientId(value: string, purpose = "reply"): string {
  let primary = 2166136261;
  let secondary = 2166136261 ^ 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    primary = Math.imul(primary ^ code, 16777619);
    secondary = Math.imul(secondary ^ code, 2246822519);
  }
  const hash = [primary, secondary]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
  return `lifeos-${purpose}-${hash}`;
}

function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: CHANNEL_VERSION, bot_agent: "LifeOS/0.3.14" };
}

export function splitWeixinReply(value: string): string[] {
  const source = value.trim();
  if (!source) return [];
  const result: string[] = [];
  let remaining = source;
  while (remaining.length > MAX_REPLY_CHARS) {
    const windowText = remaining.slice(0, MAX_REPLY_CHARS + 1);
    const boundary = Math.max(windowText.lastIndexOf("\n\n"), windowText.lastIndexOf("\n"), windowText.lastIndexOf("。"));
    const index = boundary >= Math.floor(MAX_REPLY_CHARS * 0.55) ? boundary + 1 : MAX_REPLY_CHARS;
    result.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) result.push(remaining);
  return result;
}

export function parseWeixinProtocolMessage(message: WeixinMessage, accountId: string): WeixinInboundRequest | null {
  if (message.message_type !== undefined && message.message_type !== 1) return null;
  const senderId = clean(message.from_user_id, 240);
  if (!senderId) return null;
  const textParts: string[] = [];
  const media: Array<Record<string, unknown>> = [];
  (message.item_list || []).forEach((item) => {
    if (item.type === 1 && clean(item.text_item?.text, 100_000)) {
      textParts.push(clean(item.text_item?.text, 100_000));
      if (item.ref_msg?.title) textParts.push(`引用：${clean(item.ref_msg.title, 2_000)}`);
      return;
    }
    if (item.type === 3) {
      const transcript = clean(item.voice_item?.text, 20_000);
      media.push({ type: "语音", transcript, durationMs: Number(item.voice_item?.playtime || 0) });
      if (transcript) textParts.push(transcript);
      return;
    }
    if (item.type === 2) {
      media.push({
        type: "图片",
        width: Number(item.image_item?.thumb_width || 0),
        height: Number(item.image_item?.thumb_height || 0),
        size: Number(item.image_item?.mid_size || item.image_item?.hd_size || 0)
      });
    }
    if (item.type === 4) media.push({ type: "文件", name: clean(item.file_item?.file_name, 240), size: Number(item.file_item?.len || 0) });
    if (item.type === 5) media.push({ type: "视频" });
  });
  const groupId = clean(message.group_id || message.room_id || message.chat_room_id, 240);
  const messageId = clean(message.message_id || message.client_id, 300) || randomClientId();
  return {
    version: 1,
    channel: "weixin",
    messageId,
    accountId: clean(accountId, 240) || "default",
    conversationId: groupId ? `group:${groupId}` : `direct:${senderId}`,
    threadId: clean(message.session_id, 240),
    senderId,
    senderName: "",
    isGroup: Boolean(groupId),
    wasMentioned: false,
    content: textParts.join("\n").trim(),
    timestamp: message.create_time_ms ? new Date(message.create_time_ms).toISOString() : new Date().toISOString(),
    media
  };
}

class WeixinLocalStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private app: App, private pluginId: string) {}

  private fullPath(): string {
    const adapter = this.app.vault.adapter as unknown as { getFullPath?: (path: string) => string };
    if (!Platform.isDesktopApp || typeof adapter.getFullPath !== "function") {
      throw new Error("微信连接仅支持 Obsidian 桌面端");
    }
    const relative = `${this.app.vault.configDir}/plugins/${this.pluginId}/weixin-state.json`;
    return adapter.getFullPath(relative);
  }

  async load(): Promise<WeixinStoredAccount[]> {
    if (!Platform.isDesktopApp) return [];
    try {
      const fs = loadDesktopModule<typeof import("fs/promises")>(["fs", "promises"].join("/"));
      return normalizeWeixinStoredAccounts(JSON.parse(await fs.readFile(this.fullPath(), "utf8")));
    } catch {
      return [];
    }
  }

  async save(accounts: WeixinStoredAccount[]): Promise<void> {
    const state: WeixinStoredStateV2 = {
      version: 2,
      accounts: normalizeWeixinStoredAccounts({ version: 2, accounts })
    };
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    const write = this.writeQueue
      .catch(() => undefined)
      .then(() => this.writeSnapshot(snapshot));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    const fs = loadDesktopModule<typeof import("fs/promises")>(["fs", "promises"].join("/"));
    const path = loadDesktopModule<typeof import("path")>(["pa", "th"].join(""));
    const target = this.fullPath();
    const temp = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(temp, snapshot, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temp, 0o600).catch(() => undefined);
    await fs.rename(temp, target).catch(async (error: unknown) => {
      await fs.unlink(target).catch(() => undefined);
      try {
        await fs.rename(temp, target);
      } catch {
        await fs.unlink(temp).catch(() => undefined);
        throw error;
      }
    });
  }

  async clear(): Promise<void> {
    if (!Platform.isDesktopApp) return;
    await this.writeQueue.catch(() => undefined);
    const fs = loadDesktopModule<typeof import("fs/promises")>(["fs", "promises"].join("/"));
    await fs.unlink(this.fullPath()).catch(() => undefined);
  }
}

export interface WeixinIlinkServiceOptions {
  pluginId: string;
  isEnabled: () => boolean;
  canHydrateMedia?: (request: WeixinInboundRequest) => boolean;
  canAnalyzeImages?: () => boolean;
  /** Persist the inbound request before the iLink cursor is advanced. */
  stageInboundMessage?: (request: WeixinInboundRequest) => Promise<WeixinInboundRequest>;
  handleMessage: (request: WeixinInboundRequest) => Promise<WeixinAssistantResponse>;
  recoverPendingMessages?: (accountId: string) => Promise<Array<{ request: WeixinInboundRequest; response: WeixinAssistantResponse }>>;
  markMessageDelivered?: (request: WeixinInboundRequest) => Promise<void>;
  markMessageDeliveryFailed?: (request: WeixinInboundRequest, error: unknown) => Promise<void>;
}

export class WeixinIlinkService {
  private readonly store: WeixinLocalStore;
  private status: WeixinConnectionStatus = {
    phase: Platform.isDesktopApp ? "disconnected" : "unavailable",
    connected: false,
    message: Platform.isDesktopApp ? "尚未连接微信。" : "微信连接仅支持 Obsidian 桌面端。",
    accountId: "",
    userId: "",
    qrDataUrl: "",
    qrExpiresAt: 0,
    lastPollAt: 0,
    lastInboundAt: 0,
    lastReplyAt: 0,
    lastError: "",
    accountCount: 0,
    accounts: []
  };
  private accounts = new Map<string, WeixinAccountRuntime>();
  private activeLogin: ActiveLogin | null = null;
  private loginGeneration = 0;
  private listeners = new Set<StatusListener>();

  constructor(private app: App, private options: WeixinIlinkServiceOptions) {
    this.store = new WeixinLocalStore(app, options.pluginId);
  }

  getStatus(): WeixinConnectionStatus {
    return { ...this.status, accounts: this.status.accounts.map((account) => ({ ...account })) };
  }

  /** Send a locally scheduled message through one exact connected Weixin account. */
  async sendProactiveText(
    accountId: string,
    recipientId: string,
    conversationId: string,
    text: string,
    clientId: string
  ): Promise<void> {
    const runtime = this.accounts.get(clean(accountId, 240));
    if (!runtime || !runtime.status.connected || !runtime.stored.token) {
      throw new Error("对应微信账号当前未连接，请保持 Obsidian 和微信 Bot 运行。");
    }
    const chunks = splitWeixinReply(formatWeixinPlainTextReply(text));
    for (let index = 0; index < chunks.length; index += 1) {
      await this.sendText(
        runtime,
        clean(recipientId, 240),
        chunks[index],
        runtime.stored.contextTokens[clean(conversationId, 300)] || "",
        `${clean(clientId, 240) || randomClientId()}-${index + 1}`
      );
    }
    this.updateAccountStatus(runtime, {
      lastReplyAt: Date.now(),
      message: "Life OS 已发送主动消息。",
      lastError: ""
    });
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  private updateStatus(patch: Partial<WeixinConnectionStatus>): void {
    const accounts = Array.from(this.accounts.values())
      .map((runtime) => ({ ...runtime.status }))
      .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    this.status = {
      ...this.status,
      ...patch,
      accountCount: accounts.length,
      accounts
    };
    this.listeners.forEach((listener) => listener(this.getStatus()));
  }

  private updateAccountStatus(runtime: WeixinAccountRuntime, patch: Partial<WeixinAccountConnectionStatus>): void {
    runtime.status = { ...runtime.status, ...patch };
    const accounts = Array.from(this.accounts.values());
    const connected = accounts.some((item) => item.status.connected);
    const latest = accounts.sort((a, b) => Date.parse(b.stored.savedAt) - Date.parse(a.stored.savedAt))[0];
    const lastError = accounts.map((item) => item.status.lastError).find(Boolean) || "";
    const hasExpired = accounts.some((item) => item.status.phase === "expired");
    const isReconnecting = accounts.some((item) => item.status.phase === "reconnecting");
    const hasError = accounts.some((item) => item.status.phase === "error");
    this.updateStatus({
      phase: this.activeLogin
        ? this.status.phase
        : connected
          ? "connected"
          : hasExpired
            ? "expired"
            : isReconnecting
              ? "reconnecting"
              : hasError
                ? "error"
                : "disconnected",
      connected,
      accountId: latest?.stored.accountId || "",
      userId: latest?.stored.userId || "",
      message: this.activeLogin
        ? this.status.message
        : connected
          ? `已连接 ${accounts.filter((item) => item.status.connected).length} 个微信 Bot，Life OS 正在等待新消息。`
          : isReconnecting
            ? "微信连接正在自动恢复，无需重新扫码。"
            : accounts.length > 0
              ? "已保存微信账号，但当前没有可用连接。"
              : "尚未连接微信。",
      lastPollAt: Math.max(0, ...accounts.map((item) => item.status.lastPollAt)),
      lastInboundAt: Math.max(0, ...accounts.map((item) => item.status.lastInboundAt)),
      lastReplyAt: Math.max(0, ...accounts.map((item) => item.status.lastReplyAt)),
      lastError
    });
  }

  private createRuntime(stored: WeixinStoredAccount): WeixinAccountRuntime {
    return {
      stored,
      monitorGeneration: 0,
      longPollTimeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
      lastPresenceAt: 0,
      lastPresenceAttemptAt: 0,
      presenceInFlight: false,
      presenceRetryTimer: null,
      status: {
        phase: "disconnected",
        connected: false,
        message: "已保存登录，等待连接。",
        accountId: stored.accountId,
        userId: stored.userId,
        savedAt: stored.savedAt,
        lastPollAt: 0,
        lastInboundAt: 0,
        lastReplyAt: 0,
        lastError: ""
      },
      messageQueues: new Map(),
      processingMessageIds: new Set(),
      preparedMessages: new Map(),
      recoveryStarted: false,
      lastRecoveryAt: 0
    };
  }

  private storedAccounts(): WeixinStoredAccount[] {
    return Array.from(this.accounts.values()).map((runtime) => runtime.stored);
  }

  private async saveAccounts(): Promise<void> {
    const accounts = this.storedAccounts();
    if (accounts.length > 0) await this.store.save(accounts);
    else await this.store.clear();
  }

  private async notifyPresence(
    runtime: WeixinAccountRuntime,
    action: "start" | "stop",
    generation = runtime.monitorGeneration
  ): Promise<boolean> {
    if (action === "start") {
      if (runtime.presenceInFlight) return false;
      runtime.presenceInFlight = true;
      runtime.lastPresenceAttemptAt = Date.now();
    }
    try {
      const response = await this.postJson<{ ret?: number; errcode?: number; errmsg?: string }>(
        runtime.stored.baseUrl,
        action === "start" ? "/ilink/bot/msg/notifystart" : "/ilink/bot/msg/notifystop",
        { base_info: baseInfo() },
        runtime.stored.token,
        PRESENCE_API_TIMEOUT_MS
      );
      const code = Number(response.errcode || response.ret || 0);
      if (code !== 0) {
        const error = new Error(`微信在线状态上报失败：${response.errmsg || code}`) as Error & { code: string };
        error.code = String(code);
        throw error;
      }
      if (
        action === "start"
        && generation === runtime.monitorGeneration
        && this.accounts.get(runtime.stored.accountId) === runtime
        && this.options.isEnabled()
      ) {
        this.clearPresenceRetry(runtime);
        runtime.lastPresenceAt = Date.now();
        this.updateAccountStatus(runtime, {
          phase: "connected",
          connected: true,
          message: "微信在线状态已确认，Life OS 正在等待新消息。",
          lastError: ""
        });
        void this.recoverInboundQueue(runtime);
      } else if (action === "stop") {
        this.clearPresenceRetry(runtime);
        runtime.lastPresenceAt = 0;
      }
      return true;
    } catch (error) {
      const detail = errorMessage(error);
      console.warn(`[Life OS] Weixin notify${action === "start" ? "Start" : "Stop"} failed for ${runtime.stored.accountId}`, detail);
      if (
        action === "start"
        && generation === runtime.monitorGeneration
        && this.accounts.get(runtime.stored.accountId) === runtime
        && runtime.status.lastPollAt === 0
      ) {
        this.updateAccountStatus(runtime, {
          phase: "reconnecting",
          connected: false,
          message: "微信在线状态暂未确认，Life OS 正在自动重试，无需重新扫码。",
          lastError: detail
        });
      }
      if (action === "start") this.schedulePresenceRetry(runtime, generation);
      return false;
    } finally {
      if (action === "start") runtime.presenceInFlight = false;
    }
  }

  private clearPresenceRetry(runtime: WeixinAccountRuntime): void {
    if (runtime.presenceRetryTimer === null) return;
    clearTimer(runtime.presenceRetryTimer);
    runtime.presenceRetryTimer = null;
  }

  private schedulePresenceRetry(runtime: WeixinAccountRuntime, generation: number): void {
    if (runtime.presenceRetryTimer !== null) return;
    runtime.presenceRetryTimer = scheduleTimer(() => {
      runtime.presenceRetryTimer = null;
      if (
        generation !== runtime.monitorGeneration
        || this.accounts.get(runtime.stored.accountId) !== runtime
        || !this.options.isEnabled()
      ) return;
      this.ensurePresence(runtime, generation, true);
    }, PRESENCE_RETRY_INTERVAL_MS);
  }

  private ensurePresence(runtime: WeixinAccountRuntime, generation: number, force = false): void {
    const now = Date.now();
    const missingOrStale = runtime.lastPresenceAt <= 0 || now - runtime.lastPresenceAt >= PRESENCE_REFRESH_MS;
    const retryReady = runtime.lastPresenceAttemptAt <= 0 || now - runtime.lastPresenceAttemptAt >= PRESENCE_RETRY_INTERVAL_MS;
    if (runtime.presenceInFlight || (!force && (!missingOrStale || !retryReady))) return;
    void this.notifyPresence(runtime, "start", generation);
  }

  async initialize(): Promise<WeixinConnectionStatus> {
    if (!Platform.isDesktopApp) return this.getStatus();
    this.stopAllMonitors();
    this.accounts.clear();
    (await this.store.load()).forEach((stored) => this.accounts.set(stored.accountId, this.createRuntime(stored)));
    if (!this.options.isEnabled()) {
      const latest = this.storedAccounts().sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0];
      this.updateStatus({
        phase: "disconnected",
        connected: false,
        accountId: latest?.accountId || "",
        userId: latest?.userId || "",
        message: this.accounts.size > 0
          ? `已保存 ${this.accounts.size} 个微信登录，可启用后继续接收消息。`
          : "尚未连接微信。"
      });
      return this.getStatus();
    }
    if (this.accounts.size > 0) this.startAllMonitors();
    else this.updateStatus({ phase: "disconnected", connected: false, message: "请生成二维码并用微信扫码连接。" });
    return this.getStatus();
  }

  async refresh(): Promise<WeixinConnectionStatus> {
    this.stopAllMonitors();
    this.stopLogin();
    return this.initialize();
  }

  async startLogin(): Promise<WeixinConnectionStatus> {
    if (!Platform.isDesktopApp) throw new Error("微信连接仅支持 Obsidian 桌面端");
    this.stopLogin();
    const generation = ++this.loginGeneration;
    this.activeLogin = null;
    const alreadyConnected = Array.from(this.accounts.values()).some((runtime) => runtime.status.connected);
    this.updateStatus({
      phase: "requesting-qr",
      connected: alreadyConnected,
      qrDataUrl: "",
      qrExpiresAt: 0,
      lastError: "",
      message: this.accounts.size > 0 ? "正在添加另一个微信 Bot…" : "正在向微信申请登录二维码…"
    });
    try {
      const payload = await this.postJson<Record<string, unknown>>(
        DEFAULT_API_BASE,
        "/ilink/bot/get_bot_qrcode?bot_type=3",
        { local_token_list: this.storedAccounts().slice(-10).reverse().map((account) => account.token) }
      );
      if (generation !== this.loginGeneration) return this.getStatus();
      const qrcode = clean(payload.qrcode, 2_000);
      const qrcodeContent = clean(payload.qrcode_img_content, 8_000);
      if (!qrcode || !qrcodeContent) throw new Error("微信没有返回可用的二维码");
      const qrDataUrl = await QRCode.toDataURL(qrcodeContent, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 256,
        color: { dark: "#111827", light: "#ffffff" }
      });
      this.activeLogin = { qrcode, qrcodeContent, baseUrl: DEFAULT_API_BASE, startedAt: Date.now(), verifyCode: "" };
      this.updateStatus({
        phase: "waiting-scan",
        connected: alreadyConnected,
        message: this.accounts.size > 0 ? "请用另一个微信账号扫描二维码。现有账号会继续接收消息。" : "请用手机微信扫描二维码。",
        qrDataUrl,
        qrExpiresAt: Date.now() + QR_TTL_MS
      });
      void this.pollLogin(generation);
      return this.getStatus();
    } catch (error) {
      const message = errorMessage(error);
      this.updateStatus({ phase: "error", connected: alreadyConnected, message: `二维码获取失败：${message}`, lastError: message });
      throw error;
    }
  }

  submitVerificationCode(value: string): void {
    if (!this.activeLogin) throw new Error("当前没有等待验证的微信登录");
    const code = clean(value, 20);
    if (!code) throw new Error("请输入微信显示的验证码");
    this.activeLogin.verifyCode = code;
    this.updateStatus({ phase: "scanned", message: "验证码已提交，正在等待微信确认…", lastError: "" });
  }

  async disconnect(accountId = ""): Promise<void> {
    this.stopLogin();
    if (accountId) {
      const runtime = this.accounts.get(accountId);
      if (runtime) {
        this.stopMonitor(runtime);
        await this.notifyPresence(runtime, "stop");
      }
      this.accounts.delete(accountId);
    } else {
      const runtimes = Array.from(this.accounts.values());
      this.stopAllMonitors();
      await Promise.all(runtimes.map((runtime) => this.notifyPresence(runtime, "stop")));
      this.accounts.clear();
    }
    await this.saveAccounts();
    const remaining = this.accounts.size;
    if (remaining > 0 && this.options.isEnabled()) this.startAllMonitors();
    this.updateStatus({
      phase: remaining > 0 ? "connected" : "disconnected",
      connected: remaining > 0,
      message: remaining > 0 ? `已移除该微信 Bot，剩余 ${remaining} 个账号。` : "微信连接已退出，本地登录令牌已删除。",
      accountId: "",
      userId: "",
      qrDataUrl: "",
      qrExpiresAt: 0,
      lastError: ""
    });
  }

  async stop(): Promise<void> {
    this.stopLogin();
    const runtimes = Array.from(this.accounts.values());
    this.stopAllMonitors();
    await Promise.all(runtimes.map((runtime) => this.notifyPresence(runtime, "stop")));
    this.listeners.clear();
  }

  private stopLogin(): void {
    this.loginGeneration += 1;
    this.activeLogin = null;
  }

  private stopMonitor(runtime: WeixinAccountRuntime): void {
    runtime.monitorGeneration += 1;
    this.clearPresenceRetry(runtime);
    runtime.messageQueues.clear();
    runtime.processingMessageIds.clear();
    runtime.status = { ...runtime.status, connected: false, phase: "disconnected", message: "连接已暂停。" };
  }

  private stopAllMonitors(): void {
    this.accounts.forEach((runtime) => this.stopMonitor(runtime));
  }

  private async pollLogin(generation: number): Promise<void> {
    while (generation === this.loginGeneration && this.activeLogin) {
      if (Date.now() - this.activeLogin.startedAt >= QR_TTL_MS) {
        this.activeLogin = null;
        this.updateStatus({
          phase: "expired",
          connected: Array.from(this.accounts.values()).some((runtime) => runtime.status.connected),
          message: "二维码已过期，请重新生成。现有微信账号不受影响。",
          qrDataUrl: "",
          qrExpiresAt: 0
        });
        return;
      }
      try {
        const verify = this.activeLogin.verifyCode
          ? `&verify_code=${encodeURIComponent(this.activeLogin.verifyCode)}`
          : "";
        const payload = await this.getJson<Record<string, unknown>>(
          this.activeLogin.baseUrl,
          `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(this.activeLogin.qrcode)}${verify}`
        );
        if (generation !== this.loginGeneration || !this.activeLogin) return;
        const status = clean(payload.status, 80).toLowerCase();
        if (status === "scaned" || status === "scanned") {
          this.updateStatus({ phase: "scanned", message: "已扫码，请在手机微信中确认连接。" });
        } else if (status === "scaned_but_redirect") {
          this.activeLogin.baseUrl = safeApiBase(`https://${clean(payload.redirect_host, 500)}`);
          this.updateStatus({ phase: "scanned", message: "已扫码，正在切换到微信登录节点…" });
        } else if (status === "need_verifycode") {
          this.updateStatus({ phase: "verification-required", message: "微信要求输入验证码，请填写后继续。" });
        } else if (status === "verify_code_blocked") {
          this.activeLogin.verifyCode = "";
          this.updateStatus({ phase: "verification-required", message: "验证码错误或暂时受限，请核对后重试。" });
        } else if (status === "confirmed") {
          await this.finishLogin(payload);
          return;
        } else if (status === "binded_redirect") {
          if (this.accounts.size > 0) {
            this.stopLogin();
            this.startAllMonitors();
            this.updateStatus({
              phase: "connected",
              connected: true,
              qrDataUrl: "",
              qrExpiresAt: 0,
              message: `该微信 Bot 已在本机保存，当前共管理 ${this.accounts.size} 个账号。`
            });
            return;
          }
          throw new Error("该微信 Bot 已绑定，但本机没有可用令牌，请重新生成二维码");
        } else if (status === "expired") {
          this.activeLogin = null;
          this.updateStatus({
            phase: "expired",
            connected: Array.from(this.accounts.values()).some((runtime) => runtime.status.connected),
            message: "二维码已过期，请重新生成。现有微信账号不受影响。",
            qrDataUrl: "",
            qrExpiresAt: 0
          });
          return;
        }
      } catch (error) {
        const message = errorMessage(error);
        this.updateStatus({ lastError: message, message: `微信登录状态查询暂时失败，正在重试：${message}` });
      }
      await sleep(1_000);
    }
  }

  private async finishLogin(payload: Record<string, unknown>): Promise<void> {
    const token = clean(payload.bot_token, 8_000);
    const accountId = clean(payload.ilink_bot_id, 240);
    if (!token || !accountId) throw new Error("微信已确认扫码，但登录凭据不完整");
    const stored: WeixinStoredAccount = {
      version: 1,
      token,
      accountId,
      userId: clean(payload.ilink_user_id, 240),
      baseUrl: safeApiBase(payload.baseurl),
      savedAt: new Date().toISOString(),
      getUpdatesBuf: "",
      contextTokens: {},
      recentMessageIds: []
    };
    const existing = this.accounts.get(accountId);
    if (existing) this.stopMonitor(existing);
    const runtime = this.createRuntime(stored);
    this.accounts.set(accountId, runtime);
    await this.saveAccounts();
    this.stopLogin();
    this.updateStatus({
      phase: "connected",
      connected: true,
      message: `微信已连接，当前共管理 ${this.accounts.size} 个微信 Bot。`,
      accountId: stored.accountId,
      userId: stored.userId,
      qrDataUrl: "",
      qrExpiresAt: 0,
      lastError: ""
    });
    this.startMonitor(runtime);
  }

  private startAllMonitors(): void {
    this.accounts.forEach((runtime) => this.startMonitor(runtime));
  }

  private startMonitor(runtime: WeixinAccountRuntime): void {
    if (!this.options.isEnabled() || !Platform.isDesktopApp) return;
    const generation = ++runtime.monitorGeneration;
    this.updateAccountStatus(runtime, {
      phase: "reconnecting",
      connected: false,
      message: "正在恢复微信连接并确认在线状态…",
      lastError: ""
    });
    this.ensurePresence(runtime, generation, true);
    void this.monitorLoop(runtime, generation);
  }

  private async monitorLoop(runtime: WeixinAccountRuntime, generation: number): Promise<void> {
    let consecutiveFailures = 0;
    while (
      generation === runtime.monitorGeneration
      && this.accounts.get(runtime.stored.accountId) === runtime
      && this.options.isEnabled()
    ) {
      try {
        const pollStartedAt = Date.now();
        const response = await this.postJson<GetUpdatesResponse>(
          runtime.stored.baseUrl,
          "/ilink/bot/getupdates",
          { get_updates_buf: runtime.stored.getUpdatesBuf || "", base_info: baseInfo() },
          runtime.stored.token,
          runtime.longPollTimeoutMs
        );
        if (generation !== runtime.monitorGeneration || this.accounts.get(runtime.stored.accountId) !== runtime) return;
        const code = Number(response.errcode || response.ret || 0);
        if (code !== 0) {
          if (code === -14 || code === -2) {
            runtime.monitorGeneration += 1;
            this.updateAccountStatus(runtime, {
              phase: "expired",
              connected: false,
              message: "该微信登录已失效，请移除后重新扫码连接。",
              lastError: response.errmsg || String(code)
            });
            return;
          }
          throw new Error(`微信 getupdates 返回 ${code}${response.errmsg ? `：${response.errmsg}` : ""}`);
        }
        const recoveredFromFailure = consecutiveFailures > 0;
        consecutiveFailures = 0;
        runtime.longPollTimeoutMs = normalizedLongPollTimeout(response.longpolling_timeout_ms);
        const nextUpdatesBuf = response.get_updates_buf !== undefined
          ? clean(response.get_updates_buf, 1_000_000)
          : runtime.stored.getUpdatesBuf;
        this.updateAccountStatus(runtime, {
          lastPollAt: Date.now(),
          phase: "connected",
          connected: true,
          message: "微信已连接，Life OS 正在等待新消息。",
          lastError: ""
        });
        void this.recoverInboundQueue(runtime);
        const inboundMessages = response.msgs || [];
        // The durable inbox must exist before advancing get_updates_buf. AI
        // processing remains asynchronous, so long polling is not blocked by
        // a slow model response.
        await Promise.all(inboundMessages.map((message) => this.prepareInboundForQueue(runtime, message)));
        inboundMessages.forEach((message) => {
          void this.enqueueMessage(runtime, message);
        });
        if (generation !== runtime.monitorGeneration || this.accounts.get(runtime.stored.accountId) !== runtime) return;
        if (nextUpdatesBuf !== runtime.stored.getUpdatesBuf) {
          runtime.stored.getUpdatesBuf = nextUpdatesBuf;
          await this.saveAccounts().catch((error) => {
            const detail = errorMessage(error);
            console.error(`[Life OS] Weixin cursor persistence failed for ${runtime.stored.accountId}`, detail);
            this.updateAccountStatus(runtime, { lastError: `同步游标保存失败：${detail}` });
          });
        }
        this.ensurePresence(runtime, generation, recoveredFromFailure);
        if ((response.msgs || []).length === 0) {
          const elapsed = Date.now() - pollStartedAt;
          const minimumCycleMs = response.longpolling_timeout_ms ? 250 : 500;
          if (elapsed < minimumCycleMs) await sleep(minimumCycleMs - elapsed);
        }
      } catch (error) {
        if (generation !== runtime.monitorGeneration || this.accounts.get(runtime.stored.accountId) !== runtime) return;
        if (isWeixinLongPollSoftTimeout(error)) {
          consecutiveFailures = 0;
          this.updateAccountStatus(runtime, {
            lastPollAt: Date.now(),
            phase: "connected",
            connected: true,
            message: "微信长轮询已续订，Life OS 正在等待新消息。",
            lastError: ""
          });
          this.ensurePresence(runtime, generation);
          await sleep(SOFT_LONG_POLL_RETRY_DELAY_MS);
          continue;
        }
        consecutiveFailures += 1;
        const message = errorMessage(error);
        this.updateAccountStatus(runtime, {
          phase: "reconnecting",
          connected: runtime.status.connected && consecutiveFailures < 3,
          message: consecutiveFailures >= 3
            ? "微信连接暂时不稳定，Life OS 将持续自动重连，无需重新扫码。"
            : "微信连接暂时中断，正在快速重试…",
          lastError: message
        });
        await sleep(reconnectDelayMs(consecutiveFailures));
      }
    }
  }

  private enqueueMessage(
    runtime: WeixinAccountRuntime,
    message: WeixinMessage
  ): Promise<void> {
    const queueKey = clean(message.group_id || message.room_id || message.chat_room_id || message.from_user_id, 240) || "unknown";
    const queueId = clean(message.message_id || message.client_id, 300);
    if (
      queueId
      && (runtime.processingMessageIds.has(queueId) || runtime.stored.recentMessageIds.includes(queueId))
    ) {
      return Promise.resolve();
    }
    if (queueId) runtime.processingMessageIds.add(queueId);
    const previous = runtime.messageQueues.get(queueKey) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.processMessage(runtime, message))
      .catch((error) => {
        const detail = errorMessage(error);
        console.error(`[Life OS] Weixin message processing failed for ${runtime.stored.accountId}`, detail);
        if (this.accounts.get(runtime.stored.accountId) === runtime) {
          this.updateAccountStatus(runtime, {
            message: "微信连接正常，但上一条消息处理失败；后续消息仍可继续使用。",
            lastError: `消息处理失败：${detail}`
          });
        }
      })
      .finally(() => {
        if (queueId) runtime.processingMessageIds.delete(queueId);
        if (runtime.messageQueues.get(queueKey) === next) runtime.messageQueues.delete(queueKey);
      });
    runtime.messageQueues.set(queueKey, next);
    return next;
  }

  private async hydrateInboundImages(message: WeixinMessage, inbound: WeixinInboundRequest): Promise<void> {
    const imageItems = (message.item_list || []).filter((item) => item.type === 2 && item.image_item);
    if (imageItems.length > 0 && this.options.canHydrateMedia && !this.options.canHydrateMedia(inbound)) return;
    const imageMedia = inbound.media.filter((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return record.type === "图片";
    }) as Array<Record<string, unknown>>;
    if (imageItems.length > 0 && this.options.canAnalyzeImages && !this.options.canAnalyzeImages()) {
      imageMedia.forEach((target) => {
        target.error = "图片视觉分析尚未启用，或尚未配置视觉模型";
      });
      return;
    }
    let totalBytes = 0;
    for (let index = 0; index < imageItems.length; index += 1) {
      const target = imageMedia[index];
      if (!target) continue;
      if (index >= MAX_INBOUND_IMAGES) {
        target.error = `一次最多识别 ${MAX_INBOUND_IMAGES} 张图片`;
        continue;
      }
      try {
        const image = await downloadWeixinImageDataUrl(imageItems[index].image_item!);
        totalBytes += image.size;
        if (totalBytes > MAX_INBOUND_IMAGE_BYTES * 2) {
          target.error = "本条消息的图片总量超过 40 MB 限制";
          continue;
        }
        target.dataUrl = image.dataUrl;
        target.mimeType = image.mimeType;
        target.size = image.size;
      } catch (error) {
        const detail = errorMessage(error)
          .replace(/https?:\/\/\S+/giu, "微信 CDN")
          .slice(0, 300);
        target.error = `图片读取失败：${detail}`;
        console.warn("[Life OS] Weixin image download/decrypt failed", detail);
      }
    }
  }

  private async prepareInboundForQueue(
    runtime: WeixinAccountRuntime,
    message: WeixinMessage
  ): Promise<void> {
    const inbound = parseWeixinProtocolMessage(message, runtime.stored.accountId);
    if (!inbound || (!inbound.content && inbound.media.length === 0)) return;
    const queueId = inbound.messageId;
    if (
      runtime.preparedMessages.has(queueId)
      || runtime.processingMessageIds.has(queueId)
      || runtime.stored.recentMessageIds.includes(queueId)
    ) return;
    await this.hydrateInboundImages(message, inbound);
    if (message.context_token) {
      runtime.stored.contextTokens[inbound.conversationId] = clean(message.context_token, 20_000);
    }
    const prepared = this.options.stageInboundMessage
      ? await this.options.stageInboundMessage(inbound)
      : inbound;
    runtime.preparedMessages.set(queueId, prepared);
  }

  private async processMessage(
    runtime: WeixinAccountRuntime,
    message: WeixinMessage
  ): Promise<void> {
    if (this.accounts.get(runtime.stored.accountId) !== runtime) return;
    const messageId = clean(message.message_id || message.client_id, 300);
    const prepared = runtime.preparedMessages.get(messageId);
    const inbound = prepared || parseWeixinProtocolMessage(message, runtime.stored.accountId);
    if (!inbound || (!inbound.content && inbound.media.length === 0)) return;
    if (runtime.stored.recentMessageIds.includes(inbound.messageId)) {
      runtime.preparedMessages.delete(inbound.messageId);
      return;
    }
    runtime.preparedMessages.delete(inbound.messageId);
    if (!prepared) await this.hydrateInboundImages(message, inbound);
    const contextKey = inbound.conversationId;
    if (message.context_token) runtime.stored.contextTokens[contextKey] = clean(message.context_token, 20_000);
    this.updateAccountStatus(runtime, {
      lastInboundAt: Date.now(),
      message: inbound.media.some((item) => Boolean((item as Record<string, unknown>)?.dataUrl))
        ? "收到微信图片，Life OS 正在调用视觉模型…"
        : "收到微信消息，Life OS 正在生成回复…"
    });
    try {
      const result = await this.options.handleMessage(inbound);
      if (this.accounts.get(runtime.stored.accountId) !== runtime) return;
      const reply = formatWeixinPlainTextReply(result.reply) || "处理完成。";
      const chunks = splitWeixinReply(reply);
      for (let index = 0; index < chunks.length; index += 1) {
        await this.sendText(
          runtime,
          inbound.senderId,
          chunks[index],
          runtime.stored.contextTokens[contextKey],
          stableClientId(`${runtime.stored.accountId}\u001f${inbound.messageId}\u001f${index + 1}`)
        );
      }
      runtime.stored.recentMessageIds = [...runtime.stored.recentMessageIds, inbound.messageId].slice(-MAX_RECENT_MESSAGE_IDS);
      await this.saveAccounts().catch((error) => {
        console.warn(`[Life OS] Weixin account cursor persistence failed for ${runtime.stored.accountId}`, errorMessage(error));
      });
      await this.options.markMessageDelivered?.(inbound).catch((error) => {
        console.warn(`[Life OS] Weixin durable delivery acknowledgement failed for ${inbound.messageId}`, errorMessage(error));
      });
      this.updateAccountStatus(runtime, {
        lastReplyAt: Date.now(),
        message: "回复已发送，Life OS 正在等待新消息。",
        lastError: ""
      });
    } catch (error) {
      await this.options.markMessageDeliveryFailed?.(inbound, error).catch(() => undefined);
      const detail = formatWeixinPlainTextReply(errorMessage(error));
      await this.sendText(
        runtime,
        inbound.senderId,
        `Life OS 处理失败：${detail}`,
        runtime.stored.contextTokens[contextKey]
      ).catch(() => undefined);
      throw error;
    }
  }

  private async recoverInboundQueue(runtime: WeixinAccountRuntime): Promise<void> {
    const now = Date.now();
    if (
      runtime.recoveryStarted
      || now - runtime.lastRecoveryAt < 30_000
      || !this.options.recoverPendingMessages
    ) return;
    runtime.recoveryStarted = true;
    runtime.lastRecoveryAt = now;
    try {
      const pending = await this.options.recoverPendingMessages(runtime.stored.accountId);
      for (const item of pending) {
        if (this.accounts.get(runtime.stored.accountId) !== runtime || !runtime.status.connected) return;
        if (runtime.stored.recentMessageIds.includes(item.request.messageId)) {
          await this.options.markMessageDelivered?.(item.request);
          continue;
        }
        try {
          const reply = formatWeixinPlainTextReply(item.response.reply) || "处理完成。";
          const chunks = splitWeixinReply(reply);
          for (let index = 0; index < chunks.length; index += 1) {
            await this.sendText(
              runtime,
              item.request.senderId,
              chunks[index],
              runtime.stored.contextTokens[item.request.conversationId] || "",
              stableClientId(`${runtime.stored.accountId}\u001f${item.request.messageId}\u001f${index + 1}`)
            );
          }
          runtime.stored.recentMessageIds = [...runtime.stored.recentMessageIds, item.request.messageId]
            .slice(-MAX_RECENT_MESSAGE_IDS);
          await this.saveAccounts();
          await this.options.markMessageDelivered?.(item.request);
        } catch (error) {
          await this.options.markMessageDeliveryFailed?.(item.request, error).catch(() => undefined);
          console.warn(`[Life OS] Weixin recovered message delivery failed for ${item.request.messageId}`, errorMessage(error));
        }
      }
    } catch (error) {
      console.warn(`[Life OS] Weixin durable inbox recovery failed for ${runtime.stored.accountId}`, errorMessage(error));
    } finally {
      runtime.recoveryStarted = false;
    }
  }

  private async sendText(
    runtime: WeixinAccountRuntime,
    to: string,
    text: string,
    contextToken = "",
    clientId = ""
  ): Promise<void> {
    const plainText = formatWeixinPlainTextReply(text);
    if (!plainText) return;
    const outboundClientId = clientId || randomClientId();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SEND_RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await sleep(SEND_RETRY_DELAYS_MS[attempt]);
      try {
        const response = await this.postJson<{ ret?: number; errcode?: number; errmsg?: string }>(
          runtime.stored.baseUrl,
          "/ilink/bot/sendmessage",
          {
            msg: {
              from_user_id: "",
              to_user_id: to,
              client_id: outboundClientId,
              message_type: 2,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text: plainText } }],
              context_token: contextToken || undefined
            },
            base_info: baseInfo()
          },
          runtime.stored.token,
          REGULAR_API_TIMEOUT_MS
        );
        const code = Number(response.errcode || response.ret || 0);
        if (code !== 0) {
          const error = new Error(`微信发送失败：${response.errmsg || code}`) as Error & { code: string };
          error.code = String(code);
          throw error;
        }
        return;
      } catch (error) {
        lastError = error;
        if (isNonRetryableWeixinError(error) || attempt === SEND_RETRY_DELAYS_MS.length - 1) break;
        if (this.accounts.get(runtime.stored.accountId) === runtime) {
          this.updateAccountStatus(runtime, {
            message: `微信回复发送出现波动，正在进行第 ${attempt + 2} 次投递…`,
            lastError: errorMessage(error)
          });
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
  }
  private commonHeaders(): Record<string, string> {
    return {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": ILINK_CLIENT_VERSION
    };
  }

  private async getJson<T>(baseUrl: string, endpoint: string, timeoutMs = REGULAR_API_TIMEOUT_MS): Promise<T> {
    const response = await withRequestTimeout(requestUrl({
      url: new URL(endpoint, `${safeApiBase(baseUrl)}/`).toString(),
      method: "GET",
      headers: this.commonHeaders()
    }), timeoutMs, endpoint);
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return response.json as T;
  }

  private async postJson<T>(
    baseUrl: string,
    endpoint: string,
    body: unknown,
    token = "",
    timeoutMs = REGULAR_API_TIMEOUT_MS
  ): Promise<T> {
    const response = await withRequestTimeout(requestUrl({
      url: new URL(endpoint, `${safeApiBase(baseUrl)}/`).toString(),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": randomWechatUin(),
        ...this.commonHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    }), timeoutMs, endpoint.includes("/getupdates") ? "getUpdates" : endpoint);
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return response.json as T;
  }
}
