import { buildKeywordLinkedMarkdown } from "./KeywordLinkService";

export type LlmWikiMaterialLength = "short" | "long" | "very-long";
export type LlmWikiSourceKind = "pasted_text" | "url" | "web_clipper" | "current_note" | "local_file" | "manual_markdown";
export type LlmWikiPrivacyLevel = "normal" | "private" | "sensitive";
export type LlmWikiCompileDepth = "light" | "standard" | "deep";
export type LlmWikiConfidence = "low" | "medium" | "high";
export type LlmWikiBatchOperation = "save" | "compile" | "accept" | "undo";
export type LlmWikiSourceStatus = "inbox" | "compiled" | "skipped" | "versioned" | "trashed";
export type LlmWikiCompileStatus = "pending" | "draft_created" | "accepted" | "failed" | "skipped";

export const LLM_WIKI_SHORT_CHAR_LIMIT = 4000;
export const LLM_WIKI_LONG_CHAR_LIMIT = 20000;

export const LLM_WIKI_FOLDERS = [
  "Knowledge/LLMWiki",
  "Knowledge/LLMWiki/Raw",
  "Knowledge/LLMWiki/Raw/Inbox",
  "Knowledge/LLMWiki/Raw/Sources",
  "Knowledge/LLMWiki/Raw/Versions",
  "Knowledge/LLMWiki/Wiki",
  "Knowledge/LLMWiki/Wiki/Drafts",
  "Knowledge/LLMWiki/Wiki/Sources",
  "Knowledge/LLMWiki/Wiki/Concepts",
  "Knowledge/LLMWiki/Wiki/Entities",
  "Knowledge/LLMWiki/Wiki/Questions",
  "Knowledge/LLMWiki/Wiki/Syntheses",
  "Knowledge/LLMWiki/Wiki/Contradictions",
  "Knowledge/LLMWiki/Wiki/Batches",
  "Knowledge/LLMWiki/Schema",
  "Knowledge/LLMWiki/Reports",
  "Knowledge/LLMWiki/Trash",
  "Knowledge/LLMWiki/Trash/Raw",
  "Knowledge/LLMWiki/Trash/Drafts",
  "Knowledge/LLMWiki/Trash/Batches"
] as const;

export function classifyLlmWikiMaterialLength(text: string): LlmWikiMaterialLength {
  const length = String(text || "").length;
  if (length <= LLM_WIKI_SHORT_CHAR_LIMIT) return "short";
  if (length <= LLM_WIKI_LONG_CHAR_LIMIT) return "long";
  return "very-long";
}

export function slugifyLlmWikiTitle(title: string): string {
  const originalTitle = String(title || "");
  const slug = originalTitle
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `untitled-source-${simpleLlmWikiHash(originalTitle)}`;
}

export function simpleLlmWikiHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return Math.abs(hash).toString(36).slice(0, 10);
}

