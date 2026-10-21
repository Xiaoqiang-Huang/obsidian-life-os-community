import type { LifeOSAgentLoopResult, LifeOSAgentToolCall, LifeOSAgentToolExecutionContext, LifeOSAgentToolResult } from "../../LifeOSAgentTypes";
import { SDK_TEXT_MODEL_TOOLS } from "./ClaudeToolBridge";

/** A model-cost workflow is executed only after run() releases the SDK slot.
 * No nested planner, automatic second synthesis, or native-provider fallback. */
export async function finishSdkDeferredWorkflow(result: LifeOSAgentLoopResult, context: LifeOSAgentToolExecutionContext,
  execute: (call: LifeOSAgentToolCall) => Promise<LifeOSAgentToolResult>, validIdentity: () => boolean,
  monetaryCap: number | null): Promise<LifeOSAgentLoopResult> {
  if (!result.ok || !result.deferredTool) return result;
  if (!SDK_TEXT_MODEL_TOOLS.has(result.deferredTool.name)) throw new Error("sdk-deferred-tool-not-authorized");
  if (context.signal?.aborted) throw new Error("sdk-cancelled");
  if (!validIdentity()) throw new Error("sdk-workflow-identity-changed");
  // The interrupted dispatcher has no authoritative pipeline invoice. Do not
  // spend a second monetary allowance as if the first query were free.
  if (monetaryCap !== null) throw new Error("sdk-deferred-cost-budget-unconfirmed");
  const before = context.requestBudget?.used || 0;
  const tool = await execute(result.deferredTool);
  const text = tool.needsConfirmation ? tool.confirmationSummary || "写入等待确认。" : tool.ok ? tool.output : tool.error || "文字工作流未执行成功。";
  const { deferredTool: _discard, ...rest } = result;
  return { ...rest, ok: tool.ok || tool.needsConfirmation === true, text,
    error: tool.ok || tool.needsConfirmation ? undefined : tool.error,
    response: { ok: tool.ok || tool.needsConfirmation === true, text, ...(tool.ok || tool.needsConfirmation ? {} : { error: tool.error }) },
    stopReason: tool.needsConfirmation ? "needs-user" : tool.ok ? "completed" : "tool-failure",
    toolResults: [...result.toolResults, tool], toolCalls: result.toolCalls + 1,
    modelCalls: result.modelCalls + Math.max(0, (context.requestBudget?.used || 0) - before),
    events: [...result.events, { id: `${context.turnId}:sdk-deferred-finished`, sessionId: context.sessionId, turnId: context.turnId,
      sequence: result.events.length + 1, timestamp: new Date().toISOString(), channel: context.channel,
      type: tool.needsConfirmation ? "tool-confirmation-required" : tool.ok ? "turn-completed" : "turn-stopped", summary: text.slice(0, 200),
      metadata: { backend: "claude-sdk", hostWorkflow: true, usageUncertain: true, sdkHttpRequests: "unknown" } }] };
}
