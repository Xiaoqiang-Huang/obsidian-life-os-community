import { LIFEOS_AGENT_TOOL_REGISTRY } from "../LifeOSAgentToolRegistry";
import type { LifeOSAgentToolResult } from "./LifeOSAgentTypes";

export type AgentWritebackMode = "off" | "confirm" | "explicit-auto";

const WRITE_TOOL_IDS = new Set(
  LIFEOS_AGENT_TOOL_REGISTRY
    .filter((descriptor) => descriptor.mode === "write")
    .map((descriptor) => descriptor.id)
);

/**
 * The typed Agent and the legacy marker parser temporarily coexist. Once the
 * typed Agent has attempted a write, including a denied or pending write, the
 * legacy path must stand down or it can execute/confirm the same mutation a
 * second time.
 */
export function agentHandledWrite(toolResults: readonly LifeOSAgentToolResult[]): boolean {
  return toolResults.some((result) => WRITE_TOOL_IDS.has(result.toolId) || result.toolId.startsWith("custom-"));
}

export function shouldRunLegacyChatWriteback(
  mode: AgentWritebackMode,
  toolResults: readonly LifeOSAgentToolResult[]
): boolean {
  return mode !== "off" && !agentHandledWrite(toolResults);
}

/**
 * Shared natural-language guard for desktop write planning and runtime
 * permission decisions.  Keeping this in one place prevents a request from
 * opening the planner but then being downgraded to a confirmation (or the
 * reverse) because two UI/service regexes drifted apart.
 */
export function hasLifeOSWriteIntent(value: string): boolean {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (!text) return false;
  if (/(?:(?:隐藏|不显示|移除|去掉|收起|恢复显示|重新显示|显示).{0,16}(?:已完成|完成的).{0,12}(?:任务|待办)|(?:已完成|完成的).{0,12}(?:任务|待办).{0,16}(?:隐藏|不显示|移除|去掉|收起|恢复显示|重新显示|显示))/u.test(text)) {
    return true;
  }
  const mutation = "(?:写入|记入|保存|存入|收藏|归档|沉淀|放到|生成|新增|添加|创建|修改|更新|完成|删除|清空|清除|移除|取消)";
  const destination = "(?:今天的?日记|今日日记|日记|待办|任务|知识库|项目(?:文档|记录|交接)?|文档|记忆|复盘|周报|月报|提醒|Life\\s*OS)";
  const directActionAfterAssist = new RegExp(
    `(?:请|帮我|给我|替我|直接|现在|马上|立即|我要|需要你)(?:(?!(?:解释|说明|介绍|为什么|为何|如何|怎么|怎样)).){0,32}${mutation}`,
    "iu"
  );
  const explanatoryQuestion = new RegExp(
    `(?:^|[，。！？!?])(?:我想知道|我想了解|想知道|想了解|请)?\\s*(?:如何|怎么|怎样|为什么|为何|是否|能否|可不可以)|(?:介绍|说明|讲讲|解释).{0,48}(?:${mutation}|${destination})`,
    "iu"
  );
  if (explanatoryQuestion.test(text) && !directActionAfterAssist.test(text)) return false;

  const mutationFirst = new RegExp(`${mutation}.{0,32}${destination}`, "iu");
  const destinationFirst = new RegExp(`${destination}.{0,32}${mutation}`, "iu");
  if (mutationFirst.test(text) || destinationFirst.test(text)) return true;
  if (/(?:把|将).{1,100}(?:写入|记入|保存|存入|收藏|归档|生成|新增|添加|创建|修改|更新|完成|删除|清空|清除|移除|取消)/iu.test(text)) return true;
  if (/(?:提醒我|叫我|到时提醒|记得提醒|设个提醒|设置提醒)/u.test(text)) return true;
  if (/^(?:请|帮我|给我|替我)?\s*(?:记住|记下|记一下|以后记得)/u.test(text)) return true;
  if (/(?:收藏|保存|存下).{0,80}https?:\/\//iu.test(text)) return true;
  return false;
}
