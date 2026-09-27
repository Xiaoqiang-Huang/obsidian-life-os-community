import { installHostPopoverScope } from "../utils/host-popover-scope";
import { Notice, setIcon } from "obsidian";
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
  { key: "dashboard", label: "今天", shortLabel: "今天", hint: "今天的重点和记录", icon: "layout-dashboard" },
  { key: "chat", label: "AI 助手", shortLabel: "AI", hint: "提问、执行与能力管理", icon: "bot" },
  { key: "tasks", label: "任务", shortLabel: "任务", hint: "待办、今日与已完成", icon: "check-square" },
  { key: "workspace", label: "项目", shortLabel: "项目", hint: "进展、资料与 AI 上下文", icon: "git-branch" },
  { key: "knowledge", label: "资料库", shortLabel: "资料", hint: "知识、导入与原文", icon: "library" },
  { key: "diary", label: "日记与回顾", shortLabel: "日记", hint: "记录、打卡与回顾", icon: "book-open" },
  { key: "calendar", label: "日历", shortLabel: "日历", hint: "按日期查找日记与安排", icon: "calendar-days" },
  { key: "memory", label: "记忆与偏好", shortLabel: "记忆", hint: "查看、纠正或遗忘", icon: "brain" },
  { key: "checkins", label: "学习打卡", shortLabel: "打卡", hint: "自定义学习目标", icon: "graduation-cap" },
  { key: "review", label: "回顾", shortLabel: "回顾", hint: "周与月的回顾", icon: "bar-chart-3" },
  { key: "settings", label: "设置", shortLabel: "设置", hint: "连接、外观与数据", icon: "settings" },
  { key: "guide", label: "帮助", shortLabel: "帮助", hint: "功能位置与使用条件", icon: "book-open-check" },
  { key: "proCompare", label: "版本对比", shortLabel: "版本", hint: "短期与长期 Pro", icon: "columns-3" },
  { key: "pro", label: "授权与订阅", shortLabel: "授权", hint: "购买、升级与恢复", icon: "badge-check" }
];
const MOBILE_PRIMARY_KEYS: LifeOSNavKey[] = ["dashboard", "chat", "tasks"];
const MOBILE_MENU_KEYS: LifeOSNavKey[] = NAV_ITEMS.map(item => item.key);
const DESKTOP_KEYS = NAV_ITEMS.filter(item => !['pro', 'settings', 'guide'].includes(item.key)).map(item => item.key);
function desktopOrder(plugin: PersonalLifeSystemPlugin): LifeOSNavKey[] {
  const candidate = plugin.settings.sidebarNavOrder ?? plugin.settings.sidebarPinnedItems;
  const saved = Array.isArray(candidate) ? candidate.filter((key): key is string => typeof key === "string") : [];
  return [...new Set([...saved, ...DESKTOP_KEYS])].filter(key => DESKTOP_KEYS.includes(key as LifeOSNavKey)) as LifeOSNavKey[];
}
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
  nav.classList.add('lifeos-sortable-nav');
  nav.setAttribute('aria-label', '长按半秒后拖动调整导航顺序；键盘可用 Alt 加上下方向键');
  for (const key of desktopOrder(plugin)) renderNavItem(nav, NAV_ITEMS.find(item => item.key === key)!, plugin, active);
  installNavigationOrdering(nav, plugin);

  const footer = sidebar.createDiv({ cls: "lifeos-sidebar-footer lifeos-v2-sidebar-footer" });
  const bottom = footer.createDiv({ cls: "lifeos-sidebar-bottom lifeos-v2-sidebar-bottom" });
  renderNavItem(bottom, NAV_ITEMS.find((item) => item.key === "pro")!, plugin, active);
  renderNavItem(bottom, NAV_ITEMS.find((item) => item.key === "settings")!, plugin, active);
  renderNavItem(bottom, NAV_ITEMS.find((item) => item.key === "guide")!, plugin, active);
  const note = footer.createDiv({ cls: "lifeos-sidebar-note" });
  note.createDiv({ cls: "lifeos-sidebar-note-title", text: "\u672c\u5730\u4f18\u5148" });
  note.createDiv({ cls: "lifeos-sidebar-note-copy", text: "\u5185\u5bb9\u4fdd\u5b58\u5728\u4f60\u7684 Vault" });

  return sidebar;
}

