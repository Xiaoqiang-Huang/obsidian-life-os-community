export const AI_WORKSPACE_NATIVE_TOOLS = [
  "codex",
  "claude",
  "opencode",
  "codebuddy",
  "workbuddy",
  "pi"
] as const;
export const AI_WORKSPACE_EXPORT_TOOLS = [
  "cursor",
  "windsurf",
  "gemini-cli",
  "github-copilot",
  "kiro",
  "aider",
  "qwen-code",
  "trae",
  "tongyi-lingma",
  "cline",
  "roo-code",
  "continue"
] as const;
export const AI_WORKSPACE_TOOLS = [
  ...AI_WORKSPACE_NATIVE_TOOLS,
  ...AI_WORKSPACE_EXPORT_TOOLS,
  "web"
] as const;
export const AI_WORKSPACE_DESKTOP_TOOLS = [
  ...AI_WORKSPACE_NATIVE_TOOLS,
  ...AI_WORKSPACE_EXPORT_TOOLS
] as const;

export type AiWorkspaceTool = typeof AI_WORKSPACE_TOOLS[number];
export type AiWorkspaceAgentPermission = "read-only" | "workspace-write" | "project-write" | "full";
export type AiWorkspaceSessionLifecycle = "active" | "done" | "paused" | "stale";
export type AiWorkspaceMessageRole = "user" | "assistant" | "tool";
export type AiWorkspaceImportStatus = "new" | "duplicate" | "append" | "conflict";
export type AiWorkspaceDailyFactStatus = "pending" | "confirmed" | "dismissed";
export type AiWorkspaceProjectMemoryScope = AiWorkspaceTool | "shared";
export type AiWorkspaceTrackingStatus =
  | "watching"
  | "up-to-date"
  | "updated"
  | "needs-review"
  | "source-missing"
  | "error";

export interface AiWorkspaceToolSource {
  tool: AiWorkspaceTool;
  enabled: boolean;
  sourcePath: string;
  executable?: string;
}

export interface AiWorkspaceProjectBinding {
  projectId: string;
  workDirectories: string[];
  tools: AiWorkspaceToolSource[];
  updatedAt: string;
}

export interface AiWorkspaceSourceCandidate {
  key: string;
  tool: AiWorkspaceTool;
  sourceSessionId: string;
  sourcePath: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  size: number;
  fingerprint: string;
  matchedProjectIds: string[];
  parentSessionId?: string;
  model?: string;
  sourcePlatform?: string;
  sourceUrl?: string;
  sourceKind: "jsonl" | "sqlite" | "export-json" | "browser-capture";
  scanWarning?: string;
}

export interface AiWorkspaceFileReference {
  path: string;
  line?: number;
  kind?: "read" | "write" | "patch" | "reference";
}

export interface AiWorkspaceMessage {
  id: string;
  sourceId: string;
  parentId?: string;
  role: AiWorkspaceMessageRole;
  content: string;
  timestamp: string;
  sequence: number;
  kind: "message" | "tool";
  toolName?: string;
  fileReferences: AiWorkspaceFileReference[];
  important: boolean;
  contentHash: string;
}

export interface AiWorkspaceNodeIndex {
  id: string;
  parentId?: string;
  role: AiWorkspaceMessageRole;
  timestamp: string;
  sequence: number;
  kind: "message" | "tool";
  preview: string;
  summary?: string;
  important: boolean;
  fileReferences: AiWorkspaceFileReference[];
  chunk: number;
  offset: number;
  contentHash: string;
}

export interface AiWorkspaceSessionAnalysis {
  summary: string;
  outline: Array<{ nodeId: string; title: string; description: string }>;
  conclusions: Array<{ text: string; nodeIds: string[]; status?: "candidate" | "confirmed" | "dismissed" }>;
  tasks: Array<{ text: string; nodeIds: string[]; status: "candidate" | "confirmed" | "dismissed" }>;
  promptCandidates: Array<{ title: string; body: string; nodeIds: string[] }>;
  generatedAt: string;
  method: "rules" | "ai";
}

export interface AiWorkspaceActivitySummary {
  revisionId: string;
  date: string;
  headline: string;
  summary: string;
  progress: string;
  completed: string[];
  decisions: string[];
  problems: string[];
  nextActions: string[];
  sourceNodeIds: string[];
  generatedAt: string;
  method: "rules" | "ai";
}

