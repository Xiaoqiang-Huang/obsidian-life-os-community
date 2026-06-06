import { Modal } from "obsidian";
import type { IPlugin } from "../plugin-api";
import type { LicenseStateSnapshot, LicenseStatusLabel } from "./license-types";
import { getVerifiedEntitlementPayload } from "./entitlement-token";
export { __seedVerifiedEntitlementPayloadForTests } from "./entitlement-token";

export type ProFeatureId =
  | "aiChat"
  | "aiDiarySummary"
  | "aiTaskExtract"
  | "aiMemoryExtract"
  | "aiReviewGenerate"
  | "aiEmotionTrend"
  | "aiDiarySmartSearch"
  | "aiWriteback"
  | "aiExamCoach";

const FEATURE_LABELS: Record<ProFeatureId, string> = {
  aiChat: "AI Chat",
  aiDiarySummary: "AI 日记整理",
  aiTaskExtract: "从日记提取任务",
  aiMemoryExtract: "AI 提取长期记忆",
  aiReviewGenerate: "多维复盘生成",
  aiEmotionTrend: "情绪 / 趋势统计",
  aiDiarySmartSearch: "AI 智能日记问答",
  aiWriteback: "AI 写回",
  aiExamCoach: "AI 学习 / 备考辅导"
};

type EntitlementPlugin = Pick<IPlugin, "app" | "settings" | "activateProCompare" | "activateProLicense">;

function snapshotMatchesVerifiedToken(snapshot: LicenseStateSnapshot, entitlementToken = ""): boolean {
  const payload = getVerifiedEntitlementPayload(entitlementToken);
  if (!payload) return false;
  if (!snapshot.entitlement || !snapshot.license || !snapshot.activation) return false;
  return (
    snapshot.license.id === payload.licenseId &&
    snapshot.activation.id === payload.activationId &&
    snapshot.entitlement.licenseId === payload.licenseId &&
    snapshot.entitlement.activationId === payload.activationId &&
    snapshot.entitlement.installationId === payload.installationId &&
    snapshot.license.sku === payload.sku &&
    snapshot.license.tier === payload.tier
  );
}

export function resolveLicenseStatus(snapshot: LicenseStateSnapshot | null, now = new Date(), entitlementToken = ""): LicenseStatusLabel {
  const license = snapshot?.license;
  const activation = snapshot?.activation;
  if (!license || license.status !== "active") return "free";
  if (!activation || activation.status !== "active") return "free";
  if (!snapshotMatchesVerifiedToken(snapshot, entitlementToken)) return "free";
  if (license.expiresAt && Date.parse(license.expiresAt) <= now.getTime()) return "free";
  if (license.tier === "trial") return "trial";
  if (license.sku === "pro_monthly_990") return "monthly-pro";
  return "lifetime-pro";
}

export function hasProAccess(snapshot: LicenseStateSnapshot | null, now = new Date(), entitlementToken = ""): boolean {
  return resolveLicenseStatus(snapshot, now, entitlementToken) !== "free";
}

export function getProFeatureLabel(feature: ProFeatureId): string {
  return FEATURE_LABELS[feature];
}

export function requireProFeature(plugin: EntitlementPlugin, feature: ProFeatureId): boolean {
  if (hasProAccess(plugin.settings.licenseSnapshot, new Date(), plugin.settings.licenseEntitlementToken)) return true;
  new ProRequiredModal(plugin, feature).open();
  return false;
}

class ProRequiredModal extends Modal {
  constructor(private plugin: EntitlementPlugin, private feature: ProFeatureId) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeos-pro-required-modal");
    contentEl.createEl("h2", { text: "此功能需要 Pro" });
    contentEl.createEl("p", {
      text: `${getProFeatureLabel(this.feature)} 属于完整体验 Pro 能力。免费版仍可继续使用本地记录、查看、导出和迁移。`
    });
    contentEl.createEl("p", {
      cls: "lifeos-muted",
      text: "可以先使用 30 天试用，也可以用月付 Pro 或买断 Pro 激活。"
    });

    const actions = contentEl.createDiv({ cls: "lifeos-pro-required-actions" });
    this.createAction(actions, "查看版本对比", () => {
      this.close();
      void this.plugin.activateProCompare();
    });
    this.createAction(actions, "打开授权中心", () => {
      this.close();
      void this.plugin.activateProLicense();
    }, true);
  }

  private createAction(parent: HTMLElement, text: string, action: () => void, primary = false): void {
    const button = parent.createEl("button", {
      text,
      cls: primary ? "mod-cta" : undefined,
      attr: { type: "button" }
    });
    button.onclick = action;
  }
}
