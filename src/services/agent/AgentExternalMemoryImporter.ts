import { TFile, type App } from "obsidian";
import type { AiClient } from "../../ai";
import type { PersonalLifeSystemSettings } from "../../settings";
import { AiWorkspaceService } from "../AiWorkspaceService";
import { FileSystemService } from "../FileSystemService";
import { agentMemoryHash, AgentMemoryStore, tokenizeAgentMemory } from "./AgentMemoryStore";

export interface AgentExternalMemoryImportResult {
  scanned: number;
  added: number;
  updated: number;
  ignored: number;
  errors: string[];
}

/** Imports already-snapshotted Codex/Claude/OpenCode/etc. project rules as scoped candidates. */
export class AgentExternalMemoryImporter {
  constructor(
    private app: App,
    private getSettings: () => PersonalLifeSystemSettings,
    private store: AgentMemoryStore,
    private ai?: AiClient
  ) {}

  async importProject(projectId?: string): Promise<AgentExternalMemoryImportResult> {
    const settings = this.getSettings();
    const workspace = new AiWorkspaceService(
      this.app,
      new FileSystemService(this.app, settings.rootFolder, settings.directoryLanguage),
      settings,
      this.ai
    );
    const state = await workspace.loadState(true);
    const memories = state.projectMemories
      .filter((memory) => memory.status === "active")
      .filter((memory) => !projectId || memory.projectId === projectId)
      .slice(0, 160);
    const result: AgentExternalMemoryImportResult = {
      scanned: memories.length,
      added: 0,
      updated: 0,
      ignored: 0,
      errors: []
    };
    for (const memory of memories) {
      try {
        const versionPath = memory.versionPaths[Math.max(0, memory.currentVersion - 1)] || memory.versionPaths.at(-1);
        if (!versionPath) {
          result.ignored += 1;
          continue;
        }
        const file = this.app.vault.getAbstractFileByPath(versionPath);
        if (!(file instanceof TFile)) {
          result.ignored += 1;
          continue;
        }
        const raw = await this.app.vault.read(file);
        const content = this.readable(raw).slice(0, 12_000);
        if (!content) {
          result.ignored += 1;
          continue;
        }
        const sourceTool = memory.scope === "shared" ? "shared" : memory.scope;
        const outcome = await this.store.upsertCandidate({
          kind: "external",
          title: `${sourceTool} 项目记忆：${memory.relativePath || memory.sourcePath.split(/[\\/]/u).pop() || "规则"}`,
          content,
          keywords: tokenizeAgentMemory(`${memory.relativePath} ${content}`),
          scope: { projectScopeId: memory.projectId },
          authority: "external",
          confidence: memory.scope === "shared" ? 0.88 : 0.78,
          sourceTool,
          evidence: [{
            path: versionPath,
            excerpt: content.slice(0, 800),
            hash: memory.contentHash || agentMemoryHash(content),
            capturedAt: memory.capturedAt || new Date().toISOString()
          }]
        });
        result[outcome] += 1;
      } catch (error) {
        result.errors.push(String(error instanceof Error ? error.message : error).slice(0, 240));
      }
    }
    return result;
  }

  private readable(value: string): string {
    return String(value || "")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "")
      .replace(/^# .+\r?\n+/u, "")
      .replace(/> 这是 Life OS 保存的只读项目记忆快照[^\r\n]*\r?\n+/u, "")
      .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/giu, "[binary omitted]")
      .trim();
  }
}