export type AiWorkspaceHandoffGenerationMethod = "rules" | "ai" | "local-tool";

export interface AiWorkspaceHandoffSnapshot {
  revisionId: string;
  method: AiWorkspaceHandoffGenerationMethod;
  generatedAt: string;
  documentPath: string;
  markdownPath: string;
}

export interface AiWorkspaceSessionTracking {
  enabled: boolean;
  sourceKind: AiWorkspaceSourceCandidate["sourceKind"];
  options: AiWorkspaceImportOptions;
  status: AiWorkspaceTrackingStatus;
  lastCheckedAt?: string;
  lastUpdatedAt?: string;
  message?: string;
}

export interface AiWorkspaceRevisionSummary {
  id: string;
  number: number;
  createdAt: string;
  sourceFingerprint: string;
  messageCount: number;
  reason: "initial" | "append" | "conflict";
  manifestPath: string;
}

export interface AiWorkspaceSessionSummary {
  id: string;
  projectId: string;
  tool: AiWorkspaceTool;
  sourceSessionId: string;
  sourcePath: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  importedAt: string;
  model?: string;
  sourcePlatform?: string;
  sourceUrl?: string;
  parentSessionId?: string;
  lifecycle: AiWorkspaceSessionLifecycle;
  currentRevisionId: string;
  revisions: AiWorkspaceRevisionSummary[];
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  fileReferences: AiWorkspaceFileReference[];
  notePath: string;
  rawSnapshotPath?: string;
  analysis: AiWorkspaceSessionAnalysis;
  activity?: AiWorkspaceActivitySummary;
  handoff?: AiWorkspaceHandoffSnapshot;
  tracking: AiWorkspaceSessionTracking;
}

export interface AiWorkspaceRevisionManifest {
  schemaVersion: 1;
  sessionId: string;
  revisionId: string;
  projectId: string;
  tool: AiWorkspaceTool;
  sourceSessionId: string;
  sourcePath: string;
  sourceFingerprint: string;
  sourcePlatform?: string;
  sourceUrl?: string;
  importedAt: string;
  nodes: AiWorkspaceNodeIndex[];
  chunks: string[];
}

export interface AiWorkspaceDailyFact {
  id: string;
  projectId: string;
  sessionId: string;
  date: string;
  text: string;
  sourceNodeIds: string[];
  status: AiWorkspaceDailyFactStatus;
  createdAt: string;
  updatedAt?: string;
  revisionId?: string;
  generatedBy?: "rules" | "ai";
  confirmedAt?: string;
}

export interface AiWorkspacePromptAsset {
  id: string;
  title: string;
  scope: "global" | "project";
  projectId?: string;
  tool: AiWorkspaceTool | "any";
  tags: string[];
  currentVersion: number;
  versionPaths: string[];
  usageCount: number;
  lastUsedAt?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  sourceSessionId?: string;
  sourceNodeIds?: string[];
}

export interface AiWorkspaceProjectMemoryCandidate {
  scope: AiWorkspaceProjectMemoryScope;
  sourcePath: string;
  relativePath: string;
  content: string;
  contentHash: string;
  size: number;
  sourceModifiedAt: string;
}

export interface AiWorkspaceProjectMemoryAsset {
  id: string;
  projectId: string;
  scope: AiWorkspaceProjectMemoryScope;
  sourcePath: string;
  relativePath: string;
  contentHash: string;
  size: number;
  sourceModifiedAt: string;
  capturedAt: string;
  currentVersion: number;
  versionPaths: string[];
  status: "active" | "missing";
}

export interface AiWorkspaceState {
  schemaVersion: 1;
  bindings: AiWorkspaceProjectBinding[];
  sessions: AiWorkspaceSessionSummary[];
  rejectedSourceKeys: string[];
  dailyFacts: AiWorkspaceDailyFact[];
  prompts: AiWorkspacePromptAsset[];
  projectMemories: AiWorkspaceProjectMemoryAsset[];
  agentPermission: AiWorkspaceAgentPermission;
  lastScanAt?: string;
}

export interface AiWorkspaceImportOptions {
  includeToolCalls: boolean;
  includeFileReferences: boolean;
  includeProjectMemory: boolean;
  includeToolMemory: boolean;
  retainRawSnapshot: boolean;
  redactSecrets: boolean;
}

