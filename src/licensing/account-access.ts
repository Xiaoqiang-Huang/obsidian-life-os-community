import type { AccountEntitlementPayload } from './account-entitlement';

export interface AccountModeSettings { licenseAccountSessionId?: string }
const verified = new WeakMap<object, AccountEntitlementPayload>();
/** Only the account runtime calls this after signature and local device verification. Never load a payload directly from settings. */
export function publishVerifiedAccountAccess(settings: object, payload: AccountEntitlementPayload | null): void {
  if (payload) verified.set(settings, structuredClone(payload));
  else verified.delete(settings);
}
/** undefined means never switched to account mode; false MUST NOT fall back to legacy. */
export function accountAccess(settings: AccountModeSettings, now = new Date()): boolean | undefined {
  if (!settings.licenseAccountSessionId) return undefined;
  const p = verified.get(settings);
  const seconds = Math.floor(now.getTime() / 1000);
  return Boolean(p && p.sessionId === settings.licenseAccountSessionId &&
    p.notBefore <= seconds && p.expiresAt > seconds && p.features.includes('lifeos.core'));
}
