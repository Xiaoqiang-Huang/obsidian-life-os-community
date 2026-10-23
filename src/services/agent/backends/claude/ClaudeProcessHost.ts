import type { AgentRuntimeProfile } from "../../AgentEngineConfig";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk/core";
import { checkClaudeRuntimePaths } from "./ClaudeSdkRuntime";

/** Owns only explicitly configured children; never scans logins or runs a shell. */
export class ClaudeProcessHost {
  private readonly children = new Map<import("node:child_process").ChildProcess, Promise<void>>();
  private disposed = false;
  private closing: Promise<void> | undefined;
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
      let markClosed!: () => void;
      const closed = new Promise<void>(resolve => { markClosed = resolve; });
      this.children.set(child, closed);
      // Never persist stderr: SDK errors may include transport or credential details.
      child.stderr?.resume();
      const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
      options.signal.addEventListener("abort", stop, { once: true });
      const cleanup = () => { options.signal.removeEventListener("abort", stop); this.children.delete(child); markClosed(); };
      child.once("close", cleanup);
      // A failed spawn owns no process. Other errors are not proof of closure.
      child.once("error", () => { if (child.pid === undefined) cleanup(); });
      if (options.signal.aborted) stop();
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
  dispose(): Promise<void> {
    if (!this.closing) {
      this.disposed = true;
      const owned = [...this.children.entries()];
      this.closing = (async () => {
        const stopped = Promise.all(owned.map(([, closed]) => closed));
        const waitForClose = async (): Promise<boolean> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([stopped.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
          } finally { if (timer !== undefined) clearTimeout(timer); }
        };
        for (const [child] of owned) {
          try { if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end(); } catch { /* closure must still be observed */ }
          try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); } catch { /* escalate below, never assume success */ }
        }
        if (await waitForClose()) return;
        for (const [child] of owned) {
          try { if (this.children.has(child) && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* fail closed if it remains owned */ }
        }
        if (!await waitForClose()) throw new Error("sdk-host-cleanup-failed");
      })();
    }
    return this.closing;
  }
  get activeChildren(): number { return this.children.size; }
}