export interface AiWorkspaceParsedSession {
  source: AiWorkspaceSourceCandidate;
  messages: AiWorkspaceMessage[];
  fileReferences: AiWorkspaceFileReference[];
  ruleAnalysis: AiWorkspaceSessionAnalysis;
}

export interface AiWorkspacePreparedImport {
  candidate: AiWorkspaceSourceCandidate;
  projectId: string;
  status: AiWorkspaceImportStatus;
  parsed: AiWorkspaceParsedSession;
  existingSessionId?: string;
  overlapCount: number;
  newMessageCount: number;
  changedMessageCount: number;
}

export interface AiWorkspaceImportResult {
  session: AiWorkspaceSessionSummary;
  status: AiWorkspaceImportStatus;
  revisionId: string;
  appendedMessages: number;
  skippedMessages: number;
}

/**
 * Emitted as soon as a browser conversation has been validated and durably
 * written to the project Inbox. Indexing, revision generation, memories and
 * daily activity analysis may continue after this point.
 */
export interface AiWorkspaceBrowserCaptureProgress {
  phase: "staged";
  inboxPath: string;
  title: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
}

export interface AiWorkspaceContinuationPackage {
  session: AiWorkspaceSessionSummary;
  revision: AiWorkspaceRevisionSummary;
  mode: "summary" | "outline" | "full";
  scope: "session" | "project";
  targetTool: AiWorkspaceTool;
  markdown: string;
  exportPath: string;
  bundleRoot: string;
  launchPrompt: string;
  files: {
    startHere: string;
    protocol: string;
    handoff: string;
    projectMemory: string;
    sourceIndex: string;
  };
}

export interface AiWorkspaceLocalHandoffRequest {
  sessionId: string;
  revisionId: string;
  tool: AiWorkspaceTool;
  requestPath: string;
  outputPath: string;
  prompt: string;
}

export interface AiWorkspaceOpenResult {
  opened: boolean;
  method: "direct" | "terminal" | "clipboard" | "export";
  message: string;
}

export interface AiWorkspaceAutoSyncReport {
  checked: number;
  updated: number;
  appendedMessages: number;
  needsReview: number;
  errors: number;
  results: AiWorkspaceImportResult[];
}

export type HandoffEvidenceSourceType =
  | "session-node"
  | "project-memory"
  | "file"
  | "command";

export interface HandoffEvidenceRef {
  id: string;
  sourceType: HandoffEvidenceSourceType;
  sourceId: string;
  nodeId?: string;
  sequence?: number;
  role?: AiWorkspaceMessageRole;
  timestamp?: string;
  excerpt: string;
  contentHash?: string;
  part?: number;
  partCount?: number;
}

export type HandoffWorkItemStatus =
  | "verified"
  | "claimed"
  | "partial"
  | "pending"
  | "blocked"
  | "unknown";

export interface HandoffWorkItem {
  id: string;
  title: string;
  status: HandoffWorkItemStatus;
  summary: string;
  evidence: HandoffEvidenceRef[];
  acceptanceCriteria: string[];
}

export interface HandoffDeliverable {
  id: string;
  name: string;
  path?: string;
  purpose: string;
  status: HandoffWorkItemStatus;
  evidence: HandoffEvidenceRef[];
}

export interface HandoffFailedAttempt {
  id: string;
  approach: string;
  outcome: string;
  reason: string;
  lesson: string;
  evidence: HandoffEvidenceRef[];
}

export interface HandoffNextAction {
  id: string;
  action: string;
  target: string;
  expectedResult: string;
  acceptanceCriteria: string;
  evidence: HandoffEvidenceRef[];
}

export interface HandoffQualityReport {
  score: number;
  passed: boolean;
  nodeCoverage: number;
  citationCoverage: number;
  warnings: string[];
  errors: string[];
  repairCount: number;
  missingNodeIds: string[];
}

export interface HandoffSourceRevision {
  revisionId: string;
  nodeCount: number;
  compiledAt: string;
  cacheKey: string;
}

export interface HandoffEvidenceSegment {
  id: string;
  nodeIds: string[];
  evidenceIds: string[];
  startSequence: number;
  endSequence: number;
  charCount: number;
  content: string;
}

