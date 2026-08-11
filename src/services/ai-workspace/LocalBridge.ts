import type {
  AiWorkspaceImportOptions,
  AiWorkspaceOpenResult,
  AiWorkspaceParsedSession,
  AiWorkspaceProjectBinding,
  AiWorkspaceProjectMemoryCandidate,
  AiWorkspaceProjectMemoryScope,
  AiWorkspaceSessionSummary,
  AiWorkspaceSourceCandidate,
  AiWorkspaceTool
} from "./types";
import {
  AI_WORKSPACE_TOOLS,
  aiWorkspaceToolLabel,
  aiWorkspaceToolSupportsDirectScan
} from "./types";
import {
  BuddyTranscriptParser,
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  normalizeWorkspacePath,
  parseCodexSessionNames,
  parseLifeOsConversationExport,
  parseOpenCodeExport,
  parseOpenCodeRecords,
  pathsBelongTogether,
  PiTranscriptParser,
  stableTextHash,
  type OpenCodeMessageRecord,
  type OpenCodePartRecord,
  type OpenCodeSessionRecord
} from "./logic";

type NodeRequireLike = (id: string) => unknown;

interface NodeStatLike {
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface SqliteStatementLike {
  all(...values: unknown[]): Array<Record<string, unknown>>;
  get(...values: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

interface SqliteModuleLike {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabaseLike;
}

const MAX_DISCOVERY_FILES = 8000;
const SCAN_HEAD_BYTES = 64 * 1024;
const SCAN_SAMPLE_BYTES = 512 * 1024;
const SCAN_YIELD_EVERY = 50;
const MAX_CODEX_SESSION_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_PROJECT_MEMORY_FILES = 80;
const MAX_PROJECT_MEMORY_FILE_BYTES = 256 * 1024;
const MAX_PROJECT_MEMORY_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_MEMORY_RULE_DIRECTORIES = 200;
const MAX_PROJECT_MEMORY_DISCOVERY_DIRECTORIES = 240;
const MAX_PROJECT_MEMORY_DISCOVERY_DEPTH = 2;
const PROJECT_MEMORY_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".obsidian",
  ".cache",
  ".venv",
  "__pycache__",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  "out",
  "output",
  "outputs",
  "logs",
  "tmp",
  "temp",
  "archive",
  "archives",
  "artifacts",
  "release",
  "releases"
]);

export class AiWorkspaceLocalBridge {
  isAvailable(): boolean {
    return Boolean(this.nodeRequire());
  }

  defaultSourcePath(tool: AiWorkspaceTool): string {
    if (tool === "web" || !aiWorkspaceToolSupportsDirectScan(tool)) return "";
    const nodeRequire = this.nodeRequire();
    if (!nodeRequire) return "";
    const os = nodeRequire("os") as typeof import("os");
    const path = nodeRequire("path") as typeof import("path");
    const home = os.homedir();
    if (tool === "codex") return path.join(home, ".codex");
    if (tool === "claude") return path.join(home, ".claude", "projects");
    if (tool === "opencode") return path.join(home, ".local", "share", "opencode", "opencode.db");
    if (tool === "codebuddy") {
      const candidates = [path.join(home, ".codebuddy"), path.join(home, ".codebuddycn")];
      return candidates.find((candidate) => this.fs().existsSync(candidate)) ?? candidates[0];
    }
    if (tool === "workbuddy") return path.join(home, ".workbuddy");
    if (tool === "pi") return path.join(home, ".pi", "agent", "sessions");
    return "";
  }

  defaultExecutable(tool: AiWorkspaceTool): string {
    if (tool === "gemini-cli") return "gemini";
    if (tool === "github-copilot") return "copilot";
    if (tool === "kiro") return "kiro-cli";
    if (tool === "qwen-code") return "qwen";
    if (tool === "tongyi-lingma" || tool === "cline" || tool === "roo-code" || tool === "continue") {
      return "code";
    }
    return tool;
  }

  sourcePathExists(tool: AiWorkspaceTool, sourcePath = ""): boolean {
    if (tool === "web" || !aiWorkspaceToolSupportsDirectScan(tool)) return true;
    const nodeRequire = this.nodeRequire();
    if (!nodeRequire) return false;
    try {
      const path = sourcePath.trim() || this.defaultSourcePath(tool);
      return Boolean(path && this.fs().existsSync(this.expandHome(path)));
    } catch {
      return false;
    }
  }

