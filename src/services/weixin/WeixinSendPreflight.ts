export const WEIXIN_SESSION_REFRESH_HINT = "请先在微信给 bot 发一条消息刷新会话，然后再试。";
export const WEIXIN_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type WeixinPreflightCode = "ok" | "missing-token" | "stale-token" | "prepare-failed" | "send-failed";

export interface WeixinPreflightInput {
  token?: string;
  lastInboundAt?: number;
  freshToken?: boolean;
  now?: number;
  maxAgeMs?: number;
}

export interface WeixinPreflightResult {
  ok: boolean;
  code: WeixinPreflightCode;
  hint?: string;
  ageMs?: number;
}

export function preflightWeixinSend(input: WeixinPreflightInput): WeixinPreflightResult {
  const token = String(input.token || "").trim();
  const now = Number(input.now ?? Date.now());
  const maxAgeMs = Number(input.maxAgeMs ?? WEIXIN_TOKEN_MAX_AGE_MS);
  if (input.freshToken) return { ok: true, code: "ok", ageMs: 0 };
  if (!token) return { ok: false, code: "missing-token", hint: WEIXIN_SESSION_REFRESH_HINT };
  const lastInboundAt = Number(input.lastInboundAt || 0);
  if (lastInboundAt > 0) {
    const ageMs = Math.max(0, now - lastInboundAt);
    if (ageMs > maxAgeMs) return { ok: false, code: "stale-token", hint: WEIXIN_SESSION_REFRESH_HINT, ageMs };
    return { ok: true, code: "ok", ageMs };
  }
  return { ok: true, code: "ok" };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || "";
  return String(error ?? "");
}

export function mapWeixinSendError(error: unknown): WeixinPreflightResult {
  const text = errorText(error);
  if (/prepare failed/iu.test(text) || /context[_ -]?token/iu.test(text)) {
    return { ok: false, code: "prepare-failed", hint: WEIXIN_SESSION_REFRESH_HINT };
  }
  return { ok: false, code: "send-failed", hint: "微信发送失败，请稍后重试。" };
}

export function shouldRetryWeixinSend(error: unknown): boolean {
  return mapWeixinSendError(error).code !== "prepare-failed";
}
