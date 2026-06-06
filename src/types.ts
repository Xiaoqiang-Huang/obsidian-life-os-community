export type LifeOSNavKey =
  | "dashboard"
  | "tasks"
  | "diary"
  | "knowledge"
  | "memory"
  | "checkins"
  | "review"
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
