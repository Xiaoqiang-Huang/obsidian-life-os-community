import { setIcon } from "obsidian";

export function createStatCard(
  parent: HTMLElement,
  label: string,
  value: string,
  tone: "purple" | "green" | "blue" | "orange" = "purple",
  icon = "sparkles"
): HTMLElement {
  const card = parent.createDiv({ cls: `lifeos-stat-card lifeos-card-subtle tone-${tone}` });
  const iconEl = card.createSpan({ cls: "lifeos-stat-icon" });
  setIcon(iconEl, icon);
  const copy = card.createDiv();
  copy.createDiv({ cls: "lifeos-stat-value", text: value });
  copy.createDiv({ cls: "lifeos-stat-label", text: label });
  return card;
}
