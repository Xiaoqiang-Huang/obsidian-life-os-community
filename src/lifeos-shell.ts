import { Notice, TFile, TFolder, setIcon, type App } from "obsidian";
import type { IPlugin } from "./plugin-api";
import type PersonalLifeSystemPlugin from "./main";
import { QuickCaptureModal } from "./modals/QuickCaptureModal";
import { ensureFile } from "./utils";
import { installLifeOSResponsiveShell } from "./utils/responsive-shell";

export type LifeOsActivePage = "dashboard" | "tasks" | "diary" | "chat" | "calendar" | "search" | "memory" | "reports" | "resources" | "settings";

interface LifeOsShellOptions {
  active: LifeOsActivePage;
  title: string;
  subtitle: string;
  showDirectory?: boolean;
  onRefresh?: () => void | Promise<void>;
}

export function createLifeOsShell(
  app: App,
  plugin: IPlugin,
  root: HTMLElement,
  options: LifeOsShellOptions
): HTMLElement {
  root.addClass("pls-lifeos-shell");
  installLifeOSResponsiveShell(root);
  root.toggleClass("pls-sidebar-collapsed", plugin.settings.sidebarCollapsed);
  root.toggleClass("pls-dir-collapsed", plugin.settings.sidebarDirectoryCollapsed);
  applyLifeOsBackground(plugin, root);

  const sidebar = root.createDiv({ cls: "pls-lifeos-sidebar" });
  renderBrand(app, plugin, sidebar, options);
  renderNav(plugin, sidebar, options.active);
  if (options.showDirectory !== false) {
    renderDirectory(app, plugin, sidebar, options.onRefresh);
  }
  renderFooter(plugin, sidebar, options.onRefresh);

  const main = root.createDiv({ cls: "pls-lifeos-main" });
  const header = main.createDiv({ cls: "pls-lifeos-header" });
  const titleWrap = header.createDiv({ cls: "pls-lifeos-heading" });
  titleWrap.createEl("h2", { text: options.title });
  titleWrap.createEl("p", { text: options.subtitle });
  const meta = header.createDiv({ cls: "pls-lifeos-header-actions" });
  const date = meta.createDiv({ cls: "pls-date-pill" });
  setIcon(date.createSpan({ cls: "pls-inline-icon" }), "calendar-days");
  date.createSpan({
    text: new Date().toLocaleDateString("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long"
    })
  });
  const avatar = meta.createDiv({ cls: "pls-avatar", attr: { "aria-hidden": "true" } });
  avatar.createDiv({ cls: "pls-avatar-face" });
  return main.createDiv({ cls: "pls-lifeos-content" });
}

export function applyLifeOsBackground(plugin: IPlugin, root: HTMLElement): void {
  const backgroundUrl = plugin.getBackgroundResourceUrl();
  if (!backgroundUrl) return;
  root.addClass("pls-has-custom-bg");
  root.style.setProperty("--pls-custom-bg", `url("${backgroundUrl.replace(/"/g, "%22")}")`);
}

export function markLifeOsLeaf(app: App): void {
  app.workspace.activeLeaf?.view.containerEl.addClass("pls-life-file-leaf");
}

function renderBrand(app: App, plugin: IPlugin, sidebar: HTMLElement, options: LifeOsShellOptions): void {
  const brand = sidebar.createDiv({ cls: "pls-lifeos-brand" });
  const logo = brand.createSpan({ cls: "pls-lifeos-logo" });
  setIcon(logo, "gem");
  const copy = brand.createDiv({ cls: "pls-lifeos-brand-copy" });
  copy.createDiv({ cls: "pls-lifeos-brand-title", text: plugin.settings.systemName });
  copy.createDiv({ cls: "pls-lifeos-brand-subtitle", text: "记录成长，规划未来" });
  const collapse = brand.createEl("button", {
    cls: "pls-lifeos-collapse",
    attr: {
      "aria-label": plugin.settings.sidebarCollapsed ? "展开左侧导航栏" : "收起左侧导航栏",
      title: plugin.settings.sidebarCollapsed ? "展开左侧导航栏" : "收起左侧导航栏"
    }
  });
  setIcon(collapse, plugin.settings.sidebarCollapsed ? "panel-left-open" : "panel-left-close");
  collapse.onclick = async () => {
    plugin.settings.sidebarCollapsed = !plugin.settings.sidebarCollapsed;
    await plugin.saveSettings();
    await options.onRefresh?.();
  };
}

