import type { AgentToolRuntime, AgentToolRuntimeOptions } from "../../AgentToolRuntime";
import { isAgentWebToolAllowed } from "../../AgentToolRuntime";
import type { LifeOSAgentToolDescriptor } from "../../../LifeOSAgentToolRegistry";
import type { LifeOSAgentToolExecutionContext, LifeOSAgentToolResult } from "../../LifeOSAgentTypes";
import type { LifeOSAgentToolCall } from "../../LifeOSAgentTypes";
import { SDK_DEFAULT_TOOL_TIMEOUT_SECONDS } from "../../../sdk/SdkChatLimits";

export const SDK_TEXT_MODEL_TOOLS = new Set(["diary-generate", "review-generate", "summary-generate", "subagent-web", "subagent-rag", "subagent-project"]);
/** Model/derived-document work must run OUTSIDE the active SDK query slot. */
export const SDK_HOST_CONTINUATION_TOOLS = new Set([...SDK_TEXT_MODEL_TOOLS, "pdf-page-read", "docx-text-read", "image-describe", "vision", "ocr-read"]);

export interface ClaudeBridgePolicy {
  /** File roots originate in the host scope, never in model output. */
  allowedRoots: string[];
  allowDerivedWrites: boolean;
  allowVision: boolean;
  allowNativeModelTools: boolean;
  allowSdkTextModelTools?: boolean;
  allowHostContinuations?: boolean;
  maxToolCalls: number;
  /** Vault-relative Life OS root used to accept both documented path dialects. */
  lifeOsRoot?: string;
  /** Per-tool deadline for read tools; invalid/absent falls back to the default. */
  toolTimeoutMs?: number;
}
const normalize = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
export const SDK_DEFAULT_LIFE_OS_ROOT = "PersonalLifeSystem";
export type SdkScopedPathShape = "vault-relative" | "root-relative" | "absolute" | "parent-escape" | "control" | "obsidian" | "empty";
export interface SdkScopedPathCheck { ok: boolean; canonical?: string; code?: string; hint?: string; shape: SdkScopedPathShape }
/** One path dialect for the whole tool chain (F-03a). The SDK bridge used to
 * accept only Vault-relative paths (`PersonalLifeSystem/x`) while the executor
 * below it also accepts Life-OS-root-relative paths (`x`) — the model was
 * rejected for writing what the tool description asks for. Both documented
 * forms now resolve to the same canonical Vault path; absolute paths, drive
 * letters, control characters, `.`/`..` segments and the `.obsidian` config
 * directory stay rejected, and the project/host scope is still enforced. */
