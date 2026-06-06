import { createUiIcon, createUiElement } from "./dom";
import type { UiAction, UiPageShellOptions, UiSectionOptions } from "./types";
import { createUiButton } from "./components/button";

export interface UiPageShellParts {
  root: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  toolbar: HTMLElement;
}

export function createUiPageShell(parent: HTMLElement, options: UiPageShellOptions): UiPageShellParts {
  const root = createUiElement(parent, "div", {
    className: ["lifeos-v2", "lifeos-v2-page", `lifeos-v2-page-${options.page}`, options.className ?? ""]
  });
  const header = createUiElement(root, "header", { className: "lifeos-v2-page-header" });
  const heading = createUiElement(header, "div", { className: "lifeos-v2-page-heading" });
  if (options.title) createUiElement(heading, "h1", { text: options.title });
  if (options.subtitle) createUiElement(heading, "p", { text: options.subtitle });
  const toolbar = createUiElement(header, "div", { className: "lifeos-v2-toolbar" });
  const body = createUiElement(root, "div", { className: "lifeos-v2-page-body" });
  return { root, header, body, toolbar };
}

export function createUiSection(parent: HTMLElement, options: UiSectionOptions = {}): HTMLElement {
  const section = createUiElement(parent, "section", {
    className: ["lifeos-v2-section", options.className ?? ""]
  });
  if (options.title || options.subtitle || options.icon) {
    const header = createUiElement(section, "div", { className: "lifeos-v2-section-header" });
    if (options.icon) createUiIcon(header, options.icon);
    const copy = createUiElement(header, "div", { className: "lifeos-v2-section-heading" });
    if (options.title) createUiElement(copy, "h2", { text: options.title });
    if (options.subtitle) createUiElement(copy, "p", { text: options.subtitle });
  }
  return section;
}

export function createUiToolbar(parent: HTMLElement, actions: UiAction[], className = ""): HTMLElement {
  const toolbar = createUiElement(parent, "div", { className: ["lifeos-v2-toolbar", className] });
  for (const action of actions) {
    createUiButton(toolbar, action);
  }
  return toolbar;
}

export function createUiResponsiveGrid(parent: HTMLElement, className = ""): HTMLElement {
  return createUiElement(parent, "div", { className: ["lifeos-v2-grid", className] });
}
