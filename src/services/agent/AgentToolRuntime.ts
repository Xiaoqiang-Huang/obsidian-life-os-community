import type { LifeOSAgentToolDescriptor } from "../LifeOSAgentToolRegistry";
import type {
  LifeOSAgentToolCall,
  LifeOSAgentToolExecutionContext,
  LifeOSAgentToolResult
} from "./LifeOSAgentTypes";

export type LifeOSAgentToolExecutor = (
  input: Record<string, unknown>,
  context: LifeOSAgentToolExecutionContext
) => Promise<string | { output: string; metadata?: Record<string, string | number | boolean> }>;

export interface LifeOSAgentWriteConfirmation {
  allowed: boolean;
  summary?: string;
}

export interface AgentToolRuntimeOptions {
  confirmWrite?: (descriptor: LifeOSAgentToolDescriptor, call: LifeOSAgentToolCall, context: LifeOSAgentToolExecutionContext) => Promise<LifeOSAgentWriteConfirmation>;
}

export interface LifeOSAgentPendingWrite {
  descriptorId: string;
  call: LifeOSAgentToolCall;
  createdAt: number;
  confirmationSummary: string;
}

const PENDING_WRITE_TTL_MS = 30 * 60 * 1000;

/** Executes typed tools with permission gates, idempotency, and bounded output. */
export class AgentToolRuntime {
  private readonly descriptors = new Map<string, LifeOSAgentToolDescriptor>();
  private readonly executors = new Map<string, LifeOSAgentToolExecutor>();
  private readonly resultCache = new Map<string, LifeOSAgentToolResult>();
  private readonly pendingWrites = new Map<string, LifeOSAgentPendingWrite>();

  constructor(descriptors: readonly LifeOSAgentToolDescriptor[]) {
    descriptors.forEach((descriptor) => this.descriptors.set(descriptor.id, descriptor));
  }

  register(id: string, executor: LifeOSAgentToolExecutor): void {
    if (!this.descriptors.has(id)) throw new Error(`未知 Agent 工具：${id}`);
    this.executors.set(id, executor);
  }

  /** Register a persisted declarative tool without allowing built-in tools to be replaced. */
  registerDynamic(descriptor: LifeOSAgentToolDescriptor, executor: LifeOSAgentToolExecutor): void {
    if (!/^custom-[a-z0-9][a-z0-9-]{2,63}$/u.test(descriptor.id)) {
      throw new Error("自定义工具 ID 必须以 custom- 开头，并且只能包含小写字母、数字和连字符。");
    }
    const existing = this.descriptors.get(descriptor.id);
    if (existing && !existing.id.startsWith("custom-")) throw new Error(`不能覆盖原生工具：${descriptor.id}`);
    this.descriptors.set(descriptor.id, descriptor);
    this.executors.set(descriptor.id, executor);
    this.clearToolCache(descriptor.id);
  }

  unregisterDynamic(id: string): boolean {
    if (!id.startsWith("custom-")) return false;
    const removed = this.descriptors.delete(id);
    this.executors.delete(id);
    this.clearToolCache(id);
    return removed;
  }

  hasExecutor(id: string): boolean {
    return this.executors.has(id);
  }

  available(channel: "desktop" | "weixin"): LifeOSAgentToolDescriptor[] {
    return Array.from(this.descriptors.values()).filter((descriptor) => descriptor.channels.includes(channel) && this.executors.has(descriptor.id));
  }

  descriptor(id: string): LifeOSAgentToolDescriptor | undefined {
    return this.descriptors.get(id);
  }

  descriptorsForChannel(channel: "desktop" | "weixin"): LifeOSAgentToolDescriptor[] {
    return Array.from(this.descriptors.values()).filter((descriptor) => descriptor.channels.includes(channel));
  }

  pendingWrite(sessionId: string): LifeOSAgentPendingWrite | null {
    const pending = this.pendingWrites.get(sessionId);
    if (!pending) return null;
    if (Date.now() - pending.createdAt > PENDING_WRITE_TTL_MS) {
      this.pendingWrites.delete(sessionId);
      return null;
    }
    return {
      ...pending,
      call: { ...pending.call, input: { ...pending.call.input } }
    };
  }

  pendingWriteDecision(value: string): "confirm" | "cancel" | null {
    const normalized = String(value || "")
      .trim()
      .replace(/[，。！？!?,；;：:\s]+$/gu, "");
    if (/^(?:确认|确认执行|确定|确定执行|同意|执行|继续执行|可以执行|就这么做|好的)$/u.test(normalized)) return "confirm";
    if (/^(?:取消|取消执行|拒绝|不执行|不要|算了|否)$/u.test(normalized)) return "cancel";
    return null;
  }

