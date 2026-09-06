const PROJECT_CONTEXT_PATH = /(?:^|\/)(?:ai workspace|session notes|period reviews|ai工作区|会话笔记|复盘草稿)(?:\/|$)/iu;
const PROJECT_CONTEXT_FRONTMATTER_TYPE = /(?:^|\r?\n)type:\s*(?:period-review(?:-draft)?|project-(?:context|review|handoff)|ai-workspace)(?:\s|$)/iu;
const REVIEW_SOURCE_ID = /\breview-[a-z0-9][a-z0-9-]{5,}\b/iu;
const PROJECT_CONTEXT_LABEL = /(?:项目上下文|会话交接|自动复盘)/u;

export function isProjectContextTaskSource(filePath: string, content: string): boolean {
  const normalizedPath = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  if (PROJECT_CONTEXT_PATH.test(normalizedPath)) return true;
  const frontmatter = String(content || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
  return PROJECT_CONTEXT_FRONTMATTER_TYPE.test(frontmatter)
    || REVIEW_SOURCE_ID.test(content)
    || PROJECT_CONTEXT_LABEL.test(frontmatter);
}

export function isProjectContextDerivedTaskLine(line: string): boolean {
  const value = String(line || "");
  return REVIEW_SOURCE_ID.test(value)
    || /#pls\/(?:project|review|ai-workspace)\b/iu.test(value)
    || PROJECT_CONTEXT_LABEL.test(value);
}

/**
 * Limit only automatically generated project-context tasks. User-authored and
 * ordinary carried tasks remain untouched. Capping happens before daily-note
 * deduplication so repeated startups cannot gradually leak later candidates in.
 */
export function capProjectContextTaskLines(lines: string[], rawLimit: unknown): string[] {
  const parsed = Math.floor(Number(rawLimit));
  const limit = Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 1;
  let projectContextCount = 0;
  return lines.filter((line) => {
    if (!isProjectContextDerivedTaskLine(line)) return true;
    projectContextCount += 1;
    return projectContextCount <= limit;
  });
}
