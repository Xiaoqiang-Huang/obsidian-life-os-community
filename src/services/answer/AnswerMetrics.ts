import type { AnswerDecision } from "./FastPathRouter";

export interface AnswerMetric {
  at: number;
  channel: "desktop" | "weixin";
  path: "fast" | "fast_context" | "deep";
  candidate: "fast" | "fast_context" | "deep";
  reason: string;
  shadow: boolean;
  ttftMs: number | null;
  totalMs: number;
  /** Fast path only; deep orchestration is unknown until every planner is instrumented. */
  dispatch: number | null;
  validationFailed: boolean;
  reasoningAvailable: boolean;
  prefetchHit: boolean;
  status: "completed" | "error" | "interrupted";
  kind?: "answer" | "speculation";
  effort?: "default" | "low" | "medium" | "high" | "max";
  toolCount?: number | null;
  fallbackCount?: number | null;
  prefetchMs?: number | null;
  speculativeStarted?: number;
  speculativeAccepted?: number;
  pathHashes?: string[];
}

const REASONS = new Set(["ambiguous", "length", "forced-deep", "attachment", "scoped-context", "web",
  "multiple-questions", "external-object", "write", "multi-step", "retrieval-or-reference", "date",
  "high-stakes", "single-concept", "simple-advice", "diary-context", "search-context", "prefetch-miss", "quality-gate", "unknown"]);
const EFFORTS = new Set(["default", "low", "medium", "high", "max"]);
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null => { const n = finite(value); return n === null ? null : Math.min(1_000_000, Math.floor(n)); };

/** Rebuild every persisted row from an allowlist, including loaded legacy rows. */
export function sanitizeAnswerMetric(input: unknown): AnswerMetric {
  const row = (input && typeof input === "object" ? input : {}) as Partial<AnswerMetric>;
  return {
    at: finite(row.at) ?? 0, channel: row.channel === "weixin" ? "weixin" : "desktop",
    path: row.path === "fast" || row.path === "fast_context" ? row.path : "deep", candidate: row.candidate === "fast" || row.candidate === "fast_context" ? row.candidate : "deep",
    reason: REASONS.has(String(row.reason)) ? String(row.reason) : "unknown", shadow: row.shadow === true,
    ttftMs: finite(row.ttftMs), totalMs: finite(row.totalMs) ?? 0, dispatch: count(row.dispatch),
    validationFailed: row.validationFailed === true, reasoningAvailable: row.reasoningAvailable === true,
    prefetchHit: row.prefetchHit === true,
    status: row.status === "error" || row.status === "interrupted" ? row.status : "completed",
    kind: row.kind === "speculation" ? "speculation" : "answer",
    effort: EFFORTS.has(String(row.effort)) ? row.effort : "default",
    toolCount: count(row.toolCount), fallbackCount: count(row.fallbackCount), prefetchMs: finite(row.prefetchMs),
    speculativeStarted: Math.min(1, count(row.speculativeStarted) ?? 0),
    speculativeAccepted: Math.min(1, count(row.speculativeAccepted) ?? 0),
    pathHashes: Array.isArray(row.pathHashes) ? [...new Set(row.pathHashes.filter(p => typeof p === "string" && /^[0-9a-f]{16}$/u.test(p)))].slice(0, 16) : []
  };
}

export function recordAnswerMetric(
  settings: { answerMetrics?: AnswerMetric[] },
  decision: AnswerDecision,
  data: Omit<AnswerMetric, "path" | "candidate" | "shadow" | "reason" | "at">
): void {
  const now = Date.now();
  const metric = sanitizeAnswerMetric({ ...data, at: now, path: decision.path, candidate: decision.candidate,
    reason: decision.reason, shadow: decision.shadow });
  settings.answerMetrics = [...(settings.answerMetrics || []).map(sanitizeAnswerMetric)
    .filter(row => row.at > now - 7 * 86400_000 && row.at <= now), metric].slice(-1000);
}

export function summarizeAnswerMetrics(rows: AnswerMetric[] = [], now = Date.now()) {
  const all = rows.map(sanitizeAnswerMetric).filter(row => row.at > now - 7 * 86400_000 && row.at <= now);
  const recent = all.filter(row => row.kind === "answer");
  const quantile = (values: number[], q: number): number | null => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null;
  };
  const successful = recent.filter((row) => row.status === "completed");
  const numbers = (key: keyof AnswerMetric) => recent.flatMap(row => typeof row[key] === "number" ? [row[key] as number] : []);
  const rate = (n: number, d: number) => d ? n / d : 0;
  const started = all.reduce((n, row) => n + (row.speculativeStarted || 0), 0);
  return {
    count: recent.length, speculationCount: started,
    ttftP50: quantile(successful.flatMap((r) => r.ttftMs === null ? [] : [r.ttftMs]), .5),
    ttftP90: quantile(successful.flatMap((r) => r.ttftMs === null ? [] : [r.ttftMs]), .9),
    totalP50: quantile(successful.map((r) => r.totalMs), .5),
    totalP90: quantile(successful.map((r) => r.totalMs), .9),
    dispatchTotal: all.reduce((n, r) => n + (r.dispatch ?? 0), 0),
    dispatchP50: quantile(numbers("dispatch"), .5), dispatchP90: quantile(numbers("dispatch"), .9),
    toolP50: quantile(numbers("toolCount"), .5), toolP90: quantile(numbers("toolCount"), .9),
    fastShare: recent.length ? recent.filter((r) => r.path !== "deep").length / recent.length : 0,
    fastContextShare: recent.length ? recent.filter((r) => r.path === "fast_context").length / recent.length : 0,
    validationFailureRate: recent.length ? recent.filter((r) => r.validationFailed).length / recent.length : 0,
    fallbackRate: rate(recent.filter(r => (r.fallbackCount ?? 0) > 0).length, recent.length),
    fallbackTotal: recent.reduce((n, r) => n + (r.fallbackCount ?? 0), 0),
    prefetchHitRate: rate(recent.filter(r => r.prefetchHit).length, recent.length),
    prefetchP50: quantile(numbers("prefetchMs"), .5), prefetchP90: quantile(numbers("prefetchMs"), .9),
    speculationAcceptRate: rate(all.reduce((n, r) => n + (r.speculativeAccepted || 0), 0), started),
    reasoningAvailableRate: rate(recent.filter(r => r.reasoningAvailable).length, recent.length),
    effortCounts: Object.fromEntries([...EFFORTS].map(effort => [effort, recent.filter(r => r.effort === effort).length]))
  };
}
