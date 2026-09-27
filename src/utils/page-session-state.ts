/** Bounded Vault-scoped, in-process UI state; never written or sent. Sensitive drafts have caller TTLs. */
const sessions = new WeakMap<object, Map<string, unknown>>();
import { restoreStableViewState } from "./stable-view-refresh";
export function savePageScroll(vault: object, root: string, page: string, container: HTMLElement): void {
  // Obsidian detaches the old leaf BEFORE onClose; detached geometry is zero.
  // Scroll events keep the last live position, never replace it with that zero.
  if (!container.isConnected || container.clientHeight === 0) return;
  savePageSession(vault, root, `${page}:scroll`, { top: container.scrollTop, left: container.scrollLeft });
}
export function restorePageScroll(vault: object, root: string, page: string, container: HTMLElement, isCurrent: () => boolean): void {
  const saved = readPageSession<{ top: number; left: number }>(vault, root, `${page}:scroll`);
  if (saved) restoreStableViewState(container, { fixed: [{ element: container, ...saved }], keyed: [] }, isCurrent);
}
export function savePageSession<T>(vault: object, root: string, page: string, state: T): void {
  let entries = sessions.get(vault);
  if (!entries) { entries = new Map(); sessions.set(vault, entries); }
  const key = `${root}\0${page}`;
  entries.delete(key); entries.set(key, structuredClone(state));
  while (entries.size > 32) entries.delete(entries.keys().next().value!);
}
export function readPageSession<T>(vault: object, root: string, page: string): T | undefined {
  const state = sessions.get(vault)?.get(`${root}\0${page}`);
  return state === undefined ? undefined : structuredClone(state) as T;
}
