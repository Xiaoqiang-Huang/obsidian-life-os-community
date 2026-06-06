import type { LicenseSku } from "./license-types";

export interface LicenseEntitlementTokenPayload {
  iss: "lifeos-license-worker";
  aud: string;
  licenseId: string;
  activationId: string;
  installationId: string;
  sku: LicenseSku;
  tier: "trial" | "pro";
  features: string[];
  discountClass: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number | null;
  tokenRefreshAfter: number;
  keyVersion: string;
  jti: string;
}

interface PublicKeyConfig {
  version: string;
  alg: "ES256";
  jwk: JsonWebKey;
}

const LICENSE_AUDIENCE = "personal-life-system";
const ENTITLEMENT_CLOCK_SKEW_LEEWAY_SECONDS = 300;
const LIFEOS_LICENSE_PUBLIC_KEYS: PublicKeyConfig[] = [
  {
    version: "2026-05",
    alg: "ES256",
    jwk: {
      key_ops: ["verify"],
      ext: true,
      kty: "EC",
      x: "VnP61h46eFvh3BtIqP24WUaCvbkc1SquHTtG22DP5XE",
      y: "EfC6JPksrPG7jx8XsY3_pnjmyUXtlWQz5IUWZgP_eIE",
      crv: "P-256"
    }
  }
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const verifiedPayloads = new Map<string, LicenseEntitlementTokenPayload>();

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function jsonFromBase64Url<T>(value: string): T {
  return JSON.parse(decoder.decode(base64UrlToBytes(value))) as T;
}

async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

export function decodeLicenseEntitlementPayload(token: string): LicenseEntitlementTokenPayload | null {
  const [, encodedPayload] = String(token || "").split(".");
  if (!encodedPayload) return null;
  try {
    return jsonFromBase64Url<LicenseEntitlementTokenPayload>(encodedPayload);
  } catch {
    return null;
  }
}

export function getVerifiedEntitlementPayload(token: string): LicenseEntitlementTokenPayload | null {
  return verifiedPayloads.get(token) ?? null;
}

export function __seedVerifiedEntitlementPayloadForTests(token: string, payload: LicenseEntitlementTokenPayload): void {
  const testEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (testEnv?.LIFEOS_TEST_MODE !== "1") {
    throw new Error("test-only entitlement seeding is disabled");
  }
  verifiedPayloads.set(token, payload);
}

export async function verifyLicenseEntitlementToken(
  token: string,
  installationId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<LicenseEntitlementTokenPayload> {
  const cached = verifiedPayloads.get(token);
  if (cached && cached.installationId === installationId) return cached;

  const [encodedHeader, encodedPayload, encodedSignature] = String(token || "").split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("invalid entitlement token format");
  }

  const header = jsonFromBase64Url<{ alg: string; kid?: string }>(encodedHeader);
  if (header.alg !== "ES256") {
    throw new Error("unsupported entitlement token algorithm");
  }

  const payload = jsonFromBase64Url<LicenseEntitlementTokenPayload>(encodedPayload);
  const key = LIFEOS_LICENSE_PUBLIC_KEYS.find((item) => item.version === header.kid || item.version === payload.keyVersion);
  if (!key) {
    throw new Error("unknown entitlement key version");
  }

  const publicKey = await importPublicKey(key.jwk);
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    toArrayBuffer(base64UrlToBytes(encodedSignature)),
    encoder.encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!verified) {
    throw new Error("invalid entitlement token signature");
  }
  if (payload.iss !== "lifeos-license-worker") {
    throw new Error("entitlement issuer mismatch");
  }
  if (payload.aud !== LICENSE_AUDIENCE) {
    throw new Error("entitlement audience mismatch");
  }
  if (payload.installationId !== installationId) {
    throw new Error("entitlement installation mismatch");
  }
  if (payload.notBefore > nowSeconds + ENTITLEMENT_CLOCK_SKEW_LEEWAY_SECONDS) {
    throw new Error("entitlement token is not active yet");
  }
  if (payload.expiresAt !== null && payload.expiresAt <= nowSeconds) {
    throw new Error("entitlement token expired");
  }

  verifiedPayloads.set(token, payload);
  return payload;
}
