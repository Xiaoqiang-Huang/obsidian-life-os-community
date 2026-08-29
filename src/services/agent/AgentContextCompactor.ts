import type { AiMessage, AiMessageContent } from "../../ai";

export interface AgentCompactionResult {
  messages: AiMessage[];
  compacted: boolean;
  beforeChars: number;
  afterChars: number;
  summary: string;
  droppedMessages: number;
}

/** Provider-independent compaction with deterministic emergency fallback. */
export class AgentContextCompactor {
  compact(
    messages: AiMessage[],
    options: { maxChars: number; keepRecent?: number; taskMemory?: string }
  ): AgentCompactionResult {
    const maxChars = Math.max(4_000, options.maxChars);
    const keepRecent = Math.max(2, options.keepRecent ?? 8);
    const beforeChars = this.totalChars(messages);
    const normalized = this.removeHistoricalImages(messages);
    if (this.totalChars(normalized) <= maxChars) {
      return {
        messages: normalized,
        compacted: false,
        beforeChars,
        afterChars: this.totalChars(normalized),
        summary: "",
        droppedMessages: messages.length - normalized.length
      };
    }

    const system = normalized.find((item) => item.role === "system");
    const nonSystem = normalized.filter((item) => item.role !== "system");
    const recent = nonSystem.slice(-keepRecent).map((item) => this.truncateMessage(item, 4_500));
    const old = nonSystem.slice(0, Math.max(0, nonSystem.length - keepRecent));
    const summary = this.summarize(old, options.taskMemory || "", Math.min(5_000, Math.floor(maxChars * 0.28)));
    const compacted: AiMessage[] = [
      ...(system ? [this.truncateMessage(system, Math.min(10_000, Math.floor(maxChars * 0.3)))] : []),
      ...(summary ? [{ role: "system" as const, content: `# 会话压缩摘要\n${summary}` }] : []),
      ...recent
    ];
    while (this.totalChars(compacted) > maxChars && compacted.length > 2) compacted.splice(1, 1);
    if (this.totalChars(compacted) > maxChars) {
      for (let index = 0; index < compacted.length; index += 1) compacted[index] = this.truncateMessage(compacted[index], Math.floor(maxChars / compacted.length));
    }
    return {
      messages: compacted,
      compacted: true,
      beforeChars,
      afterChars: this.totalChars(compacted),
      summary,
      droppedMessages: Math.max(0, messages.length - compacted.length)
    };
  }

  private removeHistoricalImages(messages: AiMessage[]): AiMessage[] {
    const currentTurnIndex = messages.length - 1;
    return messages.map((message, index) => {
      if (!Array.isArray(message.content) || index === currentTurnIndex) return message;
      const text = message.content.filter((part) => part.type === "text");
      return { ...message, content: text.length ? text : "[历史附件已从活动上下文移除]" };
    });
  }

  private summarize(messages: AiMessage[], taskMemory: string, maxChars: number): string {
    const episodes = messages.map((message) => {
      const content = this.contentText(message.content).replace(/\s+/gu, " ").trim();
      return content ? `${message.role === "user" ? "用户" : "助手"}：${content.slice(0, 420)}` : "";
    }).filter(Boolean);
    return [taskMemory ? `结构化任务记忆：\n${taskMemory}` : "", episodes.join("\n")]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, maxChars);
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

  private totalChars(messages: AiMessage[]): number {
    return messages.reduce((sum, message) => sum + this.contentText(message.content).length, 0);
  }

  private contentText(content: AiMessageContent): string {
    return typeof content === "string"
      ? content
      : content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
  }
}
