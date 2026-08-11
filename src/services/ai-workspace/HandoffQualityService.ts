import {
  normalizeAiWorkspaceHandoffDocument,
  type AiWorkspaceHandoffDocument,
  type HandoffEvidenceBundle,
  type HandoffEvidenceRef,
  type HandoffQualityReport,
  type HandoffWorkItem
} from "./types";

const PLACEHOLDER_PATTERN = /^(?:尚未|暂无|未识别|待生成|待整理|unknown|n\/a)/iu;
const VALIDATION_PATTERN = /(?:测试|验证|验收|构建|编译|通过|回归|截图|哈希|sha-?256|tests?|passed|build|verified|commit)/iu;
const USER_CONFIRMATION_PATTERN = /(?:我确认|确认完成|已经完成|验收通过|可以了|符合要求|approved|confirmed|accepted)/iu;

export interface HandoffQualityEnforcementResult {
  document: AiWorkspaceHandoffDocument;
  report: HandoffQualityReport;
}

export class HandoffQualityService {
  evaluate(
    documentInput: AiWorkspaceHandoffDocument,
    evidence: HandoffEvidenceBundle,
    repairCount = documentInput.quality?.repairCount ?? 0
  ): HandoffQualityReport {
    const document = normalizeAiWorkspaceHandoffDocument(documentInput);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!meaningful(document.executiveSummary)) {
      errors.push("一分钟接手摘要缺失或仍是占位文本。");
    }
    if (!meaningful(document.progress)) {
      errors.push("当前进度缺失或仍是占位文本。");
    }
    if (!document.currentState.some(meaningful)) {
      errors.push("当前状态缺失，接手工具无法判断项目处于哪里。");
    }
    if (!document.userIntent.some(meaningful) && !document.scope.some(meaningful)) {
      errors.push("用户目标与工作范围缺失。");
    }
    if (document.actionPlan.length === 0) {
      errors.push("下一步行动缺失。");
    }

    document.actionPlan.forEach((action, index) => {
      if (!meaningful(action.action)) errors.push(`下一步 ${index + 1} 缺少执行动作。`);
      if (!meaningful(action.target)) errors.push(`下一步 ${index + 1} 缺少目标对象。`);
      if (!meaningful(action.expectedResult)) errors.push(`下一步 ${index + 1} 缺少预期结果。`);
      if (!meaningful(action.acceptanceCriteria)) errors.push(`下一步 ${index + 1} 缺少验收条件。`);
    });

    for (const item of document.verifiedCompleted) {
      if (!hasVerificationEvidence(item.evidence)) {
        errors.push(`“${item.title}”被标记为已验证完成，但没有测试、构建、产物、提交或用户确认。`);
      }
    }

    const statusesByTitle = new Map<string, Set<string>>();
    for (const item of document.workItems) {
      const key = normalizeWorkTitle(item.title || item.summary);
      if (!key) continue;
      const statuses = statusesByTitle.get(key) ?? new Set<string>();
      statuses.add(item.status);
      statusesByTitle.set(key, statuses);
    }
    for (const [title, statuses] of statusesByTitle) {
      const completed = statuses.has("verified") || statuses.has("claimed");
      const notCompleted = statuses.has("pending") || statuses.has("blocked");
      if (completed && notCompleted) {
        errors.push(`工作项“${title}”同时存在完成与未完成状态，交接内容互相矛盾。`);
      }
    }

    const sourceNodeIds = new Set(evidence.coveredNodeIds);
    const referencedNodeIds = new Set<string>();
    const factGroups: Array<{ label: string; evidence: HandoffEvidenceRef[] }> = [
      ...document.workItems.map((item) => ({ label: item.title, evidence: item.evidence })),
      ...document.deliverables.map((item) => ({ label: item.name, evidence: item.evidence })),
      ...document.failedAttempts.map((item) => ({ label: item.approach, evidence: item.evidence })),
      ...document.actionPlan.map((item) => ({ label: item.action, evidence: item.evidence }))
    ];
    let citedFacts = 0;
    for (const fact of factGroups) {
      const validRefs = fact.evidence.filter((ref) => {
        if (ref.sourceType !== "session-node") return Boolean(ref.sourceId);
        if (!ref.nodeId || !sourceNodeIds.has(ref.nodeId)) return false;
        referencedNodeIds.add(ref.nodeId);
        return true;
      });
      if (validRefs.length > 0) citedFacts += 1;
      else warnings.push(`关键事实“${shorten(fact.label, 60)}”缺少可验证引用。`);
    }

