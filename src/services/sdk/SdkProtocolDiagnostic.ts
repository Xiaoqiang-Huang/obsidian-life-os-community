/** Finite, content-free protocol diagnostics. Never accept upstream error text,
 * field names, headers, model output, reasoning or local paths as a diagnostic. */
export const SDK_PROTOCOL_STAGES = ["request-body", "request-convert", "upstream", "response-headers", "response-stream", "response-final", "response-write"] as const;
export interface SdkProtocolFailure { stage: typeof SDK_PROTOCOL_STAGES[number]; code: string; status?: number }
const codes = new Set([
  "SDK_PROTOCOL_UNCLASSIFIED", "SDK_NATIVE_INVALID_JSON", "SDK_NATIVE_INVALID_EVENT", "SDK_NATIVE_UPSTREAM_ERROR", "SDK_NATIVE_AFTER_STOP", "SDK_NATIVE_INCOMPLETE",
  ...["INVALID_CHUNK","INVALID_USAGE","INVALID_IDENTIFIER","STREAM_REQUIRED","INVALID_LIMIT","CLOSED","BYTE_LIMIT","INVALID_UTF8","FRAME_LIMIT","UPSTREAM_ERROR","AFTER_DONE","INVALID_JSON","IDENTITY_CHANGED","DUPLICATE_USAGE","INVALID_CHOICES","AFTER_FINISH","UNSUPPORTED_DELTA","INVALID_ROLE","INVALID_TOOL","INCOMPLETE","INVALID_FINAL","INVALID_EVENT"].map(c=>"SDK_STREAM_"+c),
  ...["EMPTY_RESPONSE","OUTPUT_TRUNCATED","TOOL_FINISH_MISMATCH","INVALID_OBJECT","INVALID_RESPONSE","INVALID_MODEL","INVALID_BUDGET","INVALID_MESSAGES","INVALID_SYSTEM","INVALID_ROLE","INVALID_CONTENT","INVALID_TEXT","INVALID_TOOL","INVALID_USAGE","UNRESOLVED_TOOL","UNKNOWN_TOOL","UNSUPPORTED_RESPONSE","UNSUPPORTED_REASONING","INVALID_REASONING","UNSUPPORTED_FINISH","UNSUPPORTED_CONTENT","UNSUPPORTED_REQUEST","UNSUPPORTED_TOOL","UNSUPPORTED_TOOL_CHOICE","INVALID_SAMPLING","INVALID_STOP","UNSUPPORTED_OUTPUT_CONFIG","STREAM_NOT_IMPLEMENTED"].map(c=>"SDK_WIRE_"+c),
  "SDK_ENVELOPE_UNSUPPORTED", "SDK_REASONING_REPLAY_LIMIT", "SDK_REASONING_REPLAY_INVALID",
  ...["TIMEOUT","ABORTED","INVALID_BODY","INPUT_LIMIT","MODEL_CHANGED","UNSUPPORTED_REQUEST","UPSTREAM_STATUS","INVALID_CONTENT_TYPE","EMPTY_BODY","OUTPUT_LIMIT","UPSTREAM_INVALID","UPSTREAM_CONNECTION"].map(c=>"SDK_BRIDGE_"+c)
]);
export function sdkProtocolFailure(stage: SdkProtocolFailure["stage"], cause: unknown, status?: number): Readonly<SdkProtocolFailure> {
  const raw = cause instanceof Error ? cause.message : "";
  return Object.freeze({ stage: SDK_PROTOCOL_STAGES.includes(stage) ? stage : "upstream", code: codes.has(raw) ? raw : "SDK_PROTOCOL_UNCLASSIFIED",
    ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { status } : {}) });
}
