/** Business state only. No SDK, credentials, filesystem or model is loaded here. */
export type ReadState = "read" | "failed" | "unsupported";
export type TextOrigin = "native" | "vision" | "manually-edited";
export interface SourceEntry {
  path: string; projectId: string; format: string;
  kind: "original" | "wrapper" | "recognition" | "derived-report" | "work-state";
  /** Explicit source_file relation, never inferred from filename/content equality. */
  sourceFile?: string; explicitlyIncluded?: boolean;
}
export interface TextUnit {
  unitId: string; page?: number; section?: string; text: string; readState: ReadState;
  role: "author" | "comment" | "unknown"; author?: string; origin: TextOrigin;
  originalVerified?: boolean; error?: string;
}
export interface ReadSnapshot {
  sourceHash: string; totalUnits: number | null; units: TextUnit[]; error?: string;
}
export interface LogicalDocument {
  docId: string; originalPath: string; effectivePath: string; paths: string[]; projectId: string;
  format: string; sourceHash: string; effectiveTextHash: string; totalUnits: number | null;
  units: TextUnit[]; error?: string;
}
export interface Manifest { schemaVersion: 1; manifestHash: string; scope: string; documents: LogicalDocument[] }
export interface ManifestReader {
  /** Must enumerate the entire permitted scope; pages are not a sampling limit. */
  enumerate(cursor?: string): Promise<{ entries: SourceEntry[]; next?: string }>;
  snapshot(effective: SourceEntry, original: SourceEntry): Promise<ReadSnapshot>;
  currentIdentity(doc: LogicalDocument): Promise<{ sourceHash: string; effectiveTextHash: string }>;
}
export interface ModelIdentity {
  profile: string; profileRevision: string; model: string; modelRevision: string;
  backend: "api" | "sdk"; destination: string;
  /** Unknown capability fails closed before bulk calls. No automatic probe. */
  contextTokens: number | null; inputTokens: number; outputTokens: number; overheadTokens: number;
  maxInputChars: number; tokenCounting: "confirmed" | "conservative-estimate";
  sdkTurnLimit?: number;
  /** Conservative terminal-reported turn reservation per query, NOT CLI maxTurns.
   * SDK maxTurns limits tool-use round trips; terminal num_turns uses other units. */
  sdkReportedTurnAllowance?: number;
}
export interface ChunkSpec { version: string; extractionVersion: string; maxChars: number; overlap: number }
export interface Chunk {
  chunkId: string; cacheKey: string; docId: string; unitId: string;
  start: number; end: number; ownedStart: number; ownedEnd: number;
  inputHash: string; text: string; specVersion: string;
}
export interface SpanInput { unitId: string; start: number | null; end: number | null; quote: string; quoteHash: string | null }
export interface TrustedSpan extends SpanInput {
  start: number; end: number; quoteHash: string;
  docId: string; sourceHash: string; effectiveTextHash: string; path: string;
  page?: number; section?: string; textOrigin: TextOrigin; originalVerified: boolean;
}
export interface ClaimInput { text: string; citations: SpanInput[] }
export interface EvidenceClaim { text: string; citations: TrustedSpan[] }
export interface Viewpoint {
  viewpointId: string; chunkId: string; docId: string;
  author: { name: string; kind: "source-author" | "commenter" | "unknown" };
  statement: EvidenceClaim; arguments: EvidenceClaim[]; conditions: EvidenceClaim[];
  counterexamples: EvidenceClaim[]; time: EvidenceClaim | null;
  kind: "reported-fact" | "interpretation"; explanation: string;
  evidenceCheck: "span-verified-semantic-unverified";
}
export type TaskState = "pending" | "running" | "done" | "failed" | "interrupted";
export interface ChunkResult {
  chunk: Chunk; status: TaskState; viewpoints: Viewpoint[]; noViewpointsReason?: string;
  error?: string; attempts: number; executionId?: string;
}
export interface SynthesisItem {
  id: string; statement: string; conditions: string[]; counterexamples: string[];
  authors?: Array<Viewpoint["author"] & { viewpointId?: string }>;
}
export interface SynthesisNode {
  nodeId: string; level: number; inputIds: string[]; viewpointIds: string[];
  qualificationIds: string[]; items: SynthesisItem[]; status: TaskState; attempts: number; error?: string;
  themes: { label: string; statement: string; inputIds: string[] }[];
  conflicts: { statement: string; inputIds: string[] }[];
}
export interface Coverage {
  documentsTotal: number; documentsComplete: number; unitsKnownTotal: number;
  unitsRead: number; unitsAnalyzed: number; unknownTotalDocuments: string[];
  chunksTotal: number; chunksComplete: number; omissions: string[];
}
export type Category = "api" | "sdk" | "vision" | "search" | "write";
export interface BudgetLimits {
  api: number; sdk: number; vision: number; search: number; write: number;
  tokens: number | null; cost: number | null; currency?: string; durationMs: number | null;
  sdkTurns: number;
}
export interface Reservation {
  executionId: string; taskId: string; category: Category; tokens: number; cost: number | null;
  state: "reserved" | "settled" | "uncertain"; startedAt: number;
  sdkTurns: number;
  profile: string;
}
export interface UsageInput {
  receiptId: string; executionId: string; taskId: string; profile: string;
  category: Category; basis: "incremental" | "cumulative"; counterId?: string;
  tokens: number | null; cost: number | null; currency?: string;
  /** SDK HTTP count is not the application's original API count. */
  sdkHttpRequests: number | null;
  /** Actual terminal-reported turns for this execution, NOT CLI tool-round maxTurns.
   * Unknown stays null and pauses; never fabricate 1 from maxTurns=1. */
  sdkTurns: number | null;
  /** Optional raw copy of result num_turns; the charged sdkTurns must be observed too. */
  sdkResultTurns?: number | null;
}
export interface UsageReceipt extends UsageInput { deltaTokens: number | null; deltaCost: number | null }
export interface JobBudget {
  limits: BudgetLimits; requests: Record<Category, number>; tokens: number; cost: number;
  unknown: boolean; reservations: Reservation[]; receipts: UsageReceipt[];
  cumulative: Record<string, { tokens: number | null; cost: number | null }>;
  sdkTurns: number;
}
export interface AuthorizationScope {
  profile: ModelIdentity; permissions: { modelEgress: boolean; derivedWrite: boolean };
  contentCategories: string[]; limits: BudgetLimits;
}
export interface ApprovalReceipt {
  jobId: string; authorizationRevision: number; identityHash: string;
  approvedAt: number; expiresAt: number | null;
}
export type JobStatus = "draft" | "preparing" | "awaiting-approval" | "running-recognition"
  | "running-extraction" | "running-synthesis" | "verifying" | "completed"
  | "paused" | "partial" | "cancelled" | "failed";
