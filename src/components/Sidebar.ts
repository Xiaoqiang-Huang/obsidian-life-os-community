import { setIcon } from "obsidian";
import type PersonalLifeSystemPlugin from "../main";
import type { LifeOSNavKey } from "../types";

type LifeOSNavItem = {
  key: LifeOSNavKey;
  label: string;
  shortLabel: string;
  hint: string;
  icon: string;
};

const NAV_ITEMS: LifeOSNavItem[] = [
  { key: "chat", label: "\u0041\u0049 \u52a9\u624b", shortLabel: "AI", hint: "\u95ee\u95ee\u5f53\u524d\u72b6\u6001", icon: "bot" },
  { key: "guide", label: "\u4f7f\u7528\u624b\u518c", shortLabel: "\u624b\u518c", hint: "\u5982\u4f55\u4f7f\u7528", icon: "book-open-check" },
  { key: "proCompare", label: "\u7248\u672c\u5bf9\u6bd4", shortLabel: "\u7248\u672c", hint: "\u77ed\u671f / \u957f\u671f \u0050\u0072\u006f", icon: "columns-3" },
  { key: "pro", label: "\u0050\u0072\u006f \u6388\u6743", shortLabel: "Pro", hint: "\u8d2d\u4e70\u4e0e\u6fc0\u6d3b", icon: "badge-check" },
  { key: "dashboard", label: "\u4eca\u65e5\u884c\u52a8", shortLabel: "\u4eca\u65e5", hint: "\u4eca\u5929\u5148\u505a\u4ec0\u4e48", icon: "layout-dashboard" },
  { key: "tasks", label: "\u4efb\u52a1", shortLabel: "\u4efb\u52a1", hint: "\u884c\u52a8\u6e05\u5355", icon: "check-square" },
  { key: "diary", label: "\u65e5\u8bb0", shortLabel: "\u65e5\u8bb0", hint: "\u8bb0\u5f55\u4eca\u5929", icon: "book-open" },
  { key: "knowledge", label: "\u77e5\u8bc6\u5e93", shortLabel: "\u77e5\u8bc6", hint: "\u8d44\u6599\u4e0e\u7b14\u8bb0", icon: "library" },
  { key: "memory", label: "\u8bb0\u5fc6", shortLabel: "\u8bb0\u5fc6", hint: "\u786e\u8ba4\u540e\u518d\u6c89\u6dc0", icon: "brain" },
  { key: "review", label: "\u590d\u76d8", shortLabel: "\u590d\u76d8", hint: "\u770b\u89c1\u6210\u957f", icon: "bar-chart-3" },
  { key: "workspace", label: "\u9879\u76ee\u4e0a\u4e0b\u6587", shortLabel: "\u9879\u76ee", hint: "\u7ba1\u7406 AI \u534f\u4f5c\u8d44\u4ea7", icon: "git-branch" },
  { key: "checkins", label: "\u5b66\u4e60\u6253\u5361", shortLabel: "\u6253\u5361", hint: "\u7559\u4e0b\u8fdb\u5ea6", icon: "graduation-cap" },
  { key: "settings", label: "\u8bbe\u7f6e", shortLabel: "\u8bbe\u7f6e", hint: "\u6570\u636e\u4e0e\u5b89\u5168", icon: "settings" }
];

const MOBILE_PRIMARY_KEYS: LifeOSNavKey[] = ["chat", "dashboard", "tasks", "diary", "knowledge"];
const MOBILE_MENU_KEYS: LifeOSNavKey[] = [
  "chat",
  "dashboard",
  "tasks",
  "diary",
  "checkins",
  "knowledge",
  "memory",
  "review",
  "workspace",
  "settings",
  "guide",
  "proCompare",
  "pro"
];

const NAV_GROUPS: Array<{ title: string; keys: LifeOSNavKey[] }> = [
  { title: "\u4e3b\u9875", keys: ["chat"] },
  { title: "\u4eca\u5929", keys: ["dashboard", "tasks", "diary", "checkins"] },
  { title: "\u6c89\u6dc0", keys: ["knowledge", "memory", "review", "workspace"] }
];

export function createSidebar(parent: HTMLElement, plugin: PersonalLifeSystemPlugin, active: LifeOSNavKey): HTMLElement {
  const sidebar = parent.createDiv({ cls: "lifeos-sidebar lifeos-v2-sidebar lifeos-sidebar-minimal lifeos-glass-sidebar" });
  renderMobileNavigation(sidebar, plugin, active);
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
  group.setAttr("data-lifeos-nav-group", title);
  group.createDiv({ cls: "lifeos-nav-section-label", text: title });
  for (const key of keys) {
    const item = NAV_ITEMS.find((entry) => entry.key === key);
    if (item) renderNavItem(group, item, plugin, active);
  }
  syncNavGroupVisibility(group);
}

function renderNavItem(
  parent: HTMLElement,
  item: LifeOSNavItem,
  plugin: PersonalLifeSystemPlugin,
  active: LifeOSNavKey
): void {
  const button = parent.createEl("button", {
    cls: [
      "lifeos-nav-item",
      "lifeos-v2-sidebar-item",
      item.key === active ? "is-active" : "",
      isNavItemHidden(plugin, item.key) ? "is-user-hidden" : ""
    ].filter(Boolean).join(" "),
    attr: {
      type: "button",
      title: `${item.label} - ${item.hint}`,
      "aria-label": `${item.label}: ${item.hint}`,
      "data-nav-key": item.key
    }
  });
  setIcon(button.createSpan({ cls: "lifeos-nav-icon lifeos-v2-sidebar-icon" }), item.icon);
  const text = button.createSpan({ cls: "lifeos-nav-copy lifeos-v2-sidebar-copy" });
  text.createSpan({ cls: "lifeos-nav-label", text: item.label });
  text.createSpan({ cls: "lifeos-nav-hint", text: item.hint });
  button.onclick = () => {
    markNavigationPending(button);
    activateNavItem(plugin, item.key);
  };
}

