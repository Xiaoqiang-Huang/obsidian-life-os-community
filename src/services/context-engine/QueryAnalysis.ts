const GENERIC_ANCHORS = new Set([
  "answer", "context", "information", "knowledge", "please", "project", "question", "record", "task",
  "什么", "内容", "全部", "具体", "分析", "回答", "如何", "完整", "怎么", "情况", "所有", "方案",
  "根据", "检索", "知识", "知识库", "记录", "资料", "问题", "项目"
]);

const CONNECTOR_PATTERN = /(?:中的|里的|里面的|其中的|以及|或者|并且|同时|还有|然后|和|与|及|、)/u;
const LEADING_FILLER = /^(?:请|麻烦|帮我|替我|给我|根据|从|在|对|关于|有关|之前|以前|曾经|当前|现在|看看|查找|查询|检索|找到|说明|分析|梳理|总结|盘点)+/u;
const TRAILING_FILLER = /(?:具体包含哪些内容|包含哪些内容|结论是什么|方案是什么|是什么|有哪些|有什么|怎么做|如何处理|如何|具体内容|的结论|结论|的方案|方案|的内容|内容|的信息|信息|记录|情况|的)$/u;

/**
 * Pulls out user-authored, discriminative phrases before query expansion.
 * These anchors stop generic alias terms from outranking an exact Chinese
 * project, decision, handoff, or document phrase.
 */
export function extractSpecificQueryAnchors(value: string): string[] {
  const normalized = String(value || "").normalize("NFKC").toLowerCase();
  const anchors: string[] = [];
  const lexical = Array.from(normalized.matchAll(/[a-z0-9][a-z0-9_.-]*|[\p{Script=Han}]+/gu), (match) => match[0]);

  for (const term of lexical) {
    if (/^[a-z0-9]/.test(term)) {
      if (term.length >= 3 && !GENERIC_ANCHORS.has(term)) anchors.push(term);
      continue;
    }

    for (const rawPiece of term.split(CONNECTOR_PATTERN)) {
      let piece = rawPiece;
      let previous = "";
      while (piece && piece !== previous) {
        previous = piece;
        piece = piece.replace(LEADING_FILLER, "").replace(TRAILING_FILLER, "");
      }
      piece = piece.trim();
      if (piece.length < 2 || GENERIC_ANCHORS.has(piece)) continue;
      anchors.push(piece.slice(0, 24));
    }
  }

  return Array.from(new Set(anchors)).slice(0, 12);
}
