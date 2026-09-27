import type { LifeOSAgentToolResult } from "./LifeOSAgentTypes";
interface Entry { identity: string; status: "started" | "completed"; result?: LifeOSAgentToolResult; }
/** Persistent at-most-once journal. Ambiguous/crashed writes require reconciliation, not blind replay. */
export class AgentWriteJournal {
 private static queues = new Map<string, Promise<unknown>>();
 constructor(private read: (key: string) => Promise<string | null>, private write: (key: string, value: string) => Promise<void>) {}
 async run(scope: string, operation: string, identity: string, execute: () => Promise<LifeOSAgentToolResult>) {
  const bytes = new TextEncoder().encode(JSON.stringify([scope, operation]));
  const key = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(x=>x.toString(16).padStart(2,"0")).join("");
  const previous = AgentWriteJournal.queues.get(key) || Promise.resolve();
  const pending = previous.catch(()=>undefined).then(async () => {
    const raw = await this.read(key);
    if (raw) {
      const entry = JSON.parse(raw) as Entry;
      if (entry.identity !== identity) throw new Error("操作编号已用于不同内容，未重复写入");
      if (entry.status === "completed" && entry.result?.ok) return { ...entry.result, cached: true };
      throw new Error("该写入的完成状态不确定，请核对目标后处理；不会自动重复执行");
    }
    await this.write(key, JSON.stringify({ identity, status: "started" }));
    const result = await execute();
    if (result.ok) await this.write(key, JSON.stringify({ identity, status: "completed", result }));
    return result;
  });
  AgentWriteJournal.queues.set(key, pending);
  try { return await pending; } finally { if (AgentWriteJournal.queues.get(key) === pending) AgentWriteJournal.queues.delete(key); }
 }
}
export function stableAgentIdentity(value: unknown): string {
 if (Array.isArray(value)) return "[" + value.map(stableAgentIdentity).join(",") + "]";
 if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableAgentIdentity((value as Record<string, unknown>)[key])).join(",") + "}";
 return JSON.stringify(value);
}
