import type { App } from "obsidian";
import type { PersonalLifeSystemSettings } from "../settings";
import { today } from "../utils/dates";
import { joinPath, normalizePath } from "../utils/vault";

const RECENT_HINTS_CHAR_BUDGET = 5000;
const DAILY_HINT_CHAR_BUDGET = 3499;
const TASK_HINT_CHAR_BUDGET = 1500;

type FileLike = { path: string; name: string; basename: string };

export interface LlmWikiProjectRelation {
  relatedProjects: string[];
  relationConfidence: "low" | "medium" | "high";
  relationReason: string;
}

export class LlmWikiProjectLinkService {
  constructor(private app: App, private settings: Partial<PersonalLifeSystemSettings>) {}

  async inferRelatedProjects(content: string): Promise<LlmWikiProjectRelation> {
    const projects = await this.readCurrentProjects();
    const contentMatched = this.findProjectMatches(projects, content);

    if (contentMatched.length > 0) {
      return {
        relatedProjects: contentMatched.slice(0, 3),
        relationConfidence: contentMatched.length === 1 ? "medium" : "high",
        relationReason: "资料内容与 current-projects.md 中的项目名称直接匹配。"
      };
    }

    const hints = await this.readRecentHints();
    const hintMatched = this.findProjectMatches(projects, hints);
    if (hintMatched.length > 0) {
      return {
        relatedProjects: hintMatched.slice(0, 3),
        relationConfidence: hintMatched.length === 1 ? "low" : "medium",
        relationReason: "资料内容未直接匹配项目；近期 Daily/Tasks 线索弱关联到 current-projects.md 中的项目。"
      };
    }

    return {
      relatedProjects: ["Unassigned"],
      relationConfidence: "low",
      relationReason: "没有匹配到 current-projects.md 中的活跃项目。"
    };
  }

  private async readCurrentProjects(): Promise<string[]> {
    const content = this.stripLeadingYamlFrontmatter(await this.readPath(this.path("Memory", "Core", "current-projects.md")));
    const projects: string[] = [];
    const seen = new Set<string>();

    for (const line of content.split(/\r?\n/)) {
      const project = this.cleanProjectLine(line);
      if (
        project.length <= 1 ||
        this.isIgnoredProjectLine(project) ||
        this.isStructuralProjectHeading(project)
      ) {
        continue;
      }

      const key = project.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push(project);
      if (projects.length >= 20) break;
    }

    return projects;
  }

  private findProjectMatches(projects: string[], text: string): string[] {
    return projects.filter((project) => this.matchesProjectName(text, project));
  }

  private matchesProjectName(text: string, project: string): boolean {
    if (!project) return false;
    if (/^[\x00-\x7F]+$/.test(project)) {
      const pattern = new RegExp(`(^|[^A-Za-z0-9_])${this.escapeRegExp(project)}(?=$|[^A-Za-z0-9_])`, "i");
      return pattern.test(text);
    }
    return text.toLowerCase().includes(project.toLowerCase());
  }

  private cleanProjectLine(line: string): string {
    return line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/^\[[ xX]\]\s+/, "")
      .trim();
  }

  private stripLeadingYamlFrontmatter(content: string): string {
    const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return content;

    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === "---") {
        return lines.slice(index + 1).join("\n");
      }
    }

    return content;
  }

  private isIgnoredProjectLine(project: string): boolean {
    return /^-{3,}$/.test(project) || /^\.\.\.$/.test(project) || /^[A-Za-z0-9_.-]+\s*:\s*.*$/.test(project);
  }

  private isStructuralProjectHeading(project: string): boolean {
    const normalized = project.toLowerCase().replace(/\s+/g, " ").trim();
    if (["current project", "current projects", "project", "projects", "active project", "active projects"].includes(normalized)) {
      return true;
    }

    return ["项目", "当前项目", "活跃项目", "进行中项目"].includes(project.replace(/\s+/g, ""));
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private async readRecentHints(): Promise<string> {
    const dailyContent = await this.readFirstAvailablePath(this.dailyHintPaths());
    const tasksPath = this.path("Tasks", "open.md");
    const taskContent = await this.readPath(tasksPath);
    const dailyHint = dailyContent.slice(0, DAILY_HINT_CHAR_BUDGET);
    const taskHint = taskContent.slice(0, Math.min(
      TASK_HINT_CHAR_BUDGET,
      Math.max(0, RECENT_HINTS_CHAR_BUDGET - dailyHint.length - (dailyHint ? 1 : 0))
    ));
    return [dailyHint, taskHint].filter(Boolean).join("\n");
  }

  private dailyHintPaths(): string[] {
    const date = today();
    const rootDailyPath = this.path("Daily", `${date}.md`);
    const dailyNotesFolder = this.settings.useDailyNotesPlugin ? this.getDailyNotesFolder() : null;
    const pluginDailyPath = dailyNotesFolder ? joinPath(dailyNotesFolder, `${date}.md`) : "";
    return Array.from(new Set([pluginDailyPath, rootDailyPath].filter(Boolean)));
  }

  private getDailyNotesFolder(): string | null {
    const config = (this.app as unknown as {
      internalPlugins?: {
        plugins?: Record<string, { instance?: { options?: { folder?: string } } }>;
      };
    }).internalPlugins?.plugins?.["daily-notes"]?.instance?.options;
    const folder = normalizePath(config?.folder ?? "");
    return folder || null;
  }

  private async readFirstAvailablePath(paths: string[]): Promise<string> {
    for (const path of paths) {
      if (!this.getFile(path)) continue;
      const content = await this.readPath(path);
      if (content) return content;
    }
    return "";
  }

  private async readPath(path: string): Promise<string> {
    const file = this.getFile(path);
    if (!file) return "";
    const vault = (this.app as unknown as { vault?: { read?: (file: FileLike) => Promise<string> } }).vault;
    if (!vault?.read) return "";
    try {
      return String(await vault.read(file));
    } catch {
      return "";
    }
  }

  private getFile(path: string): FileLike | null {
    const file = (this.app as unknown as { vault?: { getAbstractFileByPath?: (path: string) => unknown } }).vault?.getAbstractFileByPath?.(path);
    return file && typeof file === "object" && typeof (file as FileLike).path === "string" ? file as FileLike : null;
  }

  private path(partA = "", partB = "", partC = ""): string {
    const root = normalizePath(this.settings.rootFolder || "PersonalLifeSystem") || "PersonalLifeSystem";
    return joinPath(root, partA, partB, partC);
  }
}
