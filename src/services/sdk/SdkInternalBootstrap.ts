import { captureOrdinarySdkConfig, type OrdinarySdkSettings, type OrdinarySdkSnapshot } from "./SdkOrdinaryConfig";

export interface SdkBootstrapScope {
  accountScopeId: string; projectScopeId: string; sessionId: string;
  automatic: boolean; approval: () => boolean; signal?: AbortSignal;
  task?: "text" | "vision";
}
export interface SdkBootstrapContext {
  readonly signal: AbortSignal; readonly scopeKey: string; readonly revision: number;
  /** Must also guard any host continuation/write; an old result is not authorization. */
  assertCurrent(): void;
}
export interface SdkPreparedResource<Request, Result> {
  execute(request: Request, context: SdkBootstrapContext): Promise<Result>;
  dispose(): Promise<void>;
}
export interface SdkBootstrapPorts<Request, Result> {
  /** Preparation may resolve owned runtime/bridge, but must never call a model. */
  prepare(snapshot: OrdinarySdkSnapshot, signal: AbortSignal): Promise<SdkPreparedResource<Request, Result>>;
}
interface Job<Request, Result> {
  request: Request; scope: SdkBootstrapScope; snapshot: OrdinarySdkSnapshot; revision: number;
  controller: AbortController; settled: boolean; resource?: SdkPreparedResource<Request, Result>;
  resolve(result: Result): void; reject(error: Error): void; unlisten(): void;
}
const fixed = new Set(["SDK_BOOTSTRAP_DESKTOP_ONLY", "SDK_BOOTSTRAP_DISPOSED", "SDK_BOOTSTRAP_STALE_CONFIGURATION", "SDK_BOOTSTRAP_CANCELLED", "SDK_BOOTSTRAP_APPROVAL_REQUIRED", "SDK_BOOTSTRAP_SCOPE_INVALID", "SDK_BOOTSTRAP_PREPARE_FAILED", "SDK_BOOTSTRAP_EXECUTION_FAILED", "SDK_BOOTSTRAP_RUNTIME_UNAVAILABLE", "SDK_BOOTSTRAP_ROUTE_UNSUPPORTED", "SDK_BOOTSTRAP_REASONING_UNSUPPORTED", "SDK_BOOTSTRAP_CLEANUP_FAILED"]);
const ordinaryCodes = new Set(["SDK_ORDINARY_INVALID_CREDENTIAL", "SDK_ORDINARY_MISSING_CREDENTIAL", "SDK_ORDINARY_INVALID_HEADERS", "SDK_ORDINARY_DIRECT_AUTH_UNAVAILABLE", "SDK_ORDINARY_AMBIGUOUS_AUTH", "SDK_ORDINARY_INVALID_REASONING"]);
function error(code: string): Error { return new Error(code); }
function safe(cause: unknown, fallback: string): Error { return cause instanceof Error && fixed.has(cause.message) ? cause : error(fallback); }
/** User-facing hints for ordinary AI configuration and task lifecycle. Never
 * reflect arbitrary codes/bodies or direct users to a separate SDK form. */
