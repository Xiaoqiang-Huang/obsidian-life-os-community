import type { AiMessage } from "../../ai";
import type { LifeOSAgentToolExecutionContext, LifeOSAgentLoopBudget, LifeOSAgentEvent } from "../agent/LifeOSAgentTypes";
import type { AgentWorkingCheckpoint } from "../agent/AgentMemoryTypes";
import type { AgentToolRuntimeOptions } from "../agent/AgentToolRuntime";
export interface SdkChannelInput {
  messages: AiMessage[];
  toolContext: LifeOSAgentToolExecutionContext;
  taskMemory: string;
  workingCheckpoint?: AgentWorkingCheckpoint;
  hasLocalEvidence: boolean;
  hasWebEvidence: boolean;
  forcePlanner?: boolean;
  enableTools?: boolean;
  responseFormat?: "text" | "json";
  budget?: Partial<LifeOSAgentLoopBudget>;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "max";
  maxOutputTokens?: number;
  maxDurationMs?: number;
  temperature?: number;
  onEvent?: (event: LifeOSAgentEvent) => void | Promise<void>;
  toolOptions?: AgentToolRuntimeOptions;
}
