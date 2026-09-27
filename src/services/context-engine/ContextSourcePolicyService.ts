type Frontmatter = Record<string, unknown>;

export type EvidenceOrigin = "note" | "user-saved-conversation" | "context-only";
export interface CitableMarkdown {
  allowed: boolean;
  markdown: string;
  origin: EvidenceOrigin;
  reason?: string;
}

export const USER_SAVED_CONVERSATION_SOURCE = "lifeos:user-saved-conversation:v1";
export const USER_SAVED_CONVERSATION_START = `<!-- ${USER_SAVED_CONVERSATION_SOURCE}:start -->`;
export const USER_SAVED_CONVERSATION_END = `<!-- ${USER_SAVED_CONVERSATION_SOURCE}:end -->`;
export const USER_SAVED_CONVERSATION_LABEL = "用户保存的对话内容（非独立原始事实）";
const AUTOMATIC_TYPES = new Set(["chat", "chat-session", "chat-history", "ai-history", "aihistory", "session", "agent-event", "agent-memory-read-path", "writeback-receipt", "writeback-receipts", "writeback-undo", "wiki-change-receipt"]);

/** Explicit-save callers only. A reversible envelope; never mark an autosave. */
export function markUserSavedConversation(markdown: string): string {
  if (savedConversationEnvelope(markdown)) return markdown;
  return `${USER_SAVED_CONVERSATION_START}\n${markdown}\n${USER_SAVED_CONVERSATION_END}`;
}

/** No host, model, network or file writes. The returned text keeps original line positions. */
export function prepareCitableMarkdown(path: string, markdown: string, options: { rootFolder?: string } = {}): CitableMarkdown {
  const policy = new ContextSourcePolicyService(options.rootFolder ?? "");
  const frontmatter = evidenceFrontmatter(markdown);
  const filtered = filterConversationBlocks(markdown);
  const effective = filtered.saved && !frontmatter.lifeos_evidence ? { ...frontmatter, lifeos_evidence: "user-saved-conversation-v1" } : frontmatter;
  if (!policy.isAllowed(path, effective)) return { allowed: false, markdown: "", origin: "context-only", reason: "automatic-conversation-or-explicit-exclusion" };
  const origin = filtered.saved || isSavedConversationFrontmatter(frontmatter) ? "user-saved-conversation" : "note";
  const body = filtered.markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").replace(/<!--[\s\S]*?-->/gu, "").trim();
  return body
    ? { allowed: true, markdown: filtered.markdown, origin }
    : { allowed: false, markdown: "", origin: "context-only", reason: "no-citable-content" };
}

/** Deliberately narrow metadata contract: `status: saved` is NOT consent. */
export function isSavedConversationFrontmatter(frontmatter: Frontmatter): boolean {
  return scalar(frontmatter.lifeos_evidence) === "user-saved-conversation-v1"
    || scalar(frontmatter.source_path) === USER_SAVED_CONVERSATION_SOURCE;
}

function scalar(value: unknown): string {
  return String(value ?? "").trim().replace(/^(["'])([\s\S]*)\1$/u, "$2").toLowerCase();
}

export function evidenceFrontmatter(markdown: string): Frontmatter {
  const block = markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  if (!block) return {};
  const result: Frontmatter = {};
  for (const line of block.split(/\r?\n/u)) {
    const pair = line.match(/^([A-Za-z0-9_.-]+):\s*(.*?)\s*$/u);
    if (!pair) continue;
    let value = pair[2];
    // Strip YAML comments only outside quoted scalars.
    if (!/^["']/u.test(value)) value = value.replace(/\s+#.*$/u, "");
    result[pair[1]] = scalar(value);
  }
  return result;
}

function savedConversationEnvelope(markdown: string): boolean {
  return filterConversationBlocks(markdown).saved;
}

function filterConversationBlocks(markdown: string): { markdown: string; saved: boolean } {
  const parts = markdown.split(/(\r\n|\n|\r)/u);
  let fence = "", fenceLength = 0, automatic = "", legacyLevel = 0;
  let savedRegion = false, saved = false;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    // Managed blocks are masked even when a model put an unclosed fence inside them.
    if (automatic) {
      if (line.trim() === `<!-- lifeos-weixin-daily-${automatic}:end -->`) automatic = "";
      parts[i] = "";
      continue;
    }
    const fenceMatch = line.match(/^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence && fenceMatch[1].length >= fenceLength && !fenceMatch[2].trim()) fence = "";
      if (legacyLevel) parts[i] = "";
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1][0]; fenceLength = fenceMatch[1].length;
      if (legacyLevel) parts[i] = "";
      continue;
    }
    const start = line.match(/^ {0,3}<!-- lifeos-weixin-daily-(inputs|digest):start -->\s*$/u);
    if (start) { automatic = start[1]; parts[i] = ""; continue; }
    if (/^ {0,3}- .*<!-- lifeos-weixin-input:[A-Za-z0-9_-]+ -->\s*$/u.test(line)) { parts[i] = ""; continue; }
    // Canonical task metadata and confirmed-memory metadata survive edits/moves.
    // Recognize only this exact explicit-save provenance, never generic source/status text.
    if (!legacyLevel && (/^\s*-\s*\[[ xX]\]\s+.*\ssource:lifeos:user-saved-conversation:v1(?=\s|$)/u.test(line)
      || /^\s{2,}-\s+source:\s*lifeos:user-saved-conversation:v1\s*$/u.test(line))) saved = true;
    if (line === USER_SAVED_CONVERSATION_START && parts.slice(i + 2).some((part, n) => n % 2 === 0 && part === USER_SAVED_CONVERSATION_END)) {
      savedRegion = true; saved = true; legacyLevel = 0;
    }
    if (line === USER_SAVED_CONVERSATION_END) { savedRegion = false; legacyLevel = 0; }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+)$/u);
    if (heading && legacyLevel && heading[1].length <= legacyLevel) legacyLevel = 0;
    if (!savedRegion && heading && /^AI 对话记录(?:\s+\d{1,2}:\d{2})?\s*$/u.test(heading[2])) legacyLevel = heading[1].length;
    if (legacyLevel) parts[i] = "";
  }
  return { markdown: parts.join(""), saved };
}

