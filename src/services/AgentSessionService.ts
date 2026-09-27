/** Session metadata only: never grants document-write permissions or indexes chat as knowledge. */
export interface AgentSession { id: string; title: string; updatedAt: string; snapshot?: Record<string, unknown> }
interface SessionIndex {
  version: 1; active: string; sessions: AgentSession[];
  listed: string[]; receipts: Record<string, string>;
}
export interface AgentSessionStore {
  read(scope: string): Promise<string | null>;
  write(scope: string, value: string): Promise<void>;
}
export type SessionCommand = { action: "new" | "list" | "switch" | "rename"; value: string };

export function parseSessionCommand(text: string): SessionCommand | null {
  const input = text.trim().replace(/[。！!]+$/u, "");
  const command = input.match(/^\/lifeos\s+(new|sessions|switch|rename)(?:\s+([\s\S]+))?$/iu);
  if (command) return { action: ({ new: "new", sessions: "list", switch: "switch", rename: "rename" } as const)[command[1].toLowerCase() as "new" | "sessions" | "switch" | "rename"], value: command[2]?.trim() || "" };
  if (/^(?:请)?(?:看看|查看|列出)(?:最近的?|所有的?)?会话(?:列表)?$/u.test(input)) return { action: "list", value: "" };
  if (/^(?:结束这个话题[，,]?重新聊|重新聊|新建(?:一个)?会话)$/u.test(input)) return { action: "new", value: "" };
  const create = input.match(/^(?:请)?新建(?:一个)?会话[，,:：\s]+(.+)$/u);
  if (create) return { action: "new", value: create[1] };
  const rename = input.match(/^(?:把)?(?:这个|当前)会话(?:改名为|重命名为)[：:\s]*(.+)$/u);
  if (rename) return { action: "rename", value: rename[1] };
  const change = input.match(/^切换到(?:会话)?[：:\s]*(.+)$/u);
  if (change) return { action: "switch", value: change[1] };
  return null;
}

/** Injected storage allows the same service to be used by any entry without moving its UI. */
export class AgentSessionService {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private store: AgentSessionStore) {}
  private async load(scope: string): Promise<SessionIndex> {
    const raw = await this.store.read(scope);
    if (!raw) return { version: 1, active: "legacy", sessions: [{ id: "legacy", title: "原有会话", updatedAt: new Date(0).toISOString() }], listed: [], receipts: {} };
    const data = JSON.parse(raw) as SessionIndex;
    if (data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > 200
      || !data.sessions.every(s => s && typeof s.id === "string" && typeof s.title === "string" && typeof s.updatedAt === "string")
      || new Set(data.sessions.map(s => s.id)).size !== data.sessions.length || !data.sessions.some(s => s.id === data.active)
      || !Array.isArray(data.listed) || !data.receipts || typeof data.receipts !== "object") throw new Error("会话索引损坏，未重置原有记录。");
    return data;
  }
  async list(scope: string): Promise<AgentSession[]> {
    await this.queues.get(scope);
    return (await this.load(scope)).sessions;
  }
  async current(scope: string): Promise<AgentSession> {
    await this.queues.get(scope);
    const data = await this.load(scope);
    return data.sessions.find(s => s.id === data.active)!;
  }
  /** Adopt an existing entry identity without deleting its working checkpoint. */
  async adopt(scope: string, id: string, title: string, snapshot?: Record<string, unknown>): Promise<AgentSession> {
    const prior = this.queues.get(scope) || Promise.resolve();
    const task = prior.catch(() => undefined).then(async () => {
      const data = await this.load(scope);
      let item = data.sessions.find(s => s.id === id);
      if (!item) {
        if (data.sessions.length >= 200) throw new Error("会话数量已达上限，未丢弃旧会话。");
        item = { id, title: title.slice(0, 80) || "会话", updatedAt: new Date().toISOString() };
        data.sessions.push(item);
      }
      if (snapshot) {
        const serialized = JSON.stringify(snapshot);
        if (serialized.length > 2_000_000) throw new Error("会话快照过大，未覆盖已有记录。");
        item.snapshot = JSON.parse(serialized);
      }
      item.updatedAt = new Date().toISOString(); data.active = id;
      await this.store.write(scope, JSON.stringify(data));
      return item;
    });
    this.queues.set(scope, task);
    try { return await task; } finally { if (this.queues.get(scope) === task) this.queues.delete(scope); }
  }

  async command(scope: string, messageId: string, command: SessionCommand): Promise<string> {
    if (!messageId) throw new Error("缺少消息编号，不能安全修改会话。");
    const prior = this.queues.get(scope) || Promise.resolve();
    const task = prior.catch(() => undefined).then(async () => {
      const data = await this.load(scope);
      const receipt = "message:" + messageId;
      if (Object.prototype.hasOwnProperty.call(data.receipts, receipt)) return data.receipts[receipt];
      let reply: string;
      if (command.action === "list") {
        const sessions = [...data.sessions].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
        data.listed = sessions.map(s => s.id);
        reply = sessions.map((s,i) => `${i+1}. ${s.title}${s.id === data.active ? "（当前）" : ""}`).join("\n") + "\n发送“切换到第二个”或“切换到会话名称”。";
      } else if (command.action === "new") {
        if (data.sessions.length >= 200) return "会话数量已达 200，暂不新建；原有记录未删除。";
        const session = { id: crypto.randomUUID(), title: command.value.trim().slice(0, 80) || "新会话", updatedAt: new Date().toISOString() };
        data.sessions.push(session); data.active = session.id;
        reply = `已新建并切换到：${session.title}。\n原有对话保留；不继承旧选区、图片、待确认操作或项目绑定。`;
      } else if (command.action === "rename") {
        const title = command.value.trim().slice(0, 80);
        if (!title) return "请提供新的会话名称。";
        const session = data.sessions.find(s => s.id === data.active)!;
        session.title = title; session.updatedAt = new Date().toISOString();
        reply = `当前会话已改名为：${title}`;
      } else {
        const numerals: Record<string, number> = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
        const match = command.value.match(/^第?([0-9]+|[一二三四五六七八九十])个?$/u);
        const n = match ? (numerals[match[1]] || Number(match[1])) : 0;
        const candidates = match ? data.sessions.filter(s => s.id === data.listed[n-1]) : data.sessions.filter(s => s.title === command.value || s.id === command.value);
        if (candidates.length !== 1) return candidates.length > 1 ? "有多个同名会话，请先查看会话列表，再按编号切换。" : "未找到该会话，请先发送“查看会话列表”，再按列表编号或完整名称切换。";
        data.active = candidates[0].id;
        reply = `已切换到：${candidates[0].title}。后续消息使用该会话上下文；不会自动执行待确认操作。`;
      }
      data.receipts[receipt] = reply;
      const keys = Object.keys(data.receipts);
      for (const key of keys.slice(0, Math.max(0, keys.length - 256))) delete data.receipts[key];
      await this.store.write(scope, JSON.stringify(data));
      return reply;
    });
    this.queues.set(scope, task);
    try { return await task; } finally { if (this.queues.get(scope) === task) this.queues.delete(scope); }
  }
}
