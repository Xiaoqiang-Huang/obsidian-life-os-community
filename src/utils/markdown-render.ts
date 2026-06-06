import { App, Component, MarkdownRenderer } from "obsidian";

export interface MarkdownDisplayOptions {
  cls?: string;
  sourcePath?: string;
}

export function createMarkdownDisplay(
  parent: HTMLElement,
  app: App,
  component: Component | unknown,
  markdown: string,
  options: MarkdownDisplayOptions = {}
): HTMLElement {
  const el = parent.createDiv({ cls: options.cls ? `lifeos-markdown-content ${options.cls}` : "lifeos-markdown-content" });
  renderMarkdownDisplay(app, component, el, markdown, options.sourcePath);
  return el;
}

export function renderMarkdownDisplay(
  app: App,
  component: Component | unknown,
  el: HTMLElement,
  markdown: string,
  sourcePath = ""
): void {
  el.empty();
  el.addClass("lifeos-markdown-content");
  const normalized = normalizeDisplayMarkdown(markdown);
  if (!normalized) return;
  void MarkdownRenderer.renderMarkdown(normalized, el, sourcePath, component as Component);
}

export function normalizeDisplayMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .trim();
}
