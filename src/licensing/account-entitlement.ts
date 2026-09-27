/** Structurally identical to the legacy PublicKeyConfig, without a runtime import.
 * Keep this pure module byte-identical to the candidate licensing copy.
 */
export interface PublicKeyConfig {
  version: string;
  alg: 'ES256';
  jwk: JsonWebKey;
}

export const ACCOUNT_ENTITLEMENT_MAX_OFFLINE_SECONDS = 24 * 60 * 60;

/** Independent v2 format. It must never be accepted as a legacy installation token. */
export interface AccountEntitlementPayload {
  aud: 'personal-life-system/account-device';
  iss: 'lifeos-license-worker';
  version: 2;
  accountId: string;
  licenseId: string;
  deviceId: string;
  sessionId: string;
  deviceKeyId: string;
  features: string[];
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  refreshAfter: number;
  keyVersion: string;
  jti: string;
}

export interface VerifyAccountEntitlementOptions {
  deviceKeyId: string;
  sessionId?: string;
  /** Unix seconds, not milliseconds. Defaults to the current clock, without leeway. */
  now?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function seconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid account entitlement encoding');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  // Reject padding, whitespace and noncanonical trailing bits rather than aliases.
  if (encodeBase64Url(bytes) !== value) throw new Error('Invalid account entitlement encoding');
  return bytes;
}

function encodeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') throw new Error('Invalid account entitlement JSON');
  return encodeBase64Url(encoder.encode(json));
}

function decodeJson(segment: string): unknown {
  return JSON.parse(decoder.decode(decodeBase64Url(segment)));
}

function validatePayload(value: unknown): asserts value is AccountEntitlementPayload {
  if (!record(value) || value.version !== 2 || value.iss !== 'lifeos-license-worker' ||
      value.aud !== 'personal-life-system/account-device') {
    throw new Error('Invalid account entitlement type');
  }
  for (const field of ['accountId', 'licenseId', 'deviceId', 'sessionId', 'deviceKeyId', 'keyVersion', 'jti']) {
    if (!nonempty(value[field])) throw new Error(`Invalid account entitlement ${field}`);
  }
  if (!Array.isArray(value.features) || !value.features.every(nonempty) || !value.features.includes('lifeos.core')) {
    throw new Error('Invalid account entitlement features');
  }
  const { issuedAt, notBefore, expiresAt, refreshAfter } = value;
  if (!seconds(issuedAt) || !seconds(notBefore) || !seconds(expiresAt) || !seconds(refreshAfter) ||
      issuedAt > notBefore || notBefore >= expiresAt || issuedAt > refreshAfter || refreshAfter >= expiresAt ||
      expiresAt - issuedAt > ACCOUNT_ENTITLEMENT_MAX_OFFLINE_SECONDS) {
    throw new Error('Invalid account entitlement lifetime');
  }
}

function privateKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('Invalid account entitlement private key');
  }
  const binary = atob(value);
  if (btoa(binary) !== value) throw new Error('Invalid account entitlement private key');
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export async function signAccountEntitlement(
  payload: AccountEntitlementPayload,
  privateKeyBase64: string,
  keyVersion: string
): Promise<string> {
  // Serialize and validate a snapshot before the first await. Caller mutations
  // cannot replace validated claims during private-key import or signing.
  const encodedPayload = encodeJson(payload);
  const claims = decodeJson(encodedPayload);
  validatePayload(claims);
  if (!nonempty(keyVersion) || claims.keyVersion !== keyVersion) {
    throw new Error('Account entitlement key version mismatch');
  }
  const encodedHeader = encodeJson({ typ: 'JWT', alg: 'ES256', kid: keyVersion });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', privateKeyBytes(privateKeyBase64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  // Errors deliberately propagate: no unsigned token, legacy fallback or cached result.
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoder.encode(signingInput)
  ));
  if (signature.length !== 64) throw new Error('Invalid account entitlement signature length');
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

/** Offline verification only; online session/device revocation is the caller's responsibility.
 * keys MUST be caller-owned trusted configuration (e.g. built into the client),
 * never public keys received alongside a token or from a refresh response.
 * No token-provided key material or URL is used, and no keys are fetched here.
 */
export async function verifyAccountEntitlement(
  token: string,
  keys: readonly PublicKeyConfig[],
  options: VerifyAccountEntitlementOptions
): Promise<AccountEntitlementPayload> {
  if (typeof token !== 'string') throw new Error('Invalid account entitlement format');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) throw new Error('Invalid account entitlement format');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  // Only our fixed protected header is supported (no crit/b64/jwk/jku overrides).
  if (!record(header) || header.typ !== 'JWT' || header.alg !== 'ES256' || !nonempty(header.kid) ||
      Object.keys(header).some(key => !['typ', 'alg', 'kid'].includes(key))) {
    throw new Error('Invalid account entitlement header');
  }
  const payload = decodeJson(encodedPayload);
  validatePayload(payload);
  if (header.kid !== payload.keyVersion) throw new Error('Account entitlement key version mismatch');
  if (!Array.isArray(keys)) throw new Error('Invalid account entitlement public keys');
  const matchingKeys = keys.filter(key => record(key) && key.version === header.kid);
  if (matchingKeys.length !== 1) throw new Error('Unknown or ambiguous account entitlement key version');
  const config = matchingKeys[0];
  if (config.alg !== 'ES256' || !record(config.jwk) || config.jwk.kty !== 'EC' || config.jwk.crv !== 'P-256' ||
      (config.jwk.alg !== undefined && config.jwk.alg !== 'ES256')) {
    throw new Error('Invalid account entitlement public key');
  }
  const signature = decodeBase64Url(encodedSignature);
  if (signature.length !== 64) throw new Error('Invalid account entitlement signature length');
  const publicKey = await crypto.subtle.importKey(
    'jwk', config.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
  );
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature,
    encoder.encode(`${encodedHeader}.${encodedPayload}`))) {
    throw new Error('Invalid account entitlement signature');
  }
  const now = options?.now === undefined ? Math.floor(Date.now() / 1000) : options.now;
  if (!seconds(now)) throw new Error('Invalid account entitlement verification time');
  if (payload.issuedAt > now || payload.notBefore > now) throw new Error('Account entitlement is not active yet');
  if (payload.expiresAt <= now) throw new Error('Account entitlement expired');
  if (!nonempty(options?.deviceKeyId) || payload.deviceKeyId !== options.deviceKeyId) {
    throw new Error('Account entitlement device key mismatch');
  }
  if (options.sessionId !== undefined && (!nonempty(options.sessionId) || payload.sessionId !== options.sessionId)) {
    throw new Error('Account entitlement session mismatch');
  }
  return payload;
}
