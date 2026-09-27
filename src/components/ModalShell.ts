import { setIcon } from "obsidian";
import { applyExperienceTheme } from "../ui/theme";

export interface ModalShellParts {
  header: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
}

export function createModalShell(
  contentEl: HTMLElement,
  options: {
    title: string;
    subtitle?: string;
    icon?: string;
    className?: string;
  }
): ModalShellParts {
  contentEl.empty();
  const host = contentEl.closest<HTMLElement>(".modal") || contentEl;
  host.classList.add("lifeos-v3", "lifeos-v3-modal", "lifeos-v3-shell-host");
  applyExperienceTheme(host);
  contentEl.addClass("lifeos-modal", "lifeos-modal-shell", "lifeos-glass-modal", "lifeos-v2", "lifeos-v2-modal");
  if (options.className) {
    for (const cls of options.className.split(/\s+/).filter(Boolean)) contentEl.addClass(cls);
  }

  const header = contentEl.createDiv({ cls: "lifeos-modal-header lifeos-v2-modal-header" });
  if (options.icon) setIcon(header.createSpan({ cls: "lifeos-modal-icon" }), options.icon);
  const copy = header.createDiv({ cls: "lifeos-modal-heading" });
  copy.createEl("h2", { text: options.title });
  if (options.subtitle) copy.createEl("p", { text: options.subtitle });

  const body = contentEl.createDiv({ cls: "lifeos-modal-body lifeos-v2-modal-body" });
  const footer = contentEl.createDiv({ cls: "lifeos-modal-footer lifeos-glass-toolbar lifeos-v2-modal-footer" });
  return { header, body, footer };
}
