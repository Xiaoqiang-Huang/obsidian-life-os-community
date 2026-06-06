import { setIcon } from "obsidian";

function classListFrom(input?: string | string[]): string[] {
  if (!input) return [];
  const values = Array.isArray(input) ? input : [input];
  return values.flatMap((value) => value.split(/\s+/).map((item) => item.trim()).filter(Boolean));
}

export interface CreateUiElementOptions {
  className?: string | string[];
  text?: string;
  attr?: Record<string, string>;
}

export function createUiElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  options: CreateUiElementOptions = {}
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  applyUiClasses(element, options.className);
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attr ?? {})) {
    element.setAttribute(name, value);
  }
  parent.appendChild(element);
  return element;
}

export function applyUiClasses(element: HTMLElement, className?: string | string[]): void {
  const classes = classListFrom(className);
  if (classes.length > 0) element.classList.add(...classes);
}

export function setUiText(element: HTMLElement, text: string): void {
  element.textContent = text;
}

export function createUiIcon(parent: HTMLElement, icon: string, className = "lifeos-v2-icon"): HTMLElement {
  const iconEl = createUiElement(parent, "span", { className, attr: { "aria-hidden": "true" } });
  setIcon(iconEl, icon);
  return iconEl;
}

export function setUiBusy(element: HTMLElement, busy: boolean): void {
  element.classList.toggle("is-busy", busy);
  element.setAttribute("aria-busy", busy ? "true" : "false");
}
