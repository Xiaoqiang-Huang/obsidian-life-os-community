const INSTALLATION_PREFIX = "lifeos";

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
}

export function createInstallationId(): string {
  const randomId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : randomHex(32);
  return `${INSTALLATION_PREFIX}_${randomId}`;
}

export function normalizeInstallationId(value: string | undefined | null): string {
  const trimmed = value?.trim() ?? "";
  return trimmed || createInstallationId();
}
