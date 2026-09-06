import type { AiMessage, AiMessageContent } from "../../ai";
import { emptyAgentWorkingCheckpoint, type AgentWorkingCheckpoint } from "./AgentMemoryTypes";

export interface AgentCompactionResult {
  messages: AiMessage[];
  compacted: boolean;
  beforeChars: number;
  afterChars: number;
  summary: string;
  checkpoint: AgentWorkingCheckpoint;
  droppedMessages: number;
}

export interface AgentCompactionOptions {
  maxChars: number;
  keepRecent?: number;
  taskMemory?: string;
  checkpoint?: AgentWorkingCheckpoint;
}

/**
 * Provider-independent structured compaction.
 * Stable intent, corrections, constraints and unresolved work are pinned in a
 * checkpoint instead of being flattened into a lossy transcript paragraph.
 */
export class AgentContextCompactor {
  compact(messages: AiMessage[], options: AgentCompactionOptions): AgentCompactionResult {
    const maxChars = Math.max(4_000, options.maxChars);
    const keepRecent = Math.max(2, options.keepRecent ?? 8);
    const beforeChars = this.totalChars(messages);
    const normalized = this.removeHistoricalImages(messages);
    const checkpoint = this.buildCheckpoint(normalized, options);
    if (this.totalChars(normalized) <= maxChars) {
      return {
        messages: normalized,
        compacted: false,
        beforeChars,
        afterChars: this.totalChars(normalized),
        summary: this.renderCheckpoint(checkpoint, ""),
        checkpoint,
        droppedMessages: messages.length - normalized.length
      };
    }

    const system = normalized.find((item) => item.role === "system");
    const nonSystem = normalized.filter((item) => item.role !== "system");
    const recent = nonSystem.slice(-keepRecent).map((item) => this.truncateMessage(item, 4_500));
    const old = nonSystem.slice(0, Math.max(0, nonSystem.length - keepRecent));
    const episodic = this.summarizeEpisodes(old, Math.min(3_600, Math.floor(maxChars * 0.2)));
    const summary = this.renderCheckpoint(checkpoint, episodic)
      .slice(0, Math.min(7_000, Math.floor(maxChars * 0.34)));
    const compacted: AiMessage[] = [
      ...(system ? [this.truncateMessage(system, Math.min(10_000, Math.floor(maxChars * 0.3)))] : []),
      ...(summary ? [{ role: "system" as const, content: `# 会话语义检查点（系统生成）\n${summary}` }] : []),
      ...recent
    ];
    while (this.totalChars(compacted) > maxChars && compacted.length > 2) compacted.splice(1, 1);
    if (this.totalChars(compacted) > maxChars) {
      for (let index = 0; index < compacted.length; index += 1) {
        compacted[index] = this.truncateMessage(compacted[index], Math.floor(maxChars / compacted.length));
      }
    }
    return {
      messages: compacted,
      compacted: true,
      beforeChars,
      afterChars: this.totalChars(compacted),
      summary,
      checkpoint,
      droppedMessages: Math.max(0, nonSystem.length - recent.length)
    };
  }

  renderCheckpoint(checkpoint: AgentWorkingCheckpoint, episodicSummary = ""): string {
    const rows = [
      checkpoint.objective ? `目标：${checkpoint.objective}` : "",
      checkpoint.activeWork ? `当前工作：${checkpoint.activeWork}` : "",
      this.row("已确认决定", checkpoint.decisions),
      this.row("必须遵守的约束", checkpoint.constraints),
      this.row("用户纠正（优先于旧上下文）", checkpoint.corrections),
      this.row("待核实/未解决", checkpoint.unresolved),
      this.row("下一步", checkpoint.nextActions),
      this.row("关键实体", checkpoint.entities),
      this.row("近期主题", checkpoint.recentTopics),
      this.row("证据引用", checkpoint.evidenceRefs),
      episodicSummary ? `历史过程（仅供追溯，不得覆盖上面的纠正和决定）：\n${episodicSummary}` : ""
    ].filter(Boolean);
    return rows.length ? rows.join("\n") : "当前没有需要跨压缩保留的状态。";
  }

