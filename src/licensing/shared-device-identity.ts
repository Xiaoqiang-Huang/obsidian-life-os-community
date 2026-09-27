// Desktop-only, deliberately not wired into legacy authorization until host acceptance.
import { promises as fs } from 'fs';
import { join, isAbsolute } from 'path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'crypto';

export interface DeviceSecretCodec {
  readonly id: string;
  isAvailable(): boolean;
  seal(plaintext: string): Promise<string>;
  open(ciphertext: string): Promise<string>;
}

export interface SharedDeviceIdentity {
  readonly deviceKeyId: string;
  readonly publicKeyPem: string;
  signChallenge(message: string): Promise<string>;
}

interface StoredIdentity {
  version: 1;
  codec: string;
  privateKeyCiphertext: string;
  publicKeyPem: string;
  deviceKeyId: string;
}

function keyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** Callers must supply one stable, local OS-user directory, never a Vault path. */
export class SharedDeviceIdentityStore {
  readonly filePath: string;
  constructor(private readonly directory: string, private readonly codec: DeviceSecretCodec) {
    if (!isAbsolute(directory)) throw new Error('device_identity_directory_must_be_absolute');
    this.filePath = join(directory, 'device-identity-v1.json');
  }

  private async read(): Promise<SharedDeviceIdentity> {
    const raw = await fs.readFile(this.filePath, 'utf8');
    try {
      const record = JSON.parse(raw) as StoredIdentity;
      if (record.version !== 1 || record.codec !== this.codec.id ||
          typeof record.privateKeyCiphertext !== 'string' || !record.privateKeyCiphertext ||
          typeof record.publicKeyPem !== 'string' || typeof record.deviceKeyId !== 'string') {
        throw new Error('invalid_record');
      }
      const privateKey = createPrivateKey(await this.codec.open(record.privateKeyCiphertext));
      if (privateKey.asymmetricKeyType !== 'ec' ||
          privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('invalid_curve');
      const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
      if (publicKeyPem !== record.publicKeyPem || keyId(publicKeyPem) !== record.deviceKeyId) {
        throw new Error('key_mismatch');
      }
      return Object.freeze({
        deviceKeyId: record.deviceKeyId,
        publicKeyPem,
        async signChallenge(message: string): Promise<string> {
          if (!message || Buffer.byteLength(message, 'utf8') > 8192) throw new Error('invalid_challenge');
          return sign('sha256', Buffer.from(message, 'utf8'), {
            key: privateKey, dsaEncoding: 'ieee-p1363'
          }).toString('base64');
        }
      });
    } catch {
      // Never silently create a replacement key for an existing but unreadable identity.
      throw new Error('device_identity_recovery_required');
    }
  }

  async loadOrCreate(): Promise<SharedDeviceIdentity> {
    if (!this.codec.isAvailable()) throw new Error('device_secure_storage_unavailable');
    try { return await this.read(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const privateKeyCiphertext = await this.codec.seal(privateKeyPem);
    // Fail before committing if the platform codec cannot round-trip the secret.
    const recovered = createPrivateKey(await this.codec.open(privateKeyCiphertext));
    const proof = sign('sha256', Buffer.from('LifeOS-device-store-check'), recovered);
    if (!verify('sha256', Buffer.from('LifeOS-device-store-check'), pair.publicKey, proof)) {
      throw new Error('device_secure_storage_roundtrip_failed');
    }
    const record: StoredIdentity = {
      version: 1, codec: this.codec.id, privateKeyCiphertext, publicKeyPem,
      deviceKeyId: keyId(publicKeyPem)
    };
    const temp = join(this.directory, `.device-${randomUUID()}.tmp`);
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      // Atomic no-replace publication: all concurrent Vaults must read the same winner.
      // Unsupported hard links fail closed, rather than falling back to unsafe overwrite.
      try { await fs.link(temp, this.filePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await fs.unlink(temp); }
    return this.read();
  }
}
