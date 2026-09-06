import type { AiImageUrlContentPart, AiMessage, AiResponse } from "../../ai";
import type { ChatContextBundle } from "../ChatContextService";
import type { AgentCompactionResult } from "./AgentContextCompactor";

export type LifeOSAgentChannel = "desktop" | "weixin";

export type LifeOSAgentStopReason =
  | "completed"
  | "needs-user"
  | "permission-denied"
  | "max-steps"
  | "budget-exhausted"
  | "context-failure"
  | "tool-failure"
  | "model-failure"
  | "aborted";

export type LifeOSAgentEventType =
  | "turn-started"
  | "context-prepared"
  | "skill-routed"
  | "attachment-staged"
  | "attachment-bound"
  | "attachment-referenceable"
  | "plan-created"
  | "tool-started"
  | "tool-completed"
  | "tool-failed"
  | "tool-confirmation-required"
  | "context-compacted"
  | "subagent-started"
  | "subagent-completed"
  | "model-started"
  | "model-streaming"
  | "answer-verified"
  | "memory-state-loaded"
  | "memory-state-saved"
  | "memory-recalled"
  | "memory-extraction-enqueued"
  | "memory-extraction-completed"
  | "turn-completed"
  | "turn-stopped";

export interface LifeOSAgentEvent {
  id: string;
  sessionId: string;
  turnId: string;
  sequence: number;
  timestamp: string;
  channel: LifeOSAgentChannel;
  type: LifeOSAgentEventType;
  summary: string;
  detail?: string;
  toolId?: string;
  callId?: string;
  durationMs?: number;
  metadata?: Record<string, string | number | boolean>;
}

export type LifeOSAgentAttachmentState =
  | "pending"
  | "bound"
  | "consumed"
  | "referenceable"
  | "archived";

export interface LifeOSAgentAttachment {
  id: string;
  sessionId: string;
  sourceMessageId: string;
  state: LifeOSAgentAttachmentState;
  kind: "image" | "file" | "link" | "text";
  name: string;
  mimeType?: string;
  vaultPath?: string;
  createdAt: string;
  updatedAt: string;
  boundTurnId?: string;
  consumedAt?: string;
  lastReferencedAt?: string;
  ordinal: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface LifeOSAgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LifeOSAgentToolResult {
  callId: string;
  toolId: string;
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  cached?: boolean;
  needsConfirmation?: boolean;
  confirmationSummary?: string;
  metadata?: Record<string, string | number | boolean>;
}

export type LifeOSAgentPermissionMode = "read-only" | "confirm" | "explicit-auto";

export interface LifeOSAgentToolExecutionContext {
  channel: LifeOSAgentChannel;
  /** Public conversation identity used by tools, routes, logs, and UI events. */
  sessionId: string;
  /**
   * Internal identity for transient caches and pending confirmations.
   * It includes channel/project/account scope so reusing a public chat id can
   * never confirm or reuse another scope's operation.
   */
  runtimeSessionId?: string;
  turnId: string;
  projectScopeId: string;
  userContent: string;
  context: ChatContextBundle;
  imageParts: AiImageUrlContentPart[];
  permissionMode: LifeOSAgentPermissionMode;
  explicitWriteIntent: boolean;
  signal?: AbortSignal;
}

export interface LifeOSAgentLoopBudget {
  maxSteps: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxContextChars: number;
  maxRepeatedCalls: number;
}

export interface LifeOSAgentLoopResult {
  ok: boolean;
  text: string;
  error?: string;
  response: AiResponse;
  stopReason: LifeOSAgentStopReason;
  events: LifeOSAgentEvent[];
  toolResults: LifeOSAgentToolResult[];
  messages: AiMessage[];
  modelCalls: number;
  toolCalls: number;
  /** Structured state produced by the exact compaction used for this run. */
  compaction?: AgentCompactionResult;
}

export interface LifeOSAgentTaskMemory {
  sessionId: string;
  goal: string;
  currentFocus: string;
  openItems: string[];
  decisions: string[];
  completedItems: string[];
  constraints: string[];
  corrections: string[];
  unresolved: string[];
  nextActions: string[];
  recentTopics: string[];
  lastSummary: string;
  updatedAt: string;
}

export interface LifeOSAgentSkillRoute {
  selectedIds: string[];
  matchedIds: string[];
  confidence: number;
  reason: "explicit" | "named" | "semantic" | "default";
  indexSummary: string;
}
