import { CitationVerifierService } from "./CitationVerifierService";
import type { ContextEngineResult } from "./types";

export interface RagEvaluationCase {
  id: string;
  expectedPaths: string[];
  result: ContextEngineResult;
  answer?: string;
}

export interface RagEvaluationMetrics {
  id: string;
  sourceRecallAtK: number;
  citationValidity: number;
  citationCompleteness: number;
  retrievedSources: number;
  latencyMs: number;
}

/** Deterministic offline metrics used by regression fixtures and release gates. */
export class RagEvaluationService {
  private readonly verifier = new CitationVerifierService();

  evaluate(input: RagEvaluationCase): RagEvaluationMetrics {
    const expected = new Set(input.expectedPaths.map((path) => this.normalize(path)));
    const actual = new Set(input.result.sources.map((source) => this.normalize(source.path)));
    const matched = Array.from(expected).filter((path) => actual.has(path)).length;
    const verification = input.answer
      ? this.verifier.verify(input.answer, input.result.sources, {
        requireCitations: input.result.sources.length > 0,
        verifyClaimSupport: input.result.sources.length > 0,
        minimumSupportCoverage: 0.7
      })
      : null;
    return {
      id: input.id,
      sourceRecallAtK: expected.size === 0 ? 1 : matched / expected.size,
      citationValidity: verification ? (verification.invalidCitationIds.length === 0 ? 1 : 0) : 1,
      citationCompleteness: verification?.completeness ?? 1,
      retrievedSources: input.result.sources.length,
      latencyMs: input.result.retrievalTrace?.durationMs ?? 0
    };
  }

  aggregate(metrics: RagEvaluationMetrics[]): Omit<RagEvaluationMetrics, "id"> {
    if (metrics.length === 0) {
      return { sourceRecallAtK: 1, citationValidity: 1, citationCompleteness: 1, retrievedSources: 0, latencyMs: 0 };
    }
    const mean = (key: keyof Omit<RagEvaluationMetrics, "id">) =>
      metrics.reduce((sum, metric) => sum + metric[key], 0) / metrics.length;
    return {
      sourceRecallAtK: mean("sourceRecallAtK"),
      citationValidity: mean("citationValidity"),
      citationCompleteness: mean("citationCompleteness"),
      retrievedSources: mean("retrievedSources"),
      latencyMs: mean("latencyMs")
    };
  }

  private normalize(path: string): string {
    return String(path || "").replace(/\\/g, "/").toLowerCase();
  }
}
