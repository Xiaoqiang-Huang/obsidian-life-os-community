import type { AgentRuntimeProfile } from "../../AgentEngineConfig";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk/core";
import { checkClaudeRuntimePaths } from "./ClaudeSdkRuntime";

/** Owns only explicitly configured children; never scans logins or runs a shell. */
export class ClaudeProcessHost {
  private readonly children = new Set<import("node:child_process").ChildProcess>();
  private disposed = false;
  async prepare(runtime: AgentRuntimeProfile, desktop: boolean, environment: Record<string, string>, cwd: string) {
    if (this.disposed) throw new Error("sdk-host-disposed");
    const check = await checkClaudeRuntimePaths(runtime, desktop);
    if (!check.readyForVersionProbe) throw new Error(check.code);
    const cp = await import("node:child_process"), fs = await import("node:fs/promises"), path = await import("node:path");
    if (!path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory()) throw new Error("sdk-cwd-required");
    const js = /\.[cm]?js$/i.test(runtime.executablePath);
    const env = Object.freeze({ ...environment });
    return (options: SpawnOptions): SpawnedProcess => {
      if (this.disposed || options.signal.aborted) throw new Error("sdk-host-cancelled");
      // SDK supplies protocol flags, not the command or authentication identity.
      const args = [...options.args];
      if (args[0] === runtime.executablePath) args.shift();
      const child = cp.spawn(js ? runtime.nodePath : runtime.executablePath, js ? [runtime.executablePath, ...args] : args,
        { cwd, env: { ...env }, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.children.add(child);
      // Never persist stderr: SDK errors may include transport or credential details.
      child.stderr?.resume();
      const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
      options.signal.addEventListener("abort", stop, { once: true });
      const cleanup = () => { options.signal.removeEventListener("abort", stop); this.children.delete(child); };
      child.once("close", cleanup); child.once("error", cleanup);
      return child as unknown as SpawnedProcess;
    };
  }
  async probe(runtime: AgentRuntimeProfile, desktop: boolean, cwd: string): Promise<string> {
    const spawn = await this.prepare(runtime, desktop, {}, cwd);
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const child = spawn({ command: runtime.executablePath, args: ["--version"], cwd, env: {}, signal: controller.signal });
      let text = ""; const timeout = setTimeout(() => { controller.abort(); reject(new Error("sdk-version-timeout")); }, 10000);
      child.stdout.on("data", value => { text += String(value); if (text.length > 4096) controller.abort(); });
      child.once("error", () => { clearTimeout(timeout); reject(new Error("sdk-version-start-failed")); });
      child.once("exit", code => { clearTimeout(timeout); const version = text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
        if (code === 0 && version) resolve(version); else reject(new Error("sdk-version-invalid")); });
    });
  }
  dispose(): void { this.disposed = true; for (const child of this.children) { child.stdin?.end(); child.kill("SIGTERM"); } this.children.clear(); }
  get activeChildren(): number { return this.children.size; }
}
