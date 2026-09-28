import type { FileSystemService } from "./FileSystemService";
import { isManagedOriginalOnlyPath } from "../utils/managed-original-documents";
/** User documents, not pipeline receipts, generated indexes or internal logs. */
export function isManagedKnowledgePath(path: string, fs: FileSystemService): boolean {
  const normalized = path.replace(/\\/g, "/");
  const projects = fs.path("Projects").replace(/\\/g, "/").replace(/\/+$/u, "");
  const root = fs.path("Knowledge").replace(/\\/g, "/").replace(/\/+$/u, "");
  if (isManagedOriginalOnlyPath(normalized, root, projects, fs.path("Knowledge", "Attachments"))) return true;
  if (normalized.startsWith(`${projects}/`)) {
    const parts = normalized.slice(projects.length + 1).split("/");
    return parts.length >= 3 && parts[1] === "Documents" && parts[2] !== "AI Workspace"
      && !parts.some(part => !part || part === "." || part === "..")
      && normalized.endsWith(".md") && parts[parts.length - 1].toLowerCase() !== "index.md";
  }
  if (!normalized.startsWith(`${root}/`) || normalized.split("/").pop()?.toLowerCase() === "index.md") return false;
  const wiki = fs.path("Knowledge", "LLMWiki").replace(/\\/g, "/");
  const internal = ["Raw", "Wiki/Drafts", "Wiki/Batches", "Trash", "Undo", "Reports", "Schema"];
  if (internal.some(part => normalized === `${wiki}/${part}` || normalized.startsWith(`${wiki}/${part}/`))) return false;
  return !["hot.md", "log.md"].some(name => normalized === `${wiki}/Wiki/${name}`);
}
