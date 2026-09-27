import type { App } from "obsidian";
import { AgentSessionService } from "./AgentSessionService";
import { FileSystemService } from "./FileSystemService";
import { ensureFile, readFile } from "../utils/vault";

const services = new WeakMap<App, Map<string, AgentSessionService>>();
/** Shared locking/storage, separate active pointers per entry. No workspace navigation. */
export function agentEntrySessions(app: App, fs: FileSystemService): AgentSessionService {
  let byRoot = services.get(app);
  if (!byRoot) { byRoot = new Map(); services.set(app, byRoot); }
  const folder = fs.path("Chat", "Agent", "Sessions");
  let service = byRoot.get(folder);
  if (!service) {
    const path = async (scope: string) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
      return folder + "/" + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("") + ".json";
    };
    service = new AgentSessionService({
      read: async scope => readFile(app, await path(scope)),
      write: async (scope, content) => { const file = await ensureFile(app, await path(scope), ""); await app.vault.modify(file, content); }
    });
    byRoot.set(folder, service);
  }
  return service;
}
