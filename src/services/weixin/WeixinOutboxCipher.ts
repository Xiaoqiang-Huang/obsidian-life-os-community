import { Platform } from "obsidian";
import { createHostDeviceSecretCodec, type HostSafeStorage } from "../../licensing/device-secret-codec";
import type { OutboxCipher } from "./WeixinOutbox";

declare const require: NodeRequire;

/** Load only the host-provided Electron safeStorage. No renderer shim and no
 * plaintext fallback: an unavailable key makes the caller degrade, not leak. */
export function createHostOutboxCipher(): OutboxCipher | undefined {
  if (!Platform.isDesktopApp) return undefined;
  let storage: HostSafeStorage | undefined;
  try { storage = (require("electron") as { remote?: { safeStorage?: HostSafeStorage } }).remote?.safeStorage; } catch { /* older host */ }
  if (!storage) {
    try { storage = (require("@electron/remote") as { safeStorage?: HostSafeStorage }).safeStorage; } catch { /* not installed */ }
  }
  if (!storage) return undefined;
  try { return createHostDeviceSecretCodec(storage, process.platform); } catch { return undefined; }
}
