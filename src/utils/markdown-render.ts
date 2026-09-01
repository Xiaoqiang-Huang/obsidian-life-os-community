import { App, Component, MarkdownRenderer } from "obsidian";
import { normalizeDisplayMarkdown } from "./markdown-normalize";

export { normalizeDisplayMarkdown } from "./markdown-normalize";

const markdownRenderRevisions = new WeakMap<HTMLElement, number>();

export interface MarkdownDisplayOptions {
  cls?: string;
  sourcePath?: string;
}

export function createMarkdownDisplay(
  parent: HTMLElement,
  app: App,
  component: Component,
  markdown: string,
  options: MarkdownDisplayOptions = {}
): HTMLElement {
  const el = parent.createDiv({ cls: options.cls ? `lifeos-markdown-content ${options.cls}` : "lifeos-markdown-content" });
  renderMarkdownDisplay(app, component, el, markdown, options.sourcePath);
  return el;
}

export function renderMarkdownDisplay(
  app: App,
  component: Component,
  el: HTMLElement,
  markdown: string,
  sourcePath = ""
): Promise<void> {
  const revision = (markdownRenderRevisions.get(el) ?? 0) + 1;
  markdownRenderRevisions.set(el, revision);
  el.addClass("lifeos-markdown-content");
  const normalized = normalizeDisplayMarkdown(markdown);
  if (!normalized) {
    el.empty();
    return Promise.resolve();
  }

  el.setAttribute("aria-busy", "true");
  const staging = el.ownerDocument.createElement("div");
  return MarkdownRenderer.renderMarkdown(normalized, staging, sourcePath, component)
    .then(() => {
      if (markdownRenderRevisions.get(el) !== revision) return;
      el.replaceChildren(...Array.from(staging.childNodes));
    })
    .catch(() => {
      if (markdownRenderRevisions.get(el) !== revision) return;
      el.setText(normalized);
    })
    .finally(() => {
      if (markdownRenderRevisions.get(el) === revision) {
        el.removeAttribute("aria-busy");
      }
    });
}
