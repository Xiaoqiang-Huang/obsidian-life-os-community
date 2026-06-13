import type { App } from "obsidian";
import type { LifeOSProject, LifeOSProjectStatus, LifeOSProjectType, LifeOSTask } from "../types";
import { randomId } from "../utils/ids";
import { ensureFile, readFile } from "../utils/vault";
import type { FileSystemService } from "./FileSystemService";
import { ProjectDocumentService } from "./ProjectDocumentService";
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

  async loadProjects(): Promise<LifeOSProject[]> {
    const file = await ensureFile(this.app, this.fs.path("Projects", "index.md"), PROJECTS_INDEX_FALLBACK);
    return ProjectService.parseProjectIndex(await readFile(this.app, file.path));
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