export interface HandoffEvidenceBundle {
  schemaVersion: 2;
  evidenceSchemaVersion: "handoff-evidence-v2";
  sessionId: string;
  revisionId: string;
  cacheKey: string;
  totalNodeCount: number;
  coveredNodeIds: string[];
  segments: HandoffEvidenceSegment[];
  evidenceIndex: HandoffEvidenceRef[];
  userIntentEvidence: HandoffEvidenceRef[];
  decisionEvidence: HandoffEvidenceRef[];
  completionClaims: HandoffEvidenceRef[];
  validationEvidence: HandoffEvidenceRef[];
  failedAttempts: HandoffEvidenceRef[];
  riskEvidence: HandoffEvidenceRef[];
  pendingEvidence: HandoffEvidenceRef[];
  nextActionEvidence: HandoffEvidenceRef[];
  questionEvidence: HandoffEvidenceRef[];
  commandEvidence: HandoffEvidenceRef[];
  fileEvidence: HandoffEvidenceRef[];
  projectMemoryEvidence: HandoffEvidenceRef[];
}

export interface AiWorkspaceHandoffDocument {
  schemaVersion: 2;
  sessionId: string;
  revisionId: string;
  title: string;
  executiveSummary: string;
  progress: string;
  background: string[];
  scope: string[];
  currentState: string[];
  milestones: string[];
  completed: string[];
  decisions: string[];
  validation: string[];
  pending: string[];
  nextActions: string[];
  openQuestions: string[];
  constraints: string[];
  environment: string[];
  commands: string[];
  files: string[];
  projectMemory: string[];
  latestContext: string[];
  provenance: string[];
  userIntent: string[];
  workItems: HandoffWorkItem[];
  deliverables: HandoffDeliverable[];
  failedAttempts: HandoffFailedAttempt[];
  verifiedCompleted: HandoffWorkItem[];
  claimedCompleted: HandoffWorkItem[];
  partialCompleted: HandoffWorkItem[];
  actionPlan: HandoffNextAction[];
  acceptanceCriteria: string[];
  evidenceIndex: HandoffEvidenceRef[];
  sourceRevision: HandoffSourceRevision;
  quality: HandoffQualityReport;
  userAddendum: string;
  generatedAt: string;
  method: AiWorkspaceHandoffGenerationMethod;
  markdown: string;
}

export interface AiWorkspaceHandoffViewState {
  document: AiWorkspaceHandoffDocument;
  stale: boolean;
  currentRevisionId: string;
  currentNodeCount: number;
  sourceRevisionId: string;
  sourceNodeCount: number;
  staleReason?: string;
}

