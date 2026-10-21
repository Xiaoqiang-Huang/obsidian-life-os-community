import { parseProjectIndex } from "../project-context";

/** Host-owned public facts only. Never serialize settings, endpoints or credentials. */
export function sdkPluginFacts(input: { provider: string; model: string; permissionMode: string; webSearchMode?: string }): string {
  return ["# Life OS 当前运行信息（宿主提供，不是检索文档）",
    "配置服务商：" + JSON.stringify(input.provider) + "；本轮请求模型标识：" + JSON.stringify(input.model) + "。这是请求配置，不保证兼容服务底层实际型号。",
    "Claude Agent SDK 是插件的执行框架，不是模型；不要因为使用 SDK 就自称 Claude，也不必联网猜测本轮模型。",
    "用户问有哪些项目/项目列表时直接调用 project-list，按 hasMore/nextOffset 分页；不要用全文相似度检索代替完整目录。查项目具体观点时再用 project-search/分段读取。",
    "介绍插件能力时以本轮工具为准；tool-capabilities 可查询当前可用能力。查看项目、任务、笔记，检索/总结资料与文档识别通过对应工具完成，写入仍受原有确认与授权限制。",
    "当前写入策略：" + input.permissionMode + "；联网策略：" + (input.webSearchMode || "auto") + "。本地项目目录、当前模型和插件功能不需要搜索互联网。",
    "只提供当前问题所需的简洁结论；不为介绍功能执行写入或逐一调用所有工具。"
  ].join("\n");
}

/** The catalog is NOT full document evidence. Scope first, then paginate. */
export function projectIndexPage(markdown: string, input: Record<string, unknown>, scope: string) {
  const offset = input.offset === undefined ? 0 : input.offset;
  const limit = input.limit === undefined ? 50 : input.limit;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error("项目分页参数无效；offset 必须为非负整数，limit 为 1–100。");
  const query = String(input.query || "").normalize("NFKC").toLocaleLowerCase().trim();
  const projects = parseProjectIndex(markdown).filter(p => !scope || p.id === scope)
    .filter(p => !query || (p.name + " " + p.id).normalize("NFKC").toLocaleLowerCase().includes(query))
    .map(({ id, name, type, status }) => ({ id, name, type, status }));
  const page = projects.slice(offset, offset + limit), hasMore = offset + page.length < projects.length;
  return { projects: page, total: projects.length, offset, hasMore, nextOffset: hasMore ? offset + page.length : null,
    note: "这是当前范围的项目目录，不代表已读取项目文档正文；全部项目完成分页后才可称已列全。" };
}