export interface FinalizationEffect {
  turnId: string; effectKind: "report"; effectId: string; authorizationRevision: number;
  payloadHash: string; state: "pending" | "applied" | "uncertain"; receipt?: string;
}
export interface SynthesisReport {
  inputResultIds: string[]; index: Viewpoint[]; nodes: SynthesisNode[]; coverage: Coverage;
  reportHash: string; markdown: string; quality: "structural-only-semantic-unverified";
}
export interface AnalysisJob {
  type: "lifeos-agent-analysis-state";
  hostIdentity: string;
  schemaVersion: 1; jobId: string; request: string; manifest: Manifest; authorization: AuthorizationScope;
  authorizationRevision: number; stateRevision: number; approval?: ApprovalReceipt;
  status: JobStatus; waitReason?: "approval-required" | "budget-required" | "source-changed" | "resume-required" | "write-confirmation-required";
  identityHash: string; chunks: ChunkResult[]; nodes: SynthesisNode[]; budget: JobBudget;
  cursor: number; startedAt: number; updatedAt: number;
  lease?: { owner: string; token: string; expiresAt: number }; report?: SynthesisReport;
  effects: FinalizationEffect[]; error?: string;
}
export interface ModelResponse { output: unknown; finish: "complete" | "length" | "error"; usage?: UsageInput }
export interface ModelCall {
  jobId: string; executionId: string; taskId: string; profile: ModelIdentity; signal: AbortSignal;
  maxOutputTokens: number; remaining: BudgetLimits; prompt: string;
  maxTurns: number;
  allowance: { tokens: number; cost: number | null; currency?: string };
  nativeRequestBudget: import("../AgentRequestBudget").AgentRequestBudget;
}
export interface AnalysisModel {
  extract(input: ModelCall & { chunk: Chunk; schema: object }): Promise<ModelResponse>;
  synthesize(input: ModelCall & { node: SynthesisNode; schema: object }): Promise<ModelResponse>;
  /** Ceiling in user-confirmed currency; null means not reliably priced. */
  costCeiling(inputTokens: number, outputTokens: number): number | null;
  countTokens?(text: string): number;
}
