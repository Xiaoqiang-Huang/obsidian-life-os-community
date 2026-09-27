import type PersonalLifeSystemPlugin from "../main";
import { getThemeStyleClasses, normalizeThemeStyle } from "../settings";
import type { LifeOSNavKey } from "../types";
import { createSidebar } from "./Sidebar";
import { installLifeOSResponsiveShell } from "../utils/responsive-shell";
import { applyExperienceTheme } from "../ui/theme";

export function createLifeOSShell(
  container: HTMLElement,
  plugin: PersonalLifeSystemPlugin,
  active: LifeOSNavKey
): HTMLElement {
  const themeStyle = normalizeThemeStyle(plugin.settings.themeStyle);
  const root = container.createDiv({ cls: ["lifeos-root", "lifeos-v2-compat-root", ...getThemeStyleClasses(themeStyle)].join(" ") });
  root.addClass("lifeos-workspace");
  root.addClass("lifeos-v3");
  root.dataset.page = active;
  applyExperienceTheme(root, plugin.settings);
  installLifeOSResponsiveShell(root);
  const shell = root.createDiv({ cls: "lifeos-shell lifeos-v2-shell" });
  createSidebar(shell, plugin, active);
  return shell.createDiv({ cls: "lifeos-main lifeos-v2-main" });
}
