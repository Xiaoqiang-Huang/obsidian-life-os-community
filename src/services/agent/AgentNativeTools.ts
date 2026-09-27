import type { LifeOSAgentToolDescriptor } from "../LifeOSAgentToolRegistry";
export interface AgentNativeTool { name: string; description: string; parameters: Record<string, unknown>; }
export interface AgentNativeCall { id: string; name: string; input: Record<string, unknown>; }
export function nativeToolSchemas(tools: LifeOSAgentToolDescriptor[]): AgentNativeTool[] {
  return tools.map(tool => ({ name: tool.id, description: tool.description, parameters: {
    type: "object",
    properties: Object.fromEntries(Object.entries(tool.input || {}).map(([key, spec]) => [key, {
      type: spec.type, description: spec.description, ...(spec.type === "array" ? { items: {} } : {})
    }])),
    required: Object.entries(tool.input || {}).filter(([, spec]) => spec.required).map(([key]) => key),
    additionalProperties: false
  } }));
}
export function extractNativeCalls(payload: unknown): AgentNativeCall[] {
  const data = payload as any;
  const openai = data?.choices?.[0]?.message?.tool_calls;
  const anthropic = Array.isArray(data?.content) ? data.content.filter((item: any) => item?.type === "tool_use") : [];
  const raw = Array.isArray(openai) ? openai : anthropic;
  return raw.slice(0, 12).map((item: any, index: number) => {
    const name = item?.function?.name ?? item?.name;
    const args = item?.function ? JSON.parse(item.function.arguments || "{}") : item?.input;
    if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid native tool arguments");
    return { id: String(item.id || `native-${index + 1}`).slice(0, 80), name, input: args };
  });
}
export function unsupportedNativeTools(error: string): boolean {
  return /(?:tools?|function_call|tool_choice)/i.test(error) && /(?:unsupported|not supported|unknown|unrecognized|unexpected|不支持|未知)/i.test(error);
}