function renderNav(plugin: IPlugin, sidebar: HTMLElement, active: LifeOsActivePage): void {
  const nav = sidebar.createDiv({ cls: "pls-lifeos-nav" });
  const items: Array<{ id: LifeOsActivePage; label: string; icon: string; action: () => void | Promise<void> }> = [
    { id: "dashboard", label: "今日概览", icon: "layout-dashboard", action: () => plugin.activateDashboard() },
    { id: "tasks", label: "任务管理", icon: "check-square", action: () => plugin.activateTasks() },
    { id: "diary", label: "日记", icon: "book-open", action: () => openToday(plugin) },
    { id: "memory", label: "记忆系统", icon: "brain", action: () => plugin.activateMemory() },
    { id: "chat", label: "AI 助手", icon: "bot", action: () => plugin.activateChat() },
    { id: "calendar", label: "日历", icon: "calendar-days", action: () => plugin.activateCalendar() },
    { id: "search", label: "日记检索", icon: "search", action: () => plugin.showDiarySearch() },
    { id: "resources", label: "资源库", icon: "archive", action: () => plugin.showUploadMaterial() },
    { id: "reports", label: "复盘总结", icon: "bar-chart-3", action: () => plugin.generateReport("daily") },
    { id: "settings", label: "设置", icon: "settings", action: () => openObsidianSettings(plugin.app) }
  ];
  for (const item of items) {
    const button = nav.createEl("button", {
      cls: item.id === active ? "pls-lifeos-nav-item is-active" : "pls-lifeos-nav-item",
      attr: { title: item.label, "aria-label": item.label, "data-label": item.label }
    });
    const icon = button.createSpan({ cls: "pls-lifeos-nav-icon" });
    setIcon(icon, item.icon);
    button.createSpan({ cls: "pls-lifeos-nav-label", text: item.label });
    button.onclick = () => void item.action();
  }
}

async function openToday(plugin: IPlugin): Promise<void> {
  await plugin.openTodayNote(false);
  markLifeOsLeaf(plugin.app);
}

async function openPluginPath(plugin: IPlugin, path: string): Promise<void> {
  const existing = plugin.app.vault.getAbstractFileByPath(path);
  const file = existing instanceof TFile ? existing : await ensureFile(plugin.app, path, "");
  await plugin.app.workspace.getLeaf(false).openFile(file);
  markLifeOsLeaf(plugin.app);
}

function renderDirectory(
  app: App,
  plugin: IPlugin,
  sidebar: HTMLElement,
  onRefresh?: () => void | Promise<void>
): void {
  const tree = sidebar.createDiv({ cls: "pls-lifeos-tree" });
  const header = tree.createDiv({ cls: "pls-lifeos-tree-header" });
  setIcon(header.createSpan({ cls: "pls-lifeos-tree-icon" }), "folder-tree");
  header.createSpan({ cls: "pls-lifeos-tree-title", text: plugin.getRoot() || "Vault" });
  const toggle = header.createEl("button", {
    cls: "pls-tree-toggle",
    attr: {
      "aria-label": plugin.settings.sidebarDirectoryCollapsed ? "展开侧目录" : "收起侧目录",
      title: plugin.settings.sidebarDirectoryCollapsed ? "展开侧目录" : "收起侧目录"
    }
  });
  setIcon(toggle, plugin.settings.sidebarDirectoryCollapsed ? "chevrons-down-up" : "chevrons-up-down");
  toggle.onclick = async () => {
    plugin.settings.sidebarDirectoryCollapsed = !plugin.settings.sidebarDirectoryCollapsed;
    await plugin.saveSettings();
    await onRefresh?.();
  };

  if (plugin.settings.sidebarDirectoryCollapsed) {
    tree.createDiv({ cls: "pls-sidebar-tree-empty", text: "侧目录已收起" });
    return;
  }

  const rootFolder = app.vault.getAbstractFileByPath(plugin.getRoot());
  if (!(rootFolder instanceof TFolder)) {
    tree.createDiv({ cls: "pls-sidebar-tree-empty", text: "目录尚未初始化" });
    return;
  }

  const currentPath = app.workspace.getActiveFile()?.path ?? "";
  const list = tree.createDiv({ cls: "pls-file-tree" });
  renderFolderChildren(app, plugin, list, rootFolder, currentPath, 0, onRefresh);
}

