export interface ManagedKnowledgeFrontmatter {
  frontmatter?: Record<string, unknown>;
  warning?: string;
  issue?: {
    fileLine?: number;
    sourceLine?: string;
    suggestedLine?: string;
  };
}

// A broken note must not prevent the rest of the library from loading.
// Keep the original note bytes intact and let the view use its heading or filename.
export function readManagedKnowledgeFrontmatter(
  content: string,
  parse: (yaml: string) => unknown
): ManagedKnowledgeFrontmatter {
  const yaml = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  if (yaml === undefined) return {};
  try {
    const parsed = parse(yaml);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown> };
    }
    return { warning: "属性区不是键值对象；已保留正文并按标题或文件名显示。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const yamlLine = Number(message.match(/\bline\s+(\d+)\b/iu)?.[1]);
    // Parser locations count from the YAML body, while the editor also shows
    // the opening delimiter. Never display the parser's potentially long
    // message: it may contain private document text.
    const lines = yaml.split(/\r?\n/u);
    const fileLine = Number.isInteger(yamlLine) && yamlLine > 0 && yamlLine <= lines.length
      ? yamlLine + 1 : undefined;
    const rawLine = fileLine ? lines[yamlLine - 1] : undefined;
    const sourceLine = rawLine && rawLine.length > 180 ? `${rawLine.slice(0, 180)}…` : rawLine;
    let suggestedLine: string | undefined;
    // Only suggest a concrete replacement when the entire revised YAML parses;
    // otherwise show a general fix and leave the original document untouched.
    const listValue = rawLine?.match(/^(\s*-\s*)("[^"]+"\S.*)$/u);
    if (listValue && fileLine) {
      const proposed = `${listValue[1]}'${listValue[2].replace(/'/gu, "''")}'`;
      const revised = [...lines];
      revised[yamlLine - 1] = proposed;
      try {
        const checked = parse(revised.join("\n"));
        if (checked && typeof checked === "object" && !Array.isArray(checked)) suggestedLine = proposed;
      } catch { /* No unverified auto-fix advice. */ }
    }
    const location = fileLine ? `（文件第 ${fileLine} 行附近）` : "";
    return {
      warning: `属性区格式错误${location}；已保留正文并按标题或文件名显示。`,
      issue: { fileLine, sourceLine, suggestedLine }
    };
  }
}
