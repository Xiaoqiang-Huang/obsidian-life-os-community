import { resolveBundledClaudeRuntime } from "./BundledClaudeRuntime";
import { resolveExternalClaudeRuntime } from "./ExternalClaudeRuntime";
import { PINNED_AGENT_SDK_VERSION } from "./ClaudeSdkRuntime";

export interface ResolvedClaudeRuntime {
  executablePath: string;
  nodePath: string;
  cliVersion: string;
  source: "bundled" | "external";
  sdkVersion: string;
}

const FALLBACK_CODES = new Set([
  "sdk-bundled-runtime-missing",
  "sdk-bundled-platform-unavailable",
  "sdk-plugin-directory-unavailable"
]);

/** Bundled runtime wins. Only a genuinely missing/inapplicable bundle falls
 * back to a user-installed Claude Code CLI; a corrupted bundle is never
 * silently replaced. */
export async function resolveClaudeRuntime(
  pluginDirectory: string,
  platform: string,
  arch: string,
  desktop: boolean
): Promise<ResolvedClaudeRuntime> {
  try {
    const bundled = await resolveBundledClaudeRuntime(pluginDirectory, platform, arch, desktop);
    return { ...bundled, nodePath: "", source: "bundled", sdkVersion: PINNED_AGENT_SDK_VERSION };
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error ?? "");
    if (!FALLBACK_CODES.has(code)) throw error;
    const external = await resolveExternalClaudeRuntime(platform, arch, desktop);
    return { ...external, source: "external", sdkVersion: PINNED_AGENT_SDK_VERSION };
  }
}
