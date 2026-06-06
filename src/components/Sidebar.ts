import { setIcon } from "obsidian";
import type PersonalLifeSystemPlugin from "../main";
import type { LifeOSNavKey } from "../types";

const NAV_ITEMS: Array<{ key: LifeOSNavKey; label: string; hint: string; icon: string }> = [
  { key: "chat", label: "\u0041\u0049 \u52a9\u624b", hint: "\u95ee\u95ee\u5f53\u524d\u72b6\u6001", icon: "bot" },
  { key: "guide", label: "\u4f7f\u7528\u624b\u518c", hint: "\u5982\u4f55\u4f7f\u7528", icon: "book-open-check" },
  { key: "proCompare", label: "\u7248\u672c\u5bf9\u6bd4", hint: "\u77ed\u671f / \u957f\u671f \u0050\u0072\u006f", icon: "columns-3" },
  { key: "pro", label: "\u0050\u0072\u006f \u6388\u6743", hint: "\u8d2d\u4e70\u4e0e\u6fc0\u6d3b", icon: "badge-check" },
  { key: "dashboard", label: "\u4eca\u65e5\u884c\u52a8", hint: "\u4eca\u5929\u5148\u505a\u4ec0\u4e48", icon: "layout-dashboard" },
  { key: "tasks", label: "\u4efb\u52a1", hint: "\u884c\u52a8\u6e05\u5355", icon: "check-square" },
  { key: "diary", label: "\u65e5\u8bb0", hint: "\u8bb0\u5f55\u4eca\u5929", icon: "book-open" },
  { key: "knowledge", label: "\u77e5\u8bc6\u5e93", hint: "\u8d44\u6599\u4e0e\u7b14\u8bb0", icon: "library" },
  { key: "memory", label: "\u8bb0\u5fc6", hint: "\u786e\u8ba4\u540e\u518d\u6c89\u6dc0", icon: "brain" },
  { key: "review", label: "\u590d\u76d8", hint: "\u770b\u89c1\u6210\u957f", icon: "bar-chart-3" },
  { key: "checkins", label: "\u5b66\u4e60\u6253\u5361", hint: "\u7559\u4e0b\u8fdb\u5ea6", icon: "graduation-cap" },
  { key: "settings", label: "\u8bbe\u7f6e", hint: "\u6570\u636e\u4e0e\u5b89\u5168", icon: "settings" }
];

const NAV_GROUPS: Array<{ title: string; keys: LifeOSNavKey[] }> = [
  { title: "\u4e3b\u9875", keys: ["chat"] },
  { title: "\u4eca\u5929", keys: ["dashboard", "tasks", "diary", "checkins"] },
  { title: "\u6c89\u6dc0", keys: ["knowledge", "memory", "review"] }
];

export function createSidebar(parent: HTMLElement, plugin: PersonalLifeSystemPlugin, active: LifeOSNavKey): HTMLElement {
  const sidebar = parent.createDiv({ cls: "lifeos-sidebar lifeos-v2-sidebar lifeos-sidebar-minimal lifeos-glass-sidebar" });
  const brand = sidebar.createDiv({ cls: "lifeos-brand" });
  setIcon(brand.createSpan({ cls: "lifeos-brand-icon" }), "sparkles");
  const copy = brand.createDiv();
  copy.createDiv({ cls: "lifeos-brand-title", text: plugin.settings.systemName || "Life OS" });
  copy.createDiv({ cls: "lifeos-brand-subtitle", text: "Personal Life System" });

  const main = sidebar.createDiv({ cls: "lifeos-sidebar-main lifeos-v2-sidebar-main" });
  const nav = main.createDiv({ cls: "lifeos-nav lifeos-v2-sidebar-nav" });
  for (const group of NAV_GROUPS) {
    renderNavGroup(nav, group.title, group.keys, plugin, active);
  }

  const footer = sidebar.createDiv({ cls: "lifeos-sidebar-footer lifeos-v2-sidebar-footer" });
  const bottom = footer.createDiv({ cls: "lifeos-sidebar-bottom lifeos-v2-sidebar-bottom" });
  renderNavItem(bottom, NAV_ITEMS.find((item) => item.key === "settings")!, plugin, active);
  renderNavItem(bottom, NAV_ITEMS.find((item) => item.key === "guide")!, plugin, active);
  renderNavItem(bottom, NAV_ITEMS.find((item) => item.key === "proCompare")!, plugin, active);
  renderNavItem(bottom, NAV_ITEMS.find((item) => item.key === "pro")!, plugin, active);
  const note = footer.createDiv({ cls: "lifeos-sidebar-note" });
  note.createDiv({ cls: "lifeos-sidebar-note-title", text: "\u672c\u5730\u4f18\u5148" });
  note.createDiv({ cls: "lifeos-sidebar-note-copy", text: "\u5185\u5bb9\u4fdd\u5b58\u5728\u4f60\u7684 Vault" });

  return sidebar;
}

function renderNavGroup(parent: HTMLElement, title: string, keys: LifeOSNavKey[], plugin: PersonalLifeSystemPlugin, active: LifeOSNavKey): void {
  const group = parent.createDiv({ cls: "lifeos-nav-section" });
  group.createDiv({ cls: "lifeos-nav-section-label", text: title });
  for (const key of keys) {
    const item = NAV_ITEMS.find((entry) => entry.key === key);
    if (item) renderNavItem(group, item, plugin, active);
  }
}

function renderNavItem(
  parent: HTMLElement,
  item: { key: LifeOSNavKey; label: string; hint: string; icon: string },
  plugin: PersonalLifeSystemPlugin,
  active: LifeOSNavKey
): void {
  const button = parent.createEl("button", {
    cls: item.key === active ? "lifeos-nav-item lifeos-v2-sidebar-item is-active" : "lifeos-nav-item lifeos-v2-sidebar-item",
    attr: { type: "button", title: `${item.label} - ${item.hint}`, "aria-label": `${item.label}: ${item.hint}` }
  });
  setIcon(button.createSpan({ cls: "lifeos-nav-icon lifeos-v2-sidebar-icon" }), item.icon);
  const text = button.createSpan({ cls: "lifeos-nav-copy lifeos-v2-sidebar-copy" });
  text.createSpan({ cls: "lifeos-nav-label", text: item.label });
  text.createSpan({ cls: "lifeos-nav-hint", text: item.hint });
  button.onclick = () => {
    if (item.key === "dashboard") void plugin.activateDashboard();
    if (item.key === "tasks") void plugin.activateTasks();
    if (item.key === "memory") void plugin.activateMemory();
    if (item.key === "review") void plugin.activateReview();
    if (item.key === "chat") void plugin.activateChat();
    if (item.key === "guide") void plugin.activateUserGuide();
    if (item.key === "proCompare") void plugin.activateProCompare();
    if (item.key === "pro") void plugin.activateProLicense();
    if (item.key === "diary") void plugin.activateDaily();
    if (item.key === "knowledge") void plugin.activateKnowledge();
    if (item.key === "checkins") void plugin.showCheckinModal();
    if (item.key === "settings") openSettings(plugin);
  };
}

function openSettings(plugin: PersonalLifeSystemPlugin): void {
  const appWithSettings = plugin.app as unknown as { setting?: { open: () => void; openTabById?: (id: string) => void } };
  appWithSettings.setting?.open();
  appWithSettings.setting?.openTabById?.(plugin.manifest.id);
}
