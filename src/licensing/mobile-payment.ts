import type { PaymentInfo } from "./license-client";

export interface PaymentPresentation {
  directUrl: string;
  hasQrImage: boolean;
  hasQrOnly: boolean;
  samePhoneGuidance: string | null;
}

export function buildAccountCenterUrl(baseUrl: string): string {
  const normalized = baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:portal|admin)$/i, "");
  return `${normalized}/portal`;
}

export function getPaymentPresentation(payment: PaymentInfo): PaymentPresentation {
  const directUrl = payment.payUrl || payment.qrCodeUrl || "";
  const hasQrImage = Boolean(payment.qrCodeImageUrl);
  return {
    directUrl,
    hasQrImage,
    hasQrOnly: hasQrImage && !directUrl,
    samePhoneGuidance: hasQrImage && !directUrl
      ? "当前只有二维码支付。同一台手机上可能无法扫码自己的屏幕，请使用另一台设备扫码，或到账号中心/联系支持处理。"
      : null
  };
}

export function isDeviceQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /设备数|设备.*满|activation.*limit|max.*activation|too many activations|limit exceeded/i.test(message);
}

export function buildDeviceQuotaMessage(): string {
  return "设备数已满，请到账号中心查看已激活设备，或联系支持解绑旧设备/补发授权。";
}
