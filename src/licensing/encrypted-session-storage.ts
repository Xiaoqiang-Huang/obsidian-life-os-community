import { promises as fs, constants } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { DeviceSecretCodec } from './shared-device-identity';
import type { AccountSessionState, AccountSessionStorage } from './account-refresh-client';

export interface EncryptedSessionStorageOptions {
  /** Stable, local OS-user directory shared by Vaults; not a synced/network directory. */
  directory: string;
  /** All Vault roots known to the caller. At least the current Vault is required. */
  vaultPaths: readonly string[];
  /** Trusted fingerprint from SharedDeviceIdentity, not from a server response. */
  deviceKeyId: string;
}

const MAX_RECORD_BYTES = 512 * 1024;
const MAX_TOKEN_CHARS = 64 * 1024;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const HASH = /^[a-f0-9]{64}$/;
const REVISION = /^\d{16}\.json$/;
const STAGING = /^\.stage-[a-f0-9-]{36}\.tmp$/;

type Head = { state: AccountSessionState; hash: string };

function fail(code = 'account_session_storage_corrupt'): never { throw new Error(code); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function secret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}
function validState(value: unknown): value is AccountSessionState {
  if (!record(value) || !keys(value, ['revision', 'sessionId', 'deviceId', 'licenseId', 'refreshToken', 'entitlementToken', 'blocked', 'pending', 'vaultOwner']) ||
      !revision(value.revision) || !secret(value.refreshToken)) return false;
  for (const field of ['sessionId', 'deviceId', 'licenseId']) {
    if (typeof value[field] !== 'string' || !ID.test(value[field] as string)) return false;
  }
  if (value.blocked !== undefined && typeof value.blocked !== 'boolean') return false;
  if (value.vaultOwner !== undefined && (typeof value.vaultOwner !== 'string' || !HASH.test(value.vaultOwner))) return false;
  if (value.entitlementToken !== undefined && (typeof value.entitlementToken !== 'string' ||
      value.entitlementToken.length > MAX_TOKEN_CHARS || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.entitlementToken))) return false;
  if (value.pending !== undefined) {
    const p = value.pending;
    if (!record(p) || !keys(p, ['operationId', 'nextSecret']) ||
        typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{20,80}$/.test(p.operationId) ||
        !secret(p.nextSecret) || p.nextSecret === value.refreshToken) return false;
  }
  return true;
}
function snapshot(value: AccountSessionState): AccountSessionState {
  try {
    if (!validState(value)) fail();
    const copy: unknown = JSON.parse(JSON.stringify(value));
    if (!validState(copy)) fail();
    return copy;
  } catch { fail('account_session_storage_invalid_state'); }
}
function sameIdentity(left: AccountSessionState, right: AccountSessionState): boolean {
  return left.sessionId === right.sessionId && left.deviceId === right.deviceId && left.licenseId === right.licenseId && left.vaultOwner === right.vaultOwner;
}
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function name(rev: number): string { return `${String(rev).padStart(16, '0')}.json`; }
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

/** Append-only encrypted revisions, published with atomic no-replace hard links.
 * No timeout locks, overwrite/rename fallback, mutable head file, or plaintext fallback.
 * A crash before publication leaves an ignored encrypted stage; after publication load
 * recovers the complete revision (including pending). Never prune this chain in place.
 * This detects corrupt records/gaps/substitution, NOT deletion of a complete history
 * suffix or restoration of an entire older filesystem snapshot by a local attacker.
 * File contents are fsynced before publication; Windows lacks portable directory fsync,
 * so process-crash recovery is supported but sudden power-loss durability is not promised.
 */
export class EncryptedSessionStorage implements AccountSessionStorage {
  private readonly directory: string;
  private readonly vaultPaths: readonly string[];
  private readonly deviceKeyId: string;

