import type { App, Component } from "obsidian";
import type { PendingMemory } from "../types";
import { renderMarkdownDisplay } from "../utils/markdown-render";

export function createMemoryItem(
  parent: HTMLElement,
  app: App,
  component: Component,
  memory: PendingMemory,
  onToggle: (checked: boolean) => void
): HTMLElement {
  const item = parent.createDiv({ cls: "lifeos-memory-item" });
  const checkbox = item.createEl("input", { attr: { type: "checkbox", "aria-label": "选择候选记忆" } });
  checkbox.checked = memory.selected;
  checkbox.onchange = () => onToggle(checkbox.checked);

  const body = item.createDiv({ cls: "lifeos-memory-body" });
  renderMarkdownDisplay(app, component, body.createDiv({ cls: "lifeos-memory-content" }), memory.content);

  const meta = body.createDiv({ cls: "lifeos-memory-meta" });
  meta.createSpan({ cls: "lifeos-badge", text: sourceLabel(memory.source) });
  meta.createSpan({ text: memory.created || "未记录时间" });
  meta.createSpan({ cls: "lifeos-badge tone-blue", text: memory.category || "其他" });
  meta.createSpan({ cls: "lifeos-badge tone-orange", text: memory.importance || "普通" });
  return item;
}

function sourceLabel(source: string): string {
  if (source === "quick-capture") return "快速记录";
  if (source === "daily") return "今日日记";
  return source || "未知来源";
}
