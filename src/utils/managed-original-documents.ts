/** Keep raw-only imports separate from generated Markdown and internal attachments. */
export function isManagedOriginalOnlyPath(
  path: string, knowledgeRoot: string, projectsRoot: string,
  knowledgeAttachmentsRoot = `${knowledgeRoot}/Attachments`
): boolean {
  const normalized = path.replace(/\\/gu, "/");
  const knowledgeAttachments = knowledgeAttachmentsRoot.replace(/\/+$/u, "");
  const projects = projectsRoot.replace(/\/+$/u, "");
  if (normalized.startsWith(`${knowledgeAttachments}/Originals/`)) return true;
  if (!normalized.startsWith(`${projects}/`)) return false;
  const parts = normalized.slice(projects.length + 1).split("/");
  return parts.length >= 4 && Boolean(parts[0]) && parts[1] === "Attachments"
    && parts[2] === "Originals" && parts.slice(3).every(Boolean);
}

/** A source button may only open an attachment belonging to the same knowledge area or project. */
export function managedOriginalSourcePath(
  notePath: string,
  candidate: unknown,
  knowledgeRoot: string,
  projectsRoot: string,
  knowledgeAttachmentsRoot = `${knowledgeRoot}/Attachments`
): string | null {
  if (typeof candidate !== "string") return null;
  const path = candidate.trim().replace(/\\/gu, "/");
  if (!path || path.startsWith("/") || /[:\u0000-\u001f]/u.test(path)
    || path.split("/").some(part => !part || part === "." || part === "..")) return null;
  const knowledge = knowledgeRoot.replace(/\/+$/u, "");
  const knowledgeAttachments = knowledgeAttachmentsRoot.replace(/\/+$/u, "");
  const projects = projectsRoot.replace(/\/+$/u, "");
  if (notePath.startsWith(`${knowledge}/`)) {
    return path.startsWith(`${knowledgeAttachments}/`) ? path : null;
  }
  if (!notePath.startsWith(`${projects}/`)) return null;
  const projectId = notePath.slice(projects.length + 1).split("/")[0];
  return projectId && path.startsWith(`${projects}/${projectId}/Attachments/`) ? path : null;
}
