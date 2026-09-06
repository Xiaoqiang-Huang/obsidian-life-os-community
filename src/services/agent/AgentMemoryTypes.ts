import type { AgentMemoryMode, AgentMemoryScopeMode } from "../../settings";
import type { LifeOSAgentChannel, LifeOSAgentTaskMemory } from "./LifeOSAgentTypes";

export interface AgentMemoryPolicy {
  mode: AgentMemoryMode;
  use: boolean;
  contribute: boolean;
  temporary: boolean;
}

export interface AgentWorkingCheckpoint {
  objective: string;
  activeWork: string;
  decisions: string[];
  constraints: string[];
  corrections: string[];
  unresolved: string[];
  nextActions: string[];
  entities: string[];
  recentTopics: string[];
  evidenceRefs: string[];
}

export interface AgentWorkingMemoryState {
  schemaVersion: 1;
  sessionId: string;
  channel: LifeOSAgentChannel;
  projectScopeId: string;
  accountScopeId?: string;
  policy: AgentMemoryPolicy;
  taskMemory: LifeOSAgentTaskMemory;
  checkpoint: AgentWorkingCheckpoint;
  compressedSummary: string;
  compressedMessageCount: number;
  compressedSourceCount: number;
  lastTurnId: string;
  lastTurnAt: string;
  updatedAt: string;
}

export type AgentMemoryKind =
  | "preference"
  | "fact"
  | "decision"
  | "procedure"
  | "correction"
  | "open-loop"
  | "workflow"
  | "external";

export type AgentMemoryStatus = "candidate" | "confirmed" | "stale" | "superseded" | "forgotten";
export type AgentMemoryAuthority = "generated" | "confirmed" | "external";

export interface AgentMemoryScope {
  projectScopeId?: string;
  channel?: LifeOSAgentChannel;
  accountId?: string;
}

export interface AgentMemoryEvidence {
  sessionId?: string;
  turnId?: string;
  path?: string;
  excerpt: string;
  hash: string;
  capturedAt: string;
}

export interface AgentMemoryRecord {
  id: string;
  kind: AgentMemoryKind;
  title: string;
  content: string;
  keywords: string[];
  scope: AgentMemoryScope;
  status: AgentMemoryStatus;
  authority: AgentMemoryAuthority;
  confidence: number;
  evidence: AgentMemoryEvidence[];
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  supersedes?: string[];
  sourceTool?: string;
}

export interface AgentMemoryCandidate {
  kind: AgentMemoryKind;
  title: string;
  content: string;
  keywords: string[];
  scope: AgentMemoryScope;
  authority?: AgentMemoryAuthority;
  confidence: number;
  evidence: AgentMemoryEvidence[];
  sourceTool?: string;
}

export interface AgentMemoryExtractionJob {
  id: string;
  fingerprint: string;
  sessionId: string;
  turnId: string;
  channel: LifeOSAgentChannel;
  projectScopeId: string;
  accountScopeId?: string;
  userContent: string;
  assistantContent: string;
  toolSummaries: string[];
  status: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  leaseUntil?: string;
  error?: string;
}

export interface AgentSkillSuggestion {
  id: string;
  title: string;
  reason: string;
  examplePrompt: string;
  occurrences: number;
  status: "candidate" | "dismissed" | "created";
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMemoryDiagnostics {
  storeId: string;
  schemaVersion: number;
  recordCount: number;
  candidateCount: number;
  confirmedCount: number;
  staleCount: number;
  forgottenCount: number;
  queuedJobCount: number;
  failedJobCount: number;
  suggestionCount: number;
  externalRecordCount: number;
  workingStateCount: number;
  latestRecordAt: string;
  lastMaintenanceAt: string;
  storePath: string;
  readPath: string;
  lastError?: string;
}

export interface AgentMemoryRecallResult {
  records: AgentMemoryRecord[];
  registryMatches: number;
  queryKeywords: string[];
  scope: AgentMemoryScope;
  prompt: string;
}

export interface AgentMemoryStoreState {
  schemaVersion: 1;
  records: AgentMemoryRecord[];
  jobs: AgentMemoryExtractionJob[];
  skillSuggestions: AgentSkillSuggestion[];
  forgottenFingerprints: string[];
  lastMaintenanceAt: string;
  lastError?: string;
}

export function resolveAgentMemoryPolicy(mode: AgentMemoryMode, globallyEnabled = true): AgentMemoryPolicy {
  if (!globallyEnabled) return { mode: "disabled", use: false, contribute: false, temporary: false };
  if (mode === "temporary") return { mode, use: false, contribute: false, temporary: true };
  if (mode === "disabled") return { mode, use: false, contribute: false, temporary: false };
  if (mode === "use-only") return { mode, use: true, contribute: false, temporary: false };
  return { mode: "standard", use: true, contribute: true, temporary: false };
}

export function buildAgentMemoryScope(
  mode: AgentMemoryScopeMode,
  projectScopeId: string,
  channel: LifeOSAgentChannel,
  accountScopeId?: string
): AgentMemoryScope {
  const scope: AgentMemoryScope = projectScopeId ? { projectScopeId } : {};
  if (mode === "project-channel") scope.channel = channel;
  if (mode === "project-account") scope.accountId = String(accountScopeId || channel).trim() || channel;
  return scope;
}

export function emptyAgentWorkingCheckpoint(): AgentWorkingCheckpoint {
  return {
    objective: "",
    activeWork: "",
    decisions: [],
    constraints: [],
    corrections: [],
    unresolved: [],
    nextActions: [],
    entities: [],
    recentTopics: [],
    evidenceRefs: []
  };
}
