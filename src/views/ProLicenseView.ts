import { ItemView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { PRO_LICENSE_VIEW_TYPE } from "../constants";
import { LicenseClient, type CreateOrderResult, type PaymentOrder, type ActivationResult, type RedeemResult } from "../licensing/license-client";
import { buildAccountCenterUrl, buildDeviceQuotaMessage, getPaymentPresentation, isDeviceQuotaError } from "../licensing/mobile-payment";
import {
  LIFEOS_CURRENT_LIFETIME_PRO_SKU,
  LIFEOS_CURRENT_MONTHLY_PRO_SKU,
  type LicenseSku,
  type LicenseStateSnapshot,
  type LicenseStatusLabel
} from "../licensing/license-types";
import { resolveLicenseStatus } from "../licensing/entitlement";
import { verifyLicenseEntitlementToken } from "../licensing/entitlement-token";
import type PersonalLifeSystemPlugin from "../main";
import { createLifeOSShell } from "../components/LifeOSComponent";
import { localizeLifeOsPathParts, normalizeDirectoryLanguage } from "../settings";
import { ensureFile } from "../utils";

const ORDER_POLL_INTERVAL_MS = 8000;
const ENTITLEMENT_CLOCK_SKEW_NOTICE =
  "授权已生成，但当前电脑时间和授权服务器时间不一致。请同步系统时间后再点激活；兑换码不要重复输入，可到账号中心复制授权码。";

const PRODUCT_COPY: Record<"monthly" | "lifetime", {
  sku: LicenseSku;
  title: string;
  price: string;
  description: string;
  maxDevices: string;
}> = {
  monthly: {
    sku: LIFEOS_CURRENT_MONTHLY_PRO_SKU,
    title: "月付 Pro",
    price: "19.9 元 / 30 天",
    description: "设备数最多 3 台，适合先完整体验 Pro 工作流。",
    maxDevices: "设备数最多 3 台"
  },
  lifetime: {
    sku: LIFEOS_CURRENT_LIFETIME_PRO_SKU,
    title: "买断 Pro",
    price: "299 元一次买断",
    description: "一次买断，长期使用全部 Pro 能力。",
    maxDevices: "设备数最多 5 台"
  }
};

type ActivationAttempt = "activated" | "device-quota" | "failed";
type ProInputOptions = {
  type?: string;
  inputmode?: string;
  autocomplete?: string;
  spellcheck?: boolean;
  autocapitalize?: string;
  autocorrect?: string;
};

function isEntitlementNotActiveError(error: unknown): boolean {
  return error instanceof Error && /entitlement token is not active yet/i.test(error.message);
}

export class ProLicenseView extends ItemView {
  private pendingOrder: CreateOrderResult | null = null;
  private pollTimer: number | null = null;
  private isPolling = false;
  private pollRequestInFlight = false;
  private copyFallbackText = "";
  private licenseIssueMessage = "";

  constructor(leaf: WorkspaceLeaf, private plugin: PersonalLifeSystemPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return PRO_LICENSE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Pro 授权中心";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.stopPolling();
  }

  private async render(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    const main = createLifeOSShell(container as HTMLElement, this.plugin, "pro");
    main.addClass("lifeos-pro-license-view");

    this.renderHero(main);
    this.renderStatus(main);
    this.renderRecoveryPanel(main);
    this.renderServerSettings(main);
    this.renderPurchase(main);
    this.renderRedeemAndActivate(main);
    this.renderDataAccess(main);
  }

  private get client(): LicenseClient {
    return new LicenseClient(this.plugin.settings.licenseApiBaseUrl);
  }

  private renderHero(parent: HTMLElement): void {
    const hero = parent.createDiv({ cls: "lifeos-pro-hero lifeos-card lifeos-card-primary" });
    const copy = hero.createDiv({ cls: "lifeos-pro-hero-copy" });
    copy.createDiv({ cls: "lifeos-kicker", text: "Life OS Pro" });
    copy.createEl("h1", { text: "Pro 授权中心" });
    copy.createEl("p", { text: "购买、兑换、激活和备份授权码都在这里完成。你的 Markdown 数据查看、导出和迁移入口不会被 Pro 锁住。" });
    const actions = hero.createDiv({ cls: "lifeos-pro-hero-actions" });
    this.button(actions, "打开账号中心", "external-link", () => { this.openExternalLinkOrNotify(this.accountCenterUrl(), "账号中心链接已显示在页面上，可以复制后在浏览器打开。"); }, true);
    this.button(actions, "复制安装 ID", "copy", () => void this.copyText(this.plugin.settings.licenseInstallationId, "安装 ID 已复制。"), true);
    this.button(actions, "保存授权码备份", "download", () => void this.exportLicenseSummary());
  }

  private renderStatus(parent: HTMLElement): void {
    const snapshot = this.plugin.settings.licenseSnapshot;
    const status = this.resolveStatus(snapshot);
    const grid = parent.createDiv({ cls: "lifeos-pro-status-grid" });
    this.stat(grid, "当前授权状态", this.statusText(status), "badge-check");
    this.stat(grid, "到期时间", this.expiryText(snapshot), "calendar-clock");
    this.stat(grid, "设备数", this.deviceText(snapshot), "monitor-smartphone");
    this.stat(grid, "当前设备安装 ID", this.shortId(this.plugin.settings.licenseInstallationId), "fingerprint");
  }

  private renderServerSettings(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "lifeos-pro-card lifeos-card" });
    this.cardTitle(card, "授权服务设置", "cloud");
    card.createEl("p", { text: "购买和激活需要连接授权服务。邮箱用于订单、兑换码绑定和授权找回。" });

    const form = card.createDiv({ cls: "lifeos-pro-form-grid" });
    const server = this.input(form, "授权服务地址", "https://license.lifeoskit.com", this.plugin.settings.licenseApiBaseUrl, {
      type: "url",
      inputmode: "url",
      autocomplete: "url",
      spellcheck: false
    });
    const email = this.input(form, "邮箱", "you@example.com", this.plugin.settings.licenseEmail, {
      type: "email",
      inputmode: "email",
      autocomplete: "email",
      spellcheck: false
    });
    const action = form.createDiv({ cls: "lifeos-pro-form-actions" });
    this.button(action, "保存", "save", async () => {
      this.plugin.settings.licenseApiBaseUrl = server.value.trim();
      this.plugin.settings.licenseEmail = email.value.trim();
      await this.plugin.saveSettings();
      new Notice("授权服务设置已保存。");
      await this.render();
    }, true);
    this.button(action, "复制账号中心链接", "copy", () => void this.copyText(this.accountCenterUrl(), "账号中心链接已复制。"));
  }

  private renderRecoveryPanel(parent: HTMLElement): void {
    const panel = parent.createDiv({ cls: "lifeos-pro-inline-panel lifeos-card lifeos-pro-recovery" });
    this.cardTitle(panel, "账号中心 / 授权找回", "shield-check");
    panel.createEl("p", { text: "账号中心用于查看订单、找回授权码、确认已激活设备。换设备或设备数已满时，优先从这里处理。" });
    if (this.licenseIssueMessage) {
      panel.createEl("p", { cls: "lifeos-pro-warning", text: this.licenseIssueMessage });
    }
    panel.createDiv({ cls: "lifeos-pro-selectable", text: this.accountCenterUrl() });
    const actions = panel.createDiv({ cls: "lifeos-pro-action-row" });
    this.button(actions, "打开账号中心", "external-link", () => { this.openExternalLinkOrNotify(this.accountCenterUrl(), "账号中心链接已显示在页面上，可以复制后在浏览器打开。"); }, true);
    this.button(actions, "复制账号中心链接", "copy", () => void this.copyText(this.accountCenterUrl(), "账号中心链接已复制。"));
    if (this.copyFallbackText) {
      const fallback = panel.createEl("textarea", { cls: "lifeos-pro-copy-fallback" });
      fallback.value = this.copyFallbackText;
      fallback.setAttr("readonly", "true");
    }
  }

  private renderPurchase(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "lifeos-pro-section" });
    this.sectionTitle(section, "购买 Pro", "qr-code");
    this.renderTrialCard(section);
    const grid = section.createDiv({ cls: "lifeos-pro-product-grid" });
    this.productCard(grid, PRODUCT_COPY.monthly);
    this.productCard(grid, PRODUCT_COPY.lifetime);

    const restoredOrder = this.pendingOrder ?? this.restorePendingOrderFromSettings();
    if (restoredOrder && !this.pendingOrder) {
      this.pendingOrder = restoredOrder;
    }

    if (this.pendingOrder) {
      this.renderPaymentPanel(section, this.pendingOrder);
      return;
    }

    if (this.plugin.settings.licenseLastOrderId) {
      const resume = section.createDiv({ cls: "lifeos-pro-inline-panel lifeos-card" });
      resume.createEl("p", { text: `最近订单：${this.plugin.settings.licenseLastOrderId}` });
      this.button(resume, "继续轮询订单", "refresh-cw", () => void this.pollExistingOrder(this.plugin.settings.licenseLastOrderId), true);
    }
  }

  private renderTrialCard(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "lifeos-pro-card lifeos-card lifeos-pro-trial-card" });
    this.cardTitle(card, "30 天试用", "sparkles");
    card.createEl("p", { text: "免费一次，30 天，最多 3 台设备。试用功能与 Pro 一致，适合先完整体验 AI 写回、知识库、记忆和复盘流程。" });
    const form = card.createDiv({ cls: "lifeos-pro-form-grid" });
    const email = this.input(form, "邮箱", "you@example.com", this.plugin.settings.licenseEmail, {
      type: "email",
      inputmode: "email",
      autocomplete: "email",
      spellcheck: false
    });
    const code = this.input(form, "验证码", "6 位数字", "", {
      type: "text",
      inputmode: "numeric",
      autocomplete: "one-time-code",
      spellcheck: false
    });
    const actions = card.createDiv({ cls: "lifeos-pro-action-row" });
    this.button(actions, "发送试用验证码", "mail", async () => {
      await this.requestTrialCode(email.value.trim());
    }, true);
    this.button(actions, "验证并激活试用", "badge-check", async () => {
      await this.verifyTrialCode(email.value.trim(), code.value.trim());
    }, true);
  }

  private renderRedeemAndActivate(parent: HTMLElement): void {
    const grid = parent.createDiv({ cls: "lifeos-pro-two-col" });
    const redeem = grid.createDiv({ cls: "lifeos-pro-card lifeos-card" });
    this.cardTitle(redeem, "兑换码", "ticket");
    redeem.createEl("p", { text: "早期用户输入 15 / 30 / 90 天游离码，绑定邮箱和当前安装 ID。" });
    const redeemEmail = this.input(redeem, "绑定邮箱", "you@example.com", this.plugin.settings.licenseEmail, {
      type: "email",
      inputmode: "email",
      autocomplete: "email",
      spellcheck: false
    });
    const redeemCode = this.input(redeem, "兑换码", "EARLY-XXXX-XXXX", "", {
      type: "text",
      inputmode: "text",
      autocomplete: "off",
      spellcheck: false,
      autocapitalize: "characters",
      autocorrect: "off"
    });
    const redeemActions = redeem.createDiv({ cls: "lifeos-pro-card-actions" });
    this.button(redeemActions, "兑换并激活", "ticket-check", async () => {
      this.plugin.settings.licenseEmail = redeemEmail.value.trim();
      await this.redeem(redeemCode.value.trim(), redeemEmail.value.trim());
    }, true);

    const activate = grid.createDiv({ cls: "lifeos-pro-card lifeos-card" });
    this.cardTitle(activate, "激活码 / 授权码", "key-round");
    activate.createEl("p", { text: "已购买用户可手动粘贴授权码，在当前设备激活。" });
    const licenseKey = this.input(activate, "授权码", "LOS-XXXX-XXXX-XXXX", this.plugin.settings.licenseKey, {
      type: "text",
      inputmode: "text",
      autocomplete: "off",
      spellcheck: false,
      autocapitalize: "characters",
      autocorrect: "off"
    });
    const activateActions = activate.createDiv({ cls: "lifeos-pro-card-actions" });
    this.button(activateActions, "激活当前设备", "check-circle-2", async () => {
      await this.activateLicense(licenseKey.value.trim());
    }, true);
  }

  private renderDataAccess(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "lifeos-pro-card lifeos-card" });
    this.cardTitle(card, "数据查看 / 导出 / 迁移", "archive");
    card.createEl("p", { text: "这些入口始终保留。即使没有 Pro，Life OS 也不会锁死你的本地 Markdown 数据。" });
    const actions = card.createDiv({ cls: "lifeos-pro-action-row" });
    this.button(actions, "打开数据说明", "folder-open", () => void this.openDataReadme(), true);
    this.button(actions, "导出授权备份", "download", () => void this.exportLicenseSummary());
    this.button(actions, "生成迁移说明", "move-right", () => void this.openMigrationGuide());

    const backup = card.createDiv({ cls: "lifeos-pro-backup" });
    backup.createDiv({ cls: "lifeos-pro-backup-label", text: "授权码备份" });
    backup.createEl("code", { text: this.plugin.settings.licenseKey || "尚未保存授权码" });
  }

  private productCard(parent: HTMLElement, product: typeof PRODUCT_COPY[keyof typeof PRODUCT_COPY]): void {
    const card = parent.createDiv({ cls: "lifeos-pro-product lifeos-card" });
    card.createDiv({ cls: "lifeos-pro-product-title", text: product.title });
    card.createDiv({ cls: "lifeos-pro-product-price", text: product.price });
    card.createEl("p", { text: product.description });
    card.createDiv({ cls: "lifeos-pro-product-meta", text: product.maxDevices });
    this.button(card, "选择支付宝支付", "qr-code", () => void this.createOrder(product.sku), true);
  }

  private renderPaymentPanel(parent: HTMLElement, result: CreateOrderResult): void {
    const panel = parent.createDiv({ cls: "lifeos-pro-payment lifeos-card" });
    this.cardTitle(panel, "支付宝支付", "scan-line");
    panel.createEl("p", { text: `订单 ${result.order.outTradeNo}，状态：${this.orderStatusText(result.order)}` });
    const body = panel.createDiv({ cls: "lifeos-pro-payment-body" });
    const qr = body.createDiv({ cls: "lifeos-pro-qr" });
    const paymentInfo = getPaymentPresentation(result.payment);
    if (result.payment.qrCodeImageUrl) {
      qr.createEl("img", { attr: { src: result.payment.qrCodeImageUrl, alt: "支付宝二维码" } });
      if (paymentInfo.samePhoneGuidance) {
        qr.createEl("p", { cls: "lifeos-pro-warning", text: paymentInfo.samePhoneGuidance });
      }
    } else if (paymentInfo.directUrl) {
      this.paymentLink(qr, paymentInfo.directUrl);
    } else {
      qr.createEl("p", { text: "支付二维码暂不可用，请稍后刷新订单。" });
    }
    if (paymentInfo.directUrl) {
      const direct = body.createDiv({ cls: "lifeos-pro-payment-link" });
      direct.createEl("p", { text: Platform.isMobileApp ? "手机端建议直接打开网页支付，支付完成后回到 Obsidian 等待自动激活。" : "如果浏览器没有自动打开，可以手动打开网页支付。" });
      this.paymentLink(direct, paymentInfo.directUrl);
      direct.createDiv({ cls: "lifeos-pro-selectable", text: paymentInfo.directUrl });
    }
    const actions = body.createDiv({ cls: "lifeos-pro-payment-actions" });
    this.button(actions, this.isPolling ? "正在轮询..." : "轮询订单", "refresh-cw", () => void this.pollExistingOrder(result.order.id), true);
    this.button(actions, "复制订单号", "copy", () => void this.copyText(result.order.outTradeNo, "订单号已复制。"));
    if (paymentInfo.directUrl) {
      this.button(actions, "复制支付链接", "copy", () => void this.copyText(paymentInfo.directUrl, "支付链接已复制。"));
      this.button(actions, "打开网页支付", "external-link", () => { this.openExternalLinkOrNotify(paymentInfo.directUrl, "浏览器阻止了打开支付页，支付链接已显示在页面上。"); }, true);
    }
  }

  private async createOrder(sku: LicenseSku): Promise<void> {
    const email = this.plugin.settings.licenseEmail.trim();
    if (!email.includes("@")) {
      new Notice("请先填写有效邮箱。");
      return;
    }
    try {
      const result = await this.client.createOrder({
        sku,
        email,
        installationId: this.plugin.settings.licenseInstallationId,
        payType: "alipay"
      });
      this.pendingOrder = result;
      this.plugin.settings.licenseLastOrderId = result.order.id;
      this.plugin.settings.licenseLastOrderClaimToken = result.orderClaimToken ?? "";
      this.plugin.settings.licenseLastOrderSnapshot = JSON.stringify(result.order);
      this.plugin.settings.licenseLastPaymentSnapshot = JSON.stringify(result.payment);
      await this.plugin.saveSettings();
      await this.render();
      this.openPaymentUrl(result.payment);
      this.startPolling(result.order.id);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private openPaymentUrl(payment: CreateOrderResult["payment"]): void {
    const url = getPaymentPresentation(payment).directUrl;
    if (!url) return;
    if (this.openExternalLink(url)) {
      new Notice("已打开网页支付，支付完成后会自动激活。");
      return;
    }
    new Notice("浏览器阻止了自动打开，请点击页面里的“打开网页支付”。");
  }

  private async pollExistingOrder(orderId: string): Promise<void> {
    if (this.pollRequestInFlight) return;
    this.pollRequestInFlight = true;
    try {
      const result = await this.client.pollOrder(orderId, this.orderClaimTokenFor(orderId));
      if (result.order.status === "paid" && result.licenseKey) {
        this.stopPolling();
        this.pendingOrder = this.pendingOrder
          ? { ...this.pendingOrder, order: result.order }
          : this.pendingOrder;
        const activated = await this.activateLicense(result.licenseKey);
        if (activated !== "activated") {
          this.plugin.settings.licenseKey = result.licenseKey;
          await this.plugin.saveSettings();
          if (activated === "device-quota") {
            new Notice("支付成功，授权码已保存。当前设备数已满，请先到账号中心查看设备或联系支持处理。");
          } else {
            new Notice("支付成功，但自动激活失败。授权码已返回，请稍后在激活码区域手动重试。");
          }
          await this.render();
          return;
        }
        this.pendingOrder = null;
        this.clearPendingOrderSettings();
        await this.plugin.saveSettings();
        new Notice("支付成功，已自动激活 Pro。");
        await this.render();
        return;
      }
      if (this.isTerminalOrderStatus(result.order.status)) {
        this.stopPolling();
        this.pendingOrder = null;
        this.clearPendingOrderSettings();
        await this.plugin.saveSettings();
        new Notice(`订单已结束：${this.orderStatusText(result.order)}`);
        await this.render();
        return;
      }
      if (result.order.status === "paid" && !result.licenseKey) {
        this.stopPolling();
        this.licenseIssueMessage = "订单已支付，但当前设备缺少订单校验信息。请打开账号中心，用购买邮箱找回授权码后在本页激活。";
        new Notice(this.licenseIssueMessage, 8000);
        await this.render();
        return;
      }
      this.pendingOrder = this.pendingOrder
        ? { ...this.pendingOrder, order: result.order }
        : null;
      this.plugin.settings.licenseLastOrderSnapshot = JSON.stringify(result.order);
      new Notice(`订单状态：${this.orderStatusText(result.order)}`);
      await this.render();
    } catch (error) {
      this.stopPolling();
      new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      this.pollRequestInFlight = false;
    }
  }

  private restorePendingOrderFromSettings(): CreateOrderResult | null {
    if (!this.plugin.settings.licenseLastOrderId || !this.plugin.settings.licenseLastOrderSnapshot || !this.plugin.settings.licenseLastPaymentSnapshot) return null;
    try {
      return {
        order: JSON.parse(this.plugin.settings.licenseLastOrderSnapshot) as PaymentOrder,
        payment: JSON.parse(this.plugin.settings.licenseLastPaymentSnapshot) as CreateOrderResult["payment"],
        orderClaimToken: this.plugin.settings.licenseLastOrderClaimToken || undefined
      };
    } catch {
      this.clearPendingOrderSettings();
      void this.plugin.saveSettings();
      return null;
    }
  }

  private orderClaimTokenFor(orderId: string): string | undefined {
    if (this.pendingOrder?.order.id === orderId && this.pendingOrder.orderClaimToken) return this.pendingOrder.orderClaimToken;
    return this.plugin.settings.licenseLastOrderClaimToken || undefined;
  }

  private clearPendingOrderSettings(): void {
    this.plugin.settings.licenseLastOrderId = "";
    this.plugin.settings.licenseLastOrderClaimToken = "";
    this.plugin.settings.licenseLastOrderSnapshot = "";
    this.plugin.settings.licenseLastPaymentSnapshot = "";
  }

  private async requestTrialCode(email: string): Promise<void> {
    if (!email.includes("@")) {
      new Notice("请先填写有效邮箱。");
      return;
    }
    try {
      this.plugin.settings.licenseEmail = email;
      const result = await this.client.requestTrialCode({
        email,
        installationId: this.plugin.settings.licenseInstallationId
      });
      await this.plugin.saveSettings();
      const debug = result.debugCode ? ` 测试验证码：${result.debugCode}` : "";
      new Notice(`试用验证码已发送，有效期至 ${new Date(result.expiresAt).toLocaleString("zh-CN")}。${debug}`, 8000);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyTrialCode(email: string, code: string): Promise<void> {
    if (!email.includes("@")) {
      new Notice("请先填写有效邮箱。");
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
      new Notice("请输入 6 位试用验证码。");
      return;
    }
    try {
      const result = await this.client.verifyTrialCode({
        email,
        code,
        installationId: this.plugin.settings.licenseInstallationId
      });
      await this.saveLicenseResult(result, result.licenseKey || this.plugin.settings.licenseKey || "");
      new Notice("30 天试用已激活。");
      await this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private startPolling(orderId: string): void {
    this.stopPolling();
    this.isPolling = true;
    this.pollTimer = window.setInterval(() => {
      void this.pollExistingOrder(orderId);
    }, ORDER_POLL_INTERVAL_MS);
    void this.pollExistingOrder(orderId);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  private async activateLicense(licenseKey: string): Promise<ActivationAttempt> {
    if (!licenseKey) {
      new Notice("请填写授权码。");
      return "failed";
    }
    try {
      const result = await this.client.activate({
        licenseKey,
        installationId: this.plugin.settings.licenseInstallationId
      });
      await this.saveLicenseResult(result, licenseKey);
      new Notice("授权已激活。");
      await this.render();
      return "activated";
    } catch (error) {
      if (isDeviceQuotaError(error)) {
        this.licenseIssueMessage = `${buildDeviceQuotaMessage()} 当前安装 ID：${this.plugin.settings.licenseInstallationId}`;
        new Notice(this.licenseIssueMessage);
        await this.render();
        return "device-quota";
      }
      new Notice(error instanceof Error ? error.message : String(error));
      return "failed";
    }
  }

  private async redeem(code: string, email: string): Promise<void> {
    if (!code) {
      new Notice("请填写兑换码。");
      return;
    }
    if (!email.includes("@")) {
      new Notice("请填写有效邮箱。");
      return;
    }
    try {
      const result = await this.client.redeem({
        code,
        email,
        installationId: this.plugin.settings.licenseInstallationId
      });
      await this.saveLicenseResult(result, result.licenseKey);
      new Notice("兑换成功，已激活当前设备。");
      await this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async saveLicenseResult(result: ActivationResult | RedeemResult, licenseKey: string): Promise<void> {
    try {
      await verifyLicenseEntitlementToken(result.entitlementToken, this.plugin.settings.licenseInstallationId);
    } catch (error) {
      if (isEntitlementNotActiveError(error)) {
        if (licenseKey) {
          this.plugin.settings.licenseKey = licenseKey;
          await this.plugin.saveSettings();
        }
        throw new Error(ENTITLEMENT_CLOCK_SKEW_NOTICE);
      }
      throw error;
    }
    if (licenseKey) this.plugin.settings.licenseKey = licenseKey;
    this.plugin.settings.licenseEntitlementToken = result.entitlementToken;
    this.plugin.settings.licenseSnapshot = {
      license: result.license,
      activation: result.activation,
      entitlement: result.entitlement,
      activeActivationCount: result.activeActivationCount ?? null,
      updatedAt: new Date().toISOString()
    };
    this.plugin.settings.licenseLastCheckedAt = new Date().toISOString();
    await this.plugin.saveSettings();
  }

  private resolveStatus(snapshot: LicenseStateSnapshot | null): LicenseStatusLabel {
    return resolveLicenseStatus(snapshot, new Date(), this.plugin.settings.licenseEntitlementToken);
  }

  private statusText(status: LicenseStatusLabel): string {
    if (status === "trial") return "试用";
    if (status === "monthly-pro") return "月付 Pro";
    if (status === "lifetime-pro") return "买断 Pro";
    return "免费";
  }

  private expiryText(snapshot: LicenseStateSnapshot | null): string {
    const expiresAt = snapshot?.license?.expiresAt;
    if (!snapshot?.license) return "无";
    if (!expiresAt) return "永久";
    return new Date(expiresAt).toLocaleString("zh-CN");
  }

  private deviceText(snapshot: LicenseStateSnapshot | null): string {
    if (!snapshot?.license) return `0 / 0`;
    const active = snapshot.activeActivationCount ?? (snapshot.activation ? 1 : 0);
    return `${active} / ${snapshot.license.maxActivations}`;
  }

  private orderStatusText(order: PaymentOrder): string {
    if (order.status === "paid") return "已支付";
    if (order.status === "pending") return "待支付";
    if (order.status === "created") return "已创建";
    if (order.status === "failed") return "失败";
    if (order.status === "refunded") return "已退款";
    return order.status;
  }

  private isTerminalOrderStatus(status: string): boolean {
    return status === "failed" || status === "refunded" || status === "cancelled";
  }

  private shortId(value: string): string {
    if (value.length <= 18) return value;
    return `${value.slice(0, 10)}...${value.slice(-6)}`;
  }

  private stat(parent: HTMLElement, label: string, value: string, icon: string): void {
    const card = parent.createDiv({ cls: "lifeos-pro-stat lifeos-card" });
    setIcon(card.createSpan({ cls: "lifeos-pro-stat-icon" }), icon);
    card.createDiv({ cls: "lifeos-pro-stat-label", text: label });
    card.createDiv({ cls: "lifeos-pro-stat-value", text: value });
  }

  private cardTitle(parent: HTMLElement, title: string, icon: string): void {
    const header = parent.createDiv({ cls: "lifeos-pro-card-title" });
    setIcon(header.createSpan({ cls: "lifeos-pro-card-icon" }), icon);
    header.createEl("h2", { text: title });
  }

  private sectionTitle(parent: HTMLElement, title: string, icon: string): void {
    const header = parent.createDiv({ cls: "lifeos-pro-section-title" });
    setIcon(header.createSpan({ cls: "lifeos-pro-card-icon" }), icon);
    header.createEl("h2", { text: title });
  }

  private input(parent: HTMLElement, labelText: string, placeholder: string, value: string, options: ProInputOptions = {}): HTMLInputElement {
    const label = parent.createEl("label", { cls: "lifeos-pro-field" });
    label.createSpan({ text: labelText });
    const attr: Record<string, string> = {
      type: options.type ?? "text",
      placeholder
    };
    if (options.inputmode) attr.inputmode = options.inputmode;
    if (options.autocomplete) attr.autocomplete = options.autocomplete;
    if (typeof options.spellcheck === "boolean") attr.spellcheck = String(options.spellcheck);
    if (options.autocapitalize) attr.autocapitalize = options.autocapitalize;
    if (options.autocorrect) attr.autocorrect = options.autocorrect;
    const input = label.createEl("input", { attr });
    input.value = value;
    return input;
  }

  private button(parent: HTMLElement, label: string, icon: string, action: () => void | Promise<void>, primary = false): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: primary ? "lifeos-pro-button is-primary" : "lifeos-pro-button",
      attr: { type: "button" }
    });
    setIcon(button.createSpan({ cls: "lifeos-pro-button-icon" }), icon);
    button.createSpan({ text: label });
    button.onclick = () => void action();
    return button;
  }

  private async copyText(text: string, message: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copyFallbackText = "";
      new Notice(message);
    } catch {
      this.copyFallbackText = text;
      new Notice("复制失败，请手动选中页面中的文本复制。");
      await this.render();
    }
  }

  private async openDataReadme(): Promise<void> {
    await this.plugin.ensureBaseStructure();
    const file = await ensureFile(this.app, `${this.plugin.getRoot()}/README.md`, "# Life OS 数据目录\n\n这里保存你的本地 Markdown 数据。\n");
    await this.openFile(file);
  }

  private async exportLicenseSummary(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const snapshot = this.plugin.settings.licenseSnapshot;
    const content = [
      "---",
      "type: lifeos-license-backup",
      `created: ${new Date().toISOString()}`,
      "---",
      "",
      "# Life OS 授权备份",
      "",
      `- 当前状态：${this.statusText(this.resolveStatus(snapshot))}`,
      `- 到期时间：${this.expiryText(snapshot)}`,
      `- 设备数：${this.deviceText(snapshot)}`,
      `- 安装 ID：${this.plugin.settings.licenseInstallationId}`,
      `- 授权码：${this.plugin.settings.licenseKey || "尚未保存"}`,
      `- 授权服务：${this.plugin.settings.licenseApiBaseUrl}`,
      `- 账号中心：${this.accountCenterUrl()}`,
      "",
      "## 安全提醒",
      "",
      "这份备份包含授权码，请不要公开分享，也不要提交到公开仓库。",
      "",
      "## 数据说明",
      "",
      "Life OS 的 Markdown 数据保存在当前 Vault 中。授权状态不会阻止你查看、导出或迁移这些文件。"
    ].join("\n");
    const file = await ensureFile(this.app, `${this.localizedLifeOsPath("Exports")}/license-backup-${stamp}.md`, content);
    await this.openFile(file);
    new Notice("授权备份已生成。");
  }

  private async openMigrationGuide(): Promise<void> {
    const content = [
      "# Life OS 数据迁移说明",
      "",
      "1. 复制当前 Vault 中的 Life OS 数据目录。",
      "2. 在新 Vault 安装 Personal Life System 插件。",
      "3. 将数据目录放到相同路径，或在设置中把数据目录改为原路径。",
      "4. 打开 Pro 授权中心，粘贴授权码并激活当前设备。",
      "",
      "Markdown 数据与 Pro 授权分离保存，未授权状态也可以查看和迁移本地数据。"
    ].join("\n");
    const file = await ensureFile(this.app, `${this.localizedLifeOsPath("Exports")}/migration-guide.md`, content);
    await this.openFile(file);
  }

  private localizedLifeOsPath(...parts: string[]): string {
    const language = normalizeDirectoryLanguage(this.plugin.settings.directoryLanguage);
    return [this.plugin.getRoot(), ...localizeLifeOsPathParts(parts, language)].join("/");
  }

  private async openFile(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private accountCenterUrl(): string {
    return buildAccountCenterUrl(this.plugin.settings.licenseApiBaseUrl);
  }

  private paymentLink(parent: HTMLElement, url: string): HTMLAnchorElement {
    const link = parent.createEl("a", {
      cls: "lifeos-pro-payment-open",
      text: "打开网页支付",
      href: url
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noreferrer");
    return link;
  }

  private openExternalLink(url: string): boolean {
    try {
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) this.copyFallbackText = url;
      return Boolean(opened);
    } catch {
      this.copyFallbackText = url;
      return false;
    }
  }

  private openExternalLinkOrNotify(url: string, fallbackMessage: string): void {
    if (this.openExternalLink(url)) return;
    new Notice(fallbackMessage, 6000);
    void this.render();
  }
}
