import type { SdkProtocolFailure } from "./SdkProtocolDiagnostic";
import type { Options } from "@anthropic-ai/claude-agent-sdk/core";
import type { AgentProviderProfile, AgentRuntimeProfile } from "../agent/AgentEngineConfig";
import { AGENT_CAPABILITIES } from "../agent/AgentEngineConfig";
import { resolveClaudeRuntime } from "../agent/backends/claude/ClaudeRuntimeResolver";
import { resolveBundledClaudeRuntime } from "../agent/backends/claude/BundledClaudeRuntime";
import { checkClaudeRuntimePaths, buildClaudeSdkEnvironment, buildRestrictedClaudeOptions, PINNED_AGENT_SDK_VERSION } from "../agent/backends/claude/ClaudeSdkRuntime";
import { ClaudeProcessHost } from "../agent/backends/claude/ClaudeProcessHost";
import { startLocalSdkProtocolBridge, type LocalSdkBridge } from "./LocalSdkProtocolBridge";
import { createNodeSdkTransport } from "./NodeSdkTransport";
import type { SdkBootstrapContext, SdkBootstrapPorts } from "./SdkInternalBootstrap";

export interface ManagedSdkExecutionContext {
  readonly options: Options;
  readonly scope: SdkBootstrapContext;
  readonly protocol?: "openai-chat" | "anthropic-messages";
}
/** Caller is an SDK executor, NOT a native model or a planner fallback. No CLI
 * path/profile is supplied by settings or per job. Runtime comes from plugin root. */
