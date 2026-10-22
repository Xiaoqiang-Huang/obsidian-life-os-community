import { PINNED_AGENT_SDK_VERSION } from "./ClaudeSdkRuntime";

/** Read-only validation of the optional bundled runtime metadata.
 * This never writes, installs, downloads, or replaces plugin files. */
export async function resolveBundledClaudeRuntime(pluginDirectory: string, platform: string, arch: string, desktop: boolean): Promise<{ executablePath: string; cliVersion: string }> {
  if (!desktop) throw new Error("sdk-desktop-only");
  if (![["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"]].some(([p, a]) => p === platform && a === arch)) throw new Error("sdk-bundled-platform-unavailable");
  const path = await import("node:path"), fs = await import("node:fs/promises");
  if (!pluginDirectory || !path.isAbsolute(pluginDirectory)) throw new Error("sdk-plugin-directory-unavailable");
  let root: string;
  try { root = await fs.realpath(pluginDirectory); }
  catch { throw new Error("sdk-plugin-directory-unavailable"); }
  const folder = path.join(root, "runtime", "claude-agent", PINNED_AGENT_SDK_VERSION, `${platform}-${arch}`);
  const manifestPath = path.join(folder, "runtime.json");
  let manifest: { sdkVersion?: string; platform?: string; arch?: string; entry?: string; sha256?: string; cliVersion?: string };
  try {
    if (await fs.realpath(manifestPath) !== manifestPath || (await fs.stat(manifestPath)).size > 8192) throw Error();
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch { throw new Error("sdk-bundled-runtime-missing"); }
  const entry = platform === "win32" ? "claude.exe" : "claude";
  if (manifest.sdkVersion !== PINNED_AGENT_SDK_VERSION || manifest.platform !== platform || manifest.arch !== arch || manifest.entry !== entry || !/^[a-f0-9]{64}$/.test(manifest.sha256 || "") || !/^\d+\.\d+\.\d+$/.test(manifest.cliVersion || "")) throw new Error("sdk-bundled-manifest-invalid");
  const executablePath = path.join(folder, entry);
  try { if (await fs.realpath(executablePath) !== executablePath || !(await fs.stat(executablePath)).isFile()) throw Error(); }
  catch { throw new Error("sdk-bundled-runtime-missing"); }
  const crypto = await import("node:crypto"), streamFs = await import("node:fs");
  const hash = crypto.createHash("sha256");
  for await (const part of streamFs.createReadStream(executablePath)) hash.update(part);
  if (hash.digest("hex") !== manifest.sha256) throw new Error("sdk-bundled-integrity-failed");
  return { executablePath, cliVersion: manifest.cliVersion! };
}
