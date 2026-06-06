import { createUiElement } from "../dom";
import type { UiAction } from "../types";
import { createUiToolbar } from "../layout";

export interface UiCardOptions {
  title?: string;
  description?: string;
  meta?: string;
  className?: string;
  actions?: UiAction[];
}

export interface UiCardParts {
  root: HTMLElement;
  body: HTMLElement;
  actions?: HTMLElement;
}

export function createUiCard(parent: HTMLElement, options: UiCardOptions = {}): UiCardParts {
  const root = createUiElement(parent, "article", { className: ["lifeos-v2-card", options.className ?? ""] });
  if (options.meta) createUiElement(root, "div", { className: "lifeos-v2-card-meta", text: options.meta });
  if (options.title) createUiElement(root, "h3", { className: "lifeos-v2-card-title", text: options.title });
  if (options.description) createUiElement(root, "p", { className: "lifeos-v2-card-description", text: options.description });
  const body = createUiElement(root, "div", { className: "lifeos-v2-card-body" });
  const actions = options.actions?.length ? createUiToolbar(root, options.actions, "lifeos-v2-card-actions") : undefined;
  return { root, body, actions };
}