export function createManagedSdkBootstrapPorts<Request, Result>(host: {
  desktop: boolean; pluginDirectory: string; platform: string; arch: string;
  executePrepared(request: Request, context: ManagedSdkExecutionContext): Promise<Result>;
  /** Enforced at EVERY upstream attempt, including SDK retries/tool turns.
   * When supplied, Anthropic direct also uses the owned local forwarding gate. */
  onBridgeFailure?(request: Request, scope: SdkBootstrapContext, code: string, failure?: Readonly<SdkProtocolFailure>): void;
  onBridgePreview?(request: Request, scope: SdkBootstrapContext, text: string): void;
  beforeDispatch?(request: Request, scope: SdkBootstrapContext, body: Record<string, unknown>, protocol: "openai-chat" | "anthropic-messages"): Promise<void>;
}): SdkBootstrapPorts<Request, Result> {
  const { desktop, pluginDirectory, platform, arch, executePrepared, beforeDispatch, onBridgeFailure } = host;
  return {
    async prepare(snapshot, signal) {
      if (!desktop) throw new Error("SDK_BOOTSTRAP_DESKTOP_ONLY");
      if (!["openai-bridge", "anthropic-direct", "anthropic-bridge"].includes(snapshot.config.route)) throw new Error("SDK_BOOTSTRAP_ROUTE_UNSUPPORTED");
      if (signal.aborted) throw new Error("SDK_BOOTSTRAP_CANCELLED");
      let resolved: Awaited<ReturnType<typeof resolveClaudeRuntime>>;
      try { resolved = await resolveClaudeRuntime(pluginDirectory, platform, arch, desktop); }
      catch { throw new Error("SDK_BOOTSTRAP_RUNTIME_UNAVAILABLE"); }
      if (resolved.source === "bundled" && resolved.cliVersion !== "2.1.293") throw new Error("SDK_BOOTSTRAP_RUNTIME_UNAVAILABLE");
      if (signal.aborted) throw new Error("SDK_BOOTSTRAP_CANCELLED");
      const fs = await import("node:fs/promises"), path = await import("node:path"), os = await import("node:os"), crypto = await import("node:crypto");
      const tempRoot = await fs.realpath(os.tmpdir());
      const folder = await fs.mkdtemp(path.join(tempRoot, "lifeos-sdk-managed-"));
      const owner = crypto.randomBytes(24).toString("hex"), marker = path.join(folder, ".lifeos-sdk-owner");
      await fs.writeFile(marker, owner, { flag: "wx" });
      const cwd = path.join(folder, "work"), configDirectory = path.join(folder, "config");
      await fs.mkdir(cwd); await fs.mkdir(configDirectory);
      const processHost = new ClaudeProcessHost(); let bridge: LocalSdkBridge | undefined, executionController: AbortController | undefined, disposed = false, closing: Promise<void> | undefined;
      let dispatchBinding: { request: Request; scope: SdkBootstrapContext } | undefined;
      const dispose = () => {
        if (!closing) {
          disposed = true; executionController?.abort(); processHost.dispose();
          closing = (async () => {
            if (bridge) await bridge.dispose();
            // Recursive removal is only for our own verified disposable directory.
            // Never accepts a target path or deletes the plugin runtime/Vault.
            const rel = path.relative(tempRoot, folder);
            if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !path.basename(folder).startsWith("lifeos-sdk-managed-") || await fs.realpath(folder) !== folder || (await fs.lstat(folder)).isSymbolicLink() || await fs.readFile(marker, "utf8") !== owner) throw new Error("SDK_BOOTSTRAP_CLEANUP_FAILED");
            await fs.rm(folder, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
          })();
        }
        return closing;
      };
      const abort = () => { void dispose().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted || disposed) throw new Error("SDK_BOOTSTRAP_CANCELLED");
        let baseURL: string, mode: AgentProviderProfile["authMode"], credential: string;
        if (snapshot.config.route === "openai-bridge" || snapshot.config.route === "anthropic-bridge" || beforeDispatch) {
          const nativeTransport = createNodeSdkTransport(desktop);
          const transport: typeof fetch = async (url, init) => {
            if (beforeDispatch) {
              if (!dispatchBinding || typeof init?.body !== "string") throw new Error("SDK_BOOTSTRAP_EXECUTION_FAILED");
              const { request, scope } = dispatchBinding; scope.assertCurrent();
              const body = JSON.parse(init.body) as Record<string, unknown>;
              await beforeDispatch(request, scope, body, snapshot.config.protocol); scope.assertCurrent();
              init = { ...init, body: JSON.stringify(body) };
            }
            return nativeTransport(url, init);
          };
          const opened = await startLocalSdkProtocolBridge({ desktop, config: snapshot.config,
            upstreamHeaders: { ...(snapshot.config.protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}), ...snapshot.upstreamHeaders() }, transport,
            reasoningEffort: snapshot.reasoningEffort, timeoutMs: Math.max(120000, snapshot.chatLimits.maxDurationMs),
          // The owned query is serial; never interleave previews from two HTTP responses.
          maxConcurrent: 1,
          captureTextPreview: () => {
            const binding = dispatchBinding;
            if (!binding || !host.onBridgePreview) return undefined;
            return text => {
              if (disposed || dispatchBinding !== binding || binding.scope.signal.aborted) return;
              binding.scope.assertCurrent();
              host.onBridgePreview?.(binding.request, binding.scope, text);
            };
          },
          captureFailure: () => {
            const binding = dispatchBinding;
            return (code, failure) => {
              if (!binding || disposed || dispatchBinding !== binding || binding.scope.signal.aborted) return;
              // Cancelling this captured work must still run after approval is revoked.
              onBridgeFailure?.(binding.request, binding.scope, code, failure);
            };
          } });
          if (signal.aborted || disposed) { await opened.dispose(); throw new Error("SDK_BOOTSTRAP_CANCELLED"); }
          bridge = opened;
          baseURL = bridge.baseURL; mode = "anthropic-api-key"; credential = bridge.sessionToken;
        } else {
          const auth = snapshot.directAuthentication(); baseURL = snapshot.config.sdkBaseURL!; mode = auth.mode; credential = auth.credential;
        }
        if (signal.aborted || disposed) throw new Error("SDK_BOOTSTRAP_CANCELLED");
        const runtime: AgentRuntimeProfile = {
          id: resolved.source === "bundled" ? "builtin-sdk" : "external-claude-cli",
          hostId: resolved.source === "bundled" ? "owned-plugin-runtime" : "user-installed-claude-cli",
          platform, arch,
          executablePath: resolved.executablePath,
          nodePath: resolved.nodePath,
          sdkVersion: PINNED_AGENT_SDK_VERSION,
          cliVersion: resolved.cliVersion
        };
        const profile: AgentProviderProfile = { id: "ordinary-ai", revision: 1, label: "Ordinary AI configuration", protocol: "anthropic-messages", baseUrl: baseURL,
          allowLocalHttp: baseURL.startsWith("http:"), authMode: mode, secretRef: "ephemeral-ordinary-ai", mainModel: snapshot.config.model,
          extractionModel: snapshot.config.model, verificationModel: snapshot.config.model,
          capabilities: Object.fromEntries(AGENT_CAPABILITIES.map(c => [c, "unknown"])) as AgentProviderProfile["capabilities"], capabilitySnapshot: null };
        const inherited = Object.fromEntries(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LANG", "LC_ALL"].map(k => [k, process.env[k]]));
        const environment = buildClaudeSdkEnvironment({ profile, credential, isolatedConfigDirectory: configDirectory, inherited });
        return {
          async execute(request, scope) {
            scope.assertCurrent(); if (disposed || signal.aborted) throw new Error("SDK_BOOTSTRAP_CANCELLED");
            try {
              if (resolved.source === "bundled") {
                const current = await resolveBundledClaudeRuntime(pluginDirectory, platform, arch, desktop);
                if (current.executablePath !== resolved.executablePath || current.cliVersion !== resolved.cliVersion) throw Error();
              } else {
                const check = await checkClaudeRuntimePaths(runtime, true);
                if (!check.readyForVersionProbe) throw Error();
              }
            } catch { throw new Error("SDK_BOOTSTRAP_RUNTIME_UNAVAILABLE"); }
            scope.assertCurrent();
            executionController = new AbortController();
            const stop = () => executionController?.abort(); scope.signal.addEventListener("abort", stop, { once: true });
            if (scope.signal.aborted) stop();
            const options = buildRestrictedClaudeOptions({ profile, runtime, environment, cwd, maxTurns: 1, abortController: executionController });
            options.verbatimPrompts = true; options.strictMcpConfig = true;
            options.enableFileCheckpointing = false;
            if (snapshot.config.protocol === "openai-chat") options.thinking = { type: "disabled" };
            // D-14: a request that explicitly asks for the provider default decides
            // its own effort; the user's configured effort still governs every
            // request that does not opt out (inherit) or overrides it explicitly.
            const requestEffort = (request as { reasoningEffort?: string }).reasoningEffort;
            if (requestEffort === "default") { /* explicit provider default */ }
            else if (snapshot.reasoningEffort !== "default") options.effort = snapshot.reasoningEffort;
            options.spawnClaudeCodeProcess = await processHost.prepare(runtime, true, environment, cwd);
            scope.assertCurrent();
            dispatchBinding = { request, scope };
            const context: ManagedSdkExecutionContext = Object.freeze({ scope, options, protocol: snapshot.config.protocol });
            // JSON logs must not serialize the child's credential environment.
            Object.defineProperty(options, "toJSON", { value: () => ({ model: options.model, cwd: "owned-disposable", maxTurns: options.maxTurns, persistSession: false }) });
            try { return await executePrepared(request, context); }
            finally { dispatchBinding = undefined; scope.signal.removeEventListener("abort", stop); }
          },
          async dispose() { signal.removeEventListener("abort", abort); await dispose(); }
        };
      } catch (cause) { signal.removeEventListener("abort", abort); await dispose(); throw cause; }
    }
  };
}