export function sdkBootstrapDiagnostic(code: string): { title: string; action: string } {
  const hints: Record<string, [string, string]> = {
    SDK_ORDINARY_MISSING_CREDENTIAL: ["尚未填写 AI 凭据", "请在普通 AI 配置中填写当前服务商的 API Key；没有读取其他账号的凭据。"],
    SDK_ORDINARY_INVALID_CREDENTIAL: ["AI 凭据格式无效", "请检查普通 AI 配置中的 Key，去掉多余引号、标签或换行后重试。"],
    SDK_ORDINARY_INVALID_HEADERS: ["AI 高级请求头有误", "请检查普通 AI 配置的附加请求头 JSON、重复头或不支持的字段。"],
    SDK_ORDINARY_INVALID_CONFIGURATION: ["AI 配置尚不可用", "请核对普通 AI 配置中的服务地址、模型和高级路径；不需要另配 SDK。"],
    SDK_BOOTSTRAP_RUNTIME_UNAVAILABLE: ["插件的 AI 运行组件缺失或校验失败", [
      "未找到插件内置 runtime，也没有找到可用的 Claude Code CLI（2.1.248+）。",
      "",
      "任选一种安装：",
      "1. [下载完整插件包（含 runtime）](https://github.com/Xiaoqiang-Huang/obsidian-life-os-community/releases/latest)",
      "   解压后把 personal-life-system 放进 `.obsidian/plugins`，保留 data.json 和 sdk-state。",
      "2. Claude Code CLI：",
      "   Windows PowerShell：`irm https://claude.ai/install.ps1 | iex`",
      "   macOS/Linux：`curl -fsSL https://claude.ai/install.sh | bash`",
      "   或 `npm install -g @anthropic-ai/claude-code`",
      "   安装后重启 Obsidian；运行 `claude --version` 确认版本 ≥ 2.1.248。",
      "",
      "插件不会自动下载或安装运行组件，也不会调用模型。"
    ].join("\n")],
    SDK_BOOTSTRAP_APPROVAL_REQUIRED: ["本次操作尚未获得业务授权", "请先确认对应功能的范围和操作。后台任务不会因底层引擎变化自动开启。"],
    SDK_BOOTSTRAP_STALE_CONFIGURATION: ["AI 配置已变化，旧任务已取消", "请检查当前服务商和模型，再手动重新发起；没有自动转交账号或重跑。"],
    SDK_BOOTSTRAP_CLEANUP_FAILED: ["本次任务的资源清理未确认", "请保存编辑后重新加载插件，再手动重试。已发出的请求可能产生费用，请勿连续重复提交。"],
    SDK_BOOTSTRAP_ROUTE_UNSUPPORTED: ["当前服务接口尚未适配", "请查看普通 AI 配置的接口兼容性说明；没有偷偷切换服务商或回退旧引擎。"],
    SDK_BOOTSTRAP_REASONING_UNSUPPORTED: ["当前接口尚不支持所选推理档位", "请在普通 AI 配置中选择已验证的推理档位；没有静默降低设置。"],
    SDK_BOOTSTRAP_DESKTOP_ONLY: ["此功能需要 Obsidian 桌面版", "本机 AI 执行只在桌面端可用：移动端不启动本地进程、不创建运行时目录，也不会静默失败。记录、任务、日记等非 AI 功能可继续使用；请改用桌面版 Obsidian 重试。"]
  };
  const hint = hints[code] || ["AI 请求未完成", "请查看帮助页的诊断记录后重试；没有自动重试或反映服务端原始错误内容。"];
  return { title: hint[0], action: hint[1] };
}
/** S5: one fixed sentence for every AI entry point that is unavailable off the
 * desktop build. AI entries show this before any dispatch, so a mobile user is
 * never left waiting for a request that was never going to run. */
export function sdkDesktopOnlyMessage(): string {
  const hint = sdkBootstrapDiagnostic("SDK_BOOTSTRAP_DESKTOP_ONLY");
  return `${hint.title}。${hint.action}`;
}
function race<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => undefined); return Promise.reject(error("SDK_BOOTSTRAP_CANCELLED")); }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(error("SDK_BOOTSTRAP_CANCELLED")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
  });
}

/** No SDK settings/backend selection. Constructor/state are inert. Model-capable
 * work is lazy, serialized, revision-bound and requires current business approval.
 * This is bootstrap/lifecycle, not another planning loop or native fallback. */
