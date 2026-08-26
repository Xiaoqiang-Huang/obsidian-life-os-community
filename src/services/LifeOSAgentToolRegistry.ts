export type LifeOSAgentToolMode = "read" | "write" | "reason";

export interface LifeOSAgentToolDescriptor {
  id: string;
  mode: LifeOSAgentToolMode;
  description: string;
  channels: Array<"desktop" | "weixin">;
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
  { id: "web-search", mode: "read", description: "搜索多个公开网页来源并读取正文，适合最新外部事实、官网、新闻和公开资料", channels: ["desktop", "weixin"] },
  { id: "lifeos-search", mode: "read", description: "混合检索 Life OS 日记、任务、记忆、项目、知识库和 LLM Wiki", channels: ["desktop", "weixin"] },
  { id: "diary-read", mode: "read", description: "读取指定日期的日记", channels: ["desktop", "weixin"] },
  { id: "diary-add", mode: "write", description: "把用户记录追加到日记", channels: ["desktop", "weixin"] },
  { id: "diary-generate", mode: "write", description: "根据当日输入和 Life OS 事实生成今日日记", channels: ["desktop", "weixin"] },
  { id: "task-list", mode: "read", description: "查看待办", channels: ["desktop", "weixin"] },
  { id: "task-add", mode: "write", description: "新建待办", channels: ["desktop", "weixin"] },
  { id: "task-update", mode: "write", description: "修改待办", channels: ["desktop", "weixin"] },
  { id: "task-complete", mode: "write", description: "完成待办", channels: ["desktop", "weixin"] },
  { id: "task-delete", mode: "write", description: "删除待办", channels: ["desktop", "weixin"] },
  { id: "review-generate", mode: "write", description: "生成日、周、月或自定义日期复盘", channels: ["desktop", "weixin"] },
  { id: "summary-generate", mode: "write", description: "汇总指定周期事实", channels: ["desktop", "weixin"] },
  { id: "link-save", mode: "write", description: "读取链接正文并收藏到指定知识分类", channels: ["desktop", "weixin"] },
  { id: "knowledge-save", mode: "write", description: "把文本保存到知识库", channels: ["desktop", "weixin"] },
  { id: "reminder-add", mode: "write", description: "创建主动提醒", channels: ["desktop", "weixin"] },
  { id: "reminder-list", mode: "read", description: "查看提醒", channels: ["desktop", "weixin"] },
  { id: "reminder-cancel", mode: "write", description: "取消提醒", channels: ["desktop", "weixin"] },
  { id: "skill-select", mode: "reason", description: "按人物、昵称或方法语义选择已安装 Skill", channels: ["desktop", "weixin"] },
  { id: "vision", mode: "reason", description: "理解当前或会话中最近保存的图片", channels: ["desktop", "weixin"] }
];

export function lifeOSAgentToolsForChannel(channel: "desktop" | "weixin"): readonly LifeOSAgentToolDescriptor[] {
  return LIFEOS_AGENT_TOOL_REGISTRY.filter((tool) => tool.channels.includes(channel));
}
