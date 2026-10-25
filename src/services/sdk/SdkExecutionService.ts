import { sdkProtocolFailure, type SdkProtocolFailure } from "./SdkProtocolDiagnostic";
import type { AiRequest, AiResponse, AiStreamCallbacks } from "../../ai";
import { REASONING_MAX_BYTES, REASONING_TRUNCATED_NOTICE } from "../answer/ReasoningStream";
import { combineAgentSignals } from "../agent/AgentRequestBudget";
import { loadClaudeSdk } from "../agent/backends/claude/ClaudeSdkRuntime";
import { createManagedSdkBootstrapPorts, type ManagedSdkExecutionContext } from "./ManagedSdkBootstrapPorts";
import { SdkInternalBootstrap, sdkBootstrapDiagnostic, type SdkBootstrapPorts, type SdkBootstrapScope, type SdkBootstrapContext } from "./SdkInternalBootstrap";
import type { OrdinarySdkSettings } from "./SdkOrdinaryConfig";
import { prepareSdkPrompt, sdkJsonValidator, type SdkPrompt } from "./SdkExecutionInput";
import { SdkUsageLedger, sdkFault, sdkUsage, validateSdkLimits, type SdkExecutionLimits, type SdkLedgerEvent, type SdkLedgerStore, type SdkLedgerUsage } from "./SdkUsageLedger";

export interface SdkHostToolContext {
  readonly operationId: string; readonly signal: AbortSignal; readonly scope: Readonly<SdkBootstrapScope>;
  assertCurrent(): void;
}
export interface SdkHostTool {
  name: string; description: string; parameters: Record<string, unknown>;
  /** Calls requiring another model must be deferred to an outer host continuation. */
  invokesModel?: boolean;
  authorize(input: Readonly<Record<string, unknown>>, context: SdkHostToolContext): boolean | Promise<boolean>;
  execute(input: Readonly<Record<string, unknown>>, context: SdkHostToolContext): Promise<unknown>;
}
export interface SdkExecutionControl {
  operationId: string; channel: string; limits: SdkExecutionLimits;
  jsonSchema?: Record<string, unknown>; tools?: readonly SdkHostTool[];
  /** Host capability check, not a model assertion; run again before image send. */
  allowImages?: () => boolean;
  /** Host-only asynchronous approval/source/lease check at each HTTP boundary.
   * No model parameters, tools or provider retries may bypass this check. */
  beforeDispatch?: () => Promise<void>;
  /** Why the host stopped the model loop. Read only when the run was actually
   * aborted, so an ordinary failure can never be relabeled a handoff (F-04). */
  abortReason?: () => SdkHostAbortReason | undefined;
}
/** Host-side stop reasons that are NOT a user cancel and NOT a failure. */
export type SdkHostAbortReason = "host-handoff" | "confirmation";
type SdkModule = Awaited<ReturnType<typeof loadClaudeSdk>>;
interface Work {
  onPreview?(text: string): void;
  previewBytes?: number;
  request: AiRequest; scope: SdkBootstrapScope; control: SdkExecutionControl; prompt: SdkPrompt;
  operation: string; usage?: SdkLedgerUsage; estimatedCostUsd?: number; reportedTurns?: number | null; revision?: number; fault?: string; protocolFailure?: Readonly<SdkProtocolFailure>; cancel?(): void; onToken?(text: string): void; onReasoning?(text: string): void;
}
interface Driver {
  onBridgePreview(work: Work, context: SdkBootstrapContext, text: string): void;
  onBridgeFailure(work: Work, context: SdkBootstrapContext, code: string, failure?: Readonly<SdkProtocolFailure>): void;
  executePrepared(work: Work, context: ManagedSdkExecutionContext): Promise<AiResponse>;
  beforeDispatch(work: Work, context: SdkBootstrapContext, body: Record<string, unknown>, protocol?: "openai-chat" | "anthropic-messages"): Promise<void>;
}
export interface SdkExecutionHost {
  desktop: boolean; pluginDirectory: string; platform: string; arch: string;
  getSettings(): OrdinarySdkSettings; ledgerStore: SdkLedgerStore;
}
/** Internal test seam, not exposed in plugin settings or requests. It replaces
 * only the owned process/SDK ports in offline tests, never selects a native AI. */
