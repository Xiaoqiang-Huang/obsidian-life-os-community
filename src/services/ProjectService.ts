import { TFile, type App } from "obsidian";
import { replaceProjectGoal } from "./project-goal";
import type { LifeOSProject, LifeOSProjectStatus, LifeOSProjectType, LifeOSTask } from "../types";
import { randomId } from "../utils/ids";
import { ensureFile } from "../utils/vault";
import type { FileSystemService } from "./FileSystemService";
import { ProjectDocumentService } from "./ProjectDocumentService";
import { readVaultSnapshot, throwIfReadAborted } from "../utils/vault-read-cache";
import {
  buildProjectOverview,
  formatProjectForIndex,
  formatProjectOverviewForAi,
  normalizeProjectStatus,
  normalizeProjectType,
  parseProjectIndex,
  type LifeOSProjectOverview,
  type ProjectOverviewForAiOptions
} from "./project-context";

export type { LifeOSProjectOverview, ProjectOverviewForAiOptions } from "./project-context";

const PROJECTS_INDEX_FALLBACK = "# Projects\n\n";

export class ProjectService {
  constructor(private app: App, private fs: FileSystemService) {}

  async loadProjects(signal?: AbortSignal): Promise<LifeOSProject[]> {
    throwIfReadAborted(signal);
    const file = await ensureFile(this.app, this.fs.path("Projects", "index.md"), PROJECTS_INDEX_FALLBACK);
    const content = await readVaultSnapshot(this.app, file.path, signal);
    throwIfReadAborted(signal);
    return ProjectService.parseProjectIndex(content);
  }

  async createProject(input: {
    name: string;
    type?: string;
    status?: string;
    goal?: string;
  }): Promise<LifeOSProject> {
    const name = input.name.trim();
    if (!name) throw new Error("Project name cannot be empty.");

    const project: LifeOSProject = {
      id: randomId("project"),
      name,
      type: ProjectService.normalizeType(input.type),
      status: ProjectService.normalizeStatus(input.status),
      goal: input.goal?.trim() || undefined
    };

    const file = await ensureFile(this.app, this.fs.path("Projects", "index.md"), PROJECTS_INDEX_FALLBACK);
    await this.app.vault.append(file, ProjectService.formatProject(project));
    await new ProjectDocumentService(this.app, this.fs).ensureProjectSpace(project);
    return project;
  }

  async updateGoal(projectId: string, expectedGoal: string, goal: string): Promise<void> {
    const path = this.fs.path("Projects", "index.md");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("项目索引已移动或删除，未重建。");
    await this.app.vault.process(file, current => {
      if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error("项目索引位置已变化。");
      return replaceProjectGoal(current, projectId, expectedGoal, goal);
    });
    const saved = ProjectService.parseProjectIndex(await this.app.vault.read(file)).find(p => p.id === projectId);
    if ((saved?.goal || "") !== goal.trim()) throw new Error("目标保存后核对失败，请重新打开检查。");
  }

  static parseProjectIndex(markdown: string): LifeOSProject[] {
    return parseProjectIndex(markdown);
  }

  static formatProject(project: LifeOSProject): string {
    return formatProjectForIndex(project);
  }

  static buildOverview(
    projects: LifeOSProject[],
    openTasks: LifeOSTask[],
    doneTasks: LifeOSTask[]
  ): LifeOSProjectOverview {
    return buildProjectOverview(projects, openTasks, doneTasks);
  }

  static formatOverviewForAi(
    overview: LifeOSProjectOverview,
    options: ProjectOverviewForAiOptions = {}
  ): string {
    return formatProjectOverviewForAi(overview, options);
  }

  static normalizeType(type?: string): LifeOSProjectType {
    return normalizeProjectType(type);
  }

  static normalizeStatus(status?: string): LifeOSProjectStatus {
    return normalizeProjectStatus(status);
  }
}
