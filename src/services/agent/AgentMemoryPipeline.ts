import type { AiClient } from "../../ai";
import {
  normalizeAgentMemoryMaxItemsPerSession,
  normalizeAgentMemoryMaxSessionsPerRun,
  normalizeAgentMemoryScopeMode,
  type PersonalLifeSystemSettings
} from "../../settings";
import {
  agentMemoryHash,
  AgentMemoryStore,
  tokenizeAgentMemory
} from "./AgentMemoryStore";
import type {
  AgentMemoryCandidate,
  AgentMemoryExtractionJob,
  AgentMemoryKind,
  AgentMemoryScope
} from "./AgentMemoryTypes";
import { buildAgentMemoryScope } from "./AgentMemoryTypes";
import type { LifeOSAgentChannel, LifeOSAgentToolResult } from "./LifeOSAgentTypes";

export interface AgentMemoryTurnInput {
  sessionId: string;
  turnId: string;
  channel: LifeOSAgentChannel;
  projectScopeId: string;
  accountScopeId?: string;
  userContent: string;
  assistantContent: string;
  toolResults?: LifeOSAgentToolResult[];
}

export interface AgentMemoryPipelineResult {
  claimed: number;
  completed: number;
  failed: number;
  added: number;
  updated: number;
}

interface ExtractedMemoryRow {
  kind?: unknown;
  title?: unknown;
  content?: unknown;
  keywords?: unknown;
  confidence?: unknown;
  durable?: unknown;
}

const MEMORY_KINDS = new Set<AgentMemoryKind>([
  "preference",
  "fact",
  "decision",
  "procedure",
  "correction",
  "open-loop",
  "workflow",
  "external"
]);

/**
 * Two-phase generated-memory pipeline.
 *
 * Phase 1 records an idempotent, restart-safe extraction job after a turn.
 * Phase 2 runs outside the answer critical path, extracts only durable facts,
 * then lets AgentMemoryStore consolidate duplicates and corrections.
 */
export class AgentMemoryPipeline {
  private running: Promise<AgentMemoryPipelineResult> | null = null;
  private scheduled = false;

  constructor(
    private ai: AiClient,
    private store: AgentMemoryStore,
    private getSettings: () => Partial<PersonalLifeSystemSettings>
  ) {}

