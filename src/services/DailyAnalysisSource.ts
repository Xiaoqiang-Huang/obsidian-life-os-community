import { cleanReviewDailyContent, stripManagedReviewDailyBlocks } from "./ReviewEvidenceService";
import { prepareCitableMarkdown, type EvidenceOrigin } from "./context-engine/ContextSourcePolicyService";

/** Shared input boundary for user-triggered diary analysis; never modify the source. */
export function prepareDailyAnalysisSource(path: string, markdown: string, rootFolder: string): { content: string; origin: EvidenceOrigin } {
  const source = prepareCitableMarkdown(path, markdown, { rootFolder });
  if (!source.allowed) return { content: "", origin: "context-only" };
  const lines: string[] = [];
  let aiLevel = 0, fence = "";
  // Remove the entire subtree BEFORE empty-heading cleanup can discard its parent.
  for (const line of stripManagedReviewDailyBlocks(source.markdown).split(/\r?\n/u)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""; }
    const heading = !fence && !marker ? line.match(/^(#{1,6})\s+(.+?)\s*$/u) : null;
    if (heading && aiLevel && heading[1].length <= aiLevel) aiLevel = 0;
    if (heading && /^(?:AI 分析|四圣谏言|日终总结|Life OS总结)$/iu.test(heading[2])) aiLevel = heading[1].length;
    if (!aiLevel) lines.push(line);
  }
  const content = cleanReviewDailyContent(lines.join("\n")).trim();
  return { content, origin: content ? source.origin : "context-only" };
}
