import type { WebSearchGrounding } from "../WebContextService";

export type ContextEngineMode = "local" | "vector" | "graph";
export type ChatContextMode = "smart" | "semantic" | "global";
export type WebSearchMode = "auto" | "always" | "off";
export type WebSearchProviderResult = string | WebSearchGrounding;

export interface ContextEngineBuildInput {
  userMessage: string;
  mode?: ContextEngineMode;
  chatMode?: ChatContextMode;
  date?: string;
  maxChars?: number;
  projectScopeId?: string;
  fetchUrl?: (url: string) => Promise<string>;
  searchWeb?: (query: string) => Promise<WebSearchProviderResult>;
  webSearchMode?: WebSearchMode;
  webSearchQuery?: string;
  /** AI is optional for query planning; local hybrid retrieval never depends on it. */
  useAiPlanner?: boolean;
}

export interface ContextInventoryItem {
  path: string;
  title: string;
  tags: string[];
  headings: string[];
  links: string[];
  backlinks: string[];
  frontmatter: Record<string, unknown>;
  mtime: number;
}

export interface ContextRetrievalPlan {
  keywords: string[];
  paths: string[];
  tags: string[];
  directories: string[];
  limit: number;
}

export interface ContextSource {
  path: string;
  /** The binary original behind a user-visible recognition Markdown; path remains the citable cache note. */
  originalPath?: string;
  title: string;
  type: "current-note" | "daily" | "task" | "project" | "memory" | "summary" | "knowledge" | "llm-wiki" | "graph" | "url";
  excerpt?: string;
  /** Stable, answer-facing citation id assigned by ContextComposer. */
  citationId?: string;
  /** Stable index chunk id. Multiple chunks may come from the same file. */
  chunkId?: string;
  heading?: string;
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  updatedAt?: number;
  score?: number;
  trust?: number;
  /** Provenance, not a claim that the contents are independently established facts. */
  evidenceOrigin?: "note" | "user-saved-conversation" | "context-only";
}

export interface ContextSection {
  title: string;
  content: string;
  priority: number;
  source?: string;
  sourceInfo?: ContextSource;
  kind?: "evidence" | "context" | "diagnostic";
}

export interface ContextEvidence {
  content: string;
  score: number;
  source: ContextSource;
}

export type ContextRetrievalRoute = "none" | "focused" | "broad" | "deep";

export interface ContextRetrievalTrace {
  route: ContextRetrievalRoute;
  strategy: string;
  queries: string[];
  attempts: number;
  sparseCandidates: number;
  vectorCandidates: number;
  fusedCandidates: number;
  selectedCount: number;
  candidateCount: number;
  /** Concept coverage: how much of the query's concepts appears in the returned evidence. It is NOT a claim that every document was read. */
  coverage: number;
  /** The same measure as coverage, named explicitly so callers/UI can keep it separate from document coverage. */
  conceptCoverage: number;
  /** Distinct Markdown documents whose text actually entered the returned evidence. */
  documentsRead: number;
  /** Markdown documents in the retrieval scope that could have been read. */
  documentsTotal: number;
  /** documentsRead / documentsTotal (1 when the scope is empty). */
  documentsCoverage: number;
  /** True when documentsRead < documentsTotal; coverage=1 alone must not be read as full-document coverage. */
  documentsTruncated: boolean;
  /** Human-readable sampling/truncation reasons; empty when nothing was sampled away. */
  samplingReasons: string[];
  durationMs: number;
  indexDocuments: number;
  indexChunks: number;
  updatedDocuments: number;
  reusedDocuments: number;
}

export interface ContextEngineResult {
  promptContext: string;
  sections: ContextSection[];
  sources: ContextSource[];
  confidence: number;
  warnings: string[];
  modeUsed: ContextEngineMode;
  retrievalTrace?: ContextRetrievalTrace;
}

export interface AiCompleteRequest {
  prompt: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  responseFormat?: "json" | "text";
  temperature?: number;
}

export interface AiCompleteResponse {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface AiLike {
  complete(request: AiCompleteRequest): Promise<AiCompleteResponse>;
}
