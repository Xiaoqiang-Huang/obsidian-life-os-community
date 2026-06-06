import { setIcon } from "obsidian";

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
