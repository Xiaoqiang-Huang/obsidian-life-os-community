import type { ContextEngineMode, ContextEngineResult, ContextSection, ContextSource } from "./types";

interface ComposeInput {
  userMessage: string;
  modeUsed: ContextEngineMode;
  maxChars: number;
  sections: ContextSection[];
  warnings: string[];
}

const MAX_EVIDENCE_SECTION_CHARS = 1900;
const MAX_CONTEXT_SECTION_CHARS = 3200;

export class ContextComposer {
  compose(input: ComposeInput): ContextEngineResult {
    const warnings = [...input.warnings];
    const sortedSections = input.sections
      .filter((section) => section.kind !== "diagnostic")
      .sort((a, b) => b.priority - a.priority);
    const includedSections: ContextSection[] = [];
    const sources: ContextSource[] = [];
    const sourceByKey = new Map<string, ContextSource>();
    const maxChars = Math.max(0, input.maxChars);
    let promptContext = ["# 用户当前问题", input.userMessage, "", "# Life OS 相关证据"].join("\n");

    for (const section of sortedSections) {
      const rawSource = this.sourceFor(section, section.content);
      const source = rawSource ? this.withCitation(rawSource, sourceByKey) : null;
      const header = this.sectionHeader(section, source);
      const remaining = maxChars - promptContext.length - header.length;
      if (remaining <= 24) {
        this.addWarning(warnings, "上下文预算不足，部分低优先级内容未注入。");
        continue;
      }

      const sectionCap = section.kind === "evidence" ? MAX_EVIDENCE_SECTION_CHARS : MAX_CONTEXT_SECTION_CHARS;
      const allowed = Math.min(remaining, sectionCap);
      const wasTruncated = section.content.length > allowed;
      const content = this.safeSlice(section.content, allowed);
      if (!content.trim()) continue;
      const includedSource = source ? { ...source, excerpt: content } : null;
      if (includedSource) sourceByKey.set(this.sourceKey(includedSource), includedSource);

      promptContext += `${header}${content}`;
      includedSections.push({ ...section, content, sourceInfo: includedSource ?? section.sourceInfo });
      if (includedSource && !sources.some((item) => this.sourceKey(item) === this.sourceKey(includedSource))) {
        sources.push(includedSource);
      }
      if (wasTruncated) this.addWarning(warnings, `“${section.title}”已按上下文预算截取相关片段。`);
    }

    if (promptContext.length > maxChars) {
      promptContext = this.safeSlice(promptContext, maxChars);
      this.addWarning(warnings, "上下文预算不足，最终提示已截断。");
    }

    const includedKeys = new Set(includedSections
      .map((section) => section.sourceInfo ? this.sourceKey(section.sourceInfo) : "")
      .filter(Boolean));
    const includedSources = sources.filter((source) => includedKeys.has(this.sourceKey(source)));

    return {
      promptContext,
      sections: includedSections,
      sources: includedSources,
      confidence: this.confidence(includedSections, warnings),
      warnings,
      modeUsed: input.modeUsed
    };
  }

  private sectionHeader(section: ContextSection, source: ContextSource | null): string {
    if (!source) return `\n\n## ${section.title}\n`;
    const locator = this.locator(source);
    return [
      "",
      "",
      `## [${source.citationId}] ${section.title}`,
      `来源：[${source.citationId}] ${source.path}`,
      locator ? `定位：${locator}` : ""
    ].filter((line, index) => line || index < 2).join("\n") + "\n";
  }

  private withCitation(
    source: ContextSource,
    sourceByKey: Map<string, ContextSource>
  ): ContextSource {
    const key = this.sourceKey(source);
    const existing = sourceByKey.get(key);
    if (existing) return existing;
    const cited = { ...source, citationId: `S${sourceByKey.size + 1}` };
    sourceByKey.set(key, cited);
    return cited;
  }

  private sourceFor(section: ContextSection, content: string): ContextSource | null {
    if (section.sourceInfo) return { ...section.sourceInfo };
    if (!section.source) return null;
    const path = section.source;
    return {
      path,
      title: this.titleFromPath(path) || section.title,
      type: this.sourceType(path),
      excerpt: content.slice(0, 240)
    };
  }

  private sourceKey(source: ContextSource): string {
    return source.chunkId
      ? `${source.path}#${source.chunkId}`
      : `${source.path}:${source.heading ?? ""}:${source.lineStart ?? ""}:${source.lineEnd ?? ""}`;
  }

  private locator(source: ContextSource): string {
    const parts: string[] = [];
    if (source.page) parts.push(`第 ${source.page} 页`);
    if (source.heading) parts.push(source.heading);
    if (source.lineStart) {
      parts.push(source.lineEnd && source.lineEnd !== source.lineStart
        ? `第 ${source.lineStart}-${source.lineEnd} 行`
        : `第 ${source.lineStart} 行`);
    }
    return parts.join(" · ");
  }

  private confidence(sections: ContextSection[], warnings: string[]): number {
    const evidenceCount = sections.filter((section) => section.kind === "evidence").length;
    const evidenceBoost = Math.min(0.42, evidenceCount * 0.08 + sections.length * 0.035);
    const warningPenalty = Math.min(0.3, warnings.length * 0.06);
    return Math.max(0.1, Math.min(0.96, 0.48 + evidenceBoost - warningPenalty));
  }

  private safeSlice(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 1) return value.slice(0, Math.max(0, maxChars));
    const sliced = value.slice(0, maxChars - 1);
    const breakAt = Math.max(sliced.lastIndexOf("\n"), sliced.lastIndexOf("。"), sliced.lastIndexOf(" "));
    return `${(breakAt > maxChars * 0.55 ? sliced.slice(0, breakAt + 1) : sliced).trimEnd()}…`;
  }

  private addWarning(warnings: string[], warning: string): void {
    if (!warnings.includes(warning)) warnings.push(warning);
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
    if (lower.includes("/projects/")) return "project";
    if (lower.includes("/knowledge/llmwiki/")) return "llm-wiki";
    if (lower.includes("/memory/")) return "memory";
    if (lower.includes("/knowledge/")) return "knowledge";
    if (/^https?:\/\//i.test(path) || path.startsWith("web-search:")) return "url";
    return "graph";
  }
}