  discardPendingWrite(sessionId: string): LifeOSAgentPendingWrite | null {
    const pending = this.pendingWrite(sessionId);
    this.pendingWrites.delete(sessionId);
    return pending;
  }

  async confirmPendingWrite(
    context: LifeOSAgentToolExecutionContext
  ): Promise<LifeOSAgentToolResult | null> {
    const sessionKey = this.runtimeSessionKey(context);
    const pending = this.pendingWrite(sessionKey);
    if (!pending) return null;
    this.pendingWrites.delete(sessionKey);
    return this.execute(
      {
        ...pending.call,
        id: `${pending.call.id}-confirmed-${Date.now().toString(36)}`,
        input: { ...pending.call.input }
      },
      { ...context, explicitWriteIntent: true },
      { confirmWrite: async () => ({ allowed: true, summary: pending.confirmationSummary }) }
    );
  }

  async executeBatch(
    calls: LifeOSAgentToolCall[],
    context: LifeOSAgentToolExecutionContext,
    options: AgentToolRuntimeOptions = {}
  ): Promise<LifeOSAgentToolResult[]> {
    const uniqueCalls = calls.filter((call, index) => calls.findIndex((item) => item.id === call.id) === index).slice(0, 12);
    const canonical: LifeOSAgentToolCall[] = [];
    const canonicalBySignature = new Map<string, LifeOSAgentToolCall>();
    for (const call of uniqueCalls) {
      const signature = `${call.name}\u001f${JSON.stringify(call.input || {})}`;
      if (!canonicalBySignature.has(signature)) {
        canonicalBySignature.set(signature, call);
        canonical.push(call);
      }
    }
    const reads = canonical.filter((call) => this.descriptors.get(call.name)?.mode !== "write");
    const writes = canonical.filter((call) => this.descriptors.get(call.name)?.mode === "write");
    const parallelReads = reads.filter((call) => this.descriptors.get(call.name)?.parallelSafe === true);
    const serialReads = reads.filter((call) => this.descriptors.get(call.name)?.parallelSafe !== true);
    const readResults = await Promise.all(parallelReads.map((call) => this.execute(call, context, options)));
    // Some reads touch shared indexes or provider state and deliberately opt
    // out of parallel execution.  Preserve that contract instead of treating
    // every non-write tool as concurrency-safe.
    for (const call of serialReads) readResults.push(await this.execute(call, context, options));
    const writeResults: LifeOSAgentToolResult[] = [];
    for (const call of writes) writeResults.push(await this.execute(call, context, options));
    const byId = new Map([...readResults, ...writeResults].map((result) => [result.callId, result]));
    return uniqueCalls.map((call) => {
      const signature = `${call.name}\u001f${JSON.stringify(call.input || {})}`;
      const canonicalCall = canonicalBySignature.get(signature);
      const result = canonicalCall ? byId.get(canonicalCall.id) : undefined;
      if (!result) return null;
      return canonicalCall?.id === call.id ? result : { ...result, callId: call.id, cached: true };
    }).filter((item): item is LifeOSAgentToolResult => Boolean(item));
  }