export function normalizeAiWorkspaceHandoffDocument(value: unknown): AiWorkspaceHandoffDocument {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const strings = (input: unknown): string[] => Array.isArray(input)
    ? input.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const text = (input: unknown, fallback = ""): string => String(input ?? "").trim() || fallback;
  const refsFromText = (input: string): HandoffEvidenceRef[] => {
    const sequences = [...input.matchAll(/#(\d+)/gu)].map((match) => Number(match[1])).filter(Number.isFinite);
    return sequences.map((sequence, index) => ({
      id: `legacy-node-${sequence}-${index + 1}`,
      sourceType: "session-node" as const,
      sourceId: `sequence:${sequence}`,
      sequence,
      excerpt: input
    }));
  };
  const workItems = (input: unknown, fallbackStatus: HandoffWorkItemStatus): HandoffWorkItem[] => {
    if (!Array.isArray(input)) return [];
    return input.map((item, index) => {
      if (typeof item === "string") {
        return {
          id: `legacy-${fallbackStatus}-${index + 1}`,
          title: item,
          status: fallbackStatus,
          summary: item,
          evidence: refsFromText(item),
          acceptanceCriteria: []
        };
      }
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const status = ["verified", "claimed", "partial", "pending", "blocked", "unknown"].includes(String(row.status))
        ? String(row.status) as HandoffWorkItemStatus
        : fallbackStatus;
      const evidence = Array.isArray(row.evidence)
        ? row.evidence.map((entry, evidenceIndex) => normalizeEvidenceRef(entry, `${fallbackStatus}-${index + 1}-${evidenceIndex + 1}`)).filter(Boolean) as HandoffEvidenceRef[]
        : refsFromText(text(row.summary || row.title));
      return {
        id: text(row.id, `${fallbackStatus}-${index + 1}`),
        title: text(row.title, text(row.summary, `工作项 ${index + 1}`)),
        status,
        summary: text(row.summary, text(row.title)),
        evidence,
        acceptanceCriteria: strings(row.acceptanceCriteria)
      };
    });
  };

  const legacy = Number(source.schemaVersion || 1) < 2;
  const legacyCompleted = strings(source.completed);
  const claimedCompleted = workItems(
    source.claimedCompleted ?? (legacy ? legacyCompleted : []),
    "claimed"
  );
  const verifiedCompleted = workItems(source.verifiedCompleted, "verified");
  const partialCompleted = workItems(source.partialCompleted, "partial");
  const pendingItems = workItems(source.workItems, "pending");
  const revisionId = text(source.revisionId, "unknown");
  const generatedAt = text(source.generatedAt, new Date(0).toISOString());
  const qualitySource = source.quality && typeof source.quality === "object"
    ? source.quality as Record<string, unknown>
    : {};
  const warnings = strings(qualitySource.warnings);
  if (legacy && !warnings.some((warning) => warning.includes("V1"))) {
    warnings.unshift("由 V1 交接兼容读取；旧版完成项缺少结构化验证，已按“声称完成”处理。");
  }

  const document: AiWorkspaceHandoffDocument = {
    schemaVersion: 2,
    sessionId: text(source.sessionId),
    revisionId,
    title: text(source.title, "会话交接"),
    executiveSummary: text(source.executiveSummary, "尚未生成交接摘要。"),
    progress: text(source.progress, "尚未整理当前进度。"),
    background: strings(source.background),
    scope: strings(source.scope),
    currentState: strings(source.currentState),
    milestones: strings(source.milestones),
    completed: legacyCompleted.length > 0 ? legacyCompleted : strings(source.completed),
    decisions: strings(source.decisions),
    validation: strings(source.validation),
    pending: strings(source.pending),
    nextActions: strings(source.nextActions),
    openQuestions: strings(source.openQuestions),
    constraints: strings(source.constraints),
    environment: strings(source.environment),
    commands: strings(source.commands),
    files: strings(source.files),
    projectMemory: strings(source.projectMemory),
    latestContext: strings(source.latestContext),
    provenance: strings(source.provenance),
    userIntent: strings(source.userIntent),
    workItems: pendingItems,
    deliverables: normalizeDeliverables(source.deliverables),
    failedAttempts: normalizeFailedAttempts(source.failedAttempts),
    verifiedCompleted,
    claimedCompleted,
    partialCompleted,
    actionPlan: normalizeActions(source.actionPlan),
    acceptanceCriteria: strings(source.acceptanceCriteria),
    evidenceIndex: Array.isArray(source.evidenceIndex)
      ? source.evidenceIndex.map((entry, index) => normalizeEvidenceRef(entry, `evidence-${index + 1}`)).filter(Boolean) as HandoffEvidenceRef[]
      : [],
    sourceRevision: normalizeSourceRevision(source.sourceRevision, revisionId, generatedAt),
    quality: {
      score: boundedNumber(qualitySource.score, legacy ? 35 : 0),
      passed: qualitySource.passed === true,
      nodeCoverage: boundedRatio(qualitySource.nodeCoverage),
      citationCoverage: boundedRatio(qualitySource.citationCoverage),
      warnings,
      errors: strings(qualitySource.errors),
      repairCount: Math.max(0, Math.floor(Number(qualitySource.repairCount) || 0)),
      missingNodeIds: strings(qualitySource.missingNodeIds)
    },
    userAddendum: text(source.userAddendum),
    generatedAt,
    method: source.method === "ai" || source.method === "local-tool" ? source.method : "rules",
    markdown: text(source.markdown)
  };
  if (document.workItems.length === 0) {
    document.workItems = [
      ...document.verifiedCompleted,
      ...document.claimedCompleted,
      ...document.partialCompleted,
      ...workItems(document.pending, "pending")
    ];
  }
  return document;
}

function normalizeEvidenceRef(value: unknown, fallbackId: string): HandoffEvidenceRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const sourceType = ["session-node", "project-memory", "file", "command"].includes(String(row.sourceType))
    ? String(row.sourceType) as HandoffEvidenceSourceType
    : "session-node";
  const sequence = Number(row.sequence);
  const part = Number(row.part);
  const partCount = Number(row.partCount);
  return {
    id: String(row.id || fallbackId),
    sourceType,
    sourceId: String(row.sourceId || row.nodeId || fallbackId),
    nodeId: row.nodeId ? String(row.nodeId) : undefined,
    sequence: Number.isFinite(sequence) ? sequence : undefined,
    role: row.role === "user" || row.role === "assistant" || row.role === "tool" ? row.role : undefined,
    timestamp: row.timestamp ? String(row.timestamp) : undefined,
    excerpt: String(row.excerpt || ""),
    contentHash: row.contentHash ? String(row.contentHash) : undefined,
    part: Number.isFinite(part) ? part : undefined,
    partCount: Number.isFinite(partCount) ? partCount : undefined
  };
}

function normalizeDeliverables(value: unknown): HandoffDeliverable[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const status = ["verified", "claimed", "partial", "pending", "blocked", "unknown"].includes(String(row.status))
      ? String(row.status) as HandoffWorkItemStatus
      : "unknown";
    return {
      id: String(row.id || `deliverable-${index + 1}`),
      name: String(row.name || row.path || `产物 ${index + 1}`),
      path: row.path ? String(row.path) : undefined,
      purpose: String(row.purpose || ""),
      status,
      evidence: Array.isArray(row.evidence)
        ? row.evidence.map((entry, evidenceIndex) => normalizeEvidenceRef(entry, `deliverable-${index + 1}-${evidenceIndex + 1}`)).filter(Boolean) as HandoffEvidenceRef[]
        : []
    };
  });
}

