/**
 * A path below the Life OS root is insufficient to style a leaf: the same root
 * contains PDF, Office and image attachments rendered by Obsidian native views.
 */
export interface LifeOsDocumentLeafFile {
  path: string;
  extension: string;
}

export function shouldDecorateLifeOsMarkdownLeaf(
  file: LifeOsDocumentLeafFile | null | undefined,
  root: string
): boolean {
  if (!file || file.extension.toLowerCase() !== "md") return false;
  const normalizedRoot = root.replace(/\/+$/, "");
  return file.path === normalizedRoot || file.path.startsWith(`${normalizedRoot}/`);
}