  scanProjectMemory(
    workDirectories: string[],
    toolSources: AiWorkspaceProjectBinding["tools"] = []
  ): AiWorkspaceProjectMemoryCandidate[] {
    const fs = this.fs();
    const path = this.path();
    const candidates: AiWorkspaceProjectMemoryCandidate[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    const append = (root: string, relativePath: string, scope: AiWorkspaceProjectMemoryScope): void => {
      if (candidates.length >= MAX_PROJECT_MEMORY_FILES || totalBytes >= MAX_PROJECT_MEMORY_TOTAL_BYTES) return;
      const sourcePath = path.resolve(root, relativePath);
      const key = sourcePath.toLowerCase();
      if (seen.has(key) || !fs.existsSync(sourcePath)) return;
      try {
        const stat = fs.lstatSync(sourcePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_PROJECT_MEMORY_FILE_BYTES) return;
        if (totalBytes + stat.size > MAX_PROJECT_MEMORY_TOTAL_BYTES) return;
        const content = fs.readFileSync(sourcePath, "utf8");
        if (!content.trim() || content.includes("\0")) return;
        seen.add(key);
        totalBytes += stat.size;
        candidates.push({
          scope,
          sourcePath,
          relativePath: relativePath.replace(/\\/gu, "/"),
          content,
          contentHash: stableTextHash(content),
          size: stat.size,
          sourceModifiedAt: new Date(stat.mtimeMs).toISOString()
        });
      } catch {
        // One unreadable project rule must not block the remaining memory snapshot.
      }
    };
    const fixedFiles: Array<[string, AiWorkspaceProjectMemoryScope]> = [
      ["AGENTS.md", "shared"],
      ["CLAUDE.md", "claude"],
      [".claude/CLAUDE.md", "claude"],
      [".codex/AGENTS.md", "codex"],
      [".opencode/AGENTS.md", "opencode"],
      ["CODEBUDDY.md", "codebuddy"],
      [".codebuddy/CODEBUDDY.md", "codebuddy"],
      ["WORKBUDDY.md", "workbuddy"],
      [".workbuddy/WORKBUDDY.md", "workbuddy"],
      ["GEMINI.md", "gemini-cli"],
      ["QWEN.md", "qwen-code"],
      [".cursorrules", "cursor"],
      [".windsurfrules", "windsurf"],
      [".github/copilot-instructions.md", "github-copilot"],
      ["CONVENTIONS.md", "aider"]
    ];
    const ruleDirectories: Array<[string, AiWorkspaceProjectMemoryScope]> = [
      [".claude/rules", "claude"],
      [".claude/commands", "claude"],
      [".cursor/rules", "cursor"],
      [".windsurf/rules", "windsurf"],
      [".github/instructions", "github-copilot"],
      [".kiro/steering", "kiro"],
      [".opencode/agents", "opencode"],
      [".opencode/commands", "opencode"],
      [".codebuddy/rules", "codebuddy"],
      [".codebuddy/commands", "codebuddy"],
      [".workbuddy/memory", "workbuddy"],
      [".pi/prompts", "pi"],
      [".qwen/rules", "qwen-code"],
      [".qwen/commands", "qwen-code"],
      [".trae/rules", "trae"],
      [".lingma/rules", "tongyi-lingma"],
      [".cline/rules", "cline"],
      [".roo/rules", "roo-code"],
      [".continue/rules", "continue"]
    ];
    const allowedRuleFile = (file: string): boolean => /\.(?:md|mdc|txt)$/iu.test(file);
    for (const rawRoot of Array.from(new Set(workDirectories.map((item) => item.trim()).filter(Boolean)))) {
      const root = this.expandHome(rawRoot);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
      fixedFiles.forEach(([relativePath, scope]) => append(root, relativePath, scope));
      for (const [relativeDirectory, scope] of ruleDirectories) {
        const directory = path.join(root, relativeDirectory);
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) continue;
        const files = this.walkProjectMemoryRuleFiles(directory, allowedRuleFile);
        files.forEach((file) => append(root, path.relative(root, file), scope));
      }
      const stack: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
      let visitedDirectories = 0;
      while (
        stack.length > 0
        && candidates.length < MAX_PROJECT_MEMORY_FILES
        && visitedDirectories < MAX_PROJECT_MEMORY_DISCOVERY_DIRECTORIES
      ) {
        const current = stack.pop()!;
        visitedDirectories += 1;
        let entries: import("fs").Dirent[];
        try {
          entries = fs.readdirSync(current.directory, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const absolute = path.join(current.directory, entry.name);
          if (entry.isFile() && entry.name.toLowerCase() === "agents.md") {
            append(root, path.relative(root, absolute), "shared");
          } else if (
            entry.isDirectory()
            && current.depth < MAX_PROJECT_MEMORY_DISCOVERY_DEPTH
            && !entry.name.startsWith(".")
            && !PROJECT_MEMORY_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())
          ) {
            stack.push({ directory: absolute, depth: current.depth + 1 });
          }
        }
      }
    }
    for (const source of toolSources.filter((item) => item.enabled)) {
      const configuredRoot = source.sourcePath.trim() || this.defaultSourcePath(source.tool);
      if (!configuredRoot) continue;
      const root = this.expandHome(configuredRoot);
      if (!fs.existsSync(root)) continue;
      if (source.tool === "workbuddy") {
        const toolRoot = fs.statSync(root).isDirectory() ? root : path.dirname(root);
        const memoryDirectory = path.join(toolRoot, "memory");
        if (!fs.existsSync(memoryDirectory) || !fs.statSync(memoryDirectory).isDirectory()) continue;
        this.walkProjectMemoryRuleFiles(memoryDirectory, (file) => /\.md$/iu.test(file))
          .forEach((file) => append(toolRoot, path.relative(toolRoot, file), "workbuddy"));
      } else if (source.tool === "codebuddy") {
        const toolRoot = fs.statSync(root).isDirectory() ? root : path.dirname(root);
        append(toolRoot, "CODEBUDDY.md", "codebuddy");
      } else if (source.tool === "pi") {
        const toolRoot = path.basename(root).toLowerCase() === "sessions" ? path.dirname(root) : root;
        ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"].forEach((file) => append(toolRoot, file, "pi"));
      }
    }
    return candidates.sort((left, right) =>
      left.scope.localeCompare(right.scope) || left.relativePath.localeCompare(right.relativePath)
    );
  }

  async scan(
    binding: AiWorkspaceProjectBinding,
    tool: AiWorkspaceTool
  ): Promise<AiWorkspaceSourceCandidate[]> {
    const source = binding.tools.find((item) => item.tool === tool);
    if (!source?.enabled) return [];
    if (tool === "web" || !aiWorkspaceToolSupportsDirectScan(tool)) return [];
    const sourcePath = source.sourcePath.trim() || this.defaultSourcePath(tool);
    if (!sourcePath) throw new Error("当前环境无法读取本地会话，请改用导出文件导入。");
    let candidates: AiWorkspaceSourceCandidate[];
    if (tool === "codex") {
      candidates = await this.scanCodex(sourcePath);
    } else if (tool === "claude") {
      candidates = await this.scanClaude(sourcePath);
    } else if (tool === "opencode") {
      candidates = await this.scanOpenCode(sourcePath);
    } else if (tool === "codebuddy" || tool === "workbuddy") {
      candidates = await this.scanBuddy(sourcePath, tool);
    } else if (tool === "pi") {
      candidates = await this.scanPi(sourcePath);
    } else {
      candidates = [];
    }
    return candidates.map((candidate) => ({
      ...candidate,
      matchedProjectIds: binding.workDirectories.some((directory) => pathsBelongTogether(candidate.cwd, directory))
        ? [binding.projectId]
        : []
    }));
  }

  async parseCandidate(
    candidate: AiWorkspaceSourceCandidate,
    options: AiWorkspaceImportOptions
  ): Promise<AiWorkspaceParsedSession> {
    if (!this.nodeRequire()) throw new Error("移动端不能直接读取工具目录，请先导出会话文件再导入。");
    if (candidate.sourceKind === "export-json" || candidate.sourceKind === "browser-capture") {
      const fs = this.fs();
      const payload = JSON.parse(await fs.promises.readFile(candidate.sourcePath, "utf8")) as unknown;
      if (String(this.asRecord(payload).schema || "") === "lifeos-ai-conversation-v1") {
        return parseLifeOsConversationExport({ ...candidate }, payload, options);
      }
      if (candidate.tool === "opencode") return parseOpenCodeExport({ ...candidate }, payload, options);
      throw new Error("该 JSON 不是 Life OS 标准会话导出，请选择正确的 JSONL 文件或使用补充导出提示词。");
    }
    if (candidate.tool === "codex") {
      const parser = new CodexTranscriptParser({ ...candidate }, options);
      await this.consumeJsonLines(candidate.sourcePath, (line) => parser.consume(line));
      return parser.finish();
    }
    if (candidate.tool === "claude") {
      const parser = new ClaudeTranscriptParser({ ...candidate }, options);
      await this.consumeJsonLines(candidate.sourcePath, (line) => parser.consume(line));
      return parser.finish();
    }
    if (candidate.tool === "codebuddy" || candidate.tool === "workbuddy") {
      const parser = new BuddyTranscriptParser({ ...candidate }, options);
      await this.consumeJsonLines(candidate.sourcePath, (line) => parser.consume(line));
      return parser.finish();
    }
    if (candidate.tool === "pi") {
      const parser = new PiTranscriptParser({ ...candidate }, options);
      await this.consumeJsonLines(candidate.sourcePath, (line) => parser.consume(line));
      return parser.finish();
    }
    return this.parseOpenCodeDatabaseCandidate(candidate, options);
  }

