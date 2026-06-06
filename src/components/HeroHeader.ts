import { setIcon } from "obsidian";
import { createButton } from "./Button";
import type { EmptyStateAction } from "./EmptyState";

export function createHeroHeader(
  parent: HTMLElement,
  options: {
    kicker: string;
    title: string;
    description: string;
    meta?: string;
    icon?: string;
    actions?: EmptyStateAction[];
  }
): HTMLElement {
  const hero = parent.createDiv({ cls: "lifeos-hero" });
  const copy = hero.createDiv({ cls: "lifeos-hero-copy" });
  copy.createDiv({ cls: "lifeos-kicker", text: options.kicker });
  const titleRow = copy.createDiv({ cls: "lifeos-hero-title-row" });
  if (options.icon) setIcon(titleRow.createSpan({ cls: "lifeos-hero-icon" }), options.icon);
  titleRow.createEl("h1", { text: options.title });
  copy.createEl("p", { text: options.description });

  const side = hero.createDiv({ cls: "lifeos-hero-side" });
  if (options.meta) side.createDiv({ cls: "lifeos-date-pill", text: options.meta });
  if (options.actions?.length) {
    const actions = side.createDiv({ cls: "lifeos-hero-actions" });
    for (const action of options.actions) {
      createButton(actions, action.label, action.onClick, {
        icon: action.icon,
        primary: action.primary,
        ghost: !action.primary
      });
    }
  }

  return hero;
}
