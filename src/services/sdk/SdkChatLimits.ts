/** Ordinary AI chat budget. Existing users keep their cap until explicitly changed. */
export interface SdkChatLimitSettings { aiChatOutputTokens?: number; aiChatTimeoutSeconds?: number }
export function sdkChatLimits(settings: SdkChatLimitSettings) {
  const output = settings.aiChatOutputTokens ?? 4096, seconds = settings.aiChatTimeoutSeconds ?? 90;
  if (!Number.isSafeInteger(output) || output < 256 || output > 65536 || !Number.isSafeInteger(seconds) || seconds < 30 || seconds > 600) throw Error("SDK_EXECUTION_INVALID_LIMITS");
  return Object.freeze({ maxOutputTokens: output, maxDurationMs: seconds * 1000 });
}
/** Tool-level deadline for one host tool call inside an SDK query (F-01). The
 * whole-turn cap alone cannot stop a single heavy local read (index rebuild) and
 * then discards the entire turn; a bounded tool result keeps the turn usable.
 * Invalid persisted values fall back to the fixed default instead of unbounded. */
export interface SdkToolDeadlineSettings { aiToolTimeoutSeconds?: number }
export const SDK_DEFAULT_TOOL_TIMEOUT_SECONDS = 45;
export function sdkToolTimeoutMs(settings: SdkToolDeadlineSettings = {}): number {
  const seconds = settings.aiToolTimeoutSeconds ?? SDK_DEFAULT_TOOL_TIMEOUT_SECONDS;
  return (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 300 ? SDK_DEFAULT_TOOL_TIMEOUT_SECONDS : seconds) * 1000;
}
