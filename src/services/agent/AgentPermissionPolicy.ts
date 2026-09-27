/** One automatic-write decision for all adapters. Explicit confirmation is separate. */
export function mayAutoApplyAgentWrite(input: {
  mode: "read-only" | "confirm" | "explicit-auto";
  explicitIntent: boolean;
  forceConfirmation?: boolean;
  trustedPrivate?: boolean;
}): boolean {
  return input.mode === "explicit-auto" && input.explicitIntent
    && !input.forceConfirmation && input.trustedPrivate !== false;
}
