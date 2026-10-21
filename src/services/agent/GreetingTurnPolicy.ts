import type { ChatContextBundle } from "../ChatContextService";

/** Exact standalone salutations only: never consume an actual request or a reference. */
export function isStandaloneGreeting(content: string): boolean {
  return /^(?:你好|您好|嗨|哈喽|早上好|早安|下午好|晚上好|hi|hello|hey)[\s!！。.,，?？～~]*$/iu.test(content.trim());
}

export function useLightweightGreeting(input: {
  content: string; mode: string; contextMode: string; webSearchMode: string;
  attachmentCount: number; explicitReference?: boolean;
}): boolean {
  // Persistent UI modes are preferences, not an instruction to research a salutation.
  return (input.mode === "chat" || input.mode === "exam")
    && input.attachmentCount === 0 && !input.explicitReference && isStandaloneGreeting(input.content);
}

export function emptyGreetingContext(): ChatContextBundle {
  return { promptContext: "", sections: [], statusCards: [], contextSources: [], sources: [] };
}