export function normalizedLlmWikiSimilarity(left: string, right: string): number {
  const leftTokens = new Set(String(left || "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean));
  const rightTokens = new Set(String(right || "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean));
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  const union = new Set(Array.from(leftTokens).concat(Array.from(rightTokens))).size;
  return union === 0 ? 0 : intersection / union;
}

export function detectLlmWikiPrivacyLevel(content: string): LlmWikiPrivacyLevel {
  const text = String(content || "").toLowerCase();
  if (hasPersonalSensitiveSignal(text) || hasCredentialSecretSignal(text)) return "sensitive";
  if (/api[_ -]?key|private[_ -]?key|secret|password|token|私钥|密钥/.test(text)) return "private";
  if (/内部|未公开|未发布|私人|聊天记录|关系|财务|健康|同事|公司|客户|报价|合同|商业|路线图|家庭|家人|住址|手机号|电话|邮箱/.test(text)) return "private";
  return "normal";
}

function hasPersonalSensitiveSignal(text: string): boolean {
  return /身份证|银行卡|病历|诊断/.test(text);
}

function hasCredentialSecretSignal(text: string): boolean {
  const credentialName = String.raw`(?:api[_ -]?key|private[_ -]?key|secret|password|token|私钥|密钥)`;
  const assignedCredential = new RegExp(String.raw`${credentialName}\s*(?:[:=：]|是|为)\s*["']?([a-z0-9][a-z0-9_\-./+=]{3,})`, "i");
  if (assignedCredential.test(text)) return true;
  if (/\b(?:sk|cr|pk|rk|ghp|github_pat|xoxb|eyj)[-_a-z0-9]{12,}\b/i.test(text)) return true;
  if (/\bakia[0-9a-z]{12,}\b/i.test(text)) return true;
  return new RegExp(String.raw`${credentialName}[\s\S]{0,80}(?:should stay out|stay out of formal|do not write|do not publish|不要|不得|不应|不允许)`, "i").test(text);
}

export interface LlmWikiSourceMarkdownInput {
  id: string;
  title: string;
  sourceKind: LlmWikiSourceKind;
  content: string;
  originalUrl?: string;
  sourcePath?: string;
  capturedAt: string;
  privacyLevel: LlmWikiPrivacyLevel;
  aiProcessingAllowed: boolean;
  batchId: string;
  status?: LlmWikiSourceStatus;
  duplicateOf?: string;
  versionOf?: string;
}

export interface LlmWikiDraftMarkdownInput {
  id: string;
  title: string;
  sourceIds: string[];
  compileDepth: LlmWikiCompileDepth;
  confidence: LlmWikiConfidence;
  privacyLevel: LlmWikiPrivacyLevel;
  aiProcessingAllowed: boolean;
  relatedProjects: string[];
  relationConfidence: LlmWikiConfidence;
  relationReason: string;
  createdAt: string;
  batchId: string;
  body: string;
}

export interface LlmWikiBatchMarkdownInput {
  id: string;
  createdAt: string;
  operation: LlmWikiBatchOperation;
  sourceIds: string[];
  createdFiles: string[];
  modifiedFiles: string[];
  skippedFiles: string[];
  errors: string[];
  revertOf?: string;
}

function yamlScalar(value: string): string {
  const clean = String(value || "").replace(/\r?\n/g, " ");
  if (!clean) return "\"\"";

  const trimmed = clean.trim();
  const needsQuoting =
    clean !== trimmed ||
    /:\s|#|[\[\]{}]/.test(clean) ||
    /:$/.test(trimmed) ||
    /^['"]/.test(trimmed) ||
    /^[-?!&*|>%@`:,]/.test(trimmed) ||
    /^(true|false|null|~)$/i.test(trimmed) ||
    /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(trimmed);

  return needsQuoting ? JSON.stringify(clean) : clean;
}

function yamlList(values: string[]): string {
  const clean = values.map((value) => yamlScalar(value)).filter((value) => value !== "\"\"");
  return clean.length ? clean.map((value) => `  - ${value}`).join("\n") : "  - \"\"";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildLlmWikiSourceMarkdown(input: LlmWikiSourceMarkdownInput): string {
  const frontmatter = [
    "---",
    "type: llm-wiki-source",
    `id: ${yamlScalar(input.id)}`,
    `title: ${yamlScalar(input.title)}`,
    `source_kind: ${yamlScalar(input.sourceKind)}`,
    `original_url: ${yamlScalar(input.originalUrl || "")}`,
    `source_path: ${yamlScalar(input.sourcePath || "")}`,
    `captured_at: ${yamlScalar(input.capturedAt)}`,
    `content_hash: hash:${simpleLlmWikiHash(input.content)}`,
    `status: ${yamlScalar(input.status || "inbox")}`,
    "compile_status: pending",
    `privacy_level: ${yamlScalar(input.privacyLevel)}`,
    `ai_processing_allowed: ${input.aiProcessingAllowed !== false ? "true" : "false"}`,
    `duplicate_of: ${yamlScalar(input.duplicateOf || "")}`,
    `version_of: ${yamlScalar(input.versionOf || "")}`,
    "related_to: \"\"",
    `batch_id: ${yamlScalar(input.batchId)}`,
    "---"
  ].join("\n");

  return buildKeywordLinkedMarkdown(`${frontmatter}\n\n${input.content}`, {
    title: input.title
  });
}

export function buildLlmWikiDraftMarkdown(input: LlmWikiDraftMarkdownInput): string {
  const frontmatter = [
    "---",
    "type: llm-wiki-draft",
    `id: ${yamlScalar(input.id)}`,
    "source_ids:",
    yamlList(input.sourceIds),
    `created_at: ${yamlScalar(input.createdAt)}`,
    "status: draft",
    `compile_depth: ${yamlScalar(input.compileDepth)}`,
    `confidence: ${yamlScalar(input.confidence)}`,
    `privacy_level: ${yamlScalar(input.privacyLevel)}`,
    `ai_processing_allowed: ${input.aiProcessingAllowed !== false ? "true" : "false"}`,
    "related_projects:",
    yamlList(input.relatedProjects),
    `relation_confidence: ${yamlScalar(input.relationConfidence)}`,
    `relation_reason: ${yamlScalar(input.relationReason)}`,
    "accepted_at: \"\"",
    "formal_target: \"\"",
    `batch_id: ${yamlScalar(input.batchId)}`,
    "---"
  ].join("\n");

  return buildKeywordLinkedMarkdown(`${frontmatter}\n\n# ${input.title}\n\n${input.body}`, {
    title: input.title
  });
}

export function buildLlmWikiBatchMarkdown(input: LlmWikiBatchMarkdownInput): string {
  const frontmatter = [
    "---",
    "type: llm-wiki-batch",
    `id: ${yamlScalar(input.id)}`,
    `created_at: ${yamlScalar(input.createdAt)}`,
    `operation: ${yamlScalar(input.operation)}`,
    "source_ids:",
    yamlList(input.sourceIds),
    "created_files:",
    yamlList(input.createdFiles),
    "modified_files:",
    yamlList(input.modifiedFiles),
    "skipped_files:",
    yamlList(input.skippedFiles),
    "errors:",
    yamlList(input.errors),
    `revert_of: ${yamlScalar(input.revertOf || "")}`,
    "---"
  ].join("\n");

  return `${frontmatter}\n`;
}

export function replaceLlmWikiFrontmatterValue(markdown: string, key: string, value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    throw new Error(`Invalid LLM Wiki frontmatter key: ${key}`);
  }

  const serializedValue = yamlScalar(value);
  const replacementLine = `${key}: ${serializedValue}`;
  const frontmatterPattern = /^---(\r?\n)([\s\S]*?)\r?\n---(?=\r?\n|$)/;
  const match = markdown.match(frontmatterPattern);

  if (!match) {
    return `---\n${replacementLine}\n---\n\n${markdown}`;
  }

  const newline = match[1];
  const body = match[2];
  const keyPattern = new RegExp(`^${escapeRegExp(key)}:.*$`, "m");
  const nextBody = keyPattern.test(body)
    ? body.replace(keyPattern, () => replacementLine)
    : `${body}${body ? newline : ""}${replacementLine}`;
  return markdown.replace(frontmatterPattern, () => `---${newline}${nextBody}${newline}---`);
}

export type LlmWikiIntakeType = "knowledge_source" | "daily_reflection" | "task_candidate" | "memory_candidate" | "mixed";

export interface LlmWikiIntakeDecision {
  primaryType: LlmWikiIntakeType;
  secondaryTypes: LlmWikiIntakeType[];
  confidence: number;
  privacyLevel: LlmWikiPrivacyLevel;
  aiProcessingAllowed: boolean;
  requiresConfirmation: boolean;
  reason: string;
}

export function classifyLlmWikiIntake(content: string, userInstruction = ""): LlmWikiIntakeDecision {
  const raw = `${userInstruction}\n${content}`;
  const hasUrl = /https?:\/\//i.test(raw);
  const hasSaveIntent = /保存|存进|写入|记入|放进|收进|整理成/.test(raw);
  const hasSourceSignal = /(?:这篇|这份|外部|参考)?资料|文章|链接|wiki|source|来源[:：]|(?:知识库|wiki)(?:条目|笔记|记录|资料|文档)|知识库[:：]/i.test(raw);
  const asksKnowledgeSave = (hasSaveIntent && hasSourceSignal)
    || /(?:^|\n)\s*(?:知识库|资料|文章|链接|来源|wiki|source)[:：]|(?:知识库|wiki)(?:条目|笔记|记录|资料|文档)|保存这篇|这篇文章|文章摘录|链接[:：]|来源[:：]|source:/i.test(raw);
  const hasDailySignal = /今天|昨天|这周|本周|复盘(?!页面)|我觉得|我发现|我最近|对我|我的(?!(?:习惯|偏好))/.test(raw);
  const hasTaskSignal = /明天|待办|要整理|需要整理|安排(?!被)|(?:^|[，。\n:：])计划|计划(?:把|测试|完成|明天|本周|下周|先)|下一步|todo/i.test(raw);
  const hasMemorySignal = /(?:^|[，。:：\n])以后|以后(?:请|遇到|看到)|长期(?:偏好|记忆)|记住|偏好|习惯|我总是|我喜欢/.test(raw);
  const privacyLevel = detectLlmWikiPrivacyLevel(raw);
  const secondaryTypes: LlmWikiIntakeType[] = [];
  if (hasDailySignal) secondaryTypes.push("daily_reflection");
  if (hasTaskSignal) secondaryTypes.push("task_candidate");
  if (hasMemorySignal) secondaryTypes.push("memory_candidate");
  const isKnowledge = hasUrl || asksKnowledgeSave;
  const strongKnowledgeFrame = /保存这篇|这篇资料|这篇文章|source:|来源[:：]|知识库[:：]/i.test(raw);
  const separatePersonalSignal = /(?:另外|同时|还有|顺便|并且|以及|并)[^。；;\n]*(?:明天|待办|任务|todo|需要|计划|安排|记住|今天|我觉得|我发现|我最近|复盘)/i.test(raw);
  const explicitPersonalSignal = /(?:^|[\s，。；;:：\n])(?:明天|待办|任务|todo|需要|计划|安排|下一步|以后|记住|今天)|我的习惯|我喜欢|对我来说|我最近|我希望/i.test(raw);
  const shouldTreatKnowledgeAsMixed = isKnowledge && secondaryTypes.length > 0 && (!strongKnowledgeFrame || separatePersonalSignal || explicitPersonalSignal);
  const primaryType: LlmWikiIntakeType = shouldTreatKnowledgeAsMixed
    ? "mixed"
    : isKnowledge
      ? "knowledge_source"
      : hasTaskSignal
        ? "task_candidate"
        : hasMemorySignal
          ? "memory_candidate"
          : hasDailySignal
            ? "daily_reflection"
            : "daily_reflection";
  return {
    primaryType,
    secondaryTypes: primaryType === "mixed" ? secondaryTypes : secondaryTypes.filter((type) => type !== primaryType),
    confidence: primaryType === "mixed" ? 0.82 : 0.72,
    privacyLevel,
    aiProcessingAllowed: true,
    requiresConfirmation: primaryType !== "knowledge_source" || privacyLevel !== "normal",
    reason: privacyLevel === "sensitive"
      ? "内容包含敏感信号，默认不保存、不编译、不进入未来上下文。"
      : primaryType === "mixed"
        ? "内容同时包含资料和个人行动或反思信号。"
        : "根据链接、保存意图和文本长度做出的确定性初筛。"
  };
}
