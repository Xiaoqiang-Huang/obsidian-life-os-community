import type { SdkLedgerEvent, SdkLedgerStore } from "./SdkUsageLedger";
import { sdkFault } from "./SdkUsageLedger";

/** Explicit host-owned file only. No discovery, mkdir, secrets or startup writes.
 * Exclusive sibling lock prevents two plugin instances from silently losing a
 * reservation. Stale locks/corrupt journals fail closed; never auto-delete them. */
export function createNodeSdkLedgerStore(filename: string, desktop: boolean): SdkLedgerStore {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const run = tail.then(fn); tail = run.catch(() => undefined); return run; };
  const open = async () => {
    if (!desktop) throw sdkFault("DESKTOP_ONLY");
    const path = await import("node:path"), fs = await import("node:fs/promises");
    if (!path.isAbsolute(filename) || /[\u0000-\u001f]/.test(filename)) throw sdkFault("LEDGER_PATH");
    const parent = path.dirname(filename);
    if (await fs.realpath(parent) !== parent) throw sdkFault("LEDGER_PATH");
    try { if ((await fs.lstat(filename)).isSymbolicLink()) throw sdkFault("LEDGER_PATH"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return fs;
  };
  const read = async (fs: Awaited<ReturnType<typeof open>>): Promise<SdkLedgerEvent[]> => {
    let raw: string;
    try { if ((await fs.stat(filename)).size > 16 * 1024 * 1024) throw sdkFault("LEDGER_FULL"); raw = await fs.readFile(filename, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    let rows: SdkLedgerEvent[];
    try { rows = raw.split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { throw sdkFault("LEDGER_CORRUPT"); }
    if (rows.length > 50000 || rows.some(e => !e || typeof e.operation !== "string" || !["start", "dispatch", "finish"].includes(e.kind))) throw sdkFault("LEDGER_CORRUPT");
    return rows;
  };
  return { load: () => serial(async () => read(await open())), append: event => serial(async () => {
    const fs = await open(); let lock;
    try { lock = await fs.open(filename + ".lock", "wx", 0o600); } catch { throw sdkFault("LEDGER_BUSY"); }
    try {
      const rows = await read(fs), own = rows.filter(e => e.operation === event.operation);
      if (rows.length >= 50000) throw sdkFault("LEDGER_FULL");
      if (event.kind === "start" ? own.length !== 0 : !own.some(e => e.kind === "start") || own.some(e => e.kind === "finish") || event.kind === "dispatch" && event.ordinal !== own.filter(e => e.kind === "dispatch").length + 1) throw sdkFault("LEDGER_STATE");
      const fd = await fs.open(filename, "a", 0o600);
      try { await fd.writeFile(JSON.stringify(event) + "\n"); await fd.sync(); } finally { await fd.close(); }
    } finally { await lock.close(); await fs.unlink(filename + ".lock"); }
  }) };
}

/** Plugin-owned state is created lazily at the first explicit AI operation.
 * Never touches data.json, settings, Vault notes or another plugin's directory. */
export function createPluginSdkLedgerStore(pluginDirectory: string, desktop: boolean): SdkLedgerStore {
  let pending: Promise<SdkLedgerStore> | undefined;
  const ready = () => pending ||= (async () => {
    if (!desktop) throw sdkFault("DESKTOP_ONLY");
    const path = await import("node:path"), fs = await import("node:fs/promises");
    if (!path.isAbsolute(pluginDirectory) || await fs.realpath(pluginDirectory) !== pluginDirectory) throw sdkFault("LEDGER_PATH");
    const folder = path.join(pluginDirectory, "sdk-state");
    await fs.mkdir(folder, { recursive: false }).catch(e => { if (e.code !== "EEXIST") throw e; });
    if (await fs.realpath(folder) !== folder || (await fs.lstat(folder)).isSymbolicLink()) throw sdkFault("LEDGER_PATH");
    return createNodeSdkLedgerStore(path.join(folder, "usage.jsonl"), desktop);
  })();
  return { load: async () => (await ready()).load(), append: async e => (await ready()).append(e) };
}
