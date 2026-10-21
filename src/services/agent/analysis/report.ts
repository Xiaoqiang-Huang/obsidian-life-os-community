import type { AnalysisJob, Coverage, SynthesisItem, SynthesisNode, SynthesisReport, Viewpoint } from "./types";
import { hashRecord, hashText } from "./identity";

export function viewpointIndex(job: AnalysisJob): Viewpoint[] {
  const index = new Map<string, Viewpoint>();
  for (const result of job.chunks.filter(c => c.status === "done")) for (const v of result.viewpoints) index.set(v.viewpointId, v);
  return Array.from(index.values());
}
export function coverage(job: AnalysisJob): Coverage {
  const c: Coverage = { documentsTotal: job.manifest.documents.length, documentsComplete: 0, unitsKnownTotal: 0,
    unitsRead: 0, unitsAnalyzed: 0, unknownTotalDocuments: [], chunksTotal: job.chunks.length,
    chunksComplete: job.chunks.filter(r => r.status === "done").length, omissions: [] };
  for (const doc of job.manifest.documents) {
    if (doc.totalUnits === null) c.unknownTotalDocuments.push(doc.docId); else c.unitsKnownTotal += doc.totalUnits;
    let all = !doc.error && doc.totalUnits !== null && doc.units.length === doc.totalUnits;
    for (const unit of doc.units) {
      if (unit.readState === "read") c.unitsRead++;
      const chunks = job.chunks.filter(r => r.chunk.docId === doc.docId && r.chunk.unitId === unit.unitId).sort((a, b) => a.chunk.ownedStart - b.chunk.ownedStart);
      let cursor = 0, good = unit.readState === "read" && chunks.length > 0;
      for (const r of chunks) {
        if (r.status !== "done" || r.chunk.ownedStart !== cursor || (!r.viewpoints.length && !r.noViewpointsReason)) good = false;
        cursor = r.chunk.ownedEnd;
      }
      good = good && cursor === unit.text.length;
      if (good) c.unitsAnalyzed++; else { all = false; c.omissions.push(`${doc.docId}/${unit.unitId}`); }
    }
    if (!all) c.omissions.push(`${doc.docId}:document-incomplete`); else c.documentsComplete++;
  }
  return c;
}
export async function synthesisLevel(items: SynthesisItem[], descendants: Map<string, string[]>, level: number, fanout = 12): Promise<SynthesisNode[]> {
  if (!Number.isSafeInteger(fanout) || fanout < 2 || fanout > 32) throw new Error("invalid-fanout");
  const nodes: SynthesisNode[] = [];
  for (let i = 0; i < items.length; i += fanout) {
    const slice = items.slice(i, i + fanout), inputIds = slice.map(s => s.id);
    const viewpointIds = Array.from(new Set(slice.flatMap(s => descendants.get(s.id) || [s.id])));
    const qualificationIds = slice.filter(s => s.conditions.length || s.counterexamples.length).map(s => s.id);
    nodes.push({ nodeId: await hashRecord({ level, items: slice }), level, inputIds, viewpointIds,
      qualificationIds, items: slice, status: "pending", attempts: 0, themes: [], conflicts: [] });
  }
  return nodes;
}
export async function nextSynthesisLevel(job: AnalysisJob): Promise<SynthesisNode[]> {
  const index = viewpointIndex(job);
  if (!index.length) return [];
  if (!job.nodes.length) return synthesisLevel(index.map(v => ({ id: v.viewpointId, statement: v.statement.text,
    authors: [{ ...v.author, viewpointId: v.viewpointId }],
    conditions: v.conditions.map(c => c.text), counterexamples: v.counterexamples.map(c => c.text) })), new Map(), 0);
  const max = Math.max(...job.nodes.map(n => n.level)), top = job.nodes.filter(n => n.level === max);
  if (top.some(n => n.status !== "done") || top.length === 1) return [];
  const descendants = new Map(top.map(n => [n.nodeId, n.viewpointIds]));
  return synthesisLevel(top.map(n => ({ id: n.nodeId,
    // The parent input ID already links its complete viewpointIds lineage.
    // Deduplicate metadata labels here rather than copying thousands of leaf
    // IDs into every ancestor prompt; the authoritative index stays unchanged.
    authors: Array.from(new Map(n.items.flatMap(i => i.authors || []).map(a => [JSON.stringify([a.name, a.kind]), { name: a.name, kind: a.kind }])).values()),
    statement: n.themes.map(t => t.statement).join("\n"),
    conditions: n.items.flatMap(i => i.conditions), counterexamples: n.items.flatMap(i => i.counterexamples)
  })), descendants, max + 1);
}
function md(text: string): string { return text.replace(/\r/gu, "").replace(/\n/gu, " "); }
export async function makeReport(job: AnalysisJob): Promise<SynthesisReport> {
  const index = viewpointIndex(job), stats = coverage(job);
  const max = job.nodes.length ? Math.max(...job.nodes.map(n => n.level)) : -1;
  const root = job.nodes.filter(n => n.level === max && n.status === "done");
  if (index.length && (root.length !== 1 || root[0].viewpointIds.length !== index.length)) stats.omissions.push("synthesis-tree-incomplete");
  const lines = ["---", "type: lifeos-agent-analysis-report", `job_id: ${job.jobId}`, "---", "# 全量文档分析报告", "", "> 结构、定位及引用哈希已检查；模型提炼/综合不是语义正确性验收。",
    `覆盖：${stats.documentsComplete}/${stats.documentsTotal} 篇；${stats.unitsAnalyzed}/${stats.unitsKnownTotal} 已知单元；未知总单元文档 ${stats.unknownTotalDocuments.length}。`,
    "", "## 分层综合（模型解释）"];
  for (const n of root) {
    for (const t of n.themes) lines.push(`- ${md(t.label)}：${md(t.statement)}（输入 ${t.inputIds.join(", ")}；节点 ${n.nodeId}）`);
    for (const t of n.conflicts) lines.push(`- 冲突：${md(t.statement)}（${t.inputIds.join(", ")}）`);
  }
  lines.push("", "## 完整观点索引（不受主摘要长度限制）");
  for (const v of index) {
    lines.push(`### ${v.viewpointId}`, `${md(v.author.name)} [${v.author.kind}] · ${v.kind}`, md(v.statement.text));
    for (const [label, claims] of [["论据", v.arguments], ["条件", v.conditions], ["反例", v.counterexamples]] as const)
      for (const c of claims) lines.push(`${label}：${md(c.text)}`);
    if (v.time) lines.push(`时间：${md(v.time.text)}`);
    const claims = [v.statement, ...v.arguments, ...v.conditions, ...v.counterexamples, ...(v.time ? [v.time] : [])];
    for (const c of claims) for (const s of c.citations) {
      lines.push(`引用：${md(s.path)} · ${s.unitId} · UTF-16 [${s.start},${s.end}) · ${s.quoteHash} · ${md(s.quote)}`);
      if (s.textOrigin === "manually-edited") lines.push("基于用户修订的识别文本；" + (s.originalVerified ? "原件位置另已核对。" : "未核对原件，不作为原作者逐字证据。"));
    }
  }
  lines.push("", "## 缺口", ...stats.omissions.map(s => `- ${s}`), ...stats.unknownTotalDocuments.map(s => `- ${s}:total-units-unknown`),
    "", "## 用量边界", `原 API 预留请求 ${job.budget.requests.api}；SDK query 预留 ${job.budget.requests.sdk}；SDK HTTP 次数未折算成原 API 请求。`,
    `已知 tokens ${job.budget.tokens}；金额 ${job.budget.receipts.some(r => r.cost === null) || job.budget.reservations.some(r => r.state !== "settled" && r.cost === null) ? "unknown" : job.budget.cost}；已知金额小计 ${job.budget.cost} ${job.budget.limits.currency || "currency unknown"}（不代表总费用为零）；金额未知收据 ${job.budget.receipts.filter(r => r.cost === null).length}；不确定消费 ${job.budget.unknown}。`);
  const markdown = lines.join("\n");
  return { inputResultIds: job.chunks.filter(c => c.status === "done").map(c => c.chunk.cacheKey), index, nodes: job.nodes,
    coverage: stats, markdown, reportHash: await hashText(markdown), quality: "structural-only-semantic-unverified" };
}
