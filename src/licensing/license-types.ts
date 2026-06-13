export type LicenseStatusLabel = "free" | "trial" | "monthly-pro" | "lifetime-pro";
export type LicenseSku =
  | "pro_monthly_990"
  | "pro_monthly_1990"
  | "pro_49"
  | "pro_299"
  | "sponsor_99"
  | "sponsor_199";

export const LIFEOS_CURRENT_MONTHLY_PRO_SKU: LicenseSku = "pro_monthly_1990";
export const LIFEOS_CURRENT_LIFETIME_PRO_SKU: LicenseSku = "pro_299";

export const LIFEOS_MONTHLY_PRO_SKUS: readonly LicenseSku[] = [
  "pro_monthly_990",
  LIFEOS_CURRENT_MONTHLY_PRO_SKU
];

export function isLifeOsMonthlyProSku(sku: LicenseSku): boolean {
  return LIFEOS_MONTHLY_PRO_SKUS.includes(sku);
}

export interface LicenseRecordSnapshot {
  id: string;
  sku: LicenseSku;
  tier: "trial" | "pro";
  features: string[];
  discountClass: string;
  maxActivations: number;
  status: string;
  expiresAt: string | null;
}

export interface ActivationRecordSnapshot {
  id: string;
  deviceLabel: string;
  platform: string | null;
  obsidianVersion: string | null;
  status: string;
  activatedAt: string;
  lastSeenAt: string | null;
}

export interface EntitlementSnapshot {
  licenseId: string;
  activationId: string;
  installationId: string;
  sku: LicenseSku;
  tier: "trial" | "pro";
  features: string[];
  expiresAt: number | null;
  tokenRefreshAfter: number;
}

export interface LicenseStateSnapshot {
  license: LicenseRecordSnapshot | null;
  activation: ActivationRecordSnapshot | null;
  entitlement: EntitlementSnapshot | null;
  activeActivationCount: number | null;
  updatedAt: string;
}
