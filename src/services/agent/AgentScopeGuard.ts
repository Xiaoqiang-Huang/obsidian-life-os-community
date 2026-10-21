const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/u;
const KNOWN_TOP_LEVEL = new Set([
  "PersonalLifeSystem", "Projects", "SDK-Acceptance",
  "Daily", "Knowledge", "Tasks", "Memory"
]);

export type AgentScopeSource = "project" | "explicit" | "global" | "denied";

export interface AgentScope {
  roots: string[];
  source: AgentScopeSource;
  explicitPaths: string[];
  allowGlobal: boolean;
}

export interface AgentScopeInput {
  projectScopeId?: string;
  userContent?: string;
  lifeOsRoot: string;
  projectsRoot?: string;
  allowGlobal?: boolean;
}

export function normalizeScopePath(value: string): string {
  return String(value || "").replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
}

function isScopedToken(token: string, lifeOsRoot: string): boolean {
  const normalized = normalizeScopePath(token);
  if (!normalized || /^https?:/iu.test(normalized)) return false;
  const withoutRoot = normalized.startsWith(`${lifeOsRoot}/`) ? normalized.slice(lifeOsRoot.length + 1) : normalized;
  const top = withoutRoot.split("/")[0];
  return KNOWN_TOP_LEVEL.has(top) || normalized.startsWith(`${lifeOsRoot}/`);
}

function asFolder(token: string, lifeOsRoot: string): string {
  let normalized = normalizeScopePath(token);
  if (!normalized.startsWith(`${lifeOsRoot}/`) && normalized !== lifeOsRoot) normalized = `${lifeOsRoot}/${normalized}`;
  if (FILE_EXTENSION.test(normalized)) normalized = normalized.split("/").slice(0, -1).join("/");
  return normalizeScopePath(normalized);
}

function commonAncestor(paths: string[]): string {
  if (!paths.length) return "";
  const segments = paths.map(item => normalizeScopePath(item).split("/").filter(Boolean));
  const first = segments[0];
  const length = Math.min(...segments.map(item => item.length));
  const common: string[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!segments.every(item => item[index] === first[index])) break;
    common.push(first[index]);
  }
  return common.join("/");
}

export function extractExplicitScopePaths(text: string, lifeOsRoot: string): string[] {
  const source = String(text || "");
  const tokens = source.match(/[A-Za-z0-9_.\-\u4e00-\u9fa5]+(?:\/[A-Za-z0-9_.\-\u4e00-\u9fa5]+)+(?:\.[A-Za-z0-9]{1,8})?/gu) || [];
  const paths = tokens.filter(token => isScopedToken(token, lifeOsRoot)).map(token => asFolder(token, lifeOsRoot));
  return Array.from(new Set(paths));
}

export function deriveAgentScope(input: AgentScopeInput): AgentScope {
  const lifeOsRoot = normalizeScopePath(input.lifeOsRoot);
  const allowGlobal = input.allowGlobal !== false;
  const projectScopeId = String(input.projectScopeId || "").trim();
  if (projectScopeId) {
    const projectsRoot = normalizeScopePath(input.projectsRoot || `${lifeOsRoot}/Projects`);
    return { roots: [`${projectsRoot}/${projectScopeId}`], source: "project", explicitPaths: [], allowGlobal };
  }
  const explicitPaths = extractExplicitScopePaths(input.userContent || "", lifeOsRoot);
  if (explicitPaths.length) {
    const root = commonAncestor(explicitPaths);
    return { roots: root && root !== lifeOsRoot ? [root] : [lifeOsRoot], source: "explicit", explicitPaths, allowGlobal };
  }
  return allowGlobal
    ? { roots: [lifeOsRoot], source: "global", explicitPaths: [], allowGlobal }
    : { roots: [], source: "denied", explicitPaths: [], allowGlobal };
}

export function isPathInScope(path: string, roots: readonly string[]): boolean {
  const normalized = normalizeScopePath(path);
  return roots.some(root => {
    const normalizedRoot = normalizeScopePath(root);
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
  });
}

export function scopeDenial(path: string, roots: readonly string[]): { code: string; hint: string } | null {
  if (isPathInScope(path, roots)) return null;
  const label = roots.length ? roots.join("、") : "未授权范围";
  return {
    code: "sdk-scope-denied",
    hint: `请求已限定在 ${label}；${normalizeScopePath(path)} 不在范围内，未读取。请改用范围内路径，或先在界面选择对应项目。`
  };
}

export function allowGlobalSearch(scope: AgentScope): boolean {
  return scope.source !== "explicit";
}
