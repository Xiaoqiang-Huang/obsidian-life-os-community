export type LifeOsPurchaseKind = "monthly" | "lifetime";

export interface PublicPaymentProduct {
  sku: string;
  name: string;
  amountCents: number;
  priceYuan?: number;
  tier: string;
  discountClass: string;
  licenseDurationPreset: string;
  maxActivations: number;
}

export interface PublicPaymentCatalog {
  products: PublicPaymentProduct[];
}

export interface LifeOsPurchaseProduct {
  kind: LifeOsPurchaseKind;
  sku: string;
  title: string;
  price: string;
  amountCents: number;
  description: string;
  maxDevices: string;
}

export interface LifeOsPurchaseCatalog {
  monthly: LifeOsPurchaseProduct | null;
  lifetime: LifeOsPurchaseProduct | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function purchaseKindForDuration(duration: unknown): LifeOsPurchaseKind | null {
  if (duration === "30d") return "monthly";
  if (duration === "lifetime") return "lifetime";
  return null;
}

function formatYuan(amountCents: number): string {
  const value = (amountCents / 100).toFixed(2).replace(/\.00$/u, "").replace(/(\.\d)0$/u, "$1");
  return `${value} 元`;
}

function normalizeProduct(value: unknown): LifeOsPurchaseProduct | null {
  if (!isRecord(value)) return null;
  const sku = typeof value.sku === "string" ? value.sku.trim() : "";
  if (!sku) return null;
  if (value.tier !== "pro" || value.discountClass !== "pro") return null;
  const kind = purchaseKindForDuration(value.licenseDurationPreset);
  if (!kind) return null;
  const amountCents = value.amountCents;
  const maxActivations = value.maxActivations;
  if (!Number.isInteger(amountCents) || Number(amountCents) <= 0) return null;
  if (!Number.isInteger(maxActivations) || Number(maxActivations) <= 0) return null;

  const amount = Number(amountCents);
  const devices = Number(maxActivations);
  return {
    kind,
    sku,
    title: kind === "monthly" ? "月付 Pro" : "买断 Pro",
    price: kind === "monthly"
      ? `${formatYuan(amount)} / 30 天`
      : `${formatYuan(amount)}一次买断`,
    amountCents: amount,
    description: kind === "monthly"
      ? `最多 ${devices} 台设备，适合先完整体验 Pro 工作流。`
      : "一次买断，长期使用全部 Pro 能力。",
    maxDevices: `设备数最多 ${devices} 台`
  };
}

export function resolveLifeOsPurchaseCatalog(products: readonly unknown[]): LifeOsPurchaseCatalog {
  const catalog: LifeOsPurchaseCatalog = { monthly: null, lifetime: null };
  for (const rawProduct of products) {
    const product = normalizeProduct(rawProduct);
    if (!product) continue;
    const current = catalog[product.kind];
    if (!current) {
      catalog[product.kind] = product;
    }
  }
  return catalog;
}

export function sameLifeOsPurchaseProduct(
  first: LifeOsPurchaseProduct | null,
  second: LifeOsPurchaseProduct | null
): boolean {
  if (!first || !second) return first === second;
  return first.kind === second.kind
    && first.sku === second.sku
    && first.amountCents === second.amountCents
    && first.maxDevices === second.maxDevices;
}