  async enqueueTurn(input: AgentMemoryTurnInput): Promise<boolean> {
    const userContent = this.clean(input.userContent, 8_000);
    const assistantContent = this.clean(input.assistantContent, 8_000);
    if (!userContent || !assistantContent) return false;
    const fingerprint = agentMemoryHash([
      input.sessionId,
      input.turnId,
      userContent,
      assistantContent
    ].join("|"));
    const now = new Date().toISOString();
    const job: AgentMemoryExtractionJob = {
      id: `extract-${fingerprint}`,
      fingerprint,
      sessionId: input.sessionId,
      turnId: input.turnId,
      channel: input.channel,
      projectScopeId: this.clean(input.projectScopeId, 180),
      ...(input.accountScopeId ? { accountScopeId: this.clean(input.accountScopeId, 220) } : {}),
      userContent,
      assistantContent,
      toolSummaries: (input.toolResults || []).map((result) =>
        `${result.toolId}: ${this.clean(result.ok ? result.output : result.error, 600)}`
      ).filter(Boolean).slice(0, 20),
      status: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
    const inserted = await this.store.enqueue(job);
    if (inserted) this.schedule();
    return inserted;
  }

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      void this.processPending().catch(() => undefined);
    }, 40);
  }

  async processPending(limit?: number): Promise<AgentMemoryPipelineResult> {
    if (this.running) return this.running;
    this.running = this.processClaimed(limit).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async processClaimed(limit?: number): Promise<AgentMemoryPipelineResult> {
    const settings = this.getSettings();
    const maxJobs = limit ?? normalizeAgentMemoryMaxSessionsPerRun(settings.agentMemoryMaxSessionsPerRun);
    const jobs = await this.store.claimJobs(maxJobs);
    const result: AgentMemoryPipelineResult = {
      claimed: jobs.length,
      completed: 0,
      failed: 0,
      added: 0,
      updated: 0
    };
    for (const job of jobs) {
      try {
        const candidates = await this.extract(job);
        const outcome = await this.store.completeJob(job.id, candidates);
        result.completed += 1;
        result.added += outcome.added;
        result.updated += outcome.updated;
        if (settings.agentMemoryAutoSkillSuggestions !== false) {
          await this.captureWorkflowSuggestions(candidates);
        }
      } catch (error) {
        result.failed += 1;
        await this.store.failJob(job.id, error);
      }
    }
    return result;
  }

  private async extract(job: AgentMemoryExtractionJob): Promise<AgentMemoryCandidate[]> {
    const scope: AgentMemoryScope = buildAgentMemoryScope(
      normalizeAgentMemoryScopeMode(this.getSettings().agentMemoryScopeMode),
      job.projectScopeId,
      job.channel,
      job.accountScopeId
    );
    const evidence = [{
      sessionId: job.sessionId,
      turnId: job.turnId,
      excerpt: this.clean(`用户：${job.userContent}\n助手：${job.assistantContent}`, 800),
      hash: agentMemoryHash(`${job.sessionId}|${job.turnId}|${job.userContent}|${job.assistantContent}`),
      capturedAt: job.updatedAt
    }];
    const heuristic = this.heuristicCandidates(job, scope).map((candidate) => ({ ...candidate, evidence }));
    const maxItems = normalizeAgentMemoryMaxItemsPerSession(this.getSettings().agentMemoryMaxItemsPerSession);
    if (!this.ai.isConfigured()) return heuristic.slice(0, maxItems);

    const response = await this.ai.complete({
      responseFormat: "json",
      temperature: 0,
      skipModelCheck: true,
      messages: [
        {
          role: "system",
          content: [
            "你是 Life OS 的后台记忆提取器，不回答用户。",
            "只提取未来跨会话仍有价值、且能由本轮原文直接证明的信息。",
            "允许类型：preference、fact、decision、procedure、correction、open-loop、workflow。",
            "不要保存寒暄、一次性问题、模型自己的建议、未核实猜测、秘密、令牌、绝对路径或图片二进制。",
            "correction 只保存用户明确纠正；preference 只保存用户明确表达的稳定偏好。",
            `最多 ${maxItems} 条。若没有应保存内容，返回 {\"items\":[]}。`,
            "只输出 JSON：{\"items\":[{\"kind\":\"...\",\"title\":\"...\",\"content\":\"...\",\"keywords\":[\"...\"],\"confidence\":0.0,\"durable\":true}]}"
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `会话范围：${job.projectScopeId ? `项目 ${job.projectScopeId}` : "全局"}`,
            `用户原文：${job.userContent}`,
            `助手结果：${job.assistantContent}`,
            job.toolSummaries.length ? `已执行工具：\n${job.toolSummaries.join("\n")}` : ""
          ].filter(Boolean).join("\n\n")
        }
      ]
    });
    if (!response.ok || !response.text) return heuristic.slice(0, maxItems);
    const parsed = this.parseRows(response.text);
    const modelCandidates = parsed.map((row) => this.toCandidate(row, scope, evidence)).filter((item): item is AgentMemoryCandidate => Boolean(item));
    return this.dedupe([...heuristic, ...modelCandidates]).slice(0, maxItems);
  }

  private heuristicCandidates(job: AgentMemoryExtractionJob, scope: AgentMemoryScope): AgentMemoryCandidate[] {
    const text = job.userContent;
    const candidates: AgentMemoryCandidate[] = [];
    const append = (kind: AgentMemoryKind, title: string, content: string, confidence: number) => {
      const clean = this.clean(content, 1_200);
      if (clean.length < 3) return;
      candidates.push({
        kind,
        title: this.clean(title, 120),
        content: clean,
        keywords: tokenizeAgentMemory(clean),
        scope,
        confidence,
        evidence: []
      });
    };
    const preference = text.match(/(?:我希望|我更喜欢|我的偏好是|以后请|默认请|不要再|务必)[：:]?\s*(.{3,320})/u)?.[1];
    if (preference) append("preference", "用户明确偏好", preference, 0.82);
    const correction = text.match(/(?:不是|并非|纠正|你理解错了|应该是|改为)[：:]?\s*(.{3,320})/u)?.[1];
    if (correction) append("correction", "用户纠正", correction, 0.9);
    const decision = text.match(/(?:决定|确定|采用|选择|最终用|就按)[：:]?\s*(.{3,320})/u)?.[1];
    if (decision) append("decision", "已确认决定", decision, 0.82);
    const openLoop = text.match(/(?:下一步|待办|还需要|尚未|仍需|记得)[：:]?\s*(.{3,320})/u)?.[1];
    if (openLoop) append("open-loop", "待继续事项", openLoop, 0.72);
    const workflow = text.match(/(?:每次|每天|每周|固定流程|以后遇到).{0,40}(?:先|自动|都要|然后)(.{3,360})/u)?.[0];
    if (workflow) append("workflow", "可复用工作流", workflow, 0.72);
    return candidates;
  }

  private parseRows(value: string): ExtractedMemoryRow[] {
    const clean = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
    try {
      const parsed = JSON.parse(clean) as { items?: unknown } | unknown[];
      const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? (parsed as { items?: unknown }).items : [];
      return Array.isArray(items) ? items.filter((item): item is ExtractedMemoryRow => Boolean(item && typeof item === "object")) : [];
    } catch {
      return [];
    }
  }

  private toCandidate(
    row: ExtractedMemoryRow,
    scope: AgentMemoryScope,
    evidence: AgentMemoryCandidate["evidence"]
  ): AgentMemoryCandidate | null {
    if (row.durable === false) return null;
    const kind = String(row.kind || "") as AgentMemoryKind;
    const content = this.clean(row.content, 1_200);
    if (!MEMORY_KINDS.has(kind) || content.length < 3) return null;
    const confidence = Math.max(0, Math.min(1, Number(row.confidence) || 0));
    if (confidence < 0.5) return null;
    const keywords = Array.isArray(row.keywords)
      ? row.keywords.map((item) => this.clean(item, 48).toLocaleLowerCase()).filter(Boolean)
      : [];
    return {
      kind,
      title: this.clean(row.title, 120) || content.slice(0, 60),
      content,
      keywords: Array.from(new Set([...keywords, ...tokenizeAgentMemory(content)])).slice(0, 40),
      scope,
      confidence,
      evidence
    };
  }

  private dedupe(candidates: AgentMemoryCandidate[]): AgentMemoryCandidate[] {
    const found = new Map<string, AgentMemoryCandidate>();
    for (const candidate of candidates) {
      const fingerprint = agentMemoryHash([
        candidate.kind,
        candidate.content.toLocaleLowerCase(),
        candidate.scope.projectScopeId || "global",
        candidate.scope.channel || "any",
        candidate.scope.accountId || "any"
      ].join("|"));
      const current = found.get(fingerprint);
      if (!current || candidate.confidence > current.confidence) found.set(fingerprint, candidate);
    }
    return Array.from(found.values());
  }

  private async captureWorkflowSuggestions(candidates: AgentMemoryCandidate[]): Promise<void> {
    for (const candidate of candidates.filter((item) => item.kind === "workflow" || item.kind === "procedure")) {
      const fingerprint = agentMemoryHash(candidate.content.toLocaleLowerCase());
      await this.store.addSkillSuggestion({
        title: candidate.title || "将重复流程保存为 Skill",
        reason: `该流程已重复出现，可沉淀为可复用 Skill：${candidate.content.slice(0, 220)}`,
        examplePrompt: candidate.content,
        occurrences: 1,
        status: "candidate",
        fingerprint
      });
    }
  }

  private clean(value: unknown, max: number): string {
    return String(value || "")
      .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/giu, "[binary omitted]")
      .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{12,}/giu, "[secret omitted]")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, max);
  }
}