export function checkSdkScopedPath(value: unknown, roots: readonly string[], lifeOsRoot = SDK_DEFAULT_LIFE_OS_ROOT): SdkScopedPathCheck {
  const raw = typeof value === "string" ? value : String(value ?? "");
  if (/[\u0000-\u001f]/.test(raw)) return { ok: false, shape: "control", code: "sdk-path-invalid", hint: "路径含不可见控制字符，已拒绝。" };
  const path = normalize(raw);
  const scopes = roots.map(normalize).filter(Boolean);
  if (!path.trim()) return { ok: false, shape: "empty", code: "sdk-file-scope-denied", hint: "路径不能为空；留空表示 Life OS 根目录本身。" };
  if (path.split("/").some(part => part === "." || part === "..")) return { ok: false, shape: "parent-escape", code: "sdk-file-scope-denied", hint: "路径不能使用 . 或 .. 访问 Life OS 之外的内容。" };
  if (/^[a-z]:|^\//i.test(path)) return { ok: false, shape: "absolute", code: "sdk-file-scope-denied", hint: "请使用 Life OS 根目录内的相对路径，不要使用绝对路径或盘符。" };
  if (path.split("/").some(part => part.toLocaleLowerCase() === ".obsidian")) return { ok: false, shape: "obsidian", code: "sdk-file-scope-denied", hint: "不能通过 Agent 文件工具访问 .obsidian 配置目录。" };
  const root = normalize(lifeOsRoot);
  const clean = root && !/(?:^|\/)\.\.?($|\/)/.test(root) && !/^[a-z]:|^\//i.test(root) ? root : SDK_DEFAULT_LIFE_OS_ROOT;
  const prefixed = path === clean || path.startsWith(clean + "/");
  const canonical = prefixed ? path : `${clean}/${path}`;
  if (!scopes.some(scope => canonical === scope || canonical.startsWith(scope + "/"))) {
    return { ok: false, shape: prefixed ? "vault-relative" : "root-relative", code: "sdk-file-scope-denied", hint: `路径需在 Life OS 根（${scopes[0] || clean}）内：可写 ${scopes[0] || clean}/… 或该根内的相对路径。` };
  }
  return { ok: true, canonical, shape: prefixed ? "vault-relative" : "root-relative" };
}
/** The host's Life OS root (settings), used only to accept the documented
 * root-relative dialect. Never taken from model output. */
export function sdkLifeOsRoot(settings: { rootFolder?: unknown } | undefined): string {
  const raw = settings && typeof settings.rootFolder === "string" ? normalize(settings.rootFolder) : "";
  return raw && !/(?:^|\/)\.\.?($|\/)/.test(raw) && !/^[a-z]:|^\//i.test(raw) ? raw : SDK_DEFAULT_LIFE_OS_ROOT;
}
type ToolDeadlineOutcome<T> = { state: "value"; value: T } | { state: "timeout" } | { state: "aborted" } | { state: "rejected"; error: unknown };
/** Bound one read tool call so a heavy local read cannot consume the whole turn
 * budget and discard the answer (F-01). The caller's cancel signal always wins
 * over the deadline, and a late tool result is never pushed into the turn. */
function raceToolDeadline<T>(task: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<ToolDeadlineOutcome<T>> {
  if (!(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0)) return task.then(value => ({ state: "value", value } as const));
  return new Promise<ToolDeadlineOutcome<T>>(resolve => {
    let settled = false;
    const finish = (outcome: ToolDeadlineOutcome<T>) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted); resolve(outcome); };
    const aborted = () => finish({ state: "aborted" });
    const timer = setTimeout(() => finish({ state: "timeout" }), timeoutMs);
    if (signal?.aborted) return finish({ state: "aborted" });
    signal?.addEventListener("abort", aborted, { once: true });
    task.then(value => finish({ state: "value", value }), error => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted); resolve({ state: "rejected", error }); } });
  });
}
// Match the Runtime's confirmation scope, including two SDK turns sharing the
// same Runtime/session. Unrelated sessions may still execute concurrently.
const writeQueues = new WeakMap<AgentToolRuntime, Map<string, Promise<void>>>();
export class ClaudeToolBridge {
  readonly results: LifeOSAgentToolResult[] = [];
  private counter = 0;
  needsConfirmation = false;
  deferredCall?: LifeOSAgentToolCall;
  constructor(private runtime: AgentToolRuntime, readonly context: LifeOSAgentToolExecutionContext,
    private policy: ClaudeBridgePolicy, private options: AgentToolRuntimeOptions = {}) {}
  descriptors(): LifeOSAgentToolDescriptor[] {
    if (this.policy.maxToolCalls === 0) return [];
    return this.runtime.available(this.context.channel).filter(d => isAgentWebToolAllowed(d, this.context)
      && (d.mode !== "write" || this.context.permissionMode !== "read-only")
      && (d.id !== "memory-search" || this.context.memoryMode !== "disabled" && this.context.memoryMode !== "temporary")
      && !d.id.startsWith("custom-") && !["tool-compose", "tool-delete"].includes(d.id)
      && (!this.context.projectScopeId || d.family === "project" || d.family === "web" || d.family === "vault" || d.family === "skill" || d.family === "tooling" || d.family === "memory")
      && (this.policy.allowNativeModelTools || !(d.modelCallCost && d.modelCallCost > 0)
        || this.policy.allowHostContinuations === true && SDK_HOST_CONTINUATION_TOOLS.has(d.id)
        || this.policy.allowSdkTextModelTools === true && SDK_TEXT_MODEL_TOOLS.has(d.id))
      && (this.policy.allowDerivedWrites || !["pdf-page-read", "docx-text-read", "image-describe"].includes(d.id))
      && (this.policy.allowVision || !["pdf-page-read", "image-describe"].includes(d.id)));
  }
  async execute(id: string, raw: Record<string, unknown>): Promise<LifeOSAgentToolResult> {
    const ordinal = ++this.counter;
    const callId = `${this.context.turnId}:sdk-tool:${ordinal}`;
    const deny = (error: string, hint?: string, code = error, shape?: string): LifeOSAgentToolResult => ({ callId, toolId: id, ok: false, output: "", error, durationMs: 0,
      ...(hint ? { metadata: { code, hint, ...(shape ? { pathShape: shape } : {}) } } : {}) });
    const rejection = (check: SdkScopedPathCheck): LifeOSAgentToolResult => deny(check.code || "sdk-file-scope-denied", check.hint, check.code || "sdk-file-scope-denied", check.shape);
    if (this.context.signal?.aborted || this.needsConfirmation || this.deferredCall) return deny("sdk-tool-stopped");
    if (ordinal > this.policy.maxToolCalls) return deny("sdk-tool-budget-exhausted");
    const descriptor = this.descriptors().find(d => d.id === id);
    if (!descriptor) return deny("sdk-tool-not-authorized");
    // Strip all unknown keys, notably model-controlled operationId. Runtime assigns
    // an operation from the host turn/call identity and applies its original journal.
    const input = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "operationId" && Object.prototype.hasOwnProperty.call(descriptor.input || {}, key)));
    if (id === "vault-file-list" && !input.folder) input.folder = this.policy.allowedRoots[0];
    if (id === "vault-file-list" && input.folder === undefined) return deny("sdk-file-scope-denied", "没有可用的 Life OS 根目录范围；未列出任何文件。", "sdk-file-scope-denied", "empty");
    // Validate both ends of a move before confirmation or executor I/O. The
    // default list folder must pass the same gate as an explicitly supplied one.
    if (raw.projectScopeId && raw.projectScopeId !== this.context.projectScopeId) return deny("sdk-project-scope-denied");
    for (const key of ["path", "targetPath", "folder", "sourcePath", "from", "to"]) {
      const value = input[key]; if (value === undefined) continue;
      if (typeof value !== "string") return deny("sdk-path-invalid", "路径参数必须是字符串。", "sdk-path-invalid");
      const check = checkSdkScopedPath(value, this.policy.allowedRoots, this.policy.lifeOsRoot);
      if (!check.ok) return rejection(check);
    }
    if (this.policy.allowHostContinuations && SDK_HOST_CONTINUATION_TOOLS.has(id) || this.policy.allowSdkTextModelTools && SDK_TEXT_MODEL_TOOLS.has(id)) {
      if (descriptor.mode === "write" && this.context.permissionMode === "read-only") return deny("sdk-write-read-only");
      this.deferredCall = { id: callId, name: id, input };
      return { callId, toolId: id, ok: true, output: "宿主已接收有界续作请求；尚未识别、生成或写入。当前 SDK 查询结束后串行处理。", durationMs: 0, metadata: { sdkDeferred: true } };
    }
    const perform = async (): Promise<LifeOSAgentToolResult> => {
      // Recheck after waiting behind another write. Never replace its pending
      // confirmation, and never start a queued write after cancellation.
      if (this.context.signal?.aborted || this.needsConfirmation) return deny("sdk-tool-stopped");
      if (!this.descriptors().some(d => d.id === id)) return deny("sdk-tool-not-authorized");
      return await this.runtime.execute({ id: callId, name: id, input }, this.context, this.options);
    };
    const collect = (result: LifeOSAgentToolResult): LifeOSAgentToolResult => {
      this.results.push(result);
      this.needsConfirmation ||= result.needsConfirmation === true;
      return result;
    };
    if (descriptor.mode !== "write") {
      // Only reads are bounded; a write keeps the original journal/confirmation
      // semantics and is never reported as "not completed" after it happened.
      const timeoutMs = this.policy.toolTimeoutMs ?? SDK_DEFAULT_TOOL_TIMEOUT_SECONDS * 1000;
      const raced = await raceToolDeadline(perform(), this.context.signal, timeoutMs);
      if (raced.state === "aborted") return deny("sdk-tool-stopped");
      if (raced.state === "timeout") return deny("tool-timeout", `工具超过 ${Math.round(timeoutMs / 1000)} 秒未返回，已按未完成处理；可缩小范围或稍后重试。`, "tool-timeout");
      if (raced.state === "rejected") throw raced.error;
      return collect(raced.value);
    }
    let queues = writeQueues.get(this.runtime);
    if (!queues) { queues = new Map(); writeQueues.set(this.runtime, queues); }
    const session = String(this.context.runtimeSessionId || this.context.sessionId || "").trim();
    const execution = (queues.get(session) ?? Promise.resolve()).then(perform).then(collect);
    // A rejected observer/confirmation must not poison the queue. Permissions
    // and journaling still belong exclusively to the existing Runtime.
    const tail = execution.then(() => undefined, () => undefined);
    queues.set(session, tail);
    void tail.then(() => { if (queues.get(session) === tail) queues.delete(session); });
    return execution;
  }
  async server(desktop: boolean) {
    const { loadClaudeSdk } = await import("./ClaudeSdkRuntime");
    const sdk = await loadClaudeSdk(desktop), { z } = await import("zod/v4");
    const tools = this.descriptors().map(d => {
      const shape: Record<string, import("zod/v4").ZodType> = {};
      for (const [key, prop] of Object.entries(d.input || {})) {
        const schema = prop.type === "string" ? z.string().max(16000) : prop.type === "number" ? z.number().finite()
          : prop.type === "boolean" ? z.boolean() : prop.type === "array" ? z.array(z.unknown()) : z.record(z.string(), z.unknown());
        shape[key] = prop.required ? schema : schema.optional();
      }
      return sdk.tool(d.id, d.description, shape, async input => {
        const result = await this.execute(d.id, input);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
      });
    });
    return sdk.createSdkMcpServer({ name: "lifeos", version: "0.3.25", tools });
  }
}
