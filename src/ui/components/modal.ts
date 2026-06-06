import { createUiIcon, createUiElement } from "../dom";

export interface UiModalShellOptions {
  title: string;
  subtitle?: string;
  icon?: string;
  className?: string;
}

export interface UiModalShellParts {
  header: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
}

export function createUiModalShell(contentEl: HTMLElement, options: UiModalShellOptions): UiModalShellParts {
  contentEl.empty();
  contentEl.classList.add("lifeos-v2-modal", "lifeos-v2");
  if (options.className) contentEl.classList.add(...options.className.split(/\s+/).filter(Boolean));
  const header = createUiElement(contentEl, "header", { className: "lifeos-v2-modal-header" });
  if (options.icon) createUiIcon(header, options.icon, "lifeos-v2-modal-icon");
  const heading = createUiElement(header, "div", { className: "lifeos-v2-modal-heading" });
  createUiElement(heading, "h2", { text: options.title });
  if (options.subtitle) createUiElement(heading, "p", { text: options.subtitle });
  const body = createUiElement(contentEl, "div", { className: "lifeos-v2-modal-body" });
  const footer = createUiElement(contentEl, "footer", { className: "lifeos-v2-modal-footer lifeos-v2-toolbar" });
  return { header, body, footer };
}
