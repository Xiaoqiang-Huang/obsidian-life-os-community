import { App, normalizePath } from "obsidian";

type DocumentEditMode = "replace" | "append";
type DocumentEditTargetSource = "active-file" | "wikilink" | "path" | "title";

interface VaultFileLike {
  path: string;
  name?: string;
  basename?: string;
  extension?: string;
}

interface DocumentEditVaultLike {
  getMarkdownFiles(): VaultFileLike[];
  cachedRead?(file: VaultFileLike): Promise<string>;
  read?(file: VaultFileLike): Promise<string>;
}

interface DocumentEditWorkspaceLike {
  getActiveFile?(): VaultFileLike | null;
}

export interface AiDocumentEditTarget {
  path: string;
  title: string;
  content: string;
  source: DocumentEditTargetSource;
}

export interface AiDocumentEditCandidate {
  targetPath: string;
  title: string;
  mode: DocumentEditMode;
  content: string;
}

const DOCUMENT_EDIT_ACTION_PATTERN = /(修改|编辑|改写|润色|校对|整理|规整|重排|优化|调整格式|格式化|统一格式|管理|补充|更新)/iu;
const DOCUMENT_EDIT_TARGET_PATTERN = /(文档|文件|笔记|资料|Markdown|\.md|\[\[|当前文档|当前文件|这篇|这个)/iu;
const DOCUMENT_EDIT_MARKER_PATTERN = /最终(?:写回)?预览[：:]\s*(?:文档修改|修改文档|文档管理|文档编辑)/u;
const AI_GENERATED_FOOTER_PATTERN = /(?:^|\n)\s*(?:AI生成|AI鐢熸垚)\s*$/u;

export function hasAiDocumentEditIntent(input: string): boolean {
  return DOCUMENT_EDIT_ACTION_PATTERN.test(input) && DOCUMENT_EDIT_TARGET_PATTERN.test(input);
}

export function formatAiDocumentEditTargetForPrompt(target: AiDocumentEditTarget | null, userRequest: string): string {
  if (!hasAiDocumentEditIntent(userRequest)) return "";
  if (!target) {
    return [
      "## AI 文档编辑目标",
      "用户似乎要求修改、规整或调整某个文档，但插件没有识别到唯一目标文档。",
      "请不要输出文档修改预览；请让用户用 [[文档名]]、完整 .md 路径，或先打开目标文档后再说“当前文档”。"
    ].join("\n");
  }

  return [
    "## AI 文档编辑目标",
    `目标文档：${target.path}`,
    `目标标题：${target.title}`,
    `定位方式：${target.source}`,
    "当前文档全文如下。用户要求修改、规整、调整格式、润色或补充时，必须基于这份原文输出完整修改后的 Markdown。",
    "不要直接声称已经修改文件。必须输出下面的严格格式，插件会打开确认预览，用户确认后才会写入：",
    "最终写回预览：文档修改",
    `目标文档：${target.path}`,
    "修改方式：replace",
    "```markdown",
    "<完整修改后的 Markdown>",
    "```",
    "如果用户只要求追加内容，可以把“修改方式”写成 append，并只输出要追加的 Markdown。",
    "",
    "### 当前文档全文",
    "```markdown",
    target.content,
    "```"
  ].join("\n");
}

export function parseAiDocumentEditCandidate(
  aiContent: string,
  fallbackTarget?: Pick<AiDocumentEditTarget, "path" | "title"> | null
): AiDocumentEditCandidate | null {
  const withoutFooter = aiContent.replace(AI_GENERATED_FOOTER_PATTERN, "").trimEnd();
  const marker = withoutFooter.search(DOCUMENT_EDIT_MARKER_PATTERN);
  if (marker < 0) return null;
  const source = withoutFooter.slice(marker);
  const targetPath = normalizePath(
    source.match(/目标文档[：:]\s*([^\n]+)/u)?.[1]?.trim() ||
    fallbackTarget?.path ||
    ""
  );
  if (!targetPath) return null;
  const modeText = source.match(/修改方式[：:]\s*([^\n]+)/u)?.[1]?.toLowerCase() ?? "";
  const mode: DocumentEditMode = /append|追加|补充/u.test(modeText) ? "append" : "replace";
  const fenced = source.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/i);
  const content = (fenced?.[1] ?? stripDocumentEditMetadataLines(source)).trim();
  if (!content) return null;
  return {
    targetPath,
    title: `AI 修改文档：${fallbackTarget?.title || targetPath.split("/").pop() || targetPath}`,
    mode,
    content: mode === "append" ? `\n${content}\n` : `${content}\n`
  };
}

export class AiDocumentEditService {
  constructor(private app: App) {}

  async resolveTarget(userRequest: string): Promise<AiDocumentEditTarget | null> {
    if (!hasAiDocumentEditIntent(userRequest)) return null;
    const vault = this.vault();
    const active = this.activeMarkdownFile();
    if (active && /当前文档|当前文件|这个文档|这篇文档|这个文件|这篇|当前笔记/u.test(userRequest)) {
      return this.describeTarget(active, "active-file");
    }

    const files = vault.getMarkdownFiles().filter(isMarkdownFile);
    for (const hint of extractDocumentTargetHints(userRequest)) {
      const resolved = this.resolveHint(hint, files);
      if (resolved) return this.describeTarget(resolved.file, resolved.source);
    }

    const fuzzy = this.resolveByMentionedTitle(userRequest, files);
    return fuzzy ? this.describeTarget(fuzzy.file, fuzzy.source) : null;
  }

  private resolveHint(hint: string, files: VaultFileLike[]): { file: VaultFileLike; source: DocumentEditTargetSource } | null {
    const normalized = normalizePath(cleanTargetHint(hint));
    if (!normalized) return null;
    const exactPath = files.find((file) => normalizePath(file.path) === normalized);
    if (exactPath) return { file: exactPath, source: normalized.includes("/") ? "path" : "title" };
    const withMarkdown = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
    const exactWithExtension = files.find((file) => normalizePath(file.path) === withMarkdown);
    if (exactWithExtension) return { file: exactWithExtension, source: "path" };
    const basename = withoutMarkdownExtension(normalized.split("/").pop() || normalized);
    const matches = files.filter((file) => normalizeMatchText(file.basename || withoutMarkdownExtension(file.name || file.path)) === normalizeMatchText(basename));
    if (matches.length === 1) return { file: matches[0], source: hint.includes("[[") ? "wikilink" : "title" };
    return null;
  }

  private resolveByMentionedTitle(userRequest: string, files: VaultFileLike[]): { file: VaultFileLike; source: DocumentEditTargetSource } | null {
    const normalizedRequest = normalizeMatchText(userRequest);
    const matches = files
      .map((file) => ({
        file,
        title: normalizeMatchText(file.basename || withoutMarkdownExtension(file.name || file.path))
      }))
      .filter((item) => item.title.length >= 3 && normalizedRequest.includes(item.title))
      .sort((a, b) => b.title.length - a.title.length);
    if (matches.length === 0) return null;
    if (matches.length > 1 && matches[0].title.length === matches[1].title.length) return null;
    return { file: matches[0].file, source: "title" };
  }

  private activeMarkdownFile(): VaultFileLike | null {
    const active = (this.app.workspace as unknown as DocumentEditWorkspaceLike | undefined)?.getActiveFile?.() ?? null;
    return active && isMarkdownFile(active) ? active : null;
  }

  private async describeTarget(file: VaultFileLike, source: DocumentEditTargetSource): Promise<AiDocumentEditTarget> {
    const content = await this.readFile(file);
    return {
      path: normalizePath(file.path),
      title: file.basename || withoutMarkdownExtension(file.name || file.path.split("/").pop() || file.path),
      content,
      source
    };
  }

  private async readFile(file: VaultFileLike): Promise<string> {
    const vault = this.vault();
    if (typeof vault.cachedRead === "function") return vault.cachedRead(file);
    if (typeof vault.read === "function") return vault.read(file);
    return "";
  }

  private vault(): DocumentEditVaultLike {
    return this.app.vault as unknown as DocumentEditVaultLike;
  }
}

function extractDocumentTargetHints(input: string): string[] {
  const hints: string[] = [];
  for (const match of input.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
    hints.push(match[1]);
  }
  for (const match of input.matchAll(/[`"'“”‘’「」]?([^\s`"'“”‘’「」，,。；;！!？?<>]+\.md)[`"'“”‘’「」]?/giu)) {
    hints.push(match[1]);
  }
  return Array.from(new Set(hints.map(cleanTargetHint).filter(Boolean)));
}

function stripDocumentEditMetadataLines(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed &&
        !DOCUMENT_EDIT_MARKER_PATTERN.test(trimmed) &&
        !/^(目标文档|修改方式|建议标题|标题)[：:]/u.test(trimmed);
    })
    .join("\n");
}

function cleanTargetHint(value: string): string {
  return value
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/^[`"'“”‘’「」<]+|[`"'“”‘’「」>，,。；;！!？?]+$/gu, "")
    .replace(/\\/g, "/")
    .trim();
}

function isMarkdownFile(file: VaultFileLike): boolean {
  return file.extension === "md" ||
    /\.md$/i.test(file.path || file.name || "");
}

function withoutMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, "");
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[\s_\-—–·.。/\\()[\]【】《》<>:："'“”‘’]+/gu, "");
}