function installNavigationOrdering(nav: HTMLElement, plugin: PersonalLifeSystemPlugin): void {
  let dragged: string | null = null;
  let saving = false;
  const itemFor = (event: Event) => (event.target as HTMLElement)?.closest<HTMLButtonElement>('[data-nav-key]');
  const clear = () => { nav.querySelectorAll('.is-drop-target').forEach(el => el.classList.remove('is-drop-target')); };
  const move = async (key: string, target: string, after = false) => {
    if (saving || key === target) return;
    const order = desktopOrder(plugin);
    if (!order.includes(key as LifeOSNavKey) || !order.includes(target as LifeOSNavKey)) return;
    const next = order.filter(k => k !== key);
    next.splice(next.indexOf(target as LifeOSNavKey) + (after ? 1 : 0), 0, key as LifeOSNavKey);
    const before = plugin.settings.sidebarNavOrder;
    saving = true;
    plugin.settings.sidebarNavOrder = next;
    try { await plugin.saveSettings(); refreshSidebars(plugin); }
    catch { if (before === undefined) delete plugin.settings.sidebarNavOrder; else plugin.settings.sidebarNavOrder = before; new Notice('导航顺序保存失败，已恢复原顺序。'); }
    finally { saving = false; clear(); }
  };
  nav.querySelectorAll<HTMLButtonElement>('[data-nav-key]').forEach(button => {
    button.draggable = false;
    button.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    button.title += ' · 长按半秒后拖动排序 / Alt+↑↓';
  });
  // Arm native dragging only after a deliberate hold; ordinary clicks still navigate.
  let armed: HTMLButtonElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releaseListeners = () => {};
  let suppressClickUntil = 0;
  const resetGesture = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (armed) {
      armed.draggable = false;
      armed.classList.remove('is-reorder-ready');
    }
    armed = null;
    releaseListeners();
    releaseListeners = () => {};
  };
  nav.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  nav.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || saving || dragged) return;
    resetGesture();
    suppressClickUntil = 0;
    const button = itemFor(event);
    if (!button || !nav.contains(button)) return;
    const { clientX, clientY, pointerId } = event;
    const doc = nav.ownerDocument;
    const win = doc.defaultView;
    const finish = (up: PointerEvent) => {
      if (up.pointerId !== pointerId || dragged) return;
      if (armed) suppressClickUntil = Date.now() + 700;
      resetGesture();
    };
    const moving = (move: PointerEvent) => {
      if (move.pointerId !== pointerId || armed || dragged) return;
      if (Math.hypot(move.clientX - clientX, move.clientY - clientY) > 8) resetGesture();
    };
    const abort = () => {
      if (armed || dragged) suppressClickUntil = Date.now() + 700;
      dragged = null; clear(); resetGesture();
    };
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') abort(); };
    doc.addEventListener('pointermove', moving);
    doc.addEventListener('pointerup', finish);
    doc.addEventListener('pointercancel', finish);
    doc.addEventListener('keydown', escape);
    win?.addEventListener('blur', abort);
    releaseListeners = () => {
      doc.removeEventListener('pointermove', moving);
      doc.removeEventListener('pointerup', finish);
      doc.removeEventListener('pointercancel', finish);
      doc.removeEventListener('keydown', escape);
      win?.removeEventListener('blur', abort);
    };
    timer = setTimeout(() => {
      timer = undefined;
      if (!button.isConnected) { resetGesture(); return; }
      armed = button;
      button.draggable = true;
      button.classList.add('is-reorder-ready');
    }, 500);
  });
  nav.addEventListener('dragstart', event => {
    const button = itemFor(event);
    if (saving || !button || button !== armed || !nav.contains(button)) { event.preventDefault(); return; }
    dragged = button.dataset.navKey!;
    event.dataTransfer?.setData('text/plain', dragged);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  nav.addEventListener('dragover', event => {
    const button = itemFor(event);
    if (!dragged || !button || !nav.contains(button)) return;
    event.preventDefault(); clear(); button.classList.add('is-drop-target');
  });
  nav.addEventListener('drop', event => {
    const button = itemFor(event), key = dragged;
    suppressClickUntil = Date.now() + 700;
    dragged = null; clear(); resetGesture();
    if (!key || !button || !nav.contains(button)) return;
    event.preventDefault();
    const rect = button.getBoundingClientRect();
    void move(key, button.dataset.navKey!, event.clientY > rect.top + rect.height / 2);
  });
  nav.addEventListener('dragend', () => { suppressClickUntil = Date.now() + 700; dragged = null; clear(); resetGesture(); });
  nav.addEventListener('keydown', event => {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const button = itemFor(event); if (!button) return;
    const keys = desktopOrder(plugin).filter(key => !isNavItemHidden(plugin, key));
    const index = keys.indexOf(button.dataset.navKey as LifeOSNavKey), offset = event.key === 'ArrowUp' ? -1 : 1;
    const target = keys[index + offset]; if (!target) return;
    event.preventDefault(); void move(button.dataset.navKey!, target, offset > 0);
  });
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
  if (item.key === active) button.setAttribute("aria-current", "page");
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
  const primaryKeys = [...new Set([...desktopOrder(plugin), ...MOBILE_PRIMARY_KEYS])].filter(key => visibleByKey.has(key)).slice(0, 3);

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
  const search = menu.createEl("input", { cls: "lifeos-input", attr: { type: "search", placeholder: "查找页面…", "aria-label": "查找页面" } });
  installHostPopoverScope(more, plugin.app, search);
  search.oninput = () => menu.querySelectorAll<HTMLElement>(".lifeos-mobile-nav-item").forEach(item => { item.hidden = !(item.getAttribute("aria-label") || "").includes(search.value.trim()); });
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
  if (key === "calendar") void plugin.activateCalendar();
  if (key === "knowledge") void plugin.activateKnowledge();
  if (key === "checkins") void plugin.showCheckinModal();
  if (key === "settings") void plugin.activateSettings();
}

function isNavItemHidden(plugin: PersonalLifeSystemPlugin, key: LifeOSNavKey): boolean {
  if (key === "settings" || key === "pro") return false;
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

/** Refresh only navigation, never discard the current page's form or list state. */
export function refreshSidebars(plugin: PersonalLifeSystemPlugin): void {
  document.querySelectorAll<HTMLElement>(".lifeos-v3 .lifeos-sidebar").forEach(previous => {
    const active = previous.querySelector<HTMLElement>('[aria-current="page"]')?.dataset.navKey as LifeOSNavKey || "dashboard";
    const host = document.createElement("div");
    const next = createSidebar(host, plugin, active);
    const scroll = previous.scrollTop;
    const focused = previous.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.navKey : undefined;
    previous.replaceWith(next);
    next.scrollTop = scroll;
    if (focused) next.querySelector<HTMLButtonElement>('[data-nav-key="' + focused + '"]')?.focus({ preventScroll: true });
  });
}
