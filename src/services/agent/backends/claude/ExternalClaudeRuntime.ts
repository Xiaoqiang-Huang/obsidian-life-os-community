export interface ExternalClaudeRuntime {
  executablePath: string;
  nodePath: string;
  cliVersion: string;
}

export interface ExternalClaudeCandidate {
  executablePath: string;
  nodePath?: string;
}

const MIN_CLI_MAJOR = 2;
const MIN_CLI_MINOR = 1;
const MIN_CLI_PATCH = 248;

export function isSupportedClaudeCliVersion(version: string): boolean {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  return major > MIN_CLI_MAJOR
    || (major === MIN_CLI_MAJOR && (minor > MIN_CLI_MINOR || (minor === MIN_CLI_MINOR && patch >= MIN_CLI_PATCH)));
}

/** Candidate list only. It does not execute anything and intentionally skips
 * Windows shell wrappers (.cmd/.bat/.ps1) that would require a shell. */
export function externalClaudeCandidates(platform: string, env: Record<string, string | undefined>, home: string): ExternalClaudeCandidate[] {
  const path = require("node:path") as typeof import("node:path");
  const candidates: ExternalClaudeCandidate[] = [];
  const add = (executablePath: string, nodePath = "") => {
    if (!executablePath || candidates.some(item => item.executablePath === executablePath)) return;
    candidates.push({ executablePath, ...(nodePath ? { nodePath } : {}) });
  };
  const pathEntries = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  if (platform === "win32") {
    for (const entry of pathEntries) add(path.join(entry, "claude.exe"));
    const local = env.LOCALAPPDATA || "";
    if (local) add(path.join(local, "Claude", "claude.exe"));
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (root) add(path.join(root, "Claude", "claude.exe"));
    }
    if (home) add(path.join(home, ".claude", "local", "claude.exe"));
  } else {
    for (const entry of pathEntries) add(path.join(entry, "claude"));
    if (home) add(path.join(home, ".local", "bin", "claude"));
    if (home) add(path.join(home, ".claude", "local", "claude"));
    add("/usr/local/bin/claude");
    add("/opt/homebrew/bin/claude");
    add("/usr/bin/claude");
  }
  // npm-installed Claude Code CLI is a JS entry. Prefer it over shell wrappers.
  const npmRoots: string[] = [];
  if (platform === "win32") {
    if (env.APPDATA) npmRoots.push(path.join(env.APPDATA, "npm", "node_modules"));
  } else {
    if (home) npmRoots.push(path.join(home, ".npm-global", "lib", "node_modules"));
    npmRoots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
  }
  for (const npmRoot of npmRoots) {
    const cli = path.join(npmRoot, "@anthropic-ai", "claude-code", "cli.js");
    add(cli, findNode(platform, env, home));
  }
  return candidates;
}

export function findNode(platform: string, env: Record<string, string | undefined>, home: string): string {
  const path = require("node:path") as typeof import("node:path");
  const names = platform === "win32" ? ["node.exe"] : ["node"];
  for (const entry of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, names[0]);
    try { if (require("node:fs").statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  if (platform === "win32") {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      const candidate = path.join(root, "nodejs", "node.exe");
      try { if (require("node:fs").statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
    if (env.LOCALAPPDATA) {
      const candidate = path.join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe");
      try { if (require("node:fs").statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
  } else {
    for (const candidate of ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]) {
      try { if (require("node:fs").statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
  }
  return "";
}

async function probeVersion(candidate: ExternalClaudeCandidate, env: Record<string, string | undefined>): Promise<string> {
  const cp = await import("node:child_process");
  const js = /\.[cm]?js$/iu.test(candidate.executablePath);
  if (js && !candidate.nodePath) throw new Error("sdk-external-node-missing");
  return await new Promise<string>((resolve, reject) => {
    const child = cp.spawn(js ? candidate.nodePath! : candidate.executablePath,
      js ? [candidate.executablePath, "--version"] : ["--version"],
      { shell: false, windowsHide: true, env: { PATH: env.PATH || "", PATHEXT: env.PATHEXT || "", SYSTEMROOT: env.SYSTEMROOT || "" } });
    let text = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("sdk-external-version-timeout")); }, 10_000);
    child.stdout.on("data", value => { text += String(value); if (text.length > 4096) child.kill("SIGTERM"); });
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timer); reject(new Error("sdk-external-version-failed")); });
    child.once("exit", code => {
      clearTimeout(timer);
      const version = text.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1] || "";
      if (code === 0 && isSupportedClaudeCliVersion(version)) resolve(version);
      else reject(new Error("sdk-external-version-invalid"));
    });
  });
}

/** Finds a user-installed Claude Code CLI. This never installs, downloads,
 * reads credentials, or uses a shell. The caller still supplies the plugin's
 * own provider credential through the isolated environment. */
export async function resolveExternalClaudeRuntime(platform: string, arch: string, desktop: boolean, env: Record<string, string | undefined> = process.env, home = ""): Promise<ExternalClaudeRuntime> {
  if (!desktop) throw new Error("sdk-desktop-only");
  if (![["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"]].some(([p, a]) => p === platform && a === arch)) throw new Error("sdk-bundled-platform-unavailable");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const resolvedHome = home || os.homedir();
  const candidates = externalClaudeCandidates(platform, env, resolvedHome);
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate.executablePath)).isFile()) continue;
      const version = await probeVersion(candidate, env);
      return { executablePath: candidate.executablePath, nodePath: candidate.nodePath || "", cliVersion: version };
    } catch { /* try next candidate */ }
  }
  throw new Error("sdk-external-runtime-missing");
}