  async execute(
    call: LifeOSAgentToolCall,
    context: LifeOSAgentToolExecutionContext,
    options: AgentToolRuntimeOptions = {}
  ): Promise<LifeOSAgentToolResult> {
    const startedAt = Date.now();
    const descriptor = this.descriptors.get(call.name);
    if (!descriptor || !descriptor.channels.includes(context.channel)) {
      return this.failure(call, startedAt, `当前渠道不可用工具：${call.name}`);
    }
    const executor = this.executors.get(call.name);
    if (!executor) return this.failure(call, startedAt, `工具尚未加载执行器：${call.name}`);
    if (descriptor.mode === "write" && context.permissionMode === "read-only") {
      return {
        ...this.failure(call, startedAt, "当前权限为只读，未执行写入。"),
        needsConfirmation: false
      };
    }
    const validationError = this.validate(descriptor, call.input);
    if (validationError) return this.failure(call, startedAt, validationError);
    if (context.signal?.aborted) return this.failure(call, startedAt, "执行已取消。");

    const cacheKey = this.cacheKey(call, context);
    const cached = this.resultCache.get(cacheKey);
    if (cached) return { ...cached, callId: call.id, cached: true, durationMs: Date.now() - startedAt };

    if (descriptor.mode === "write") {
      const canAutoWrite = descriptor.confirmation !== "always"
        && context.permissionMode === "explicit-auto"
        && context.explicitWriteIntent;
      if (!canAutoWrite) {
        const defaultConfirmationSummary = `准备执行：${descriptor.description}\n回复“确认”执行，回复“取消”放弃。`;
        const confirmation = options.confirmWrite
          ? await options.confirmWrite(descriptor, call, context)
          : { allowed: false, summary: defaultConfirmationSummary };
        if (!confirmation.allowed) {
          const confirmationSummary = confirmation.summary || defaultConfirmationSummary;
          this.pendingWrites.set(this.runtimeSessionKey(context), {
            descriptorId: descriptor.id,
            call: {
              id: call.id,
              name: call.name,
              input: this.sanitizeInput(call.input, descriptor)
            },
            createdAt: Date.now(),
            confirmationSummary
          });
          return {
            callId: call.id,
            toolId: call.name,
            ok: false,
            output: "",
            error: "写入等待用户确认。",
            durationMs: Date.now() - startedAt,
            needsConfirmation: true,
            confirmationSummary
          };
        }
      }
    }

    try {
      const value = await executor(this.sanitizeInput(call.input, descriptor), context);
      const output = typeof value === "string" ? value : value.output;
      const result: LifeOSAgentToolResult = {
        callId: call.id,
        toolId: call.name,
        ok: true,
        output: this.sanitizeOutput(output),
        durationMs: Date.now() - startedAt,
        ...(typeof value === "string" || !value.metadata ? {} : { metadata: value.metadata })
      };
      this.pendingWrites.delete(this.runtimeSessionKey(context));
      this.resultCache.set(cacheKey, result);
      if (this.resultCache.size > 400) this.resultCache.delete(this.resultCache.keys().next().value as string);
      return result;
    } catch (error) {
      return this.failure(call, startedAt, error instanceof Error ? error.message : String(error));
    }
  }

  private validate(descriptor: LifeOSAgentToolDescriptor, input: Record<string, unknown>): string {
    const rawLength = JSON.stringify(input || {}).length;
    if (rawLength > 30_000) return "工具参数超过 30,000 字符上限。";
    for (const [key, property] of Object.entries(descriptor.input || {})) {
      const value = input?.[key];
      if (property.required && (value === undefined || value === null || String(value).trim() === "")) return `工具 ${descriptor.id} 缺少参数：${key}`;
      if (value === undefined || value === null) continue;
      const valid = property.type === "array"
        ? Array.isArray(value)
        : property.type === "object"
          ? typeof value === "object" && !Array.isArray(value)
          : property.type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : typeof value === property.type;
      if (!valid) return `工具 ${descriptor.id} 参数 ${key} 类型应为 ${property.type}。`;
    }
    return "";
  }

  private sanitizeInput(input: Record<string, unknown>, descriptor: LifeOSAgentToolDescriptor): Record<string, unknown> {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input || {})) {
      if (!Object.prototype.hasOwnProperty.call(descriptor.input || {}, key)) continue;
      if (typeof value === "string") next[key] = value.replace(/\u0000/gu, "").slice(0, 16_000);
      else if (["number", "boolean"].includes(typeof value) || value === null) next[key] = value;
      else next[key] = JSON.parse(JSON.stringify(value));
    }
    return next;
  }

  private sanitizeOutput(value: unknown): string {
    return String(value || "")
      .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/giu, "[binary omitted]")
      .slice(0, 32_000);
  }

  private failure(call: LifeOSAgentToolCall, startedAt: number, error: string): LifeOSAgentToolResult {
    return { callId: call.id, toolId: call.name, ok: false, output: "", error: this.sanitizeOutput(error), durationMs: Date.now() - startedAt };
  }

  private cacheKey(call: LifeOSAgentToolCall, context: LifeOSAgentToolExecutionContext): string {
    return [this.runtimeSessionKey(context), context.turnId, call.name, JSON.stringify(call.input || {})].join("\u001f");
  }

  private runtimeSessionKey(context: LifeOSAgentToolExecutionContext): string {
    return String(context.runtimeSessionId || context.sessionId || "").trim();
  }

  private clearToolCache(id: string): void {
    for (const key of Array.from(this.resultCache.keys())) {
      if (key.includes(`\u001f${id}\u001f`)) this.resultCache.delete(key);
    }
  }
}
