export interface KeywordLinkOptions {
  title?: string;
  maxKeywords?: number;
}

export const KEYWORD_LINKS_SECTION_START = "<!-- lifeos-keyword-links:start -->";
export const KEYWORD_LINKS_SECTION_END = "<!-- lifeos-keyword-links:end -->";
export const KEYWORD_LINKS_HEADING = "## 关键词双链";

const DEFAULT_MAX_KEYWORDS = 12;
const KEYWORD_FRONTMATTER_KEYS = ["keywords", "keyword_links"];

const GENERIC_KEYWORDS = new Set([
  "ai",
  "api",
  "csv",
  "doc",
  "docx",
  "file",
  "json",
  "life",
  "markdown",
  "os",
  "pdf",
  "raw",
  "url",
  "web",
  "word",
  "个人",
  "今天",
  "内容",
  "分析",
  "导入",
  "文档",
  "文件",
  "正文",
  "知识",
  "知识库",
  "笔记",
  "系统",
  "资料",
  "项目",
  "页面",
  "摘要",
  "来源",
  "原始文件",
  "可检索正文",
  "导入说明",
  "关键词",
  "关键词双链",
  "关键概念"
]);

interface KeywordCandidate {
  value: string;
  score: number;
}

export function buildKeywordLinkedMarkdown(markdown: string, options: KeywordLinkOptions = {}): string {
  const source = String(markdown || "");
  const keywords = extractKeywordLinks(source, options);
  if (keywords.length === 0) return stripKeywordLinksSection(source).trimEnd() + "\n";
  const withFrontmatter = upsertKeywordFrontmatter(source, keywords);
  return upsertKeywordLinksSection(withFrontmatter, keywords).trimEnd() + "\n";
}

export function extractKeywordLinks(markdown: string, options: KeywordLinkOptions = {}): string[] {
  const source = String(markdown || "");
  const body = stripHiddenMetadata(stripFrontmatter(stripKeywordLinksSection(source)));
  const frontmatter = extractFrontmatterBlock(source);
  const candidates: KeywordCandidate[] = [];
  const maxKeywords = Math.max(1, options.maxKeywords ?? DEFAULT_MAX_KEYWORDS);
  const existingOrder = new Map<string, number>();
  extractGeneratedKeywordSectionLinks(source).forEach((value, index) => {
    existingOrder.set(normalizeKeywordKey(value), index);
  });

  addKeyword(candidates, options.title || inferTitleFromMarkdown(body), 100);
  for (const value of extractYamlListValues(frontmatter, "keywords")) addKeyword(candidates, value, 95);
  for (const value of extractYamlListValues(frontmatter, "tags")) addKeyword(candidates, value, 55);
  for (const value of extractExistingWikiLinks(body)) addKeyword(candidates, value, 90);
  for (const value of extractExplicitKeywordSections(body)) addKeyword(candidates, value, 85);
  for (const value of extractImportantPhrases(body)) addKeyword(candidates, value, 70);
  for (const value of extractHeadingPhrases(body)) addKeyword(candidates, value, 62);
  for (const value of extractEnglishTerms(body)) addKeyword(candidates, value, 35);

  const ranked = new Map<string, KeywordCandidate>();
  for (const candidate of candidates) {
    const value = normalizeKeywordTitle(candidate.value);
    if (!isUsefulKeyword(value)) continue;
    const key = normalizeKeywordKey(value);
    const previous = ranked.get(key);
    if (!previous || candidate.score > previous.score) {
      ranked.set(key, { value, score: candidate.score });
    }
  }

  return Array.from(ranked.values())
    .sort((a, b) => {
      const aIndex = existingOrder.get(normalizeKeywordKey(a.value));
      const bIndex = existingOrder.get(normalizeKeywordKey(b.value));
      if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
      if (aIndex !== undefined) return -1;
      if (bIndex !== undefined) return 1;
      return b.score - a.score || a.value.localeCompare(b.value, "zh-Hans-CN");
    })
    .slice(0, maxKeywords)
    .map((candidate) => candidate.value);
}

