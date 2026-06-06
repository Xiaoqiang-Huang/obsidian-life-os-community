import { requestUrl } from "obsidian";
import type {
  ActivationRecordSnapshot,
  LicenseRecordSnapshot,
  LicenseSku,
  LicenseStateSnapshot
} from "./license-types";

export type PayType = "alipay" | "wxpay";

export interface PaymentOrder {
  id: string;
  outTradeNo: string;
  sku: LicenseSku;
  amountCents: number;
  priceYuan: number;
  currency: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
}

export interface PaymentInfo {
  providerOrderId: string | null;
  providerTradeNo: string | null;
  payUrl: string | null;
  qrCodeUrl: string | null;
  qrCodeImageUrl: string | null;
}

export interface CreateOrderResult {
  order: PaymentOrder;
  payment: PaymentInfo;
  orderClaimToken?: string;
}

export interface PollOrderResult {
  order: PaymentOrder;
  licenseKey: string | null;
}

export interface ActivationResult {
  license: LicenseRecordSnapshot;
  activation: ActivationRecordSnapshot;
  entitlementToken: string;
  entitlement: LicenseStateSnapshot["entitlement"];
  activeActivationCount?: number;
}

export interface RedeemResult extends ActivationResult {
  licenseKey: string;
}

export interface TrialRequestResult {
  email: string;
  expiresAt: string;
  debugCode?: string;
}

export interface TrialVerifyResult extends ActivationResult {
  licenseKey?: string;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:portal|admin)$/i, "");
}

function requireBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!/^https?:\/\/.+/i.test(normalized)) {
    throw new Error("请先填写有效的授权服务地址。");
  }
  return normalized;
}

function getPlatform(): string {
  const navigatorPlatform = navigator.platform || "unknown";
  const userAgent = navigator.userAgent || "";
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ios/i.test(userAgent)) return "ios";
  if (/windows/i.test(userAgent) || /win/i.test(navigatorPlatform)) return "windows";
  if (/mac/i.test(userAgent) || /mac/i.test(navigatorPlatform)) return "macos";
  if (/linux/i.test(userAgent) || /linux/i.test(navigatorPlatform)) return "linux";
  return navigatorPlatform;
}

async function api<T>(baseUrl: string, path: string, options: {
  method?: string;
  body?: unknown;
} = {}): Promise<T> {
  const normalizedBaseUrl = requireBaseUrl(baseUrl);
  let response;
  try {
    response = await requestUrl({
      url: `${normalizedBaseUrl}${path}`,
      method: options.method ?? "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      throw: false
    });
  } catch {
    throw new Error(`授权服务连接失败，请检查授权服务地址是否已部署并可访问：${normalizedBaseUrl}`);
  }
  const payload = response.json as ApiEnvelope<T> | undefined;
  if (response.status < 200 || response.status >= 300 || !payload?.ok) {
    throw new Error(payload?.error?.message || `授权服务请求失败：HTTP ${response.status}`);
  }
  return payload.data as T;
}

export function getDeviceLabel(): string {
  return `Obsidian ${getPlatform()}`;
}

export class LicenseClient {
  constructor(private readonly baseUrl: string) {}

  createOrder(input: {
    sku: LicenseSku;
    email: string;
    installationId: string;
    payType?: PayType;
  }): Promise<CreateOrderResult> {
    return api<CreateOrderResult>(this.baseUrl, "/api/orders", {
      method: "POST",
      body: {
        sku: input.sku,
        email: input.email,
        installationId: input.installationId,
        payType: input.payType ?? "alipay"
      }
    });
  }

  pollOrder(orderId: string, orderClaimToken?: string): Promise<PollOrderResult> {
    return api<PollOrderResult>(this.baseUrl, `/api/orders/${encodeURIComponent(orderId)}`, {
      method: "POST",
      body: orderClaimToken ? { claimToken: orderClaimToken } : {}
    });
  }

  requestTrialCode(input: {
    email: string;
    installationId: string;
  }): Promise<TrialRequestResult> {
    return api<TrialRequestResult>(this.baseUrl, "/api/trial/request-code", {
      method: "POST",
      body: {
        email: input.email,
        installationId: input.installationId
      }
    });
  }

  verifyTrialCode(input: {
    email: string;
    code: string;
    installationId: string;
  }): Promise<TrialVerifyResult> {
    return api<TrialVerifyResult>(this.baseUrl, "/api/trial/verify-code", {
      method: "POST",
      body: {
        email: input.email,
        code: input.code,
        installationId: input.installationId,
        deviceLabel: getDeviceLabel(),
        platform: getPlatform(),
        obsidianVersion: this.getObsidianVersion()
      }
    });
  }

  activate(input: {
    licenseKey: string;
    installationId: string;
  }): Promise<ActivationResult> {
    return api<ActivationResult>(this.baseUrl, "/api/licenses/activate", {
      method: "POST",
      body: {
        licenseKey: input.licenseKey,
        installationId: input.installationId,
        deviceLabel: getDeviceLabel(),
        platform: getPlatform(),
        obsidianVersion: this.getObsidianVersion()
      }
    });
  }

  redeem(input: {
    code: string;
    email: string;
    installationId: string;
  }): Promise<RedeemResult> {
    return api<RedeemResult>(this.baseUrl, "/api/redeem", {
      method: "POST",
      body: {
        code: input.code,
        email: input.email,
        installationId: input.installationId,
        deviceLabel: getDeviceLabel(),
        platform: getPlatform(),
        obsidianVersion: this.getObsidianVersion()
      }
    });
  }

  private getObsidianVersion(): string | null {
    const appInfo = window as unknown as { app?: { appVersion?: string } };
    return appInfo.app?.appVersion ?? null;
  }
}
