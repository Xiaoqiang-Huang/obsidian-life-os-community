import type { LifeOSProject, LifeOSProjectStatus, LifeOSProjectSummary, LifeOSProjectType, LifeOSTask } from "../types";

export interface ProjectOverviewForAiOptions {
  maxOpenTasksPerProject?: number;
  maxDoneTasksPerProject?: number;
  projectScopeId?: string;
}

export interface LifeOSProjectOverview {
  all: LifeOSProjectSummary;
  projects: LifeOSProjectSummary[];
  unassigned: LifeOSProjectSummary;
}

export function parseProjectIndex(markdown: string): LifeOSProject[] {
  const lines = markdown.split(/\r?\n/);
  const projects: LifeOSProject[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const projectMatch = lines[index].match(/^-\s+(.+)$/);
    if (!projectMatch) continue;

    const meta: Record<string, string> = {};
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const metaMatch = lines[cursor].match(/^\s+-\s+([^:]+):\s*(.*)$/);
      if (!metaMatch) break;
      meta[metaMatch[1].trim()] = metaMatch[2].trim();
      index = cursor;
    }

    projects.push({
      id: meta.id || fallbackProjectId(projectMatch[1].trim()),
      name: projectMatch[1].trim(),
      type: normalizeProjectType(meta.type),
      status: normalizeProjectStatus(meta.status),
      goal: meta.goal || undefined
    });
  }

  return projects;
}

export function formatProjectForIndex(project: LifeOSProject): string {
  const lines = [
    `- ${project.name}`,
    `  - id: ${project.id}`,
    `  - type: ${project.type}`,
    `  - status: ${project.status}`
  ];
  if (project.goal) lines.push(`  - goal: ${project.goal}`);
  return `${lines.join("\n")}\n`;
}

export function buildProjectOverview(
  projects: LifeOSProject[],
  openTasks: LifeOSTask[],
  doneTasks: LifeOSTask[]
): LifeOSProjectOverview {
  const projectIds = new Set(projects.map((project) => project.id));
  const summaries = projects.map((project) => summaryForProject(project, openTasks, doneTasks));
  const unassignedOpen = openTasks.filter((task) => !task.projectId || !projectIds.has(task.projectId));
  const unassignedDone = doneTasks.filter((task) => !task.projectId || !projectIds.has(task.projectId));

  return {
    all: makeSummary(null, "全部项目任务", openTasks, doneTasks),
    projects: summaries,
    unassigned: makeSummary(null, "未归属任务", unassignedOpen, unassignedDone)
  };
}

export function formatProjectOverviewForAi(
  overview: LifeOSProjectOverview,
  options: ProjectOverviewForAiOptions = {}
): string {
  const maxOpen = Math.max(1, options.maxOpenTasksPerProject ?? 12);
  const maxDone = Math.max(0, options.maxDoneTasksPerProject ?? 5);
  const scoped = options.projectScopeId
    ? overview.projects.filter((summary) => summary.projectId === options.projectScopeId)
    : overview.projects;
  const scopeLine = options.projectScopeId
    ? `当前只分析项目：${scoped[0]?.label ?? options.projectScopeId}。`
    : "当前覆盖全部项目；如果用户未选择项目，需要展示所有项目的未完成任务。";
  const sections = [
    "# 项目任务概览",
    "回答单独项目进度、各项目未完成任务和任务分析时优先引用本段；再结合日记、知识库、记忆和复盘内容分析原因与下一步；没有证据就说明资料不足。",
    scopeLine,
    "",
    `总览：未完成任务 ${overview.all.openCount}，已完成任务 ${overview.all.doneCount}，总进度 ${overview.all.progress}%。`
  ];

  if (scoped.length === 0 && options.projectScopeId) {
    sections.push("", `未找到项目 ${options.projectScopeId} 的任务记录。`);
  }

  for (const summary of scoped) {
    sections.push("", formatProjectSummaryForAi(summary, maxOpen, maxDone));
  }

  if (!options.projectScopeId && (overview.unassigned.openCount > 0 || overview.unassigned.doneCount > 0)) {
    sections.push("", formatProjectSummaryForAi(overview.unassigned, maxOpen, maxDone, "未归属任务"));
  }

  return sections.join("\n").trim();
}

export function normalizeProjectType(type?: string): LifeOSProjectType {
  if (type === "study" || type === "client") return type;
  return "general";
}

export function normalizeProjectStatus(status?: string): LifeOSProjectStatus {
  if (status === "paused" || status === "done") return status;
  return "active";
}

function fallbackProjectId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36) || "manual";
  let hash = 5381;
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) + hash) ^ name.charCodeAt(index);
  }
  return `project_${slug}_${Math.abs(hash).toString(36).slice(0, 6)}`;
}

function summaryForProject(
  project: LifeOSProject,
  openTasks: LifeOSTask[],
  doneTasks: LifeOSTask[]
): LifeOSProjectSummary {
  return makeSummary(
    project,
    project.name,
    openTasks.filter((task) => task.projectId === project.id),
    doneTasks.filter((task) => task.projectId === project.id)
  );
}

function makeSummary(
  project: LifeOSProject | null,
  label: string,
  openTasks: LifeOSTask[],
  doneTasks: LifeOSTask[]
): LifeOSProjectSummary {
  const openCount = openTasks.length;
  const doneCount = doneTasks.length;
  const totalCount = openCount + doneCount;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return {
    project,
    projectId: project?.id,
    label,
    openTasks,
    doneTasks,
    totalCount,
    openCount,
    doneCount,
    progress
  };
}

function formatProjectSummaryForAi(
  summary: LifeOSProjectSummary,
  maxOpen: number,
  maxDone: number,
  fallbackLabel = summary.label
): string {
  const project = summary.project;
  const lines = [`## ${project?.name ?? fallbackLabel}`];
  if (project) {
    lines.push(`项目ID：${project.id}`);
    lines.push(`类型：${project.type}`);
    lines.push(`状态：${project.status}`);
    if (project.goal) lines.push(`目标：${project.goal}`);
  }
  lines.push(`进度：${summary.progress}%（已完成 ${summary.doneCount} / 总任务 ${summary.totalCount}，未完成任务：${summary.openCount}）`);
  lines.push(`未完成任务：${summary.openCount}`);
  lines.push(...formatTaskListForAi(summary.openTasks, maxOpen, "暂无未完成任务。"));
  lines.push(`最近完成：${summary.doneCount}`);
  lines.push(...formatTaskListForAi(summary.doneTasks.slice(-maxDone), maxDone, "暂无已完成任务。"));
  return lines.join("\n");
}

function formatTaskListForAi(tasks: LifeOSTask[], limit: number, emptyText: string): string[] {
  if (limit <= 0 || tasks.length === 0) return [`- ${emptyText}`];
  const visible = tasks.slice(0, limit).map((task) => {
    const meta = [
      task.date ? `日期：${task.date}` : "",
      task.tags.length > 0 ? `标签：${task.tags.join(",")}` : ""
    ].filter(Boolean);
    return `- ${task.text}${meta.length > 0 ? `（${meta.join("；")}）` : ""}`;
  });
  if (tasks.length > limit) visible.push(`- 还有 ${tasks.length - limit} 条任务未列出。`);
  return visible;
}
