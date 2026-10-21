/** Fixed corrective messages only; never echo provider bodies, prompts or credentials. */
const ACTIONS: Record<string, string> = {
  "analysis-entitlement-required": "当前 Pro 授权不包含项目全文分析，未继续模型请求或保存报告。已有 checkpoint 和观点索引仍可查看；恢复授权后核对原范围再继续。",
  "analysis-config-not-ready": "普通 AI 配置尚不可用。请核对当前服务商、Base URL、模型和凭据；本功能不需要另建 SDK 档案，不会自动切换服务商。",
  "analysis-start-stopped": "任务已暂停或执行范围发生变化，未继续派发新的模型请求。请读取当前 checkpoint 后决定是否明确继续。",
  "uncertain-consumption": "已停止继续调用：上次中断的模型用量尚未确认，不能视作零或自动重跑。可先查看或复制已有观点索引；核对服务商用量回执后再处理，不要通过反复点击绕过。",
  "analysis-sdk-identity-changed": "服务商、模型或配置版本已变化。切回原配置，或重新建立清单并审批当前版本；旧用量不会清零。",
  "approval-required": "尚未批准当前范围与额度。请核对清单及发送目标，勾选审批后记录当前版本，再明确开始。",
  "analysis-current-consent-required": "范围或版本已变化。请重新核对当前清单并审批，不能沿用旧确认。",
  "analysis-host-lock-busy-or-interrupted": "另一项分析仍在执行，或上次退出留下未确认的锁。请先等待当前请求停止；不要删除锁文件或反复启动模型。",
  "analysis-job-already-running": "这个任务已经在执行。请查看当前进度，或点击暂停，不需要再次启动。",
  "sdk-concurrency-limit": "当前已有 SDK 请求占用执行槽。请等待完成或停止后再试；本次没有排队自动调用。",
  "analysis-service-disposed": "插件已重载或退出。请重新打开全文分析窗口并读取原 checkpoint；不会自动发起模型调用。",
  "analysis-reading-cancelled": "读取已停止。请重新打开窗口，保留原 checkpoint 并核对范围后再继续。",
  "analysis-source-missing": "清单中的源文档已找不到。请检查是否移动或改名，再刷新清单并重新审批；不要重复导入掩盖问题。",
  "foreign-host-read-only": "这个 checkpoint 属于另一宿主，当前只能查看。请在原宿主恢复，不会自动迁移凭据或调用模型。",
  "analysis-desktop-only": "项目全文分析需要 Obsidian 桌面版：它依赖本机文件路径、宿主锁和内置 AI 运行时，移动端不启动本地进程也不创建运行时目录。请在桌面版 Obsidian 打开同一 Vault 使用；移动端其他非 AI 功能不受影响。",
  "analysis-persistence-capability-unavailable": "当前宿主缺少项目全文分析所需的本地存储与路径能力。请改用桌面版 Obsidian 打开同一 Vault；没有降级为只读内存任务，也不会迁移 checkpoint。",
  "job-cancelled": "任务已由用户取消，不能继续。可查看已有结果；再次分析需要建立并确认一个新任务。"
};
export function analysisErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const code = Object.prototype.hasOwnProperty.call(ACTIONS, raw) ? raw : "analysis-operation-failed";
  return `${ACTIONS[code] || "操作未完成。请查看当前状态并保留 checkpoint，核对配置、源文档及运行时后再试；未确认的模型用量不会清零。"}（${code}）`;
}
export function analysisStateGuidance(status: string, unknown: boolean, reason?: string): string {
  if (unknown) return ACTIONS["uncertain-consumption"];
  if (status === "cancelled") return ACTIONS["job-cancelled"];
  if (status === "completed") return "结构核验已完成；可查看完整观点索引，并在允许保存报告时明确保存。结构通过不代表任意文档的语义完整性已得到保证。";
  if (reason === "source-changed") return "源文档已变化。请刷新清单并重新审批；相容的已完成块与累计用量仍会保留。";
  if (status === "paused") return "任务已暂停，已确认结果与累计用量保留。重新打开或读取 checkpoint 不会调用模型；只有明确继续才处理剩余部分。";
  return "暂停会等待当前只读请求结束并保留核验结果；取消会停止后续调用。插件重载按中断处理，不等于用户取消。";
}
