import type { DirectoryLanguage } from "../settings";
import { localizeLifeOsPathParts, normalizeDirectoryLanguage } from "../settings";
import { today } from "../utils/dates";

export interface KnowledgeWritebackCandidate {
  title: string;
  targetPath: string;
  content: string;
}

export interface MemoryWritebackCandidate {
  title: string;
  targetPath: string;
  content: string;
  category: string;
  importance: "low" | "normal" | "high";
}

export interface KnowledgeWritebackParseOptions {
  rootFolder: string;
  directoryLanguage?: DirectoryLanguage;
  fallbackDate?: string;
}

const AI_GENERATED_FOOTER_PATTERN = /(?:^|\n)\s*(?:AI生成|AI Generated)\s*$/iu;

export function parseKnowledgeWritebackCandidate(
  content: string,
  options: KnowledgeWritebackParseOptions
): KnowledgeWritebackCandidate | null {
  const cleanedContent = stripAiGeneratedFooter(content);
  if (!/(知识库|Knowledge|LLM\s*Wiki)/iu.test(cleanedContent) || !/建议路径[：:]/u.test(cleanedContent)) return null;
  const pathMatch = cleanedContent.match(/建议路径[：:]\s*`?([^\n`]+?\.md)`?/iu);
  if (!pathMatch) return null;
  const targetPath = resolveKnowledgeWritebackPath(pathMatch[1], options);
  if (!targetPath) return null;

  const fenced = cleanedContent.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/i);
  const body = stripAiGeneratedFooter(fenced?.[1]?.trim() || extractKnowledgeWritebackBody(cleanedContent, pathMatch.index ?? 0));
  if (!body.trim()) return null;
  return {
    title: knowledgeWritebackTitle(body),
    targetPath,
    content: body
  };
}

export function parseMemoryWritebackCandidate(
  content: string,
  options: KnowledgeWritebackParseOptions
): MemoryWritebackCandidate | null {
  const cleanedContent = stripAiGeneratedFooter(content);
  const marker = cleanedContent.search(/最终写回预览[：:]\s*(记忆候选|长期记忆|记忆)/u);
  if (marker < 0) return null;

  const source = cleanedContent.slice(marker);
  const fenced = source.match(/```(?:markdown|md|text)?\s*\n([\s\S]*?)```/i);
  const body = stripAiGeneratedFooter(fenced?.[1]?.trim() || extractMemoryWritebackBody(source));
  const contentLine = firstUsefulMemoryLine(body);
  if (!contentLine) return null;

  const category = extractLabeledValue(source, /(?:分类|类别|category)[：:]\s*([^\n]+)/iu) || "其他";
  const importanceRaw = extractLabeledValue(source, /(?:重要性|importance)[：:]\s*([^\n]+)/iu) || "";
  const importance = /high|important|重要|高/u.test(importanceRaw)
    ? "high"
    : /low|低/u.test(importanceRaw)
      ? "low"
      : "normal";
  const language = normalizeDirectoryLanguage(options.directoryLanguage);
  const targetPath = joinLocalPath(
    options.rootFolder,
    ...localizeLifeOsPathParts(["Memory", "Inbox", "pending-memories.md"], language)
  );

  return {
    title: `加入记忆候选：${contentLine.slice(0, 36)}`,
    targetPath,
    content: contentLine,
    category: cleanInlineValue(category),
    importance
  };
}

function stripAiGeneratedFooter(content: string): string {
  return content.replace(AI_GENERATED_FOOTER_PATTERN, "").trimEnd();
}

function extractKnowledgeWritebackBody(content: string, afterIndex: number): string {
  const rest = content.slice(afterIndex);
  const headingIndex = rest.search(/^#\s+/m);
  if (headingIndex < 0) return "";
  const fromHeading = rest.slice(headingIndex);
  const stop = fromHeading.search(/^\s*(请将以上内容|如果该路径|下一步如果|备注[：:])/mu);
  return (stop >= 0 ? fromHeading.slice(0, stop) : fromHeading).trim();
}

function extractMemoryWritebackBody(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed
        && !/^最终写回预览[：:]/u.test(trimmed)
        && !/^(建议路径|分类|类别|category|重要性|importance)[：:]/iu.test(trimmed);
    })
    .join("\n")
    .trim();
}

function firstUsefulMemoryLine(content: string): string {
  const cleaned = content
    .replace(/^[-*]\s*\[[ xX]\]\s*/u, "")
    .replace(/^[-*]\s*/u, "")
    .trim();
  const first = cleaned.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  return cleanInlineValue(first);
}

function extractLabeledValue(content: string, pattern: RegExp): string {
  return cleanInlineValue(content.match(pattern)?.[1] || "");
}

function resolveKnowledgeWritebackPath(rawPath: string, options: KnowledgeWritebackParseOptions): string | null {
  const cleaned = normalizeLocalPath(rawPath.replace(/[。；;，,]*$/g, "").replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""));
  const rawParts = cleaned.split("/").map(cleanPathSegment).filter(Boolean);
  const rootParts = normalizeLocalPath(options.rootFolder).split("/").filter(Boolean);
  const withoutRoot = rawParts.slice(0, rootParts.length).join("/") === rootParts.join("/")
    ? rawParts.slice(rootParts.length)
    : rawParts;
  const knowledgeIndex = withoutRoot.findIndex((part) => /^(Knowledge|知识库)$/i.test(part));
  const relativeParts = knowledgeIndex >= 0 ? withoutRoot.slice(knowledgeIndex + 1) : withoutRoot;
  const fallbackDate = options.fallbackDate ?? today();
  const safeParts = normalizeKnowledgeWritebackParts(relativeParts, fallbackDate);
  const last = safeParts[safeParts.length - 1];
  if (!/\.md$/i.test(last)) safeParts[safeParts.length - 1] = `${last || `${fallbackDate}-知识笔记`}.md`;

  const language = normalizeDirectoryLanguage(options.directoryLanguage);
  return joinLocalPath(
    options.rootFolder,
    ...localizeLifeOsPathParts(["Knowledge", ...safeParts], language)
  );
}

function normalizeKnowledgeWritebackParts(parts: string[], fallbackDate: string): string[] {
  const fallback = `${fallbackDate}-knowledge-note.md`;
  const safeParts = parts.filter((part) => part !== "." && part !== "..");
  if (safeParts.length === 0) return [fallback];
  if (isUnsafeKnowledgeWritebackPath(safeParts)) return ["AI Writebacks", fallback];
  return safeParts;
}

function isUnsafeKnowledgeWritebackPath(parts: string[]): boolean {
  const normalized = parts.map((part) => normalizeLocalPath(part).toLowerCase()).filter(Boolean);
  const last = normalized[normalized.length - 1] || "";
  if (!last) return true;
  if (last === "index.md" || last === "hot.md" || last === "log.md") return true;
  return normalized.some((part) => /^(llm\s*wiki|llmwiki)$/i.test(part))
    || normalized.some((part) => /^(raw|drafts|batches|trash|schema|reports)$/i.test(part));
}

function cleanPathSegment(segment: string): string {
  return segment.trim().replace(/[<>:"\\|?*\x00-\x1F]/g, "-").replace(/^\.+|\.+$/g, "").trim();
}

function cleanInlineValue(value: string): string {
  return value.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/[。；;]+$/g, "").trim();
}

function knowledgeWritebackTitle(content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading ? `写入知识库：${heading}` : "写入知识库条目";
}

function normalizeLocalPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

function joinLocalPath(...parts: string[]): string {
  return parts.map(normalizeLocalPath).filter(Boolean).join("/");
}