export interface SdkExecutionTestPorts {
  loadSdk?: () => Promise<SdkModule>;
  portsFactory?: (driver: Driver) => SdkBootstrapPorts<Work, AiResponse>;
}
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void p.catch(() => undefined); return Promise.reject(sdkFault("CANCELLED")); }
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener("abort", stop); reject(sdkFault("CANCELLED")); };
    signal.addEventListener("abort", stop, { once: true });
    p.then(v => { signal.removeEventListener("abort", stop); resolve(v); }, e => { signal.removeEventListener("abort", stop); reject(e); });
  });
}
function id(v: string): boolean { return typeof v === "string" && /^[\p{L}\p{N}._:-]{1,160}$/u.test(v); }
const codes = new Set(["EMPTY_RESPONSE", "OUTPUT_TRUNCATED", "UPSTREAM_HTTP_ERROR", "UPSTREAM_PROTOCOL_ERROR", "UPSTREAM_TRANSPORT_ERROR", "UPSTREAM_TIMEOUT", "INVALID_INPUT", "INVALID_LIMITS", "INPUT_LIMIT", "OUTPUT_LIMIT", "IMAGE_INLINE_REQUIRED", "IMAGE_UNSUPPORTED", "INVALID_JSON", "SCHEMA_INVALID", "SCHEMA_MISMATCH", "REQUEST_BUDGET", "LEDGER_STATE", "LEDGER_FULL", "LEDGER_BUSY", "LEDGER_CORRUPT", "LEDGER_UNAVAILABLE", "OPERATION_ALREADY_RECORDED", "MODEL_OVERRIDE", "REASONING_OVERRIDE", "TOOL_DENIED", "TOOL_BUDGET", "TOOL_FAILED", "TOOL_SCHEMA", "RECURSION_DENIED", "NO_DISPATCH", "NO_TERMINAL", "DUPLICATE_TERMINAL", "MODEL_FAILED", "TIMEOUT", "CANCELLED", "DISPOSED"]);
/** A bounded denial is safer than discarding a turn that already read useful
 * material: the model gets one final chance to answer from what it has. */
