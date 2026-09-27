import { readAgentTextPage } from "./AgentTextPage";
export class AgentWebPager {
 private cache = new Map<string, {id: string; text: string; created: number}>();
 private serial = 0;
 async read(scope: string, url: string, offset: unknown, limit: unknown, snapshot: unknown, fetchBody: () => Promise<string>) {
  const key = JSON.stringify([scope, url]);
  let item = this.cache.get(key);
  if (snapshot !== undefined) {
    if (!item || snapshot !== item.id || Date.now() - item.created > 600000) throw new Error("网页快照已过期或不匹配，请从 offset=0 重新读取");
  } else {
    if (offset !== undefined && offset !== 0) throw new Error("网页续读必须提供 snapshot");
    const text = await fetchBody();
    if (text.length > 500000) throw new Error("网页正文超过读取上限，未宣称完整读取；请选择章节 URL");
    if (!text.trim() || /Status: fetched, but no readable text was found/u.test(text)) throw new Error("网页未返回可读正文");
    item = { id: `${Date.now()}-${++this.serial}`, text, created: Date.now() };
    this.cache.set(key, item);
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
  }
  const result = readAgentTextPage(item!.text, url, offset, limit);
  const metadata = { ...result.metadata, snapshot: item!.id, evidenceKind: "fetched-body", scope: "fetched-page-snapshot" };
  return { output: JSON.stringify(metadata) + result.output.slice(result.output.indexOf("\n")), metadata };
 }
}
