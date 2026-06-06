import type { ContextEngineMode, ContextEngineResult, ContextSection, ContextSource } from "./types";

interface ComposeInput {
  userMessage: string;
  modeUsed: ContextEngineMode;
  maxChars: number;
  sections: ContextSection[];
  warnings: string[];
}

export class ContextComposer {
  compose(input: ComposeInput): ContextEngineResult {
    const warnings = [...input.warnings];
    const sortedSections = [...input.sections].sort((a, b) => b.priority - a.priority);
    const includedSections: ContextSection[] = [];
    const sources: ContextSource[] = [];
    const maxChars = Math.max(0, input.maxChars);
    let promptContext = [`# 用户当前问题`, input.userMessage, "", "# Life OS 上下文"].join("\n");

    for (const section of sortedSections) {
      const baseHeader = `\n\n## ${section.title}\n`;
      const remaining = maxChars - promptContext.length - baseHeader.length;
      if (remaining <= 0) {
        warnings.push("上下文预算不足，部分内容已截断。");
        break;
      }

      const wasTruncated = section.content.length > remaining;
      const content = wasTruncated ? section.content.slice(0, remaining) : section.content;
      promptContext += `${baseHeader}${content}`;
      includedSections.push({ ...section, content });
      const source = this.sourceFor(section, content);
      if (source) sources.push(source);
      if (wasTruncated) {
        warnings.push("上下文预算不足，内容已截断。");
        break;
      }
    }

    if (promptContext.length > maxChars) {
      promptContext = promptContext.slice(0, maxChars);
      warnings.push("上下文预算不足，最终 prompt 已截断。");
    }

    return {
      promptContext,
      sections: includedSections,
      sources: this.uniqueSources(sources),
      confidence: this.confidence(includedSections, warnings),
      warnings,
      modeUsed: input.modeUsed
    };
  }

  private sourceFor(section: ContextSection, content: string): ContextSource | null {
    if (section.sourceInfo) return section.sourceInfo;
    if (!section.source) return null;
    const path = section.source;
    return {
      path,
      title: this.titleFromPath(path) || section.title,
      type: this.sourceType(path),
      excerpt: content.slice(0, 240)
    };
  }

  private uniqueSources(sources: ContextSource[]): ContextSource[] {
    const seen = new Set<string>();
    return sources.filter((source) => {
      if (!source.path || seen.has(source.path)) return false;
      seen.add(source.path);
      return true;
    });
  }

  private confidence(sections: ContextSection[], warnings: string[]): number {
    const evidenceBoost = Math.min(0.45, sections.length * 0.15);
    const warningPenalty = Math.min(0.35, warnings.length * 0.1);
    return Math.max(0.1, Math.min(0.95, 0.45 + evidenceBoost - warningPenalty));
  }

  private titleFromPath(path: string): string {
    const filename = path.split("/").pop() ?? "";
    return filename.replace(/\.md$/i, "");
  }

  private sourceType(path: string): ContextSource["type"] {
    const lower = path.toLowerCase();
    if (lower.includes("/memory/summaries/") || lower.includes("summary") || lower.includes("/weekly/") || lower.includes("/monthly/")) return "summary";
    if (lower.includes("/daily/")) return "daily";
    if (lower.includes("/tasks/")) return "task";
    if (lower.includes("/knowledge/llmwiki/")) return "llm-wiki";
    if (lower.includes("/memory/")) return "memory";
    if (lower.includes("/knowledge/")) return "knowledge";
    return "graph";
  }
}