function toolBudgetNotice(limit: number): string {
  return `本轮工具调用预算已用完（上限 ${limit} 次）。请停止调用工具，立即基于已经成功读取的内容给出最终回答；未覆盖的范围请明确说明，不要猜测。`;
}
function diagnostic(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "";
  // S5: the owned ledger/store also refuses a non-desktop host. Surface that as
  // the same user-facing scope code instead of a generic model failure.
  if (code === "SDK_EXECUTION_DESKTOP_ONLY") return "SDK_BOOTSTRAP_DESKTOP_ONLY";
  if (code.startsWith("SDK_EXECUTION_") && codes.has(code.slice(14))) return code;
  if (["SDK_BOOTSTRAP_CANCELLED", "SDK_BOOTSTRAP_DISPOSED", "SDK_BOOTSTRAP_APPROVAL_REQUIRED", "SDK_BOOTSTRAP_STALE_CONFIGURATION", "SDK_BOOTSTRAP_RUNTIME_UNAVAILABLE", "SDK_BOOTSTRAP_CLEANUP_FAILED", "SDK_BOOTSTRAP_DESKTOP_ONLY", "SDK_BOOTSTRAP_ROUTE_UNSUPPORTED", "SDK_BOOTSTRAP_REASONING_UNSUPPORTED", "SDK_ORDINARY_MISSING_CREDENTIAL", "SDK_ORDINARY_INVALID_CONFIGURATION"].includes(code)) return code;
  return "SDK_EXECUTION_MODEL_FAILED";
}
/** Presentation adapter for later chat/workflow wiring; never echo raw errors. */
export function sdkExecutionDiagnostic(code: string): { title: string; action: string } {
  const hints: Record<string, [string, string]> = {
    SDK_EXECUTION_EMPTY_RESPONSE: ["AI 服务本次未返回可显示的回答", "没有把思考内容当作正文，也没有自动重试。请查看本次响应诊断后再决定是否重新发起。"],
    SDK_EXECUTION_OUTPUT_TRUNCATED: ["AI 本次输出达到上限，回答尚未完成", "此上限包含思考和正文；max 推理可能先耗尽额度。请在设置中心 → AI 模型 → 高级设置中调整“聊天输出上限（含思考）”，或缩小请求范围。未自动追加费用或降低档位。"],
    SDK_EXECUTION_UPSTREAM_PROTOCOL_ERROR: ["AI 接口返回格式尚未正确适配", "本次已停止，没有自动重试。请查看诊断记录；这不是上下文过长的判断。"],
    SDK_EXECUTION_UPSTREAM_HTTP_ERROR: ["AI 服务返回了请求错误", "请核对服务商、权限和模型配置；本次没有自动重试或换账号，已发出的请求可能产生费用。"],
    SDK_EXECUTION_UPSTREAM_TRANSPORT_ERROR: ["AI 服务连接中断", "本次已停止，没有自动重试。请检查网络及服务可用性后手动决定是否重试。"],
    SDK_EXECUTION_UPSTREAM_TIMEOUT: ["AI 服务响应超时", "本次已停止，没有自动重试。已发出的请求可能产生费用，用量缺失仍记为未知。"],
    SDK_EXECUTION_REQUEST_BUDGET: ["本次 AI 请求已达到预算限制", "请查看调用次数、输入和费用预留记录；确认额度后手动发起新操作，不会自动重试。"],
    SDK_EXECUTION_OPERATION_ALREADY_RECORDED: ["该操作已经执行或执行状态尚未确认", "请先查看原操作结果和用量记录；重新加载不会自动补跑。确需重做时请明确发起一次新操作。"],
    SDK_EXECUTION_IMAGE_UNSUPPORTED: ["当前任务尚未确认图片能力", "请选择已验证支持图片的视觉模型，并确认所选图片的处理范围。"],
    SDK_EXECUTION_IMAGE_INLINE_REQUIRED: ["图片尚未准备为可用输入", "请由插件的附件流程读取你选定的图片。执行器不会自行读取本地路径或下载网页图片。"],
    SDK_EXECUTION_INVALID_JSON: ["AI 没有返回有效的结构化结果", "本次没有提交成功结果或自动重试；可核对模型的结构化输出能力后手动重试。"],
    SDK_EXECUTION_SCHEMA_MISMATCH: ["AI 结果不符合该功能的数据格式", "本次没有执行后续写入。请检查模型能力或缩小任务范围后重新提交。"],
    SDK_EXECUTION_LEDGER_UNAVAILABLE: ["调用记录未能可靠保存", "请检查插件数据目录的空间、权限和诊断记录。已发出的请求可能产生费用，请勿连续重复提交。"],
    SDK_EXECUTION_TIMEOUT: ["AI 操作超时，已停止等待", "已发出的请求可能产生费用，用量缺失时会记为未知。请查看操作记录后决定是否重新发起。"],
    SDK_EXECUTION_HOST_HANDOFF: ["本次模型循环已正常交接给宿主续作", "这不是用户取消，也不是失败：宿主已停止模型循环，以便在查询槽之外执行一次有界续作；执行记录会记为 interrupted，交付以本轮结果为准。"],
    SDK_EXECUTION_HOST_CONFIRMATION: ["本次模型循环已停止，等待你确认写入", "这不是用户取消，也不是失败：写入仍按原有预览与确认流程执行，执行记录会记为 interrupted；确认或取消后本轮才结束。"],
    SDK_EXECUTION_TOOL_DENIED: ["工具操作未获授权", "请核对项目、文件范围及该操作的确认状态；不会绕过原有写入确认。"],
    SDK_EXECUTION_TOOL_BUDGET: ["本轮工具调用次数已达上限", "请缩小请求范围，或指定要读取的文件后重试；本轮不会自动重试。"],
    SDK_EXECUTION_TOOL_FAILED: ["本轮有工具调用未完成", "请查看诊断记录中的工具错误，缩小请求范围后重试；本轮没有把未完成的结果当作证据，也没有自动重试。"],
    SDK_EXECUTION_RECURSION_DENIED: ["该操作需要专用入口，不能在本次回答里嵌套启动 AI 请求", "请在对应的功能页单独执行该操作（例如周期复盘、日记生成、资料库识别），或等本次回答结束后重新发起。这里不会排队等待，也不会启动第二套 Agent。"]
  };
  const hint = hints[code]; return hint ? { title: hint[0], action: hint[1] } : sdkBootstrapDiagnostic(code);
}
/** F-04: one fixed mapping from execution facts to the durable finish row. The
 * old `cancelled` bucket mixed three different events (turn timeout, host
 * handoff, real user stop); new rows keep them apart. Historical rows are never
 * rewritten. */
