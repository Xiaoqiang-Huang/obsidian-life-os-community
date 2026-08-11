import { stableTextHash } from "./logic";
import type {
  AiWorkspaceFileReference,
  AiWorkspaceMessage,
  HandoffEvidenceBundle,
  HandoffEvidenceRef,
  HandoffEvidenceSegment
} from "./types";

export const HANDOFF_EVIDENCE_SCHEMA_VERSION = "handoff-evidence-v2" as const;

export interface HandoffEvidenceCompilerOptions {
  segmentCharBudget?: number;
  nodePartCharBudget?: number;
  maxCategoryEvidence?: number;
}

export interface HandoffEvidenceCompileInput {
  sessionId: string;
  revisionId: string;
  messages: AiWorkspaceMessage[];
  projectMemory: string[];
  fileReferences: AiWorkspaceFileReference[];
}

const DECISION_PATTERN = /(?:决定|决策|采用|改为|选择|结论|原因是|取舍|decision|decided|choose|chosen)/iu;
const COMPLETION_PATTERN = /(?:已完成|完成了|已实现|已修复|已经修复|成功生成|已经更新|completed|implemented|fixed|done)/iu;
const VALIDATION_PATTERN = /(?:测试|验证|验收|构建|编译|通过|回归|截图|哈希|sha-?256|tests?|passed|build|verified|commit)/iu;
const FAILED_PATTERN = /(?:失败|报错|错误|无效|不可行|没有生效|未通过|回滚|放弃|failed|failure|error|did not work|rollback)/iu;
const RISK_PATTERN = /(?:阻塞|限制|风险|卡住|不能|无法|依赖|敏感|隐私|block|limit|risk|cannot|dependency)/iu;
const PENDING_PATTERN = /(?:待办|未完成|仍需|还要|需要继续|尚未|todo|remaining|pending)/iu;
const NEXT_ACTION_PATTERN = /(?:下一步|接下来|随后|建议|应当|需要执行|next|then|follow[- ]?up)/iu;
const QUESTION_PATTERN = /(?:[？?]|待确认|需要确认|是否|能否|为什么|怎么|which|whether)/iu;
const COMMAND_PATTERN = /^(?:\s*(?:\$|>|PS>)\s*)?(?:npm|pnpm|yarn|git|python|python3|node|npx|bun|cargo|go|make|cmake|docker|kubectl|codex|claude|opencode|powershell|pwsh|bash|sh)\b/iu;

export class HandoffEvidenceCompiler {
  private readonly segmentCharBudget: number;
  private readonly nodePartCharBudget: number;
  private readonly maxCategoryEvidence: number;

  constructor(options: HandoffEvidenceCompilerOptions = {}) {
    this.segmentCharBudget = Math.max(600, Math.floor(options.segmentCharBudget ?? 8_000));
    this.nodePartCharBudget = Math.max(200, Math.min(
      this.segmentCharBudget,
      Math.floor(options.nodePartCharBudget ?? 2_400)
    ));
    this.maxCategoryEvidence = Math.max(8, Math.floor(options.maxCategoryEvidence ?? 80));
  }

  compile(input: HandoffEvidenceCompileInput): HandoffEvidenceBundle {
    const orderedMessages = [...input.messages].sort((left, right) =>
      left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp)
    );
    const evidenceIndex: HandoffEvidenceRef[] = [];
    for (const message of orderedMessages) {
      const parts = splitTraceableText(message.content, this.nodePartCharBudget);
      parts.forEach((excerpt, index) => {
        evidenceIndex.push({
          id: `${message.id}:part-${index + 1}`,
          sourceType: "session-node",
          sourceId: message.sourceId || message.id,
          nodeId: message.id,
          sequence: message.sequence + 1,
          role: message.role,
          timestamp: message.timestamp,
          excerpt,
          contentHash: message.contentHash,
          part: index + 1,
          partCount: parts.length
        });
      });
    }

    const projectMemoryEvidence = input.projectMemory
      .map((content, index) => ({
        id: `project-memory-${index + 1}`,
        sourceType: "project-memory" as const,
        sourceId: `project-memory:${index + 1}`,
        excerpt: compact(content, 2_400),
        contentHash: stableTextHash(content)
      }))
      .filter((item) => item.excerpt);
    const fileEvidence = dedupeFileReferences(input.fileReferences).map((file, index) => ({
      id: `file-${index + 1}`,
      sourceType: "file" as const,
      sourceId: file.path,
      excerpt: `${file.kind || "reference"}：${file.path}${file.line ? `:${file.line}` : ""}`,
      contentHash: stableTextHash(`${file.kind || "reference"}:${file.path}:${file.line || ""}`)
    }));