    const missingNodeIds = evidence.coveredNodeIds.filter((id) =>
      !evidence.evidenceIndex.some((ref) => ref.nodeId === id)
    );
    const nodeCoverage = evidence.totalNodeCount > 0
      ? (evidence.totalNodeCount - missingNodeIds.length) / evidence.totalNodeCount
      : 1;
    const citationCoverage = factGroups.length > 0 ? citedFacts / factGroups.length : 1;
    if (nodeCoverage < 1) {
      errors.push(`证据未覆盖全部节点：缺少 ${missingNodeIds.length} 个节点。`);
    }
    if (citationCoverage < 0.8) {
      errors.push(`关键事实引用覆盖率不足：${Math.round(citationCoverage * 100)}%。`);
    }
    if (document.sourceRevision.revisionId !== evidence.revisionId) {
      errors.push(`交接来源版本 ${document.sourceRevision.revisionId} 与当前证据版本 ${evidence.revisionId} 不一致。`);
    }
    if (document.sourceRevision.cacheKey && document.sourceRevision.cacheKey !== evidence.cacheKey) {
      errors.push("交接来源哈希已变化，当前草稿已经过期。");
    }
    if (document.verifiedCompleted.length === 0) {
      warnings.push("尚无已验证完成项；完成声明会保留为“声称完成”或“部分完成”。");
    }
    if (document.constraints.length === 0) {
      warnings.push("未识别到明确风险；接手前仍应核对环境、权限和未完成验证。 ");
    }

    const uniqueErrors = uniqueStrings(errors);
    const uniqueWarnings = uniqueStrings(warnings);
    const score = Math.max(0, Math.min(100,
      Math.round(100 - (uniqueErrors.length * 15) - (uniqueWarnings.length * 3)
        - ((1 - nodeCoverage) * 30) - ((1 - citationCoverage) * 20))
    ));
    return {
      score,
      passed: uniqueErrors.length === 0 && nodeCoverage === 1 && citationCoverage >= 0.8 && score >= 75,
      nodeCoverage,
      citationCoverage,
      warnings: uniqueWarnings,
      errors: uniqueErrors,
      repairCount: Math.max(0, Math.floor(repairCount)),
      missingNodeIds
    };
  }

  enforce(
    documentInput: AiWorkspaceHandoffDocument,
    evidence: HandoffEvidenceBundle,
    repairCount = documentInput.quality?.repairCount ?? 0
  ): HandoffQualityEnforcementResult {
    const document = normalizeAiWorkspaceHandoffDocument(structuredClone(documentInput));
    const retained: HandoffWorkItem[] = [];
    const demoted: HandoffWorkItem[] = [];
    for (const item of document.verifiedCompleted) {
      if (hasVerificationEvidence(item.evidence)) {
        retained.push({ ...item, status: "verified" });
      } else {
        demoted.push({ ...item, status: "claimed" });
      }
    }
    document.verifiedCompleted = retained;
    document.claimedCompleted = mergeWorkItems(document.claimedCompleted, demoted);
    document.workItems = mergeWorkItems(
      document.workItems.filter((item) => !demoted.some((demotedItem) => demotedItem.id === item.id)),
      retained,
      document.claimedCompleted,
      document.partialCompleted
    );
    const report = this.evaluate(document, evidence, repairCount);
    if (demoted.length > 0) {
      report.warnings = uniqueStrings([
        ...report.warnings,
        `${demoted.length} 个缺少验证证据的完成项已降级为“声称完成”。`
      ]);
      report.score = Math.max(0, report.score - Math.min(9, demoted.length * 3));
    }
    document.quality = report;
    return { document, report };
  }

  buildRepairInstruction(report: HandoffQualityReport): string {
    return [
      "只修复以下交接质量问题，不删除已有有效事实和证据引用：",
      ...report.errors.map((error, index) => `${index + 1}. ${error}`),
      ...report.warnings.map((warning, index) => `W${index + 1}. ${warning}`),
      "所有关键事实都要引用提供的 evidence id；下一步必须写明动作、目标对象、预期结果和验收条件。",
      "如果资料不足，请明确写“资料不足”，不要编造。"
    ].join("\n");
  }
}

function meaningful(value: string): boolean {
  const normalized = String(value || "").trim();
  return normalized.length >= 4 && !PLACEHOLDER_PATTERN.test(normalized);
}

function hasVerificationEvidence(evidence: HandoffEvidenceRef[]): boolean {
  return evidence.some((ref) =>
    VALIDATION_PATTERN.test(ref.excerpt)
    || (ref.role === "user" && USER_CONFIRMATION_PATTERN.test(ref.excerpt))
  );
}

function normalizeWorkTitle(value: string): string {
  return String(value || "")
    .replace(/（[^）]*节点[^）]*）/gu, "")
    .replace(/(?:已经|已|尚未|仍需|待|完成|未完成|声称)/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase()
    .slice(0, 160);
}

function mergeWorkItems(...groups: HandoffWorkItem[][]): HandoffWorkItem[] {
  const result: HandoffWorkItem[] = [];
  const byId = new Set<string>();
  for (const item of groups.flat()) {
    if (byId.has(item.id)) continue;
    byId.add(item.id);
    result.push(item);
  }
  return result;
}

function uniqueStrings(rows: string[]): string[] {
  return [...new Set(rows.map((row) => row.trim()).filter(Boolean))];
}

function shorten(value: string, max: number): string {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
