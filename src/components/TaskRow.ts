import type { App, Component } from "obsidian";
import type { LifeOSTask } from "../types";
import { renderMarkdownDisplay } from "../utils/markdown-render";

export function createTaskRow(parent: HTMLElement, app: App, component: Component, task: LifeOSTask, onComplete: () => void): HTMLElement {
  const row = parent.createDiv({ cls: task.isDone ? "lifeos-task-row is-done" : "lifeos-task-row" });
  const hitbox = row.createEl("label", { cls: "lifeos-task-hitbox", attr: { "aria-label": "标记任务完成" } });
  const checkbox = hitbox.createEl("input", { attr: { type: "checkbox", "aria-label": "标记任务完成" } });
  checkbox.checked = task.isDone;
  checkbox.disabled = task.isDone;
  checkbox.onchange = onComplete;

  const body = row.createDiv({ cls: "lifeos-task-body" });
  renderMarkdownDisplay(app, component, body.createDiv({ cls: "lifeos-task-title" }), task.text);

  const meta = body.createDiv({ cls: "lifeos-task-meta" });
  meta.createSpan({ text: task.date || "今天" });
  meta.createSpan({
    cls: "lifeos-task-source",
    text: task.source === "open" ? "待办任务" : "已归档",
    attr: { title: task.source === "open" ? "保存于 Tasks/open.md" : "保存于 Tasks/done.md" }
  });
  for (const tag of task.tags.slice(0, 2)) {
    meta.createSpan({ cls: "lifeos-badge", text: tag });
  }

  const actions = row.createDiv({ cls: "lifeos-task-actions" });
  actions.createSpan({ text: task.isDone ? "已完成" : "点击勾选后会归档" });
  return row;
}
