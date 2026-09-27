import type { DeviceSecretCodec } from './shared-device-identity';

/** Inject only an actual host-provided Electron safeStorage, never a renderer shim. */
export interface HostSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export function createHostDeviceSecretCodec(storage: HostSafeStorage, platform: string): DeviceSecretCodec {
  const available = () => {
    if (!storage.isEncryptionAvailable()) return false;
    // A plaintext fallback must not masquerade as protected storage on Linux.
    if (platform === 'linux') {
      const backend = storage.getSelectedStorageBackend?.();
      if (!backend || backend === 'basic_text' || backend === 'unknown') return false;
    }
    return true;
  };
  return {
    id: 'host-safe-storage-v1',
    isAvailable: available,
    async seal(value) {
      if (!available()) throw new Error('device_secure_storage_unavailable');
      return storage.encryptString(value).toString('base64');
    },
    async open(value) {
      if (!available()) throw new Error('device_secure_storage_unavailable');
      return storage.decryptString(Buffer.from(value, 'base64'));
    }
  };
}