export function sdkFinishRecord(input: { timeout: boolean; aborted: boolean; abortReason?: SdkHostAbortReason; error: string }): { outcome: NonNullable<SdkLedgerEvent["outcome"]>; code: string } {
  if (input.timeout) return { outcome: "timeout", code: "SDK_EXECUTION_TIMEOUT" };
  if (input.aborted && input.abortReason === "host-handoff") return { outcome: "interrupted", code: "SDK_EXECUTION_HOST_HANDOFF" };
  if (input.aborted && input.abortReason === "confirmation") return { outcome: "interrupted", code: "SDK_EXECUTION_HOST_CONFIRMATION" };
  return { outcome: input.aborted ? "cancelled" : "error", code: input.error };
}
/** Sole SDK query kernel. No AgentLoop, native AI client, credential discovery,
 * provider fallback, implicit retry or external tools. Host adapters are still
 * responsible for Pro, evidence, confirmation/write transactions and outbox. */
export class SdkExecutionService {
  readonly #ledger: SdkUsageLedger;
  readonly #bootstrap: SdkInternalBootstrap<Work, AiResponse>;
  #disposed = false; #inTool = 0; #continuations = 0;
  constructor(host: SdkExecutionHost, tests: SdkExecutionTestPorts = {}) {
    this.#ledger = new SdkUsageLedger(host.ledgerStore);
    const driver: Driver = {
      onBridgePreview: (work, context, text) => {
        context.assertCurrent();
        if (context.signal.aborted || !work.onPreview || work.request.responseFormat === "json") return;
        work.previewBytes = (work.previewBytes || 0) + new TextEncoder().encode(text).length;
        if (work.previewBytes > work.control.limits.maxOutputBytes) {
          work.fault ||= "SDK_EXECUTION_OUTPUT_LIMIT"; work.cancel?.(); return;
        }
        work.onPreview(text);
      },
      onBridgeFailure: (work, _context, code, failure) => {
        if (failure) work.protocolFailure = sdkProtocolFailure(failure.stage, new Error(failure.code), failure.status);
        const fault = failure?.code === "SDK_WIRE_EMPTY_RESPONSE" ? "EMPTY_RESPONSE" : failure?.code === "SDK_WIRE_OUTPUT_TRUNCATED" ? "OUTPUT_TRUNCATED" : code === "SDK_BRIDGE_TIMEOUT" ? "UPSTREAM_TIMEOUT" : code === "SDK_BRIDGE_UPSTREAM_STATUS" ? "UPSTREAM_HTTP_ERROR" : code === "SDK_BRIDGE_UPSTREAM_CONNECTION" ? "UPSTREAM_TRANSPORT_ERROR" : "UPSTREAM_PROTOCOL_ERROR";
        work.fault ||= "SDK_EXECUTION_" + fault; work.cancel?.();
      },
      executePrepared: async (work, context) => { try { return await this.#execute(work, context, tests.loadSdk || (() => loadClaudeSdk(host.desktop))); } catch (e) { work.fault ||= diagnostic(e); throw e; } },
      beforeDispatch: async (work, context, body, protocol = "openai-chat") => {
        try {
          context.assertCurrent();
          if (work.fault) throw Error(work.fault);
          if (work.control.beforeDispatch) await abortable(work.control.beforeDispatch(), context.signal);
          context.assertCurrent();
          if (work.prompt.vision && work.control.allowImages?.() !== true) throw sdkFault("IMAGE_UNSUPPORTED");
          if (work.request.temperature !== undefined) body.temperature = work.request.temperature;
          const effort = work.request.reasoningEffort;
          if (effort === "default") {
            // D-14: "default" is an explicit provider-default request (the bounded
            // synthesis), not "inherit". A bridge conversion may already have
            // applied the host setting to this body; remove it here — immediately
            // before the ledger dispatch and the upstream call — so only this
            // request runs without the deep-effort override. Every request that
            // does not opt out keeps the existing inherit/override behaviour.
            if (protocol === "openai-chat") delete body.reasoning_effort;
            else if (body.output_config && typeof body.output_config === "object" && !Array.isArray(body.output_config)) {
              const outputConfig = { ...(body.output_config as Record<string, unknown>) };
              delete outputConfig.effort;
              if (Object.keys(outputConfig).length) body.output_config = outputConfig; else delete body.output_config;
            }
          } else if (effort) {
            if (protocol === "openai-chat") body.reasoning_effort = effort;
            else body.output_config = { ...(body.output_config as Record<string, unknown> || {}), effort };
          }
          await this.#ledger.dispatch(work.operation, work.control.limits, body, work.request.requestBudget);
          context.assertCurrent();
        } catch (e) { work.fault = diagnostic(e); work.cancel?.(); throw e; }
      }
    };
    const ports = tests.portsFactory ? tests.portsFactory(driver) : createManagedSdkBootstrapPorts<Work, AiResponse>({ ...host, ...driver });
    this.#bootstrap = new SdkInternalBootstrap({ desktop: host.desktop, getSettings: host.getSettings, ports });
  }
  state(): unknown { return this.#bootstrap.state(); }
  toJSON(): unknown { return this.state(); }
  refreshConfiguration(): void { this.#bootstrap.refreshConfiguration(); }
  records() { return this.#ledger.records(); }
  /** The host holds this for the duration of one bounded host continuation (F-02).
   * A model call started from inside that continuation must not silently queue
   * behind other work and then burn its own whole-operation cap; it fails fast
   * instead. An idle engine still allows the continuation's own model work
   * (document vision, evidence subagents), so only real queueing is denied. */
  holdHostContinuation(): () => void {
    this.#continuations++;
    let released = false;
    return () => { if (!released) { released = true; this.#continuations = Math.max(0, this.#continuations - 1); } };
  }
  complete(request: AiRequest, scope: SdkBootstrapScope, control: SdkExecutionControl): Promise<AiResponse> { return this.#run(request, scope, control); }
  stream(request: AiRequest, callbacks: AiStreamCallbacks, scope: SdkBootstrapScope, control: SdkExecutionControl): Promise<AiResponse> { return this.#run(request, scope, control, callbacks); }
  async #run(request: AiRequest, scope: SdkBootstrapScope, control: SdkExecutionControl, callbacks?: AiStreamCallbacks): Promise<AiResponse> {
    let started = false, work: Work | undefined, terminal = false, timeout = false;
    let combined: ReturnType<typeof combineAgentSignals> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new AbortController();
    const notify = (fn: (() => void) | undefined) => { try { fn?.(); } catch { /* UI observer cannot rerun a billable request. */ } };
    try {
      if (this.#disposed) throw sdkFault("DISPOSED"); if (this.#inTool) throw sdkFault("RECURSION_DENIED");
      if (!scope || !control || !id(control.operationId) || !id(control.channel)) throw sdkFault("INVALID_INPUT");
      if (control.beforeDispatch !== undefined && typeof control.beforeDispatch !== "function") throw sdkFault("INVALID_INPUT");
      if (!request || request.responseFormat !== undefined && !["text", "json"].includes(request.responseFormat)) throw sdkFault("INVALID_INPUT");
      if ([scope.accountScopeId, scope.projectScopeId, scope.sessionId].some(v => typeof v !== "string" || !v || v.length > 240 || /[\u0000-\u001f\u007f]/.test(v)) || typeof scope.automatic !== "boolean") throw sdkFault("INVALID_INPUT");
      // F-02: while a host continuation is in progress, a nested host-mediated
      // workflow job must not queue behind other work and burn its own whole
      // cap. Only host workflow jobs (fixed `workflow:<purpose>` session) are
      // denied; an independent chat turn keeps the previous queueing behaviour,
      // and automatic background jobs are never collaterally denied. Fails
      // before the ledger start so no phantom "started" row is recorded.
      if (this.#continuations > 0 && scope.automatic !== true && String(scope.sessionId).startsWith("workflow:")) {
        const busy = this.#bootstrap.state();
        if (busy.activeBusy || busy.queued > 0) throw sdkFault("RECURSION_DENIED");
      }
      const limits = validateSdkLimits(control.limits);
      if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) throw sdkFault("INVALID_INPUT");
      const jsonSchema = control.jsonSchema ? JSON.parse(JSON.stringify(control.jsonSchema)) as Record<string, unknown> : undefined;
      if (jsonSchema) { if (request.responseFormat !== "json") throw sdkFault("INVALID_INPUT"); sdkJsonValidator(jsonSchema); }
      const prompt = prepareSdkPrompt(request, limits.maxInputBytes, jsonSchema);
      if (prompt.vision && control.allowImages?.() !== true) throw sdkFault("IMAGE_UNSUPPORTED");
      const tools = (control.tools || []).map(t => ({ ...t, parameters: JSON.parse(JSON.stringify(t.parameters)) as Record<string, unknown> }));
      if (tools.length > 64 || tools.some((t, n) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(t.name) || tools.findIndex(v => v.name === t.name) !== n || t.invokesModel || typeof t.authorize !== "function" || typeof t.execute !== "function" || typeof t.description !== "string" || t.description.length > 4000)) throw sdkFault("TOOL_SCHEMA");
      for (const t of tools) sdkJsonValidator(t.parameters);
      if (request.tools?.some(t => !tools.some(h => h.name === t.name && JSON.stringify(h.parameters) === JSON.stringify(t.parameters)))) throw sdkFault("TOOL_DENIED");
      combined = combineAgentSignals(request.requestBudget, scope.signal);
      const abort = () => stop.abort(); combined.signal.addEventListener("abort", abort, { once: true }); if (combined.signal.aborted) stop.abort();
      // dispose removes all source listeners; combined's listener dies with controller.
      if (stop.signal.aborted) throw sdkFault("CANCELLED");
      let approved = false; try { approved = scope.approval?.() === true; } catch { /* no echo */ }
      if (!approved) throw Error("SDK_BOOTSTRAP_APPROVAL_REQUIRED");
      const scopeCopy = Object.freeze({ ...scope, signal: stop.signal, task: prompt.vision ? "vision" as const : "text" as const });
      const operation = JSON.stringify([scope.accountScopeId, scope.projectScopeId, scope.sessionId, control.channel, control.operationId]);
      // Clone user-controlled messages/options; never allow edits while queued.
      const frozenRequest = { ...request, messages: JSON.parse(JSON.stringify(request.messages)) };
      work = { request: frozenRequest, scope: scopeCopy, control: { ...control, limits, tools, jsonSchema }, prompt, operation, cancel: () => stop.abort() };
      await this.#ledger.start(operation); started = true;
      timer = setTimeout(() => { timeout = true; stop.abort(); }, limits.maxDurationMs);
      notify(callbacks?.onStart);
      work.onToken = text => { if (!stop.signal.aborted && !terminal && request.responseFormat !== "json") notify(() => callbacks?.onToken?.(text)); };
      // Thinking is a separate projection: never answer bytes, never an evidence
      // source, never part of the terminal JSON contract.
      work.onReasoning = text => { if (!stop.signal.aborted && !terminal) notify(() => callbacks?.onReasoning?.(text)); };
      if (callbacks?.onPreview && request.responseFormat !== "json") work.onPreview = text => {
        if (!stop.signal.aborted && !terminal) notify(() => callbacks.onPreview?.(text));
      };
      const response = await this.#bootstrap.run(work, scopeCopy);
      if (stop.signal.aborted) throw sdkFault("CANCELLED");
      if (!(await this.#ledger.records()).some(e => e.operation === operation && e.kind === "dispatch")) throw sdkFault("NO_DISPATCH");
      await this.#ledger.finish(operation, "success", work.usage, undefined, work.estimatedCostUsd, work.reportedTurns);
      // Persisted completion is not permission for a late UI update.
      if (stop.signal.aborted || scope.approval() !== true) throw sdkFault("CANCELLED");
      this.#bootstrap.refreshConfiguration();
      if (this.#bootstrap.state().revision !== work.revision) throw Error("SDK_BOOTSTRAP_STALE_CONFIGURATION");
      terminal = true; notify(() => callbacks?.onDone?.(response.text || "")); return response;
    } catch (cause) {
      const error = timeout ? "SDK_EXECUTION_TIMEOUT" : work?.fault || diagnostic(cause);
      let abortReason: SdkHostAbortReason | undefined;
      if (!timeout && stop.signal.aborted && work) { try { abortReason = work.control.abortReason?.(); } catch { /* a broken observer cannot change the recorded cause */ } }
      const finish = sdkFinishRecord({ timeout, aborted: stop.signal.aborted, abortReason, error });
      if (started && work) {
        try { const records = await this.#ledger.records(); if (!records.some(e => e.operation === work!.operation && e.kind === "finish")) await this.#ledger.finish(work.operation, finish.outcome, work.usage, finish.code, work.estimatedCostUsd, work.reportedTurns, work.protocolFailure); }
        catch { terminal = true; notify(() => callbacks?.onError?.("SDK_EXECUTION_LEDGER_UNAVAILABLE")); return { ok: false, error: "SDK_EXECUTION_LEDGER_UNAVAILABLE", terminal: true }; }
      }
      terminal = true;
      const exposed = abortReason ? finish.code : error;
      if (!timeout && (error === "SDK_EXECUTION_CANCELLED" || error === "SDK_BOOTSTRAP_CANCELLED")) notify(callbacks?.onAbort);
      else notify(() => callbacks?.onError?.(exposed));
      return { ok: false, error: exposed, terminal: true, usage: work?.usage ? { ...work.usage, estimated: true } : undefined };
    } finally { terminal = true; if (timer) clearTimeout(timer); stop.abort(); combined?.dispose(); }
  }
  async #execute(work: Work, ctx: ManagedSdkExecutionContext, load: () => Promise<SdkModule>): Promise<AiResponse> {
    const { request, prompt, control, scope } = work, { options } = ctx;
    work.revision = ctx.scope.revision;
    const check = () => { ctx.scope.assertCurrent(); if (ctx.scope.signal.aborted) throw sdkFault("CANCELLED"); };
    check(); if (request.model && request.model !== options.model) throw sdkFault("MODEL_OVERRIDE");
    if (request.reasoningEffort) {
      if (request.reasoningEffort === "default") {
        // D-14: an explicit provider-default request clears any effort the host
        // port prepared from the user setting. The user setting itself is never
        // written; every other request keeps inheriting or overriding it.
        options.effort = undefined;
      } else {
        if (!["low", "medium", "high", "max"].includes(request.reasoningEffort)) throw sdkFault("REASONING_OVERRIDE");
        options.effort = request.reasoningEffort;
      }
    }
    const sdk = await abortable(load(), ctx.scope.signal); check();
    options.systemPrompt = prompt.system; options.maxTurns = control.limits.maxModelRequests;
    options.includePartialMessages = true; options.tools = []; options.allowedTools = []; options.mcpServers = {};
    options.settingSources = []; options.verbatimPrompts = true; options.strictMcpConfig = true; options.persistSession = false;
    let calls = 0, toolTail: Promise<unknown> = Promise.resolve();
    let reasoningBytes = 0, reasoningTruncated = false;
    const hostTools = control.tools || [], allowed = new Set(hostTools.map(t => "mcp__lifeos__" + t.name));
    options.canUseTool = async (name, input) => { check(); return allowed.has(name) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Host tool not granted." }; };
    if (hostTools.length) {
      const { z } = await import("zod/v4");
      const tools = hostTools.map(t => {
        const validate = sdkJsonValidator(t.parameters);
        const schema = z.fromJSONSchema(t.parameters) as import("zod/v4").ZodObject;
        if (!schema.shape) throw sdkFault("TOOL_SCHEMA");
        return sdk.tool(t.name, t.description, schema.shape, async raw => {
          const ordinal = ++calls;
          const pending = toolTail.then(async () => {
            check();
            if (control.limits.maxToolCalls !== null && ordinal > control.limits.maxToolCalls) {
              return { content: [{ type: "text" as const, text: toolBudgetNotice(control.limits.maxToolCalls) }] };
            }
            if (!validate(raw)) throw sdkFault("TOOL_SCHEMA");
            const input = Object.freeze(JSON.parse(JSON.stringify(raw)) as Record<string, unknown>);
            const context = Object.freeze({ operationId: control.operationId + ":tool:" + ordinal, signal: ctx.scope.signal, scope, assertCurrent: check });
            this.#inTool++;
            try {
              if (await abortable(Promise.resolve(t.authorize(input, context)), ctx.scope.signal) !== true) throw sdkFault("TOOL_DENIED");
              check();
              const result = await abortable(t.execute(input, context), ctx.scope.signal); check();
              const text = JSON.stringify(result); if (typeof text !== "string" || new TextEncoder().encode(text).length > control.limits.maxOutputBytes) throw sdkFault("OUTPUT_LIMIT");
              return { content: [{ type: "text" as const, text }] };
            } finally { this.#inTool--; }
          });
          toolTail = pending.catch(() => undefined);
          try { return await pending; } catch (e) { work.fault = diagnostic(e); throw sdkFault("TOOL_FAILED"); }
        });
      });
      options.mcpServers = { lifeos: sdk.createSdkMcpServer({ name: "lifeos", version: "0.3.25", tools }) };
    }
    async function* input(): AsyncGenerator<import("@anthropic-ai/claude-agent-sdk/core").SDKUserMessage> {
      yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: prompt.content as never } };
    }
    const query = sdk.query({ prompt: input(), options });
    const close = () => { try { query.close(); } catch { /* primary failure retained */ } };
    ctx.scope.signal.addEventListener("abort", close, { once: true });
    let final: Record<string, any> | undefined, bytes = 0;
    try {
      const it = query[Symbol.asyncIterator]();
      while (true) {
        const next = await abortable(it.next(), ctx.scope.signal); check(); if (next.done) break;
        const m = next.value as unknown as Record<string, any>;
        if (m.type === "result") { if (final) throw sdkFault("DUPLICATE_TERMINAL"); final = m; }
        if (m.type === "stream_event" && !m.parent_tool_use_id && m.event?.type === "content_block_delta") {
          if (final) throw sdkFault("DUPLICATE_TERMINAL");
          const delta = m.event.delta;
          if (delta?.type === "text_delta") {
            const text = delta.text; if (typeof text !== "string") throw sdkFault("MODEL_FAILED");
            bytes += new TextEncoder().encode(text).length; if (bytes > control.limits.maxOutputBytes) throw sdkFault("OUTPUT_LIMIT");
            check(); work.onToken?.(text);
          } else if (delta?.type === "thinking_delta") {
            // Supplier thinking is bounded and kept out of answer bytes. The
            // signature_delta and redacted_thinking payloads stay unprojected.
            const text = delta.thinking;
            if (typeof text !== "string") throw sdkFault("MODEL_FAILED");
            if (!reasoningTruncated) {
              const size = new TextEncoder().encode(text).length;
              if (reasoningBytes + size <= REASONING_MAX_BYTES) {
                reasoningBytes += size; check(); work.onReasoning?.(text);
              } else {
                reasoningTruncated = true; check(); work.onReasoning?.(REASONING_TRUNCATED_NOTICE);
              }
            }
          }
        }
      }
      if (!final) throw sdkFault("NO_TERMINAL");
      await abortable(toolTail, ctx.scope.signal); check();
      work.reportedTurns = final.startup_failure_reason === undefined && Number.isSafeInteger(final.num_turns) && final.num_turns >= 0 ? final.num_turns : null;
      // modelUsage is cumulative for the query pipeline. Do not add assistant,
      // stream and terminal usage together or treat startup placeholder zeros as billing.
      const rows: Record<string, unknown>[] | undefined = final.modelUsage && typeof final.modelUsage === "object" ? Object.values(final.modelUsage) as Record<string, unknown>[] : undefined;
      if (rows?.length && rows.every(u => [u.inputTokens, u.outputTokens, u.cacheReadInputTokens ?? 0, u.cacheCreationInputTokens ?? 0].every(n => Number.isSafeInteger(n) && Number(n) >= 0))) {
        const inputTokens = rows.reduce((sum, u) => sum + Number(u.inputTokens) + Number(u.cacheReadInputTokens ?? 0) + Number(u.cacheCreationInputTokens ?? 0), 0), outputTokens = rows.reduce((sum, u) => sum + Number(u.outputTokens), 0);
        if (Number.isSafeInteger(inputTokens + outputTokens)) work.usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
      } else work.usage = sdkUsage(final.usage);
      // Some compatible providers omit usage and SDK fills modelUsage with zero.
      // A dispatched model request cannot prove a free zero-token request.
      if (final.startup_failure_reason !== undefined || work.usage?.totalTokens === 0) work.usage = undefined;
      if (work.usage && typeof final.total_cost_usd === "number" && Number.isFinite(final.total_cost_usd) && final.total_cost_usd >= 0) work.estimatedCostUsd = final.total_cost_usd;
      if (work.fault) throw Error(work.fault);
      if (final.stop_reason === "max_tokens") throw sdkFault("OUTPUT_TRUNCATED");
      if (final.subtype !== "success" || final.is_error || typeof final.result !== "string") throw sdkFault("MODEL_FAILED");
      if (!final.result.trim()) throw sdkFault("EMPTY_RESPONSE");
      if (new TextEncoder().encode(final.result).length > control.limits.maxOutputBytes) throw sdkFault("OUTPUT_LIMIT");
      if (request.responseFormat === "json") {
        let parsed: unknown; try { parsed = JSON.parse(final.result); } catch { throw sdkFault("INVALID_JSON"); }
        if (control.jsonSchema && !sdkJsonValidator(control.jsonSchema)(parsed)) throw sdkFault("SCHEMA_MISMATCH");
      }
      check(); return { ok: true, text: final.result, terminal: true, usage: work.usage ? { ...work.usage, estimated: true } : undefined };
    } finally { ctx.scope.signal.removeEventListener("abort", close); close(); }
  }
  async dispose(): Promise<void> { this.#disposed = true; await this.#bootstrap.dispose(); }
}
