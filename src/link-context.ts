import { TFile, type App } from "obsidian";

export type LinkDirection = "outbound" | "inbound" | "both";

export interface LinkedNoteContext {
  file: TFile;
  direction: LinkDirection;
  linkCount: number;
  excerpt: string;
}

export interface NoteLinkContext {
  source: TFile;
  outboundCount: number;
  inboundCount: number;
  notes: LinkedNoteContext[];
}

export interface LinkContextOptions {
  maxNotes?: number;
  maxCharsPerNote?: number;
  includeOutbound?: boolean;
  includeInbound?: boolean;
  focusText?: string;
}

interface LinkCandidate {
  path: string;
  inboundCount: number;
  outboundCount: number;
  score: number;
}

export async function buildNoteLinkContext(
  app: App,
  source: TFile,
  options: LinkContextOptions = {}
): Promise<NoteLinkContext> {
  const maxNotes = options.maxNotes ?? 8;
  const maxCharsPerNote = options.maxCharsPerNote ?? 500;
  const includeOutbound = options.includeOutbound ?? true;
  const includeInbound = options.includeInbound ?? true;
  const focusTerms = extractFocusTerms(`${source.basename} ${options.focusText ?? ""}`);
  const candidates = collectLinkCandidates(app, source, includeOutbound, includeInbound, focusTerms);

  const notes: LinkedNoteContext[] = [];
  for (const candidate of candidates.slice(0, maxNotes)) {
    const abstract = app.vault.getAbstractFileByPath(candidate.path);
    if (!(abstract instanceof TFile)) continue;

    const content = await app.vault.read(abstract);
    const excerpt = createExcerpt(content, maxCharsPerNote);
    if (!excerpt) continue;

    notes.push({
      file: abstract,
      direction: getDirection(candidate),
      linkCount: candidate.inboundCount + candidate.outboundCount,
      excerpt
    });
  }

  const outboundCount = Object.keys(app.metadataCache.resolvedLinks[source.path] ?? {}).length;
  const inboundCount = Object.values(app.metadataCache.resolvedLinks)
    .filter((destinations) => Boolean(destinations[source.path]))
    .length;

  return {
    source,
    outboundCount,
    inboundCount,
    notes
  };
}

export function formatLinkContextForPrompt(context: NoteLinkContext | null): string {
  if (!context || context.notes.length === 0) return "";

  const lines = [
    "Obsidian 入链/出链上下文：",
    `来源笔记：${context.source.path}`,
    `已解析出链 ${context.outboundCount} 个，入链 ${context.inboundCount} 个。`
  ];

  for (const note of context.notes) {
    lines.push(
      `\n### ${directionLabel(note.direction)}：${note.file.path}（链接强度 ${note.linkCount}）`,
      note.excerpt
    );
  }

  return `\n\n${lines.join("\n")}`;
}

export function formatLinkContextForMarkdown(context: NoteLinkContext | null): string {
  if (!context || context.notes.length === 0) return "";

  const lines = [
    "## 🔗 Obsidian 链接网络",
    "",
    `> 已读取今日笔记的 ${context.outboundCount} 个出链、${context.inboundCount} 个入链，并作为本次 AI 生成的知识网络上下文。`,
    ""
  ];

  for (const note of context.notes.slice(0, 8)) {
    lines.push(`- ${directionLabel(note.direction)}：[[${note.file.path.replace(/\.md$/i, "")}]]`);
  }

  return lines.join("\n");
}

function collectLinkCandidates(
  app: App,
  source: TFile,
  includeOutbound: boolean,
  includeInbound: boolean,
  focusTerms: string[]
): LinkCandidate[] {
  const byPath = new Map<string, LinkCandidate>();
  const ensure = (path: string): LinkCandidate => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const candidate = { path, inboundCount: 0, outboundCount: 0, score: 0 };
    byPath.set(path, candidate);
    return candidate;
  };

  if (includeOutbound) {
    const outbound = app.metadataCache.resolvedLinks[source.path] ?? {};
    for (const [path, count] of Object.entries(outbound)) {
      if (path === source.path) continue;
      const candidate = ensure(path);
      candidate.outboundCount += count;
    }
  }

  if (includeInbound) {
    for (const [sourcePath, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (sourcePath === source.path) continue;
      const count = destinations[source.path] ?? 0;
      if (count <= 0) continue;
      const candidate = ensure(sourcePath);
      candidate.inboundCount += count;
    }
  }

  for (const candidate of byPath.values()) {
    const abstract = app.vault.getAbstractFileByPath(candidate.path);
    if (!(abstract instanceof TFile)) {
      candidate.score = -Infinity;
      continue;
    }
    candidate.score = scoreCandidate(abstract, candidate, focusTerms);
  }

  return Array.from(byPath.values())
    .filter((candidate) => candidate.score > -Infinity)
    .sort((a, b) => b.score - a.score);
}

function scoreCandidate(file: TFile, candidate: LinkCandidate, focusTerms: string[]): number {
  let score = candidate.outboundCount * 12 + candidate.inboundCount * 10;
  if (candidate.outboundCount > 0 && candidate.inboundCount > 0) score += 18;
  score += Math.min(12, Math.max(0, (Date.now() - file.stat.mtime) / -86400000 + 12));

  const haystack = `${file.basename} ${file.path}`.toLowerCase();
  for (const term of focusTerms) {
    if (term.length >= 2 && haystack.includes(term.toLowerCase())) {
      score += 10;
    }
  }
  return score;
}

function getDirection(candidate: LinkCandidate): LinkDirection {
  if (candidate.outboundCount > 0 && candidate.inboundCount > 0) return "both";
  return candidate.outboundCount > 0 ? "outbound" : "inbound";
}

function directionLabel(direction: LinkDirection): string {
  if (direction === "both") return "双向关联";
  return direction === "outbound" ? "出链" : "入链";
}

function extractFocusTerms(text: string): string[] {
  const terms = text
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term.length <= 24);
  return Array.from(new Set(terms)).slice(0, 12);
}

function createExcerpt(content: string, maxChars: number): string {
  const body = content
    .replace(/^---[\s\S]*?---\n*/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("![[") && !line.startsWith("![]("))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars).trim()}...`;
}
