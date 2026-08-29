export type LifeOSAgentToolMode = "read" | "write" | "reason";

export interface LifeOSAgentToolInputProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required?: boolean;
}

export interface LifeOSAgentToolDescriptor {
  id: string;
  mode: LifeOSAgentToolMode;
  description: string;
  channels: Array<"desktop" | "weixin">;
  /** Only the light schema is advertised initially. Full executors are lazy. */
  input?: Record<string, LifeOSAgentToolInputProperty>;
  family?: "web" | "rag" | "diary" | "task" | "review" | "knowledge" | "memory" | "reminder" | "skill" | "vision" | "project" | "vault" | "tooling" | "ui";
  deferred?: boolean;
  parallelSafe?: boolean;
  /** Number of model requests performed inside the tool executor. */
  modelCallCost?: number;
  risk?: "none" | "local-read" | "local-write" | "network";
  /** Destructive writes stay behind a confirmation even in explicit-auto mode. */
  confirmation?: "default" | "always";
}

/**
 * Canonical Life OS Agent capability catalog.
 *
 * The desktop assistant and remote channels must use the same catalog for
 * routing and capability descriptions. Channel adapters still enforce their
 * own permissions and presentation rules; adding a tool here never grants a
 * remote sender write access by itself.
 */
export const LIFEOS_AGENT_TOOL_REGISTRY: readonly LifeOSAgentToolDescriptor[] = [
  { id: "web-search", mode: "read", family: "web", description: "搜索多个公开网页来源并读取正文，适合最新外部事实、官网、新闻和公开资料", channels: ["desktop", "weixin"], deferred: true, parallelSafe: true, risk: "network", input: { query: { type: "string", description: "独立、完整的检索问题", required: true }, officialOnly: { type: "boolean", description: "是否优先官方来源" } } },
  { id: "lifeos-search", mode: "read", family: "rag", description: "混合检索 Life OS 日记、任务、记忆、项目、知识库和 LLM Wiki", channels: ["desktop", "weixin"], deferred: true, parallelSafe: true, risk: "local-read", input: { query: { type: "string", description: "要在 Life OS 中查找的内容", required: true }, projectScopeId: { type: "string", description: "可选项目范围" } } },
  { id: "project-search", mode: "read", family: "project", description: "在项目上下文、会话交接、任务和项目文档中检索", channels: ["desktop", "weixin"], deferred: true, parallelSafe: true, risk: "local-read", input: { query: { type: "string", description: "项目问题", required: true }, projectScopeId: { type: "string", description: "项目标识" } } },
  { id: "diary-read", mode: "read", family: "diary", description: "读取指定日期的日记", channels: ["desktop", "weixin"], parallelSafe: true, risk: "local-read", input: { date: { type: "string", description: "today、yesterday 或 YYYY-MM-DD" } } },
  { id: "diary-add", mode: "write", family: "diary", description: "把用户记录追加到日记", channels: ["desktop", "weixin"], risk: "local-write", input: { content: { type: "string", description: "要写入的内容", required: true }, date: { type: "string", description: "可选日期" } } },
  { id: "diary-generate", mode: "write", family: "diary", description: "根据当日输入和 Life OS 事实生成今日日记", channels: ["desktop", "weixin"], deferred: true, modelCallCost: 1, risk: "local-write", input: { date: { type: "string", description: "要生成的日期" } } },
  { id: "task-list", mode: "read", family: "task", description: "查看待办", channels: ["desktop", "weixin"], parallelSafe: true, risk: "local-read", input: {} },
  { id: "task-add", mode: "write", family: "task", description: "新建待办", channels: ["desktop", "weixin"], risk: "local-write", input: { title: { type: "string", description: "待办标题", required: true }, dueDate: { type: "string", description: "可选截止日期" }, projectScopeId: { type: "string", description: "可选项目" } } },
  { id: "task-update", mode: "write", family: "task", description: "修改待办", channels: ["desktop", "weixin"], risk: "local-write", input: { query: { type: "string", description: "原待办序号或关键词", required: true }, title: { type: "string", description: "新标题", required: true }, dueDate: { type: "string", description: "新截止日期" } } },
  { id: "task-complete", mode: "write", family: "task", description: "完成待办", channels: ["desktop", "weixin"], risk: "local-write", input: { query: { type: "string", description: "待办序号或关键词", required: true } } },
  { id: "task-delete", mode: "write", family: "task", description: "删除待办", channels: ["desktop", "weixin"], risk: "local-write", input: { query: { type: "string", description: "待办序号或关键词", required: true } } },
  { id: "task-clear-all", mode: "write", family: "task", description: "先完整备份 open.md，再清空全部未完成待办；回复“确认”执行，回复“取消”放弃", channels: ["desktop", "weixin"], risk: "local-write", confirmation: "always", input: {} },
  { id: "review-generate", mode: "write", family: "review", description: "生成日、周、月或自定义日期复盘", channels: ["desktop", "weixin"], deferred: true, modelCallCost: 2, risk: "local-write", input: { period: { type: "string", description: "daily、weekly、monthly 或 custom" }, start: { type: "string", description: "起始日期" }, end: { type: "string", description: "结束日期" } } },
  { id: "summary-generate", mode: "read", family: "review", description: "汇总指定周期事实，不直接写入", channels: ["desktop", "weixin"], deferred: true, modelCallCost: 2, risk: "local-read", input: { period: { type: "string", description: "daily、weekly、monthly 或 custom" }, start: { type: "string", description: "起始日期" }, end: { type: "string", description: "结束日期" } } },
  { id: "link-save", mode: "write", family: "knowledge", description: "读取链接正文并收藏到指定知识分类", channels: ["desktop", "weixin"], deferred: true, risk: "local-write", input: { url: { type: "string", description: "链接", required: true }, title: { type: "string", description: "标题" }, collection: { type: "string", description: "分类" } } },
  { id: "knowledge-save", mode: "write", family: "knowledge", description: "把文本保存到知识库", channels: ["desktop", "weixin"], risk: "local-write", input: { title: { type: "string", description: "知识标题", required: true }, content: { type: "string", description: "正文", required: true } } },
  { id: "memory-save", mode: "write", family: "memory", description: "把内容存为待确认的长期记忆候选", channels: ["desktop", "weixin"], risk: "local-write", input: { content: { type: "string", description: "记忆内容", required: true }, category: { type: "string", description: "记忆分类" }, importance: { type: "string", description: "low、normal 或 high" } } },
  { id: "project-document-save", mode: "write", family: "project", description: "把内容保存为当前项目文档", channels: ["desktop", "weixin"], risk: "local-write", input: { title: { type: "string", description: "文档标题", required: true }, content: { type: "string", description: "Markdown 正文", required: true }, kind: { type: "string", description: "note、meeting、requirement、reference 或 review" }, projectScopeId: { type: "string", description: "项目 ID 或名称" } } },
  { id: "reminder-add", mode: "write", family: "reminder", description: "创建主动提醒", channels: ["desktop", "weixin"], risk: "local-write", input: { when: { type: "string", description: "提醒时间", required: true }, content: { type: "string", description: "提醒内容", required: true } } },
  { id: "reminder-list", mode: "read", family: "reminder", description: "查看提醒", channels: ["desktop", "weixin"], parallelSafe: true, risk: "local-read", input: {} },
  { id: "reminder-cancel", mode: "write", family: "reminder", description: "取消提醒", channels: ["desktop", "weixin"], risk: "local-write", input: { id: { type: "string", description: "提醒编号", required: true } } },
  { id: "skill-select", mode: "reason", family: "skill", description: "按人物、昵称或方法语义选择任意已安装 Skill", channels: ["desktop", "weixin"], deferred: true, parallelSafe: true, risk: "none", input: { query: { type: "string", description: "用户原始问题", required: true } } },
  { id: "vision", mode: "reason", family: "vision", description: "理解本轮绑定或被明确引用的图片", channels: ["desktop", "weixin"], deferred: true, parallelSafe: true, modelCallCost: 1, risk: "none", input: { instruction: { type: "string", description: "图片处理要求" } } },
  { id: "ocr-read", mode: "reason", family: "vision", description: "隔离读取本轮图片可见文字并返回证据包", channels: ["desktop", "weixin"], deferred: true, parallelSafe: true, modelCallCost: 1, risk: "none", input: { instruction: { type: "string", description: "OCR 或版面理解要求" } } },
  { id: "subagent-web", mode: "reason", family: "web", description: "在独立上下文中完成多来源网页研究并只返回证据包", channels: ["desktop", "weixin"], deferred: true, parallelSafe: true, modelCallCost: 1, risk: "network", input: { query: { type: "string", description: "研究问题", required: true } } },
  { id: "subagent-rag", mode: "reason", family: "rag", description: "在独立上下文中检索 Life OS 并返回相关证据，不继承无关聊天", channels: ["desktop", "weixin"], deferred: true, parallelSafe: true, modelCallCost: 1, risk: "local-read", input: { query: { type: "string", description: "Life OS 问题", required: true } } },
  { id: "subagent-project", mode: "reason", family: "project", description: "在隔离项目上下文中梳理进度、决定、风险和下一步", channels: ["desktop", "weixin"], deferred: true, parallelSafe: true, modelCallCost: 1, risk: "local-read", input: { query: { type: "string", description: "项目问题", required: true }, projectScopeId: { type: "string", description: "项目标识" } } },
  {
    id: "task-view-configure",
    mode: "write",
    family: "ui",
    description: "设置任务页面是否显示已完成任务；只修改显示偏好，不删除、清空或改写任何任务",
    channels: ["desktop", "weixin"],
    risk: "local-write",
    input: { showCompleted: { type: "boolean", description: "是否在任务页面显示已完成任务", required: true } }
  },
  {
    id: "tool-capabilities",
    mode: "read",
    family: "tooling",
    description: "查询当前 Agent 已加载的原生工具和用户自定义工具；缺少直接工具时应先调用此工具",
    channels: ["desktop", "weixin"],
    parallelSafe: true,
    risk: "none",
    input: { query: { type: "string", description: "可选的能力关键词" } }
  },
  {
    id: "vault-file-list",
    mode: "read",
    family: "vault",
    description: "列出 Life OS 根目录内的文件；不能访问 Vault 其他区域",
    channels: ["desktop", "weixin"],
    parallelSafe: true,
    risk: "local-read",
    input: {
      folder: { type: "string", description: "Life OS 根目录内的相对目录，留空表示根目录" },
      recursive: { type: "boolean", description: "是否递归列出子目录" }
    }
  },
  {
    id: "vault-file-read",
    mode: "read",
    family: "vault",
    description: "读取 Life OS 根目录内的文本文件",
    channels: ["desktop", "weixin"],
    parallelSafe: true,
    risk: "local-read",
    input: { path: { type: "string", description: "Life OS 根目录内的相对文件路径", required: true } }
  },
  {
    id: "vault-file-create",
    mode: "write",
    family: "vault",
    description: "在 Life OS 根目录内新建文本文件；已存在时拒绝覆盖",
    channels: ["desktop", "weixin"],
    risk: "local-write",
    input: {
      path: { type: "string", description: "Life OS 根目录内的相对文件路径", required: true },
      content: { type: "string", description: "文件正文", required: true }
    }
  },
  {
    id: "vault-file-append",
    mode: "write",
    family: "vault",
    description: "向 Life OS 根目录内的文本文件追加内容",
    channels: ["desktop", "weixin"],
    risk: "local-write",
    input: {
      path: { type: "string", description: "Life OS 根目录内的相对文件路径", required: true },
      content: { type: "string", description: "要追加的正文", required: true }
    }
  },
  {
    id: "vault-file-replace",
    mode: "write",
    family: "vault",
    description: "在 Life OS 文本文件中精确替换内容，并在替换前创建备份",
    channels: ["desktop", "weixin"],
    risk: "local-write",
    confirmation: "always",
    input: {
      path: { type: "string", description: "Life OS 根目录内的相对文件路径", required: true },
      find: { type: "string", description: "必须匹配的原文", required: true },
      replace: { type: "string", description: "替换后的正文", required: true },
      replaceAll: { type: "boolean", description: "是否替换全部匹配；默认要求唯一匹配" }
    }
  },
  {
    id: "vault-file-move",
    mode: "write",
    family: "vault",
    description: "移动或重命名 Life OS 根目录内的文件",
    channels: ["desktop", "weixin"],
    risk: "local-write",
    confirmation: "always",
    input: {
      from: { type: "string", description: "原相对路径", required: true },
      to: { type: "string", description: "目标相对路径", required: true }
    }
  },
  {
    id: "vault-file-trash",
    mode: "write",
    family: "vault",
    description: "把 Life OS 根目录内的文件移入系统废纸篓",
    channels: ["desktop", "weixin"],
    risk: "local-write",
    confirmation: "always",
    input: { path: { type: "string", description: "Life OS 根目录内的相对文件路径", required: true } }
  },
  {
    id: "tool-compose",
    mode: "write",
    family: "tooling",
    description: "把现有安全工具组合成可复用的声明式工具；禁止 JavaScript、Shell、eval 和递归造工具",
    channels: ["desktop", "weixin"],
    risk: "local-write",
    confirmation: "always",
    input: {
      name: { type: "string", description: "新工具名称", required: true },
      description: { type: "string", description: "新工具的用途和触发场景", required: true },
      inputSchema: { type: "object", description: "新工具输入字段定义" },
      steps: { type: "array", description: "按顺序执行的现有工具步骤", required: true },
      runNow: { type: "boolean", description: "保存后是否立即执行" },
      arguments: { type: "object", description: "立即执行时传给新工具的参数" }
    }
  },
  {
    id: "tool-delete",
    mode: "write",
    family: "tooling",
    description: "删除由 Agent 创建的自定义工具，不影响原生工具",
    channels: ["desktop", "weixin"],
    risk: "local-write",
    confirmation: "always",
    input: { toolId: { type: "string", description: "custom- 开头的自定义工具 ID", required: true } }
  }
];

export function lifeOSAgentToolsForChannel(channel: "desktop" | "weixin"): readonly LifeOSAgentToolDescriptor[] {
  return LIFEOS_AGENT_TOOL_REGISTRY.filter((tool) => tool.channels.includes(channel));
}