function renderMobileNavigation(
  sidebar: HTMLElement,
  plugin: PersonalLifeSystemPlugin,
  active: LifeOSNavKey
): void {
  const visibleItems = MOBILE_MENU_KEYS
    .map((key) => NAV_ITEMS.find((item) => item.key === key))
    .filter((item): item is LifeOSNavItem => item !== undefined && !isNavItemHidden(plugin, item.key));
  const visibleByKey = new Map(visibleItems.map((item) => [item.key, item]));
  let primaryKeys = MOBILE_PRIMARY_KEYS.filter((key) => visibleByKey.has(key));
  if (!primaryKeys.includes(active) && visibleByKey.has(active)) {
    primaryKeys = [active, ...primaryKeys].slice(0, MOBILE_PRIMARY_KEYS.length);
  }

  const mobileNav = sidebar.createDiv({ cls: "lifeos-mobile-nav" });
  mobileNav.setAttr("aria-label", "Life OS 移动端导航");
  const primary = mobileNav.createDiv({ cls: "lifeos-mobile-nav-primary" });
  primary.setAttr("role", "navigation");
  primary.setAttr("aria-label", "常用页面");
  for (const key of primaryKeys) {
    const item = visibleByKey.get(key);
    if (item) renderMobileNavItem(primary, item, plugin, active);
  }

  const more = mobileNav.createEl("details", { cls: "lifeos-mobile-nav-more" });
  if (!MOBILE_PRIMARY_KEYS.includes(active)) more.addClass("contains-active");
  const summary = more.createEl("summary", {
    attr: {
      title: "查看全部页面",
      "aria-label": "全部页面"
    }
  });
  setIcon(summary.createSpan({ cls: "lifeos-mobile-nav-more-icon" }), "menu");
  summary.createSpan({ cls: "lifeos-mobile-nav-more-label", text: "更多" });

  const menu = more.createDiv({ cls: "lifeos-mobile-nav-menu" });
  menu.setAttr("role", "navigation");
  menu.setAttr("aria-label", "全部页面");
  for (const item of visibleItems) {
    renderMobileNavItem(menu, item, plugin, active, more);
  }
}

function renderMobileNavItem(
  parent: HTMLElement,
  item: LifeOSNavItem,
  plugin: PersonalLifeSystemPlugin,
  active: LifeOSNavKey,
  menu?: HTMLDetailsElement
): void {
  const button = parent.createEl("button", {
    cls: ["lifeos-mobile-nav-item", item.key === active ? "is-active" : ""].filter(Boolean).join(" "),
    attr: {
      type: "button",
      title: `${item.label} - ${item.hint}`,
      "aria-label": `${item.label}: ${item.hint}`,
      "data-nav-key": item.key
    }
  });
  if (item.key === active) button.setAttr("aria-current", "page");
  setIcon(button.createSpan({ cls: "lifeos-mobile-nav-icon" }), item.icon);
  button.createSpan({ cls: "lifeos-mobile-nav-label", text: item.shortLabel });
  button.onclick = () => {
    menu?.removeAttribute("open");
    markNavigationPending(button);
    activateNavItem(plugin, item.key);
  };
}

function activateNavItem(plugin: PersonalLifeSystemPlugin, key: LifeOSNavKey): void {
  if (key === "dashboard") void plugin.activateDashboard();
  if (key === "tasks") void plugin.activateTasks();
  if (key === "memory") void plugin.activateMemory();
  if (key === "review") void plugin.activateReview();
  if (key === "workspace") void plugin.activateAiWorkspace();
  if (key === "chat") void plugin.activateChat();
  if (key === "guide") void plugin.activateUserGuide();
  if (key === "proCompare") void plugin.activateProCompare();
  if (key === "pro") void plugin.activateProLicense();
  if (key === "diary") void plugin.activateDaily();
  if (key === "knowledge") void plugin.activateKnowledge();
  if (key === "checkins") void plugin.showCheckinModal();
  if (key === "settings") void plugin.activateSettings();
}

function isNavItemHidden(plugin: PersonalLifeSystemPlugin, key: LifeOSNavKey): boolean {
  if (key === "settings") return false;
  if (key === "checkins" && !plugin.settings.enableExamModule) return true;
  return plugin.settings.hiddenSidebarItems?.includes(key) === true;
}

function syncNavGroupVisibility(group: HTMLElement): void {
  const hasVisibleItem = Array.from(group.querySelectorAll<HTMLElement>(".lifeos-nav-item"))
    .some((item) => !item.hasClass("is-user-hidden"));
  group.toggleClass("is-empty", !hasVisibleItem);
}

function markNavigationPending(button: HTMLButtonElement): void {
  button.addClass("is-pending");
  button.setAttr("aria-busy", "true");
  window.setTimeout(() => {
    button.removeClass("is-pending");
    button.removeAttribute("aria-busy");
  }, 360);
}
