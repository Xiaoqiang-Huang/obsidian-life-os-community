export type ContextEngineMode = "local" | "vector" | "graph";
export type ChatContextMode = "smart" | "semantic" | "global";

export interface ContextEngineBuildInput {
  userMessage: string;
  mode?: ContextEngineMode;
  chatMode?: ChatContextMode;
  date?: string;
  maxChars?: number;
  projectScopeId?: string;
  fetchUrl?: (url: string) => Promise<string>;
  searchWeb?: (query: string) => Promise<string>;
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
  title: string;
  type: "current-note" | "daily" | "task" | "project" | "memory" | "summary" | "knowledge" | "llm-wiki" | "graph" | "url";
  excerpt?: string;
}

export interface ContextSection {
  title: string;
  content: string;
  priority: number;
  source?: string;
  sourceInfo?: ContextSource;
}

export interface ContextEvidence {
  content: string;
  score: number;
  source: ContextSource;
}

export interface ContextEngineResult {
  promptContext: string;
  sections: ContextSection[];
  sources: ContextSource[];
  confidence: number;
  warnings: string[];
  modeUsed: ContextEngineMode;
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