export class SdkInternalBootstrap<Request, Result> {
  #snapshots = new Map<"text" | "vision", OrdinarySdkSnapshot>();
  #revision = 0;
  #disposed = false;
  #errorCode = "";
  #cleanupFailed = false;
  #queue: Job<Request, Result>[] = [];
  #active: Job<Request, Result> | undefined;
  #draining: Promise<void> | undefined;
  #closed = new WeakMap<SdkPreparedResource<Request, Result>, Promise<void>>();
  #cleanup = new Set<Promise<void>>();
  constructor(private readonly options: { desktop: boolean; getSettings: () => OrdinarySdkSettings; ports: SdkBootstrapPorts<Request, Result>; cleanupTimeoutMs?: number }) {
    if (options.cleanupTimeoutMs !== undefined && (!Number.isSafeInteger(options.cleanupTimeoutMs) || options.cleanupTimeoutMs < 1 || options.cleanupTimeoutMs > 60000)) throw error("SDK_BOOTSTRAP_SCOPE_INVALID");
  }
  state(): { revision: number; active: number; queued: number; disposed: boolean; errorCode: string; activeBusy: boolean } {
    // activeBusy stays false while a settled job is only cleaning up its
    // resource: that window is bounded and must not look like a running job.
    return { revision: this.#revision, active: this.#active ? 1 : 0, queued: this.#queue.length, disposed: this.#disposed, errorCode: this.#errorCode, activeBusy: !!this.#active && this.#active.settled !== true };
  }
  toJSON(): unknown { return this.state(); }
  refreshConfiguration(): void {
    for (const task of this.#snapshots.size ? [...this.#snapshots.keys()] : ["text" as const]) this.#refresh(task);
  }
  #refresh(task: "text" | "vision"): void {
    if (this.#disposed) throw error("SDK_BOOTSTRAP_DISPOSED");
    if (!this.options.desktop) throw error("SDK_BOOTSTRAP_DESKTOP_ONLY");
    if (this.#cleanupFailed) throw error("SDK_BOOTSTRAP_CLEANUP_FAILED");
    let next: OrdinarySdkSnapshot;
    try { next = captureOrdinarySdkConfig(this.options.getSettings(), task); }
    catch (cause) {
      if (this.#snapshots.has(task)) { this.#snapshots.delete(task); this.#revision++; this.#invalidate("SDK_BOOTSTRAP_STALE_CONFIGURATION"); }
      const code = cause instanceof Error && ordinaryCodes.has(cause.message) ? cause.message : "SDK_ORDINARY_INVALID_CONFIGURATION";
      this.#errorCode = code; throw error(code);
    }
    if (!this.#snapshots.get(task)?.matches(next)) {
      const changesExisting = this.#snapshots.has(task);
      this.#snapshots.set(task, next);
      // Registering another task kind is not itself a configuration change.
      if (changesExisting || this.#revision === 0) { this.#revision++; this.#invalidate("SDK_BOOTSTRAP_STALE_CONFIGURATION"); }
    }
    this.#errorCode = "";
  }
  async run(request: Request, scope: SdkBootstrapScope): Promise<Result> {
    if (this.#disposed) throw error("SDK_BOOTSTRAP_DISPOSED");
    if (!this.options.desktop) throw error("SDK_BOOTSTRAP_DESKTOP_ONLY");
    if (this.#cleanupFailed) throw error("SDK_BOOTSTRAP_CLEANUP_FAILED");
    this.#validateScope(scope); this.#approve(scope);
    if (scope.signal?.aborted) throw error("SDK_BOOTSTRAP_CANCELLED");
    this.#refresh(scope.task || "text");
    const snapshot = this.#snapshots.get(scope.task || "text")!;
    return new Promise<Result>((resolve, reject) => {
      const controller = new AbortController();
      const job: Job<Request, Result> = { request, scope: { ...scope }, snapshot, revision: this.#revision, controller, settled: false, resolve, reject, unlisten: () => undefined };
      const abort = () => { controller.abort(); this.#queue = this.#queue.filter(j => j !== job); this.#settle(job, error("SDK_BOOTSTRAP_CANCELLED")); if (job.resource) void this.#close(job.resource); };
      scope.signal?.addEventListener("abort", abort, { once: true }); job.unlisten = () => scope.signal?.removeEventListener("abort", abort);
      this.#queue.push(job); this.#pump();
    });
  }
  #validateScope(scope: SdkBootstrapScope): void {
    if (!scope || [scope.accountScopeId, scope.projectScopeId, scope.sessionId].some(s => typeof s !== "string" || !s || s.length > 240 || /[\u0000-\u001f\u007f]/.test(s)) || typeof scope.automatic !== "boolean") throw error("SDK_BOOTSTRAP_SCOPE_INVALID");
  }
  #approve(scope: SdkBootstrapScope): void {
    let allowed = false; try { allowed = typeof scope.approval === "function" && scope.approval() === true; } catch { /* Never echo approval errors. */ }
    if (!allowed) throw error("SDK_BOOTSTRAP_APPROVAL_REQUIRED");
  }
  #settle(job: Job<Request, Result>, cause?: Error, result?: Result): void {
    if (job.settled) return; job.settled = true; job.unlisten();
    if (cause) job.reject(cause); else job.resolve(result as Result);
  }
  #invalidate(code: string): void {
    for (const job of this.#queue.splice(0)) { job.controller.abort(); this.#settle(job, error(code)); }
    if (this.#active) {
      this.#active.controller.abort(); this.#settle(this.#active, error(code));
      if (this.#active.resource) void this.#close(this.#active.resource);
    }
  }
  #close(resource: SdkPreparedResource<Request, Result>): Promise<void> {
    let closing = this.#closed.get(resource);
    if (!closing) {
      const disposal = Promise.resolve().then(() => resource.dispose());
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(error("SDK_BOOTSTRAP_CLEANUP_FAILED")), this.options.cleanupTimeoutMs ?? 10000); });
      closing = Promise.race([disposal, deadline]).finally(() => clearTimeout(timer)).catch(() => {
        this.#cleanupFailed = true; this.#errorCode = "SDK_BOOTSTRAP_CLEANUP_FAILED";
        this.#invalidate("SDK_BOOTSTRAP_CLEANUP_FAILED");
      });
      this.#closed.set(resource, closing); this.#cleanup.add(closing);
      const pending = closing;
      void pending.finally(() => this.#cleanup.delete(pending));
    }
    return closing;
  }
  #check(job: Job<Request, Result>): void {
    if (this.#disposed) throw error("SDK_BOOTSTRAP_DISPOSED");
    if (this.#cleanupFailed) throw error("SDK_BOOTSTRAP_CLEANUP_FAILED");
    if (job.controller.signal.aborted || job.settled) throw error("SDK_BOOTSTRAP_CANCELLED");
    this.#refresh(job.scope.task || "text");
    const current = captureOrdinarySdkConfig(this.options.getSettings(), job.scope.task || "text");
    if (job.revision !== this.#revision || !job.snapshot.matches(current)) throw error("SDK_BOOTSTRAP_STALE_CONFIGURATION");
    this.#approve(job.scope);
  }
  #pump(): void {
    if (this.#draining || this.#disposed) return;
    this.#draining = this.#drain().finally(() => { this.#draining = undefined; if (this.#queue.length && !this.#disposed) this.#pump(); });
  }
  async #drain(): Promise<void> {
    while (this.#queue.length && !this.#disposed) {
      const job = this.#queue.shift()!; if (job.settled) continue; this.#active = job;
      let stage = "SDK_BOOTSTRAP_PREPARE_FAILED";
      try {
        this.#check(job); await Promise.all([...this.#cleanup]); this.#check(job);
        const preparation = this.options.ports.prepare(job.snapshot, job.controller.signal);
        // An uncooperative late prepare never reaches execute, even after unload.
        void preparation.then(r => { if (job.controller.signal.aborted || this.#disposed) return this.#close(r); }).catch(() => undefined);
        job.resource = await race(preparation, job.controller.signal); this.#check(job);
        const context = Object.freeze({ signal: job.controller.signal, revision: job.revision,
          scopeKey: JSON.stringify([job.scope.accountScopeId, job.scope.projectScopeId, job.scope.sessionId, job.scope.task || "text", job.revision]),
          assertCurrent: () => this.#check(job) });
        stage = "SDK_BOOTSTRAP_EXECUTION_FAILED";
        const result = await race(job.resource.execute(job.request, context), job.controller.signal); this.#check(job);
        await this.#close(job.resource); this.#check(job); this.#settle(job, undefined, result);
      } catch (cause) { this.#settle(job, safe(cause, stage)); }
      finally { job.controller.abort(); if (job.resource) await this.#close(job.resource); this.#active = undefined; }
    }
  }
  async dispose(): Promise<void> {
    if (!this.#disposed) { this.#disposed = true; this.#snapshots.clear(); this.#invalidate("SDK_BOOTSTRAP_DISPOSED"); }
    await this.#draining; await Promise.all([...this.#cleanup]);
  }
}