export function stripKeywordLinksSection(markdown: string): string {
  const source = String(markdown || "");
  const markerPattern = new RegExp(
    `${escapeRegExp(KEYWORD_LINKS_SECTION_START)}[\\s\\S]*?${escapeRegExp(KEYWORD_LINKS_SECTION_END)}\\s*`,
    "g"
  );
  return source.replace(markerPattern, "").replace(/\n{3,}/g, "\n\n");
}

function extractGeneratedKeywordSectionLinks(markdown: string): string[] {
  const source = String(markdown || "");
  const markerPattern = new RegExp(
    `${escapeRegExp(KEYWORD_LINKS_SECTION_START)}([\\s\\S]*?)${escapeRegExp(KEYWORD_LINKS_SECTION_END)}`,
    "m"
  );
  const section = source.match(markerPattern)?.[1] ?? "";
  return extractExistingWikiLinks(section);
}

function upsertKeywordLinksSection(markdown: string, keywords: string[]): string {
  const source = stripKeywordLinksSection(markdown).trimEnd();
  const section = [
    KEYWORD_LINKS_SECTION_START,
    KEYWORD_LINKS_HEADING,
    "",
    ...keywords.map((keyword) => `- [[${escapeWikiLinkTarget(keyword)}]]`),
    KEYWORD_LINKS_SECTION_END
  ].join("\n");

  const frontmatterMatch = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/);
  const frontmatter = frontmatterMatch?.[0] ?? "";
  const body = frontmatter ? source.slice(frontmatter.length).trimStart() : source;
  const headingMatch = body.match(/^#\s+.+(?:\r?\n|$)/m);
  if (headingMatch?.index !== undefined) {
    const insertAt = headingMatch.index + headingMatch[0].length;
    const nextBody = `${body.slice(0, insertAt).trimEnd()}\n\n${section}\n\n${body.slice(insertAt).trimStart()}`.trimEnd();
    return `${frontmatter}${nextBody}`;
  }

  return frontmatter
    ? `${frontmatter}${section}\n\n${body}`.trimEnd()
    : `${section}\n\n${body}`.trimEnd();
}

function upsertKeywordFrontmatter(markdown: string, keywords: string[]): string {
  const source = String(markdown || "");
  const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  const keywordLines = [
    "keywords:",
    ...keywords.map((keyword) => `  - ${yamlScalar(keyword)}`),
    "keyword_links:",
    ...keywords.map((keyword) => `  - ${yamlScalar(`[[${escapeWikiLinkTarget(keyword)}]]`)}`)
  ].join("\n");

  if (!frontmatterMatch) {
    return `---\n${keywordLines}\n---\n\n${source.trimStart()}`;
  }

  const frontmatter = removeYamlKeys(frontmatterMatch[1], KEYWORD_FRONTMATTER_KEYS).trimEnd();
  const nextFrontmatter = `${frontmatter}${frontmatter ? "\n" : ""}${keywordLines}`;
  return source.replace(frontmatterMatch[0], `---\n${nextFrontmatter}\n---\n`);
}

function removeYamlKeys(frontmatter: string, keys: string[]): string {
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  const lines = String(frontmatter || "").split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+):(?:\s.*)?$/);
    if (!keyMatch || !keySet.has(keyMatch[1].toLowerCase())) {
      kept.push(line);
      continue;
    }
    while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
      index += 1;
    }
  }
  return kept.join("\n");
}

function extractFrontmatterBlock(markdown: string): string {
  return String(markdown || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/)?.[1] ?? "";
}

function stripFrontmatter(markdown: string): string {
  return String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "");
}