  async refreshTrackedCandidate(
    session: AiWorkspaceSessionSummary
  ): Promise<AiWorkspaceSourceCandidate | null> {
    if (!this.nodeRequire() || session.tool === "web") return null;
    const fs = this.fs();
    const sourcePath = this.expandHome(session.sourcePath);
    if (!sourcePath || !fs.existsSync(sourcePath)) return null;
    let candidate: AiWorkspaceSourceCandidate | null = null;
    if (session.tracking.sourceKind === "sqlite" && session.tool === "opencode") {
      candidate = this.openCodeDatabaseCandidate(sourcePath, session.sourceSessionId);
    } else if (session.tracking.sourceKind === "jsonl") {
      candidate = session.tool === "codex"
        ? this.codexCandidateFromFile(sourcePath)
        : session.tool === "claude"
          ? this.claudeCandidateFromFile(sourcePath)
          : session.tool === "codebuddy" || session.tool === "workbuddy"
            ? this.buddyCandidateFromFile(sourcePath, session.tool)
            : session.tool === "pi"
              ? this.piCandidateFromFile(sourcePath)
              : null;
    } else if (session.tracking.sourceKind === "export-json") {
      candidate = this.lifeOsExportCandidate(sourcePath, session.tool)
        ?? (session.tool === "opencode" ? this.openCodeExportCandidate(sourcePath) : null);
    }
    if (!candidate || candidate.sourceSessionId !== session.sourceSessionId) return null;
    return {
      ...candidate,
      title: candidate.title || session.title,
      cwd: candidate.cwd || session.cwd,
      model: candidate.model || session.model,
      sourcePlatform: candidate.sourcePlatform || session.sourcePlatform,
      sourceUrl: candidate.sourceUrl || session.sourceUrl,
      matchedProjectIds: [session.projectId]
    };
  }

  async copyRawSnapshot(sourcePath: string, destinationPath: string): Promise<void> {
    const fs = this.fs();
    const path = this.path();
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, destinationPath);
  }