export class ContextSourcePolicyService {
  constructor(private readonly rootFolder: string) {}

  isAllowedPath(path: string): boolean {
    const normalized = this.normalizePath(path);
    if (!normalized.toLowerCase().endsWith(".md")) return false;
    if (this.hasUnsafePathSegment(normalized)) return false;
    if (this.hasObsidianConfigSegment(normalized)) return false;
    const segments = normalized.toLowerCase().split("/");
    const root = this.normalizePath(this.rootFolder).toLowerCase();
    const relative = root && normalized.toLowerCase().startsWith(`${root}/`) ? normalized.slice(root.length + 1).toLowerCase() : "";
    if (relative.startsWith("chat/") || relative.startsWith("聊天/")) return false;
    if (segments.some((part) => part === "chat" || part === "聊天")) return false;
    // These are storage artifacts, not the notes produced by an approved writeback.
    const artifactPath = normalized.toLowerCase();
    if (/(?:^|\/)(?:aihistory|ai-history|ai history|ai历史|writeback-receipts|writeback receipts|写入凭证)(?:\/|$)/u.test(artifactPath)) return false;
    if (/(?:^|\/)(?:aiworkspace|ai workspace|ai工作区)\/(?:sessions|session notes|会话笔记)(?:\/|$)/u.test(artifactPath)) return false;
    if (/(?:^|\/)(?:writeback|writebacks|写回)\/(?:receipts|凭证)(?:\/|$)/u.test(artifactPath)) return false;
    if (/(?:^|\/)ai\/history\//u.test(artifactPath)) return false;
    return true;
  }

  isAllowedFrontmatter(frontmatter: Frontmatter = {}): boolean {
    if (AUTOMATIC_TYPES.has(scalar(frontmatter.type)) || AUTOMATIC_TYPES.has(scalar(frontmatter.lifeos_type))) return false;
    if (scalar(frontmatter.type).startsWith("ai-workspace-") && !isSavedConversationFrontmatter(frontmatter)) return false;
    if (["context-only", "excluded", "false"].includes(scalar(frontmatter.lifeos_evidence))) return false;
    if (!isSavedConversationFrontmatter(frontmatter)) {
      if ([frontmatter.source, frontmatter.source_kind, frontmatter.provenance].some(value => /^(?:chat|assistant|ai-answer|ai-generated|generated-conversation|conversation|ai-history)$/u.test(scalar(value)))) return false;
      const sourcePath = String(frontmatter.source_path ?? "").trim();
      if (sourcePath.toLowerCase().endsWith(".md") && !this.isAllowedPath(sourcePath)) return false;
    }
    return true;
  }

  isAllowed(path: string, frontmatter: Frontmatter = {}): boolean {
    return this.isAllowedPath(path) && this.isAllowedFrontmatter(frontmatter);
  }

  private normalizePath(path: string): string {
    return String(path || "").replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0).join("/");
  }

  private hasUnsafePathSegment(path: string): boolean {
    return path.split("/").some((segment) => segment === "." || segment === "..");
  }

  private hasObsidianConfigSegment(path: string): boolean {
    return path.split("/").some((segment) => segment.toLowerCase() === ".obsidian");
  }
}