function extractYamlListValues(frontmatter: string, key: string): string[] {
  const lines = String(frontmatter || "").split(/\r?\n/);
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`, "i"));
    if (!match) continue;
    values.push(...splitKeywordPhrase(match[1]));
    while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
      index += 1;
      values.push(...splitKeywordPhrase(lines[index].replace(/^\s+-\s+/, "")));
    }
  }
  return values;
}

function extractExistingWikiLinks(body: string): string[] {
  return Array.from(String(body || "").matchAll(/!?\[\[([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/g)).map((match) => match[1]);
}

function extractExplicitKeywordSections(body: string): string[] {
  const values: string[] = [];
  const lines = String(body || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const inline = line.match(/^(?:关键词|关键概念|Keywords?|Tags?)\s*[:：]\s*(.+)$/i);
    if (inline) values.push(...splitKeywordPhrase(inline[1]));

    if (/^#{1,4}\s*(?:关键词|关键概念|Keywords?|Tags?)\s*$/i.test(line)) {
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = lines[cursor].trim();
        if (/^#{1,4}\s+/.test(next)) break;
        values.push(...splitKeywordPhrase(next.replace(/^[-*]\s+/, "")));
      }
    }
  }
  return values;
}

function extractImportantPhrases(body: string): string[] {
  const text = stripCodeBlocks(body);
  const values: string[] = [];
  for (const match of text.matchAll(/《([^》]{2,40})》/g)) values.push(match[1]);
  for (const match of text.matchAll(/[“"]([^”"\n]{2,40})[”"]/g)) values.push(match[1]);
  for (const match of text.matchAll(/`([^`\n]{2,40})`/g)) values.push(match[1]);
  return values;
}

function extractHeadingPhrases(body: string): string[] {
  return Array.from(String(body || "").matchAll(/^#{1,3}\s+(.+)$/gm))
    .map((match) => match[1])
    .flatMap((value) => splitKeywordPhrase(value));
}

function extractEnglishTerms(body: string): string[] {
  const text = stripCodeBlocks(body);
  const values = new Map<string, number>();
  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[- ][A-Za-z0-9][A-Za-z0-9]*){0,3}\b/g)) {
    const value = normalizeKeywordTitle(match[0]);
    if (!isUsefulKeyword(value)) continue;
    values.set(value, (values.get(value) ?? 0) + 1);
  }
  return Array.from(values.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value);
}

function splitKeywordPhrase(value: string): string[] {
  const normalized = String(value || "")
    .replace(/!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, "$1")
    .replace(/^#+\s*/, "")
    .replace(/^[\-*]\s*/, "")
    .trim();
  if (!normalized) return [];
  return normalized
    .split(/[，,、；;|/]+/u)
    .map((item) => item.replace(/^#/, "").trim())
    .filter(Boolean);
}

function addKeyword(candidates: KeywordCandidate[], value: string, score: number): void {
  for (const item of splitKeywordPhrase(value)) {
    candidates.push({ value: item, score });
  }
}

function inferTitleFromMarkdown(markdown: string): string {
  return String(markdown || "").match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}

function normalizeKeywordTitle(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, "$1")
    .replace(/[#*_~`>]+/g, " ")
    .replace(/[\\/#^[\]|{}<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKeywordKey(value: string): string {
  return normalizeKeywordTitle(value).toLowerCase();
}

function isUsefulKeyword(value: string): boolean {
  const keyword = normalizeKeywordTitle(value);
  if (keyword.length < 2 || keyword.length > 48) return false;
  if (GENERIC_KEYWORDS.has(keyword.toLowerCase()) || GENERIC_KEYWORDS.has(keyword)) return false;
  if (/^https?:\/\//i.test(keyword)) return false;
  if (/^\d+(?:[.\-/:]\d+)*$/.test(keyword)) return false;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(keyword)) return false;
  if (/^[\p{P}\p{S}\s]+$/u.test(keyword)) return false;
  return true;
}

function stripCodeBlocks(markdown: string): string {
  return String(markdown || "").replace(/```[\s\S]*?```/g, " ");
}

function stripHiddenMetadata(markdown: string): string {
  return String(markdown || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^#{1,3}\s+Accepted Draft\s+\d{4}-\d{2}-\d{2}T[^\n]*$/gim, " ");
}

function escapeWikiLinkTarget(value: string): string {
  return normalizeKeywordTitle(value).replace(/\|/g, " ").replace(/\n/g, " ").trim();
}

function yamlScalar(value: string): string {
  const clean = String(value || "").replace(/\r?\n/g, " ").trim();
  if (!clean) return "\"\"";
  if (/[:#\[\]{}]|^\s|\s$|^(true|false|null|~)$/i.test(clean)) {
    return JSON.stringify(clean);
  }
  return clean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