  constructor(options: EncryptedSessionStorageOptions, private readonly codec: DeviceSecretCodec) {
    if (!options || typeof options.directory !== 'string' || !isAbsolute(options.directory) ||
        options.directory.startsWith('\\\\')) fail('account_session_storage_absolute_local_path_required');
    if (!Array.isArray(options.vaultPaths) || options.vaultPaths.length === 0 ||
        options.vaultPaths.some(path => typeof path !== 'string' || !isAbsolute(path)))
      fail('account_session_storage_vault_paths_required');
    if (typeof options.deviceKeyId !== 'string' || !HASH.test(options.deviceKeyId))
      fail('account_session_storage_identity_invalid');
    if (!codec || typeof codec.id !== 'string' || !codec.id || codec.id.length > 128)
      fail('account_session_storage_codec_invalid');
    this.directory = resolve(options.directory);
    this.vaultPaths = options.vaultPaths.map(path => resolve(path));
    this.deviceKeyId = options.deviceKeyId;
    this.outsideVault(this.directory, this.vaultPaths);
  }

  private available(): void {
    try { if (this.codec.isAvailable() === true) return; } catch { /* Never expose codec exceptions. */ }
    fail('account_session_storage_unavailable');
  }

  private outsideVault(path: string, vaults: readonly string[]): void {
    if (vaults.some(vault => inside(path, vault))) fail('account_session_storage_inside_vault');
  }

  /** Resolve existing ancestors before mkdir, so a junction into a Vault is rejected before writing. */
  private async projectedRealPath(path: string): Promise<string> {
    const tail: string[] = [];
    let parent = path;
    for (;;) {
      try { return resolve(await fs.realpath(parent), ...tail); }
      catch (error) {
        if (errorCode(error) !== 'ENOENT' || dirname(parent) === parent) throw error;
        // A dangling link is not a safe missing directory.
        try { if ((await fs.lstat(parent)).isSymbolicLink()) fail(); }
        catch (statError) { if (errorCode(statError) !== 'ENOENT') throw statError; }
        tail.unshift(basename(parent));
        parent = dirname(parent);
      }
    }
  }

  private async sessionDirectory(sessionId: string, create: boolean): Promise<string> {
    if (typeof sessionId !== 'string' || !ID.test(sessionId)) fail('account_session_storage_identity_invalid');
    this.available();
    try {
      const vaults = await Promise.all(this.vaultPaths.map(path => this.projectedRealPath(path)));
      const root = await this.projectedRealPath(this.directory);
      const path = join(root, `session-${digest('lifeos-account-session-v1\0' + sessionId)}`);
      this.outsideVault(root, vaults);
      this.outsideVault(path, vaults);
      if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
      if (!(await fs.lstat(root)).isDirectory()) fail();
      if (create) {
        try { await fs.mkdir(path, { mode: 0o700 }); }
        catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
      }
      const stat = await fs.lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
      this.outsideVault(await fs.realpath(path), vaults);
      return path;
    } catch (error) {
      if (error instanceof Error && error.message === 'account_session_storage_inside_vault') throw error;
      if (!create && errorCode(error) === 'ENOENT') fail('account_session_storage_not_found');
      fail();
    }
  }

