import type { ProtectedAnalysisIO } from "./store";
import { hashText, newId, safePath } from "./identity";
import { validJobId } from "./store";

// FIFO for short file operations only, shared by adapters in this process.
// In Windows an open checkpoint reader denies rename of that target. Unbounded
// overlapping observation must not starve a queued writer. OS locks still own CAS
// across processes; NEVER put withHostLock's callback here (it calls read/replace).
const shortIOTails = new Map<string, Promise<void>>();
async function serialShortIO<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = shortIOTails.get(key) || Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  shortIOTails.set(key, tail);
  await previous;
  try { return await operation(); }
  finally { release(); if (shortIOTails.get(key) === tail) shortIOTails.delete(key); }
}

/** Desktop-only atomic files and OS-wide exclusive locks. A crash leaves a lock:
 * fail closed; do NOT guess that an old lock is safe to steal or start paid work. */
export async function desktopAnalysisIO(base: string, folder: string, hostIdentity: string): Promise<ProtectedAnalysisIO> {
  const fs = await import("node:fs/promises"), path = await import("node:path");
  const root = await fs.realpath(base), relative = safePath(folder);
  const directory = path.resolve(root, relative);
  const queueKey = path.sep === "\\" ? directory.toLowerCase() : directory;
  const shortIO = <T>(operation: () => Promise<T>): Promise<T> => serialShortIO(queueKey, operation);
  const inside = (p: string): boolean => { const r = path.relative(root, p); return !r.startsWith("..") && !path.isAbsolute(r); };
  type Identity = { dev: number; ino: number; birthtimeMs: number };
  const same = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
  const parents: Array<{ path: string; identity: Identity }> = [{ path: root, identity: await fs.lstat(root) }];
  // Check EACH existing parent, not only the final resolved filename.
  let parent = root;
  for (const segment of relative.split("/")) {
    parent = path.join(parent, segment);
    try { await fs.mkdir(parent); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    if (!inside(await fs.realpath(parent))) throw new Error("analysis-workspace-symlink-outside-vault");
    const identity = await fs.lstat(parent);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("analysis-workspace-directory-required");
    parents.push({ path: parent, identity });
  }
  const assertParents = async (): Promise<void> => {
    for (const initial of parents) {
      let now; try { now = await fs.lstat(initial.path); } catch { throw new Error("analysis-workspace-identity-changed"); }
      if (!now.isDirectory() || now.isSymbolicLink() || !same(initial.identity, now)) throw new Error("analysis-workspace-identity-changed");
    }
  };
  const assertFile = async (p: string, handle: Awaited<ReturnType<typeof fs.open>>): Promise<void> => {
    await assertParents();
    const [opened, current] = await Promise.all([handle.stat(), fs.lstat(p)]);
    if (!current.isFile() || current.isSymbolicLink() || !same(opened, current)) throw new Error("analysis-open-file-identity-changed");
    await assertParents();
  };
  const resolve = (p: string): string => {
    const clean = safePath(p);
    if (!clean.startsWith(relative + "/")) throw new Error("analysis-workspace-path-required");
    const result = path.resolve(root, clean); if (!inside(result)) throw new Error("analysis-workspace-path-required"); return result;
  };
  return {
    hostIdentity,
    pathFor: (id, leaf) => { validJobId(id); return `${relative}/${id}-${leaf}`; },
    read: p => shortIO(async () => {
      await assertParents();
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try { const target = resolve(p); handle = await fs.open(target, "r"); await assertFile(target, handle);
        const text = await handle.readFile("utf8"); await assertParents(); return text; }
      catch (e) { await assertParents(); if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
      finally { await handle?.close(); }
    }),
    atomicReplace: (p, json) => shortIO(async () => {
      await assertParents();
      const target = resolve(p), temporary = path.join(directory, `${newId()}.tmp`);
      const handle = await fs.open(temporary, "wx");
      try {
        await assertFile(temporary, handle); await handle.writeFile(json, "utf8"); await handle.sync();
        let renamed = false;
        // Windows readers may temporarily deny replacement while holding the old
        // checkpoint. Retry only sharing/busy errors, rebinding directory/temp identity.
        for (let attempt = 0; attempt < 100; attempt++) {
          await assertFile(temporary, handle);
          try { await fs.rename(temporary, target); renamed = true; break; }
          catch (e) {
            await assertParents();
            if (!["EPERM", "EACCES", "EBUSY"].includes((e as NodeJS.ErrnoException).code || "")) throw e;
            await new Promise(r => setTimeout(r, 25));
          }
        }
        if (!renamed) throw new Error("analysis-atomic-replace-busy");
        await assertFile(target, handle);
      } catch (e) {
        // Never unlink a substituted parent's or somebody else's file during cleanup.
        try { await assertFile(temporary, handle); await fs.unlink(temporary); await assertParents(); } catch { /* retain uncertain artifact */ }
        await assertParents();
        throw e;
      } finally { await handle.close(); }
    }),
    withHostLock: async (key, operation) => {
      const lock = path.join(directory, `${await hashText(key)}.lock`);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        await assertParents();
        try { handle = await fs.open(lock, "wx"); await assertFile(lock, handle); break; }
        catch (e) { if (handle) { await handle.close(); handle = undefined; } await assertParents(); if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; await new Promise(r => setTimeout(r, 25)); }
      }
      if (!handle) throw new Error("analysis-host-lock-busy-or-interrupted");
      try { await assertFile(lock, handle); const result = await operation(); await assertFile(lock, handle); return result; }
      finally { try { await assertFile(lock, handle); await fs.unlink(lock); await assertParents(); } finally { await handle.close(); } }
    }
  };
}
