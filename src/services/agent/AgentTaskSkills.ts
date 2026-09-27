import type { AiSkill } from "../AiSkillService";
export const AGENT_TASK_SKILLS: AiSkill[] = [
 { id: "lifeos-task-weekly", name: "周报工作流", description: "按明确日期范围读取日志、核对来源并生成周报草稿", lens: "日期边界 / 来源 / 草稿", category: "system", source: "built-in", allowedWritebackKinds: [], systemPrompt: "先确认统计起止日期与是否包含周末，不能按文件修改时间拼出任意十几天。按日志日期筛选，分段读完纳入的日志，记录缺失日期。区分事实、推测、下周计划。遵循用户篇幅与重点；生成草稿，写入仍走统一权限与确认。未读完不能宣称完整周报。" },
 { id: "lifeos-task-answer", name: "答题工作流", description: "围绕当前题目直接解答或按用户要求逐级提示", lens: "当前选区 / 证据 / 推导", category: "learning-cognition", source: "built-in", allowedWritebackKinds: [], systemPrompt: "以本轮最新选区为题目，不把旧题答案带入新题。确认题干和选项完整，缺页先读对应页。直接解答模式先给答案再给必要推导；提示模式不提前揭晓。依据原文核对每个选项，信息不足明确说明，不编造答案来源。未要求时不创建任务或保存错题。" },
 { id: "lifeos-task-organize", name: "资料整理工作流", description: "先盘点原文件，再分段读取、分类和预览变更", lens: "原文件 / 完整性 / 可撤销", category: "system", source: "built-in", allowedWritebackKinds: [], systemPrompt: "先列出文件名和所属项目。只保存原件的 PDF 必须找到对应文件并逐页解析；空页标记需 OCR，不把文件名或目录当内容标签。网页使用正文快照而非搜索摘要。记录未读区间，提取少量稳定主题标签，提供改动预览，依照权限确认后执行；同一写入恢复时复用 operationId，勿重复追加。" }
];
export function taskSkillForQuery(query: string): string | undefined {
 if (/(?:周报|本周回顾|上周总结|一周.{0,6}复盘)/u.test(query)) return "lifeos-task-weekly";
 if (/(?:题干|选项|解题|答题|这道题|选择题)/u.test(query)) return "lifeos-task-answer";
 if (/(?:整理资料|资料整理|知识库归档|文档归类)/u.test(query)) return "lifeos-task-organize";
 return undefined;
}
