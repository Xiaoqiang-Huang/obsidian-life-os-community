import type { CreateOrderResult, PaymentInfo, PaymentOrder } from "./license-client";

export interface StoredPendingOrderInput {
  orderId: string;
  orderSnapshot: string;
  paymentSnapshot: string;
  orderClaimToken?: string;
}

const RESUMABLE_ORDER_STATUSES = new Set(["created", "pending", "processing", "paid"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function paymentInfoFrom(value: unknown): PaymentInfo | null {
  if (!isRecord(value)) return null;
  return {
    providerOrderId: optionalString(value.providerOrderId),
    providerTradeNo: optionalString(value.providerTradeNo),
    payUrl: optionalString(value.payUrl),
    qrCodeUrl: optionalString(value.qrCodeUrl),
    qrCodeImageUrl: optionalString(value.qrCodeImageUrl)
  };
}

function paymentOrderFrom(value: unknown, expectedOrderId: string): PaymentOrder | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const outTradeNo = optionalString(value.outTradeNo);
  const status = optionalString(value.status);
  const amountCents = value.amountCents;
  if (
    !id ||
    id !== expectedOrderId ||
    !outTradeNo ||
    !status ||
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0
  ) {
    return null;
  }

  const priceYuan = typeof value.priceYuan === "number" && Number.isFinite(value.priceYuan)
    ? value.priceYuan
    : amountCents / 100;
  return {
    id,
    outTradeNo,
    sku: optionalString(value.sku) ?? "unknown",
    amountCents,
    priceYuan,
    currency: optionalString(value.currency) ?? "CNY",
    status,
    createdAt: optionalString(value.createdAt) ?? "",
    paidAt: optionalString(value.paidAt)
  };
}

export function parseStoredPendingOrder(input: StoredPendingOrderInput): CreateOrderResult | null {
  const orderId = input.orderId.trim();
  if (!orderId || !input.orderSnapshot.trim() || !input.paymentSnapshot.trim()) return null;

  try {
    const order = paymentOrderFrom(JSON.parse(input.orderSnapshot), orderId);
    const payment = paymentInfoFrom(JSON.parse(input.paymentSnapshot));
    if (!order || !payment) return null;
    const orderClaimToken = input.orderClaimToken?.trim();
    return {
      order,
      payment,
      orderClaimToken: orderClaimToken || undefined
    };
  } catch {
    return null;
  }
}

export function storedOrderClaimTokenFor(
  orderId: string,
  storedOrderId: string,
  storedOrderClaimToken: string
): string | undefined {
  if (!orderId.trim() || orderId.trim() !== storedOrderId.trim()) return undefined;
  return storedOrderClaimToken.trim() || undefined;
}

export function shouldResumeOrderPolling(status: string): boolean {
  return RESUMABLE_ORDER_STATUSES.has(status.trim().toLowerCase());
}