function normalizeFailedAttempts(value: unknown): HandoffFailedAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      id: String(row.id || `failed-${index + 1}`),
      approach: String(row.approach || row.outcome || `失败尝试 ${index + 1}`),
      outcome: String(row.outcome || ""),
      reason: String(row.reason || ""),
      lesson: String(row.lesson || ""),
      evidence: Array.isArray(row.evidence)
        ? row.evidence.map((entry, evidenceIndex) => normalizeEvidenceRef(entry, `failed-${index + 1}-${evidenceIndex + 1}`)).filter(Boolean) as HandoffEvidenceRef[]
        : []
    };
  });
}

function normalizeActions(value: unknown): HandoffNextAction[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      id: String(row.id || `action-${index + 1}`),
      action: String(row.action || ""),
      target: String(row.target || ""),
      expectedResult: String(row.expectedResult || ""),
      acceptanceCriteria: String(row.acceptanceCriteria || row.acceptance || ""),
      evidence: Array.isArray(row.evidence)
        ? row.evidence.map((entry, evidenceIndex) => normalizeEvidenceRef(entry, `action-${index + 1}-${evidenceIndex + 1}`)).filter(Boolean) as HandoffEvidenceRef[]
        : []
    };
  });
}

function normalizeSourceRevision(
  value: unknown,
  revisionId: string,
  generatedAt: string
): HandoffSourceRevision {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    revisionId: String(row.revisionId || revisionId),
    nodeCount: Math.max(0, Math.floor(Number(row.nodeCount) || 0)),
    compiledAt: String(row.compiledAt || generatedAt),
    cacheKey: String(row.cacheKey || `legacy:${revisionId}`)
  };
}

function boundedNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : fallback;
}

function boundedRatio(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

export function aiWorkspaceToolLabel(tool: AiWorkspaceTool): string {
  if (tool === "codex") return "Codex";
  if (tool === "claude") return "Claude Code";
  if (tool === "opencode") return "OpenCode";
  if (tool === "codebuddy") return "CodeBuddy";
  if (tool === "workbuddy") return "WorkBuddy";
  if (tool === "pi") return "Pi";
  if (tool === "cursor") return "Cursor";
  if (tool === "windsurf") return "Windsurf";
  if (tool === "gemini-cli") return "Gemini CLI";
  if (tool === "github-copilot") return "GitHub Copilot";
  if (tool === "kiro") return "Kiro";
  if (tool === "aider") return "Aider";
  if (tool === "qwen-code") return "Qwen Code";
  if (tool === "trae") return "Trae";
  if (tool === "tongyi-lingma") return "通义灵码";
  if (tool === "cline") return "Cline";
  if (tool === "roo-code") return "Roo Code";
  if (tool === "continue") return "Continue";
  return "网页 AI";
}

export function aiWorkspaceToolSupportsDirectScan(tool: AiWorkspaceTool): boolean {
  return (AI_WORKSPACE_NATIVE_TOOLS as readonly string[]).includes(tool);
}