  async writeRawSnapshot(destinationPath: string, content: string): Promise<void> {
    const fs = this.fs();
    const path = this.path();
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, content, "utf8");
  }

  async readFileSegment(
    filePath: string,
    startLine = 1,
    lineCount = 200
  ): Promise<{ text: string; startLine: number; endLine: number; hasPrevious: boolean; hasNext: boolean }> {
    const fs = this.fs();
    const readline = this.nodeRequire()!("readline") as typeof import("readline");
    const safeStart = Math.max(1, Math.floor(startLine));
    const safeCount = Math.max(1, Math.min(500, Math.floor(lineCount)));
    const lines: string[] = [];
    let current = 0;
    let hasNext = false;
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
      current += 1;
      if (current < safeStart) continue;
      if (lines.length < safeCount) {
        lines.push(line);
        continue;
      }
      hasNext = true;
      break;
    }
    reader.close();
    stream.destroy();
    return {
      text: lines.join("\n"),
      startLine: safeStart,
      endLine: safeStart + Math.max(0, lines.length - 1),
      hasPrevious: safeStart > 1,
      hasNext
    };
  }

  async openOriginalSession(
    tool: AiWorkspaceTool,
    sessionId: string,
    cwd: string,
    prompt = "",
    executable = ""
  ): Promise<AiWorkspaceOpenResult> {
    if (tool === "web") {
      return { opened: false, method: "export", message: "网页会话请使用记录中的原始网页链接打开。" };
    }
    const nodeRequire = this.nodeRequire();
    if (!nodeRequire) {
      return { opened: false, method: "export", message: "当前环境不能启动桌面工具。" };
    }
    const command = executable.trim() || this.defaultExecutable(tool);
    const args = tool === "codex"
      ? ["resume", sessionId, ...(prompt.trim() ? [prompt] : [])]
      : tool === "claude" || tool === "codebuddy" || tool === "workbuddy"
        ? ["--resume", sessionId, ...(prompt.trim() ? [prompt] : [])]
        : ["--session", sessionId, ...(prompt.trim() ? ["--prompt", prompt] : [])];
    if (!await this.commandExists(command)) {
      return { opened: false, method: "export", message: `未找到 ${command}，已保留复制与导出降级入口。` };
    }
    try {
      const childProcess = nodeRequire("child_process") as typeof import("child_process");
      const shellCommand = this.buildPowerShellLaunch(command, args, cwd);
      const child = childProcess.spawn("powershell.exe", [
        "-NoProfile",
        "-Command",
        shellCommand
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
      child.unref();
      return { opened: true, method: "terminal", message: `已在 ${tool} 中打开原始会话。` };
    } catch (error) {
      return {
        opened: false,
        method: "export",
        message: error instanceof Error ? error.message : `无法启动 ${tool}。`
      };
    }
  }

  async openNewToolSession(
    tool: AiWorkspaceTool,
    cwd: string,
    prompt: string,
    executable = ""
  ): Promise<AiWorkspaceOpenResult> {
    if (tool === "web") {
      return { opened: false, method: "clipboard", message: "网页会话请复制上下文后回到对应网页 AI 继续。" };
    }
    const nodeRequire = this.nodeRequire();
    if (!nodeRequire) return { opened: false, method: "export", message: "当前环境不能启动桌面工具。" };
    const command = executable.trim() || this.defaultExecutable(tool);
    if (!await this.commandExists(command)) {
      return { opened: false, method: "export", message: `未找到 ${command}。` };
    }
    const args = tool === "opencode"
      ? ["--prompt", prompt]
      : tool === "gemini-cli" || tool === "github-copilot" || tool === "qwen-code"
        ? ["-p", prompt]
      : tool === "aider"
          ? ["--message", prompt]
          : tool === "cursor"
            || tool === "windsurf"
            || tool === "kiro"
            || tool === "trae"
            || tool === "tongyi-lingma"
            || tool === "cline"
            || tool === "roo-code"
            || tool === "continue"
            ? ["."]
            : [prompt];
    try {
      const childProcess = nodeRequire("child_process") as typeof import("child_process");
      const child = childProcess.spawn("powershell.exe", [
        "-NoProfile",
        "-Command",
        this.buildPowerShellLaunch(command, args, cwd)
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
      child.unref();
      const needsPaste = tool === "cursor"
        || tool === "windsurf"
        || tool === "kiro"
        || tool === "trae"
        || tool === "tongyi-lingma"
        || tool === "cline"
        || tool === "roo-code"
        || tool === "continue";
      return {
        opened: true,
        method: "terminal",
        message: needsPaste
          ? `已打开 ${aiWorkspaceToolLabel(tool)} 工作区；交接提示词已复制，请在新会话中粘贴。`
          : `已在 ${aiWorkspaceToolLabel(tool)} 中打开新会话并带入上下文。`
      };
    } catch (error) {
      return {
        opened: false,
        method: "export",
        message: error instanceof Error ? error.message : `无法启动 ${tool}。`
      };
    }
  }

  deriveDirectoryFromFiles(files: File[]): string {
    const first = files.find((file) => typeof (file as File & { path?: string }).path === "string");
    if (!first) return "";
    const path = this.path();
    const absolute = (first as File & { path?: string }).path ?? "";
    const relative = first.webkitRelativePath || first.name;
    const relativeParts = relative.replace(/\\/g, "/").split("/").filter(Boolean);
    let directory = absolute;
    for (let index = 0; index < Math.max(1, relativeParts.length - 1); index += 1) {
      directory = path.dirname(directory);
    }
    return directory;
  }

  candidateFromManualFile(filePath: string, tool: AiWorkspaceTool): AiWorkspaceSourceCandidate {
    const fs = this.fs();
    const path = this.path();
    const absolute = this.expandHome(filePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error("所选会话文件不可读取。");
    }
    const lifeOsCandidate = path.extname(absolute).toLowerCase() === ".json"
      ? this.lifeOsExportCandidate(absolute, tool)
      : null;
    if (lifeOsCandidate) return lifeOsCandidate;
    if (tool === "web") {
      throw new Error("网页 AI 导入文件必须是 Life OS 浏览器扩展生成的标准 JSON。");
    }
    if (tool === "codex") {
      const candidate = this.codexCandidateFromFile(absolute);
      if (candidate) return candidate;
      throw new Error("没有在文件中识别到 Codex 会话元数据。");
    }
    if (tool === "claude") {
      const candidate = this.claudeCandidateFromFile(absolute);
      if (candidate) return candidate;
      throw new Error("没有在文件中识别到 Claude Code 会话记录。");
    }
    if (tool === "codebuddy" || tool === "workbuddy") {
      const candidate = this.buddyCandidateFromFile(absolute, tool);
      if (candidate) return candidate;
      throw new Error(`没有在文件中识别到 ${this.toolLabel(tool)} 会话记录。`);
    }
    if (tool === "pi") {
      const candidate = this.piCandidateFromFile(absolute);
      if (candidate) return candidate;
      throw new Error("没有在文件中识别到 Pi 会话记录。");
    }
    if (tool !== "opencode") {
      throw new Error(`${this.toolLabel(tool)} 请导入 Life OS 标准会话 JSON，或先复制补充导出提示词。`);
    }
    const candidate = this.openCodeExportCandidate(absolute);
    if (candidate) return candidate;
    const stat = fs.statSync(absolute);
    return {
      key: `opencode:${stableTextHash(`${absolute}:${stat.size}:${stat.mtimeMs}`)}`,
      tool: "opencode",
      sourceSessionId: path.basename(absolute, path.extname(absolute)),
      sourcePath: absolute,
      title: path.basename(absolute),
      cwd: "",
      createdAt: new Date(stat.mtimeMs).toISOString(),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      size: stat.size,
      fingerprint: stableTextHash(`${absolute}:${stat.size}:${stat.mtimeMs}`),
      matchedProjectIds: [],
      sourceKind: "export-json"
    };
  }

  scanLifeOsExportDirectory(
    sourcePath: string,
    tool: AiWorkspaceTool,
    projectId: string
  ): AiWorkspaceSourceCandidate[] {
    const fs = this.fs();
    const path = this.path();
    const root = this.expandHome(sourcePath);
    if (!fs.existsSync(root)) return [];
    const files = this.walkFiles([root], (file) => path.extname(file).toLowerCase() === ".json");
    return files
      .map((file) => this.lifeOsExportCandidate(file, tool))
      .filter((candidate): candidate is AiWorkspaceSourceCandidate => Boolean(candidate && candidate.tool === tool))
      .map((candidate) => ({ ...candidate, matchedProjectIds: [projectId] }));
  }

  private async scanCodex(sourcePath: string): Promise<AiWorkspaceSourceCandidate[]> {
    const fs = this.fs();
    const path = this.path();
    const root = this.expandHome(sourcePath);
    if (!fs.existsSync(root)) throw new Error(`Codex 会话来源不存在：${root}`);
    const sessionNames = this.loadCodexSessionNames(root);
    const stateDb = path.extname(root).toLowerCase() === ".sqlite"
      ? root
      : path.join(root, "state_5.sqlite");
    if (fs.existsSync(stateDb)) {
      try {
        const sqlite = this.sqlite();
        const db = new sqlite.DatabaseSync(stateDb, { readOnly: true });
        const columns = db.prepare("pragma table_info(threads)").all().map((row) => String(row.name));
        const has = (name: string): boolean => columns.includes(name);
        const select = [
          "id",
          has("name") ? "name" : "'' as name",
          has("title") ? "title" : "'' as title",
          has("cwd") ? "cwd" : "'' as cwd",
          has("created_at") ? "created_at" : "0 as created_at",
          has("updated_at") ? "updated_at" : "0 as updated_at",
          has("rollout_path") ? "rollout_path" : "'' as rollout_path",
          has("source") ? "source" : "'' as source",
          has("model") ? "model" : "'' as model"
        ].join(", ");
        const rows = db.prepare(`select ${select} from threads order by updated_at desc`).all();
        db.close();
        return rows
          .filter((row) => !/(?:subagent|automation|guardian|approval-review)/iu.test(String(row.source ?? "")))
          .map((row) => this.codexCandidateFromRow(row, root, sessionNames))
          .filter((candidate): candidate is AiWorkspaceSourceCandidate => Boolean(candidate));
      } catch {
        // Fall through to the JSONL inventory when the local schema changes.
      }
    }
    const roots = fs.statSync(root).isDirectory()
      ? [path.join(root, "sessions"), path.join(root, "archived_sessions"), root]
      : [path.dirname(root)];
    const files = this.walkFiles(roots.filter((item) => fs.existsSync(item)), (file) => /^rollout-.*\.jsonl$/i.test(path.basename(file)));
    return this.mapCandidateFiles(files, (file) => this.codexCandidateFromFile(file, sessionNames));
  }

  private async scanClaude(sourcePath: string): Promise<AiWorkspaceSourceCandidate[]> {
    const fs = this.fs();
    const path = this.path();
    const root = this.expandHome(sourcePath);
    if (!fs.existsSync(root)) throw new Error(`Claude Code 会话来源不存在：${root}`);
    const files = fs.statSync(root).isFile()
      ? [root]
      : this.walkFiles([root], (file) => path.extname(file).toLowerCase() === ".jsonl");
    return this.mapCandidateFiles(files, (file) => this.claudeCandidateFromFile(file));
  }

  private async scanBuddy(
    sourcePath: string,
    tool: "codebuddy" | "workbuddy"
  ): Promise<AiWorkspaceSourceCandidate[]> {
    const fs = this.fs();
    const path = this.path();
    const root = this.expandHome(sourcePath);
    if (!fs.existsSync(root)) throw new Error(`${this.toolLabel(tool)} 会话来源不存在：${root}`);
    const stat = fs.statSync(root);
    const roots = stat.isFile()
      ? [root]
      : [
          path.basename(root).toLowerCase() === "projects" ? root : path.join(root, "projects"),
          path.join(root, "sessions")
        ].filter((item) => fs.existsSync(item));
    const files = stat.isFile()
      ? [root]
      : this.walkFiles(roots.length > 0 ? roots : [root], (file) => path.extname(file).toLowerCase() === ".jsonl");
    return this.mapCandidateFiles(files, (file) => this.buddyCandidateFromFile(file, tool));
  }

  private async scanPi(sourcePath: string): Promise<AiWorkspaceSourceCandidate[]> {
    const fs = this.fs();
    const path = this.path();
    const root = this.expandHome(sourcePath);
    if (!fs.existsSync(root)) throw new Error(`Pi 会话来源不存在：${root}`);
    const stat = fs.statSync(root);
    const roots = stat.isFile()
      ? [root]
      : [
          path.join(root, "agent", "sessions"),
          path.join(root, "sessions"),
          root
        ].filter((item, index, values) => fs.existsSync(item) && values.indexOf(item) === index);
    const files = stat.isFile()
      ? [root]
      : this.walkFiles(roots.slice(0, 1), (file) => path.extname(file).toLowerCase() === ".jsonl");
    return this.mapCandidateFiles(files, (file) => this.piCandidateFromFile(file));
  }

  private async scanOpenCode(sourcePath: string): Promise<AiWorkspaceSourceCandidate[]> {
    const fs = this.fs();
    const path = this.path();
    const root = this.expandHome(sourcePath);
    if (!fs.existsSync(root)) throw new Error(`OpenCode 会话来源不存在：${root}`);
    if (fs.statSync(root).isFile() && path.extname(root).toLowerCase() === ".db") {
      const sqlite = this.sqlite();
      const db = new sqlite.DatabaseSync(root, { readOnly: true });
      const rows = db.prepare([
        "select s.id, s.parent_id, s.directory, s.title, s.version, s.time_created, s.time_updated,",
        "(select count(*) from message m where m.session_id = s.id) as message_count,",
        "(select max(m.time_created) from message m where m.session_id = s.id) as message_latest,",
        "(select count(*) from part p where p.session_id = s.id) as part_count",
        "from session s order by s.time_updated desc"
      ].join(" ")).all();
      db.close();
      const stat = fs.statSync(root);
      return rows.map((row) => ({
        key: `opencode:${String(row.id)}`,
        tool: "opencode" as const,
        sourceSessionId: String(row.id),
        sourcePath: root,
        title: String(row.title || "OpenCode 会话"),
        cwd: String(row.directory || ""),
        createdAt: this.toIso(row.time_created, stat.mtimeMs),
        updatedAt: this.toIso(row.time_updated, stat.mtimeMs),
        size: stat.size,
        fingerprint: stableTextHash([
          row.id,
          row.time_updated,
          row.message_count,
          row.message_latest,
          row.part_count
        ].join(":")),
        matchedProjectIds: [],
        parentSessionId: row.parent_id ? String(row.parent_id) : undefined,
        model: row.version ? `OpenCode ${String(row.version)}` : undefined,
        sourceKind: "sqlite" as const
      }));
    }
    const files = fs.statSync(root).isFile()
      ? [root]
      : this.walkFiles([root], (file) => path.extname(file).toLowerCase() === ".json");
    return this.mapCandidateFiles(files, (file) => this.openCodeExportCandidate(file));
  }

  private async mapCandidateFiles(
    files: string[],
    read: (file: string) => AiWorkspaceSourceCandidate | null
  ): Promise<AiWorkspaceSourceCandidate[]> {
    const candidates: AiWorkspaceSourceCandidate[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const candidate = read(files[index]);
      if (candidate) candidates.push(candidate);
      if ((index + 1) % SCAN_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      }
    }
    return candidates;
  }

  private codexCandidateFromRow(
    row: Record<string, unknown>,
    codexRoot: string,
    sessionNames: Map<string, string> = new Map()
  ): AiWorkspaceSourceCandidate | null {
    const fs = this.fs();
    const path = this.path();
    const rawPath = String(row.rollout_path || "");
    if (!rawPath) return null;
    const sourcePath = this.expandHome(path.isAbsolute(rawPath) ? rawPath : path.join(codexRoot, rawPath));
    if (!fs.existsSync(sourcePath)) return null;
    const stat = fs.statSync(sourcePath);
    const id = String(row.id || path.basename(sourcePath).replace(/^rollout-.*?([0-9a-f-]{20,})\.jsonl$/i, "$1"));
    return {
      key: `codex:${id}`,
      tool: "codex",
      sourceSessionId: id,
      sourcePath,
      title: sessionNames.get(id) || String(row.name || row.title || ""),
      cwd: String(row.cwd || ""),
      createdAt: this.toIso(row.created_at, stat.mtimeMs),
      updatedAt: this.toIso(row.updated_at, stat.mtimeMs),
      size: stat.size,
      fingerprint: stableTextHash(`${id}:${stat.size}:${stat.mtimeMs}`),
      matchedProjectIds: [],
      model: row.model ? String(row.model) : undefined,
      sourceKind: "jsonl"
    };
  }

  private codexCandidateFromFile(
    file: string,
    sessionNames: Map<string, string> = this.loadCodexSessionNames(file)
  ): AiWorkspaceSourceCandidate | null {
    const fs = this.fs();
    const path = this.path();
    const stat = fs.statSync(file);
    const rows = this.readHeadRows(file);
    const meta = rows.find((row) => row.type === "session_meta");
    const payload = this.asRecord(meta?.payload);
    const id = String(payload.session_id || payload.id || path.basename(file).replace(/^rollout-.*?([0-9a-f-]{20,})\.jsonl$/i, "$1"));
    if (!id) return null;
    return {
      key: `codex:${id}`,
      tool: "codex",
      sourceSessionId: id,
      sourcePath: file,
      title: sessionNames.get(id) || "",
      cwd: String(payload.cwd || ""),
      createdAt: this.toIso(payload.timestamp, stat.mtimeMs),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      size: stat.size,
      fingerprint: stableTextHash(`${id}:${stat.size}:${stat.mtimeMs}`),
      matchedProjectIds: [],
      model: payload.model_provider ? String(payload.model_provider) : undefined,
      sourceKind: "jsonl"
    };
  }

  private loadCodexSessionNames(sourcePath: string): Map<string, string> {
    const fs = this.fs();
    const path = this.path();
    try {
      const absolute = this.expandHome(sourcePath);
      const stat = fs.statSync(absolute);
      const startDirectory = stat.isDirectory() ? absolute : path.dirname(absolute);
      const directories = [startDirectory];
      const baseName = path.basename(startDirectory).toLowerCase();
      if (baseName === "sessions" || baseName === "archived_sessions") {
        directories.push(path.dirname(startDirectory));
      }
      const codexSegment = `${path.sep}.codex${path.sep}`;
      const codexIndex = `${absolute}${path.sep}`.toLowerCase().lastIndexOf(codexSegment.toLowerCase());
      if (codexIndex >= 0) {
        directories.push(absolute.slice(0, codexIndex + codexSegment.length - 1));
      }
      for (const directory of Array.from(new Set(directories))) {
        const indexPath = path.join(directory, "session_index.jsonl");
        if (!fs.existsSync(indexPath)) continue;
        const indexStat = fs.statSync(indexPath);
        if (!indexStat.isFile() || indexStat.size > MAX_CODEX_SESSION_INDEX_BYTES) continue;
        return parseCodexSessionNames(fs.readFileSync(indexPath, "utf8"));
      }
    } catch {
      // Codex still remains importable when its optional display-name index is unavailable.
    }
    return new Map();
  }

  private claudeCandidateFromFile(file: string): AiWorkspaceSourceCandidate | null {
    const fs = this.fs();
    const path = this.path();
    const stat = fs.statSync(file);
    const rows = this.readHeadRows(file);
    const messageRow = rows.find((row) => row.type === "user" || row.type === "assistant");
    if (!messageRow) return null;
    const sessionId = String(messageRow.sessionId || path.basename(file, ".jsonl"));
    const message = this.asRecord(messageRow.message);
    const title = messageRow.type === "user" ? this.extractMessageText(message.content).slice(0, 90) : "";
    return {
      key: `claude:${sessionId}`,
      tool: "claude",
      sourceSessionId: sessionId,
      sourcePath: file,
      title,
      cwd: String(messageRow.cwd || ""),
      createdAt: this.toIso(messageRow.timestamp, stat.mtimeMs),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      size: stat.size,
      fingerprint: stableTextHash(`${sessionId}:${stat.size}:${stat.mtimeMs}`),
      matchedProjectIds: [],
      model: message.model ? String(message.model) : undefined,
      sourceKind: "jsonl"
    };
  }

  private buddyCandidateFromFile(
    file: string,
    tool: "codebuddy" | "workbuddy"
  ): AiWorkspaceSourceCandidate | null {
    const fs = this.fs();
    const path = this.path();
    const stat = fs.statSync(file);
    const rows = this.readSampleRows(file);
    const messageRows = rows.filter((row) => row.type === "message");
    if (messageRows.length === 0) return null;
    const metadata = rows.find((row) => row.sessionId || row.cwd) ?? messageRows[0];
    const sessionId = String(metadata.sessionId || path.basename(file, ".jsonl"));
    if (!sessionId) return null;
    const titleRow = rows.find((row) => row.type === "ai-title" && row.aiTitle);
    const firstUser = messageRows.find((row) => row.role === "user");
    const title = String(titleRow?.aiTitle || this.extractBuddyMessageText(firstUser?.content)).slice(0, 120);
    const modelRow = messageRows.find((row) => {
      const provider = this.asRecord(row.providerData);
      return provider.requestModelName || provider.model || provider.requestModelId;
    });
    const provider = this.asRecord(modelRow?.providerData);
    return {
      key: `${tool}:${sessionId}`,
      tool,
      sourceSessionId: sessionId,
      sourcePath: file,
      title,
      cwd: String(metadata.cwd || ""),
      createdAt: this.toIso(rows[0]?.timestamp, stat.mtimeMs),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      size: stat.size,
      fingerprint: stableTextHash(`${sessionId}:${stat.size}:${stat.mtimeMs}`),
      matchedProjectIds: [],
      model: provider.requestModelName
        ? String(provider.requestModelName)
        : provider.model
          ? String(provider.model)
          : provider.requestModelId
            ? String(provider.requestModelId)
            : undefined,
      sourcePlatform: this.toolLabel(tool),
      sourceKind: "jsonl"
    };
  }

  private piCandidateFromFile(file: string): AiWorkspaceSourceCandidate | null {
    const fs = this.fs();
    const path = this.path();
    const stat = fs.statSync(file);
    const rows = this.readSampleRows(file);
    const header = rows.find((row) => row.type === "session");
    if (!header) return null;
    const sessionId = String(header.id || path.basename(file, ".jsonl"));
    if (!sessionId) return null;
    const name = [...rows].reverse().find((row) => row.type === "session_info" && row.name);
    const firstUser = rows.find((row) => {
      if (row.type !== "message") return false;
      return this.asRecord(row.message).role === "user";
    });
    const firstUserMessage = this.asRecord(firstUser?.message);
    const modelChange = [...rows].reverse().find((row) => row.type === "model_change" && (row.modelId || row.model));
    const assistant = [...rows].reverse().find((row) => {
      if (row.type !== "message") return false;
      return this.asRecord(row.message).role === "assistant";
    });
    const assistantMessage = this.asRecord(assistant?.message);
    const parentSession = String(header.parentSession || "");
    const parentMatch = parentSession.match(/[0-9a-f]{8}-[0-9a-f-]{20,}/iu);
    return {
      key: `pi:${sessionId}`,
      tool: "pi",
      sourceSessionId: sessionId,
      sourcePath: file,
      title: String(name?.name || this.extractMessageText(firstUserMessage.content)).slice(0, 120),
      cwd: String(header.cwd || ""),
      createdAt: this.toIso(header.timestamp, stat.mtimeMs),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      size: stat.size,
      fingerprint: stableTextHash(`${sessionId}:${stat.size}:${stat.mtimeMs}`),
      matchedProjectIds: [],
      parentSessionId: parentSession ? parentMatch?.[0] || parentSession : undefined,
      model: modelChange?.modelId
        ? String(modelChange.modelId)
        : modelChange?.model
          ? String(modelChange.model)
          : assistantMessage.model
            ? String(assistantMessage.model)
            : undefined,
      sourcePlatform: "Pi",
      sourceKind: "jsonl"
    };
  }

  private openCodeExportCandidate(file: string): AiWorkspaceSourceCandidate | null {
    const fs = this.fs();
    const path = this.path();
    try {
      const stat = fs.statSync(file);
      if (stat.size > 64 * 1024 * 1024) return null;
      const payload = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      const root = this.asRecord(payload);
      const info = this.asRecord(root.info || root.session);
      const id = String(info.id || path.basename(file, ".json"));
      const time = this.asRecord(info.time);
      return {
        key: `opencode:${id}:${stableTextHash(file)}`,
        tool: "opencode",
        sourceSessionId: id,
        sourcePath: file,
        title: String(info.title || "OpenCode 导出会话"),
        cwd: String(info.directory || this.asRecord(info.path).cwd || ""),
        createdAt: this.toIso(time.created || info.time_created, stat.mtimeMs),
        updatedAt: this.toIso(time.updated || info.time_updated, stat.mtimeMs),
        size: stat.size,
        fingerprint: stableTextHash(`${id}:${stat.size}:${stat.mtimeMs}`),
        matchedProjectIds: [],
        parentSessionId: info.parentID ? String(info.parentID) : undefined,
        sourceKind: "export-json"
      };
    } catch {
      return null;
    }
  }

  private lifeOsExportCandidate(file: string, fallbackTool: AiWorkspaceTool): AiWorkspaceSourceCandidate | null {
    const fs = this.fs();
    const path = this.path();
    try {
      const stat = fs.statSync(file);
      if (stat.size > 64 * 1024 * 1024) return null;
      const payload = this.asRecord(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
      if (String(payload.schema || "") !== "lifeos-ai-conversation-v1") return null;
      const session = this.asRecord(payload.session);
      const embeddedTool = String(payload.tool || "");
      const tool = (AI_WORKSPACE_TOOLS as readonly string[]).includes(embeddedTool)
        ? embeddedTool as AiWorkspaceTool
        : fallbackTool;
      const id = String(session.id || path.basename(file, ".json"));
      return {
        key: `${tool}:${id}:lifeos-export`,
        tool,
        sourceSessionId: id,
        sourcePath: file,
        title: String(session.title || `${this.toolLabel(tool)} 补充导出`),
        cwd: String(session.cwd || ""),
        createdAt: this.toIso(session.createdAt, stat.mtimeMs),
        updatedAt: this.toIso(session.updatedAt, stat.mtimeMs),
        size: stat.size,
        fingerprint: stableTextHash(`${id}:${stat.size}:${stat.mtimeMs}`),
        matchedProjectIds: [],
        parentSessionId: session.parentSessionId ? String(session.parentSessionId) : undefined,
        model: session.model ? String(session.model) : undefined,
        sourcePlatform: session.platform ? String(session.platform) : undefined,
        sourceUrl: session.url ? String(session.url) : undefined,
        sourceKind: "export-json"
      };
    } catch {
      return null;
    }
  }

  private parseOpenCodeDatabaseCandidate(
    candidate: AiWorkspaceSourceCandidate,
    options: AiWorkspaceImportOptions
  ): AiWorkspaceParsedSession {
    const sqlite = this.sqlite();
    const db = new sqlite.DatabaseSync(candidate.sourcePath, { readOnly: true });
    const session = db.prepare(
      "select id, parent_id, directory, title, version, time_created, time_updated from session where id = ?"
    ).get(candidate.sourceSessionId) as unknown as OpenCodeSessionRecord | undefined;
    if (!session) {
      db.close();
      throw new Error("OpenCode 会话已不存在或数据库正在迁移。");
    }
    const messages = db.prepare(
      "select id, session_id, time_created, data from message where session_id = ? order by time_created, id"
    ).all(candidate.sourceSessionId) as unknown as OpenCodeMessageRecord[];
    const parts = db.prepare(
      "select id, message_id, session_id, time_created, data from part where session_id = ? order by time_created, id"
    ).all(candidate.sourceSessionId) as unknown as OpenCodePartRecord[];
    db.close();
    return parseOpenCodeRecords({ ...candidate }, session, messages, parts, options);
  }

  private openCodeDatabaseCandidate(
    sourcePath: string,
    sourceSessionId: string
  ): AiWorkspaceSourceCandidate | null {
    const fs = this.fs();
    const sqlite = this.sqlite();
    const db = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      const row = db.prepare([
        "select s.id, s.parent_id, s.directory, s.title, s.version, s.time_created, s.time_updated,",
        "(select count(*) from message m where m.session_id = s.id) as message_count,",
        "(select max(m.time_created) from message m where m.session_id = s.id) as message_latest,",
        "(select count(*) from part p where p.session_id = s.id) as part_count",
        "from session s where s.id = ?"
      ].join(" ")).get(sourceSessionId);
      if (!row) return null;
      const stat = fs.statSync(sourcePath);
      return {
        key: `opencode:${String(row.id)}`,
        tool: "opencode",
        sourceSessionId: String(row.id),
        sourcePath,
        title: String(row.title || "OpenCode 会话"),
        cwd: String(row.directory || ""),
        createdAt: this.toIso(row.time_created, stat.mtimeMs),
        updatedAt: this.toIso(row.time_updated, stat.mtimeMs),
        size: stat.size,
        fingerprint: stableTextHash([
          row.id,
          row.time_updated,
          row.message_count,
          row.message_latest,
          row.part_count
        ].join(":")),
        matchedProjectIds: [],
        parentSessionId: row.parent_id ? String(row.parent_id) : undefined,
        model: row.version ? `OpenCode ${String(row.version)}` : undefined,
        sourceKind: "sqlite"
      };
    } finally {
      db.close();
    }
  }

  private async consumeJsonLines(filePath: string, consume: (line: string) => void): Promise<void> {
    const fs = this.fs();
    const readline = this.nodeRequire()!("readline") as typeof import("readline");
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) consume(line);
    } finally {
      reader.close();
      stream.destroy();
    }
  }

  private readHeadRows(filePath: string): Array<Record<string, unknown>> {
    const fs = this.fs();
    const handle = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(SCAN_HEAD_BYTES);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/).slice(0, 200).flatMap((line) => {
        try {
          return [this.asRecord(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    } finally {
      fs.closeSync(handle);
    }
  }

  private readSampleRows(filePath: string): Array<Record<string, unknown>> {
    const fs = this.fs();
    const stat = fs.statSync(filePath);
    const handle = fs.openSync(filePath, "r");
    const parse = (value: string, dropFirstPartial = false): Array<Record<string, unknown>> => {
      const lines = value.split(/\r?\n/);
      if (dropFirstPartial) lines.shift();
      return lines.slice(0, 240).flatMap((line) => {
        try {
          return [this.asRecord(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    };
    try {
      const headSize = Math.min(stat.size, SCAN_SAMPLE_BYTES);
      const headBuffer = Buffer.alloc(headSize);
      const headBytes = fs.readSync(handle, headBuffer, 0, headSize, 0);
      const rows = parse(headBuffer.subarray(0, headBytes).toString("utf8"));
      if (stat.size <= SCAN_SAMPLE_BYTES) return rows;
      const tailSize = Math.min(stat.size, SCAN_HEAD_BYTES);
      const tailBuffer = Buffer.alloc(tailSize);
      const tailStart = Math.max(0, stat.size - tailSize);
      const tailBytes = fs.readSync(handle, tailBuffer, 0, tailSize, tailStart);
      return [...rows, ...parse(tailBuffer.subarray(0, tailBytes).toString("utf8"), tailStart > 0)];
    } finally {
      fs.closeSync(handle);
    }
  }

  private walkFiles(roots: string[], accept: (path: string) => boolean): string[] {
    const fs = this.fs();
    const path = this.path();
    const files: string[] = [];
    const stack = [...roots];
    const visited = new Set<string>();
    while (stack.length > 0 && files.length < MAX_DISCOVERY_FILES) {
      const current = stack.pop()!;
      const normalized = normalizeWorkspacePath(current);
      if (visited.has(normalized) || !fs.existsSync(current)) continue;
      visited.add(normalized);
      let stat: NodeStatLike;
      try {
        stat = fs.statSync(current);
      } catch {
        continue;
      }
      if (stat.isFile()) {
        if (accept(current)) files.push(current);
        continue;
      }
      if (!stat.isDirectory()) continue;
      let names: string[];
      try {
        names = fs.readdirSync(current);
      } catch {
        continue;
      }
      for (const name of names) stack.push(path.join(current, name));
    }
    return files;
  }

  private walkProjectMemoryRuleFiles(root: string, accept: (path: string) => boolean): string[] {
    const fs = this.fs();
    const path = this.path();
    const files: string[] = [];
    const stack = [root];
    let visitedDirectories = 0;
    while (
      stack.length > 0
      && files.length < MAX_PROJECT_MEMORY_FILES
      && visitedDirectories < MAX_PROJECT_MEMORY_RULE_DIRECTORIES
    ) {
      const current = stack.pop()!;
      visitedDirectories += 1;
      let entries: import("fs").Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isFile() && accept(absolute)) {
          files.push(absolute);
        } else if (
          entry.isDirectory()
          && !PROJECT_MEMORY_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())
        ) {
          stack.push(absolute);
        }
      }
    }
    return files;
  }

  private async commandExists(command: string): Promise<boolean> {
    if (/[\\/]/.test(command)) {
      try {
        return this.fs().existsSync(this.expandHome(command));
      } catch {
        return false;
      }
    }
    const childProcess = this.nodeRequire()!("child_process") as typeof import("child_process");
    return new Promise((resolve) => {
      const child = childProcess.spawn("where.exe", [command], { windowsHide: true, stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  }

  private buildPowerShellLaunch(command: string, args: string[], cwd: string): string {
    const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
    const directory = cwd.trim() ? `Set-Location -LiteralPath ${quote(cwd)}; ` : "";
    const invocation = `& ${quote(command)} ${args.map(quote).join(" ")}`.trim();
    const inner = `${directory}${invocation}`.replace(/"/g, "`\"");
    return `Start-Process powershell.exe -ArgumentList '-NoExit','-Command',\"${inner}\"`;
  }

  private expandHome(value: string): string {
    const os = this.nodeRequire()!("os") as typeof import("os");
    const path = this.path();
    const trimmed = value.trim();
    if (trimmed === "~") return os.homedir();
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.join(os.homedir(), trimmed.slice(2));
    return path.resolve(trimmed);
  }

  private toIso(value: unknown, fallbackMs: number): string {
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : fallbackMs;
      return new Date(ms).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return this.toIso(numeric, fallbackMs);
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    return new Date(fallbackMs).toISOString();
  }

  private extractMessageText(value: unknown): string {
    if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
    if (!Array.isArray(value)) return "";
    return value
      .map((part) => this.asRecord(part))
      .filter((part) => part.type === "text" || part.type === "input_text" || part.type === "output_text")
      .map((part) => String(part.text || ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractBuddyMessageText(value: unknown): string {
    return this.extractMessageText(value)
      .replace(/<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/giu, " ")
      .replace(/<local-command-caveat(?:\s[^>]*)?>[\s\S]*?<\/local-command-caveat>/giu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private toolLabel(tool: AiWorkspaceTool): string {
    return aiWorkspaceToolLabel(tool);
  }

  private sqlite(): SqliteModuleLike {
    const nodeRequire = this.nodeRequire();
    if (!nodeRequire) throw new Error("当前环境不支持 SQLite 会话读取。");
    try {
      return nodeRequire("node:sqlite") as SqliteModuleLike;
    } catch {
      throw new Error("当前 Obsidian 运行时不能直接读取 OpenCode 数据库，请使用 opencode export 导出后导入。");
    }
  }

  private fs(): typeof import("fs") {
    const nodeRequire = this.nodeRequire();
    if (!nodeRequire) throw new Error("当前环境不能直接读取本地工具目录。");
    return nodeRequire("fs") as typeof import("fs");
  }

  private path(): typeof import("path") {
    const nodeRequire = this.nodeRequire();
    if (!nodeRequire) throw new Error("当前环境不能解析本地路径。");
    return nodeRequire("path") as typeof import("path");
  }

  private nodeRequire(): NodeRequireLike | null {
    const candidate = (globalThis as typeof globalThis & { require?: NodeRequireLike }).require;
    return typeof candidate === "function" ? candidate : null;
  }
}
