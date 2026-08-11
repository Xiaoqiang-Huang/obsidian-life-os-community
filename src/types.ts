export type LifeOSNavKey =
  | "dashboard"
  | "tasks"
  | "diary"
  | "knowledge"
  | "memory"
  | "checkins"
  | "review"
  | "workspace"
  | "chat"
  | "guide"
  | "proCompare"
  | "pro"
  | "settings";

export type QuickCaptureTarget = "daily" | "inbox" | "task" | "memory";

export interface LifeOSTask {
  line: string;
  text: string;
  tags: string[];
  date?: string;
  projectId?: string;
  source: "open" | "done";
  isDone: boolean;
}

export type LifeOSProjectStatus = "active" | "paused" | "done";
export type LifeOSProjectType = "general" | "study" | "client";

export interface LifeOSProject {
  id: string;
  name: string;
  type: LifeOSProjectType;
  status: LifeOSProjectStatus;
  goal?: string;
}

export type LifeOSProjectDocumentKind = "note" | "meeting" | "requirement" | "reference" | "review";

export interface LifeOSProjectDocument {
  projectId: string;
  projectName?: string;
  title: string;
  path: string;
  kind: LifeOSProjectDocumentKind;
  mtime: number;
  excerpt?: string;
  sourceName?: string;
  sourceKind?: string;
  sourceSize?: string;
  textImportMode?: "attachment-only" | "plain-text" | "ai-formatted";
  characterCount?: number;
  hasSearchableText?: boolean;
  warningCount?: number;
}

export interface LifeOSProjectSummary {
  project: LifeOSProject | null;
  projectId?: string;
  label: string;
  openTasks: LifeOSTask[];
  doneTasks: LifeOSTask[];
  totalCount: number;
  openCount: number;
  doneCount: number;
  progress: number;
}

export interface PendingMemory {
  id: string;
  lineStart: number;
  lineEnd: number;
  raw: string;
  content: string;
  source: string;
  created: string;
  status: string;
  category: string;
  importance: string;
  selected: boolean;
}

export interface ChatMessage {
  role: "user" | "ai";
  content: string;
}
