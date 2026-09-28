export interface ManagedKnowledgeFrontmatter {
  frontmatter?: Record<string, unknown>;
  warning?: string;
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
  } catch {
    return { warning: "属性区格式错误；已保留正文并按标题或文件名显示。" };
  }
}