  private buildCheckpoint(messages: AiMessage[], options: AgentCompactionOptions): AgentWorkingCheckpoint {
    const source = options.checkpoint || emptyAgentWorkingCheckpoint();
    const checkpoint: AgentWorkingCheckpoint = {
      objective: this.clean(source.objective, 800),
      activeWork: this.clean(source.activeWork, 800),
      decisions: this.unique(source.decisions),
      constraints: this.unique(source.constraints),
      corrections: this.unique(source.corrections),
      unresolved: this.unique(source.unresolved),
      nextActions: this.unique(source.nextActions),
      entities: this.unique(source.entities),
      recentTopics: this.unique(source.recentTopics),
      evidenceRefs: this.unique(source.evidenceRefs)
    };
    const task = String(options.taskMemory || "");
    const assign = (label: string, key: keyof AgentWorkingCheckpoint) => {
      const match = task.match(new RegExp(`(?:^|\\n)${label}：([^\\n]+)`, "u"))?.[1];
      if (!match) return;
      if (key === "objective" || key === "activeWork") checkpoint[key] = this.clean(match, 800);
      else checkpoint[key] = this.unique([...(checkpoint[key] as string[]), ...match.split(/[；;]/u)]);
    };
    assign("目标", "objective");
    assign("当前焦点", "activeWork");
    assign("已确认决定", "decisions");
    assign("约束与偏好", "constraints");
    assign("用户纠正", "corrections");
    assign("待核实", "unresolved");
    assign("下一步", "nextActions");
    assign("近期主题", "recentTopics");
    if (!checkpoint.objective) {
      const firstUser = messages.find((message) => message.role === "user");
      checkpoint.objective = this.clean(firstUser ? this.contentText(firstUser.content) : "", 800);
    }
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    if (latestUser) checkpoint.activeWork = this.clean(this.contentText(latestUser.content), 800);
    return checkpoint;
  }

  private removeHistoricalImages(messages: AiMessage[]): AiMessage[] {
    // buildMessages appends the current user turn after history. Preserve image
    // payloads only when that latest user turn itself contains them. An image
    // from an earlier turn must never become implicit context for a later text
    // follow-up, even when the final message happens to be an assistant/tool row.
    let latestUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        latestUserIndex = index;
        break;
      }
    }
    return messages.map((message, index) => {
      if (!Array.isArray(message.content) || index === latestUserIndex) return message;
      const text = message.content.filter((part) => part.type === "text");
      return { ...message, content: text.length ? text : "[历史附件已从活动上下文移除]" };
    });
  }

  private summarizeEpisodes(messages: AiMessage[], maxChars: number): string {
    const episodes = messages.map((message) => {
      const content = this.contentText(message.content).replace(/\s+/gu, " ").trim();
      return content ? `${message.role === "user" ? "用户" : "助手"}：${content.slice(0, 360)}` : "";
    }).filter(Boolean);
    return episodes.join("\n").slice(0, maxChars);
  }

  private truncateMessage(message: AiMessage, maxChars: number): AiMessage {
    if (typeof message.content === "string") return { ...message, content: message.content.slice(0, maxChars) };
    let remaining = maxChars;
    const content = message.content.map((part) => {
      if (part.type === "image_url") return part;
      const text = part.text.slice(0, remaining);
      remaining -= text.length;
      return { ...part, text };
    }).filter((part) => part.type === "image_url" || part.text.length > 0);
    return { ...message, content };
  }

  private row(label: string, items: string[]): string {
    return items.length ? `${label}：${items.join("；")}` : "";
  }

  private unique(items: string[], limit = 16): string[] {
    return Array.from(new Set(items.map((item) => this.clean(item, 320)).filter(Boolean))).slice(-limit);
  }

  private clean(value: unknown, max: number): string {
    return String(value || "")
      .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/giu, "[binary omitted]")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, max);
  }

  private totalChars(messages: AiMessage[]): number {
    return messages.reduce((sum, message) => sum + this.contentText(message.content).length, 0);
  }

  private contentText(content: AiMessageContent): string {
    return typeof content === "string"
      ? content
      : content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
  }
}
