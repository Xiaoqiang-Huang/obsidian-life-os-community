type Frontmatter = Record<string, unknown>;

export class ContextSourcePolicyService {
  constructor(_rootFolder: string) {}

  isAllowedPath(path: string): boolean {
    const normalized = this.normalizePath(path);
    if (!normalized.endsWith(".md")) return false;
    if (this.hasUnsafePathSegment(normalized)) return false;
    if (this.hasObsidianConfigSegment(normalized)) return false;
    return true;
  }

  isAllowedFrontmatter(_frontmatter: Frontmatter = {}): boolean {
    return true;
  }

  isAllowed(path: string, frontmatter: Frontmatter = {}): boolean {
    return this.isAllowedPath(path) && this.isAllowedFrontmatter(frontmatter);
  }

  private normalizePath(path: string): string {
    return String(path || "").replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0).join("/");
  }

  private hasUnsafePathSegment(path: string): boolean {
    return path.split("/").some((segment) => segment === "." || segment === "..");
  }

  private hasObsidianConfigSegment(path: string): boolean {
    return path.split("/").some((segment) => segment.toLowerCase() === ".obsidian");
  }
}