  private async readRecord(path: string): Promise<string> {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) fail();
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) fail();
      const data = await handle.readFile('utf8');
      if (Buffer.byteLength(data, 'utf8') !== stat.size) fail();
      return data;
    } finally { await handle.close(); }
  }

  private async head(path: string, sessionId: string, allowEmpty = false): Promise<Head | null> {
    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (STAGING.test(entry.name) && entry.isFile()) continue;
        if (!REVISION.test(entry.name) || !entry.isFile()) fail();
        files.push(entry.name);
      }
      files.sort();
      if (!files.length) { if (allowEmpty) return null; fail(); }
      let previous: Head | null = null;
      for (let index = 0; index < files.length; index++) {
        if (files[index] !== name(index)) fail(); // No gaps, alternate names or revision jumps.
        const raw = await this.readRecord(join(path, files[index]));
        const envelope: unknown = JSON.parse(raw);
        if (!record(envelope) || !keys(envelope, ['version', 'codec', 'ciphertext']) || envelope.version !== 1 ||
            envelope.codec !== this.codec.id || typeof envelope.ciphertext !== 'string' || !envelope.ciphertext) fail();
        this.available();
        const decrypted = await this.codec.open(envelope.ciphertext);
        if (typeof decrypted !== 'string' || Buffer.byteLength(decrypted, 'utf8') > MAX_RECORD_BYTES) fail();
        const data: unknown = JSON.parse(decrypted);
        if (!record(data) || !keys(data, ['version', 'deviceKeyId', 'sessionId', 'revision', 'previousHash', 'state']) ||
            data.version !== 1 || data.deviceKeyId !== this.deviceKeyId || data.sessionId !== sessionId ||
            data.revision !== index || data.previousHash !== (previous?.hash ?? null) || !validState(data.state) ||
            data.state.sessionId !== sessionId || data.state.revision !== index) fail();
        if (previous && (!sameIdentity(previous.state, data.state) || (previous.state.blocked && !data.state.blocked))) fail();
        previous = { state: data.state, hash: digest(raw) };
      }
      return previous;
    } catch { fail(); }
  }

  private async syncDirectory(path: string): Promise<void> {
    try {
      const handle = await fs.open(path, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(errorCode(error) ?? '')) return;
      throw error;
    }
  }

  private async publish(path: string, state: AccountSessionState, previousHash: string | null): Promise<boolean> {
    const plaintext = JSON.stringify({ version: 1, deviceKeyId: this.deviceKeyId, sessionId: state.sessionId,
      revision: state.revision, previousHash, state });
    const temporary = join(path, `.stage-${randomUUID()}.tmp`);
    let staged = false;
    try {
      this.available();
      const ciphertext = await this.codec.seal(plaintext);
      if (typeof ciphertext !== 'string' || !ciphertext || ciphertext === plaintext ||
          ciphertext.includes(state.refreshToken) || (state.pending && ciphertext.includes(state.pending.nextSecret))) fail();
      this.available();
      if (await this.codec.open(ciphertext) !== plaintext) fail();
      const raw = JSON.stringify({ version: 1, codec: this.codec.id, ciphertext });
      if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) fail();
      const handle = await fs.open(temporary, 'wx', 0o600);
      staged = true;
      try { await handle.writeFile(raw, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      try { await fs.link(temporary, join(path, name(state.revision))); }
      catch (error) { if (errorCode(error) === 'EEXIST') return false; throw error; }
      await this.syncDirectory(path);
      await this.syncDirectory(dirname(path));
      return true;
    } catch { throw new Error('account_session_storage_write_failed'); }
    finally {
      if (staged) {
        try { await fs.unlink(temporary); }
        catch { fail('account_session_storage_write_failed'); }
      }
    }
  }

  /** Creates revision zero once. Existing state (including pending/blocked) is never reset.
   * Returns false for an already-initialized matching identity; caller must load it.
   */
  async initialize(initial: AccountSessionState): Promise<boolean> {
    const state = snapshot(initial);
    if (state.revision !== 0) fail('account_session_storage_invalid_revision');
    const path = await this.sessionDirectory(state.sessionId, true);
    const existing = await this.head(path, state.sessionId, true);
    if (existing) {
      if (!sameIdentity(existing.state, state)) fail('account_session_storage_identity_mismatch');
      return false;
    }
    if (await this.publish(path, state, null)) return true;
    const winner = await this.head(path, state.sessionId);
    if (!winner || !sameIdentity(winner.state, state)) fail('account_session_storage_identity_mismatch');
    return false;
  }

  async load(sessionId: string): Promise<AccountSessionState> {
    const path = await this.sessionDirectory(sessionId, false);
    const latest = await this.head(path, sessionId);
    if (!latest) fail();
    return latest.state;
  }

  async compareAndSwap(sessionId: string, expectedRevision: number, next: AccountSessionState): Promise<boolean> {
    const state = snapshot(next);
    if (!revision(expectedRevision) || expectedRevision >= Number.MAX_SAFE_INTEGER || state.revision !== expectedRevision + 1)
      fail('account_session_storage_invalid_revision');
    if (state.sessionId !== sessionId) fail('account_session_storage_identity_mismatch');
    const path = await this.sessionDirectory(sessionId, false);
    const current = await this.head(path, sessionId);
    if (!current) fail();
    if (!sameIdentity(current.state, state)) fail('account_session_storage_identity_mismatch');
    if (current.state.revision !== expectedRevision) return false;
    if (current.state.blocked && !state.blocked) fail('account_session_storage_invalid_state');
    if (await this.publish(path, state, current.hash)) return true;
    // EEXIST is a CAS loss only when the competing committed chain is valid.
    await this.head(path, sessionId);
    return false;
  }
}