    const segments = this.buildSegments(evidenceIndex);
    const refsByMessage = new Map<string, HandoffEvidenceRef[]>();
    for (const ref of evidenceIndex) {
      if (!ref.nodeId) continue;
      const rows = refsByMessage.get(ref.nodeId) ?? [];
      rows.push(ref);
      refsByMessage.set(ref.nodeId, rows);
    }
    const category = (pattern: RegExp, filter?: (message: AiWorkspaceMessage) => boolean): HandoffEvidenceRef[] => {
      const output: HandoffEvidenceRef[] = [];
      for (const message of orderedMessages) {
        if (filter && !filter(message)) continue;
        if (!pattern.test(message.content)) continue;
        const refs = refsByMessage.get(message.id) ?? [];
        const matching = refs.filter((ref) => pattern.test(ref.excerpt));
        output.push(...(matching.length > 0 ? matching : refs.slice(0, 1)));
        if (output.length >= this.maxCategoryEvidence) break;
      }
      return uniqueEvidence(output).slice(0, this.maxCategoryEvidence);
    };
    const commandEvidence = uniqueEvidence(orderedMessages.flatMap((message) => {
      const commandLines = message.content.split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => COMMAND_PATTERN.test(line));
      return commandLines.map((line, index) => ({
        id: `command-${message.id}-${index + 1}`,
        sourceType: "command" as const,
        sourceId: message.sourceId || message.id,
        nodeId: message.id,
        sequence: message.sequence + 1,
        role: message.role,
        timestamp: message.timestamp,
        excerpt: compact(line, 520),
        contentHash: stableTextHash(line)
      }));
    })).slice(0, this.maxCategoryEvidence);
    const coveredNodeIds = [...new Set(orderedMessages.map((message) => message.id))];
    const cacheMaterial = [
      input.sessionId,
      input.revisionId,
      HANDOFF_EVIDENCE_SCHEMA_VERSION,
      ...orderedMessages.map((message) => `${message.id}:${message.contentHash}`),
      ...projectMemoryEvidence.map((item) => item.contentHash || ""),
      ...fileEvidence.map((item) => item.contentHash || "")
    ].join("|");

    return {
      schemaVersion: 2,
      evidenceSchemaVersion: HANDOFF_EVIDENCE_SCHEMA_VERSION,
      sessionId: input.sessionId,
      revisionId: input.revisionId,
      cacheKey: `${input.sessionId}:${input.revisionId}:${HANDOFF_EVIDENCE_SCHEMA_VERSION}:${stableTextHash(cacheMaterial)}`,
      totalNodeCount: orderedMessages.length,
      coveredNodeIds,
      segments,
      evidenceIndex,
      userIntentEvidence: category(/(?:请|希望|我要|需要|目标|要求|帮我|please|need|want|goal|require)/iu, (message) => message.role === "user"),
      decisionEvidence: category(DECISION_PATTERN),
      completionClaims: category(COMPLETION_PATTERN, (message) => message.role === "assistant"),
      validationEvidence: category(VALIDATION_PATTERN),
      failedAttempts: category(FAILED_PATTERN),
      riskEvidence: category(RISK_PATTERN),
      pendingEvidence: category(PENDING_PATTERN),
      nextActionEvidence: category(NEXT_ACTION_PATTERN),
      questionEvidence: category(QUESTION_PATTERN, (message) => message.role === "user"),
      commandEvidence,
      fileEvidence,
      projectMemoryEvidence
    };
  }

  private buildSegments(evidence: HandoffEvidenceRef[]): HandoffEvidenceSegment[] {
    const segments: HandoffEvidenceSegment[] = [];
    let current: HandoffEvidenceRef[] = [];
    let chars = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      const nodeIds = [...new Set(current.map((item) => item.nodeId).filter((id): id is string => Boolean(id)))];
      const sequences = current.map((item) => item.sequence).filter((value): value is number => typeof value === "number");
      const content = current.map(formatEvidenceForModel).join("\n\n");
      segments.push({
        id: `segment-${String(segments.length + 1).padStart(3, "0")}`,
        nodeIds,
        evidenceIds: current.map((item) => item.id),
        startSequence: sequences.length > 0 ? Math.min(...sequences) : 0,
        endSequence: sequences.length > 0 ? Math.max(...sequences) : 0,
        charCount: content.length,
        content
      });
      current = [];
      chars = 0;
    };
    for (const ref of evidence) {
      const formattedLength = formatEvidenceForModel(ref).length + 2;
      if (current.length > 0 && chars + formattedLength > this.segmentCharBudget) flush();
      current.push(ref);
      chars += formattedLength;
    }
    flush();
    return segments;
  }
}

export function formatEvidenceForModel(ref: HandoffEvidenceRef): string {
  if (ref.sourceType !== "session-node") {
    return `[${ref.sourceType}:${ref.sourceId}] ${ref.excerpt}`;
  }
  const role = ref.role === "user" ? "用户" : ref.role === "assistant" ? "AI" : "工具";
  const part = ref.partCount && ref.partCount > 1 ? ` · 片段 ${ref.part}/${ref.partCount}` : "";
  return `[节点 #${ref.sequence || "?"} · ${ref.nodeId || ref.sourceId} · ${role}${part}] ${ref.excerpt}`;
}

function splitTraceableText(value: string, maxChars: number): string[] {
  const normalized = String(value || "").replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return ["（空节点）"];
  const output: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const candidates = [window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf("；"), window.lastIndexOf(" ")];
    const preferred = Math.max(...candidates);
    const cut = preferred >= Math.floor(maxChars * 0.55) ? preferred + 1 : maxChars;
    output.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) output.push(remaining);
  return output.filter(Boolean);
}

function uniqueEvidence(rows: HandoffEvidenceRef[]): HandoffEvidenceRef[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.sourceType}:${row.nodeId || row.sourceId}:${row.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeFileReferences(rows: AiWorkspaceFileReference[]): AiWorkspaceFileReference[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.kind || "reference"}:${row.path}:${row.line || ""}`;
    if (!row.path || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compact(value: string, maxChars: number): string {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
