import type { AnalysisJob } from "./types";
import { clone, newId } from "./identity";

export interface AtomicAnalysisStorage {
  hostIdentity: string;
  /** Host-wide atomic CAS is mandatory. Never claim cross-device sync safety. */
  atomicity: "host" | "cross-process";
  read(jobId: string): Promise<AnalysisJob | null>;
  compareAndSwap(jobId: string, expectedRevision: number | null, next: AnalysisJob): Promise<boolean>;
}
export function validJobId(id: string): void { if (!/^[a-zA-Z0-9-]{1,80}$/u.test(id)) throw new Error("invalid-job-id"); }
export class AnalysisStore {
  constructor(readonly storage: AtomicAnalysisStorage, readonly clock: () => number = Date.now) {}
  async read(id: string): Promise<AnalysisJob> {
    validJobId(id); const job = await this.storage.read(id);
    if (!job || job.schemaVersion !== 1 || job.jobId !== id || !Number.isSafeInteger(job.stateRevision)) throw new Error("job-not-found-or-schema");
    return clone(job);
  }
  async create(job: AnalysisJob): Promise<void> {
    validJobId(job.jobId); if (!await this.storage.compareAndSwap(job.jobId, null, clone(job))) throw new Error("job-already-exists");
  }
  async update(id: string, change: (job: AnalysisJob) => void | Promise<void>): Promise<AnalysisJob> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const job = await this.read(id), expected = job.stateRevision;
      if (job.hostIdentity !== this.storage.hostIdentity) throw new Error("foreign-host-read-only");
      await change(job); job.stateRevision = expected + 1; job.updatedAt = this.clock();
      if (await this.storage.compareAndSwap(id, expected, job)) return clone(job);
    }
    throw new Error("checkpoint-cas-contention");
  }
  async acquire(id: string, owner: string, token: string, ttl: number): Promise<AnalysisJob> {
    if (!owner || !token || ttl < 30) throw new Error("invalid-lease");
    return this.update(id, job => {
      if (job.lease && job.lease.expiresAt > this.clock()) throw new Error("lease-busy");
      job.lease = { owner, token, expiresAt: this.clock() + ttl };
    });
  }
  assertLease(job: AnalysisJob, token: string): void {
    if (job.lease?.token !== token || job.lease.expiresAt <= this.clock()) throw new Error("lease-lost");
  }
  renew(id: string, token: string, ttl: number): Promise<AnalysisJob> {
    return this.update(id, job => { this.assertLease(job, token); job.lease!.expiresAt = this.clock() + ttl; });
  }
}
/** Test/embedded storage: CAS has no await between comparison and replacement. */
export class MemoryAnalysisStorage implements AtomicAnalysisStorage {
  readonly hostIdentity = newId();
  readonly atomicity = "host" as const;
  private readonly rows = new Map<string, AnalysisJob>();
  async read(id: string): Promise<AnalysisJob | null> { return clone(this.rows.get(id) || null); }
  async compareAndSwap(id: string, expected: number | null, next: AnalysisJob): Promise<boolean> {
    const old = this.rows.get(id); if ((old?.stateRevision ?? null) !== expected) return false;
    this.rows.set(id, clone(next)); return true;
  }
}
export interface ProtectedAnalysisIO {
  /** Stable opaque machine identity shared by its windows, never a credential. */
  hostIdentity: string;
  /** Host supplies paths from FileSystemService's protected Agent workspace. */
  pathFor(jobId: string, leaf: "state.json"): string;
  read(path: string): Promise<string | null>;
  atomicReplace(path: string, json: string): Promise<void>;
  /** This mutex MUST be shared by all windows using this host/storage. */
  withHostLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
}
export class ProtectedJsonAnalysisStorage implements AtomicAnalysisStorage {
  readonly atomicity = "host" as const;
  constructor(private readonly io: ProtectedAnalysisIO) {}
  get hostIdentity(): string { return this.io.hostIdentity; }
  async read(id: string): Promise<AnalysisJob | null> {
    validJobId(id); const text = await this.io.read(this.io.pathFor(id, "state.json"));
    return text === null ? null : JSON.parse(text) as AnalysisJob;
  }
  compareAndSwap(id: string, expected: number | null, next: AnalysisJob): Promise<boolean> {
    validJobId(id); const path = this.io.pathFor(id, "state.json");
    return this.io.withHostLock(path, async () => {
      const current = await this.read(id); if ((current?.stateRevision ?? null) !== expected) return false;
      await this.io.atomicReplace(path, JSON.stringify(next)); return true;
    });
  }
}