function renderFolderChildren(
  app: App,
  plugin: IPlugin,
  parent: HTMLElement,
  folder: TFolder,
  currentPath: string,
  depth: number,
  onRefresh?: () => void | Promise<void>
): void {
  const children = [...folder.children]
    .filter((child) => child instanceof TFolder || child instanceof TFile)
    .sort((a, b) => {
      if (a instanceof TFolder && b instanceof TFile) return -1;
      if (a instanceof TFile && b instanceof TFolder) return 1;
      if (folder.name === "Daily" && a instanceof TFile && b instanceof TFile) {
        return b.basename.localeCompare(a.basename);
      }
      return a.name.localeCompare(b.name, "zh-CN");
    });

  for (const child of children) {
    if (child instanceof TFolder) {
      renderFolderNode(app, plugin, parent, child, currentPath, depth, onRefresh);
    } else if (child instanceof TFile && child.extension === "md") {
      renderFileNode(app, parent, child, currentPath, depth, onRefresh);
    }
  }
}

function renderFolderNode(
  app: App,
  plugin: IPlugin,
  parent: HTMLElement,
  folder: TFolder,
  currentPath: string,
  depth: number,
  onRefresh?: () => void | Promise<void>
): void {
  const hasActiveChild = currentPath.startsWith(`${folder.path}/`);
  const details = parent.createEl("details", {
    cls: hasActiveChild ? `pls-tree-folder has-active-child depth-${Math.min(depth, 3)}` : `pls-tree-folder depth-${Math.min(depth, 3)}`,
    attr: { open: depth < 1 || hasActiveChild ? "open" : null }
  });
  details.style.setProperty("--pls-tree-depth", String(depth));
  const summary = details.createEl("summary", { cls: "pls-tree-folder-summary" });
  setIcon(summary.createSpan({ cls: "pls-tree-chevron" }), "chevron-right");
  setIcon(summary.createSpan({ cls: "pls-tree-icon" }), "folder");
  summary.createSpan({ cls: "pls-tree-label", text: folder.name });
  const count = folder.children.filter((child) => child instanceof TFolder || child instanceof TFile && child.extension === "md").length;
  summary.createSpan({ cls: "pls-tree-count", text: String(count) });
  const children = details.createDiv({ cls: "pls-tree-children" });
  renderFolderChildren(app, plugin, children, folder, currentPath, depth + 1, onRefresh);
}

function renderFileNode(
  app: App,
  parent: HTMLElement,
  file: TFile,
  currentPath: string,
  depth: number,
  onRefresh?: () => void | Promise<void>
): void {
  const button = parent.createEl("button", {
    cls: file.path === currentPath ? `pls-tree-file is-active depth-${Math.min(depth, 3)}` : `pls-tree-file depth-${Math.min(depth, 3)}`,
    attr: { title: file.path }
  });
  button.style.setProperty("--pls-tree-depth", String(depth));
  setIcon(button.createSpan({ cls: "pls-tree-icon" }), getFileIcon(file));
  button.createSpan({ cls: "pls-tree-label", text: file.basename });
  button.onclick = async () => {
    await app.workspace.getLeaf(false).openFile(file);
    markLifeOsLeaf(app);
    await onRefresh?.();
  };
}

function getFileIcon(file: TFile): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(file.basename)) return "calendar-days";
  if (file.basename.toLowerCase().includes("open")) return "list-todo";
  if (file.basename.toLowerCase().includes("done")) return "check-check";
  if (file.path.includes("/Memory/")) return "book-open";
  if (file.path.includes("/Templates/")) return "copy";
  if (file.path.includes("/Exam/")) return "graduation-cap";
  return "file-text";
}

function renderFooter(plugin: IPlugin, sidebar: HTMLElement, onRefresh?: () => void | Promise<void>): void {
  const footer = sidebar.createDiv({ cls: "pls-lifeos-footer" });
  const buttons: Array<{ icon: string; label: string; action: () => void | Promise<void> }> = [
    { icon: "zap", label: "快速记录", action: () => new QuickCaptureModal(plugin.app, plugin as unknown as PersonalLifeSystemPlugin).open() },
    { icon: "settings", label: "设置", action: () => openObsidianSettings(plugin.app) },
    { icon: "moon", label: "暗夜主题", action: () => plugin.setTheme("dark-tech") }
  ];
  for (const item of buttons) {
    const button = footer.createEl("button", {
      cls: "pls-icon-button",
      attr: { title: item.label, "aria-label": item.label }
    });
    setIcon(button, item.icon);
    button.onclick = () => void item.action();
  }
}

function openObsidianSettings(app: App): void {
  const appWithSettings = app as unknown as { setting?: { open: () => void } };
  if (appWithSettings.setting) {
    appWithSettings.setting.open();
    return;
  }
  new Notice("请从 Obsidian 设置中打开个人人生系统设置。");
}
