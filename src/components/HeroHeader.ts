import { installHostPopoverScope } from "../utils/host-popover-scope";
import { setIcon, type App } from "obsidian";
import { createButton } from "./Button";
import type { EmptyStateAction } from "./EmptyState";

export function createHeroHeader(
  parent: HTMLElement,
  options: {
    app: App;
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
    const more = options.actions.length > 2 ? actions.createEl("details", { cls: "lifeos-page-more" }) : null;
    if (more) more.createEl("summary", { text: "更多", attr: { "aria-label": `${options.kicker}更多操作` } });
    const menu = more?.createDiv({ cls: "lifeos-page-more-menu" });
    options.actions.forEach((action, index) => {
      const host = index < 2 ? actions : menu || actions;
      const button = createButton(host, action.label, () => { if (more) more.open = false; action.onClick(); }, {
        icon: action.icon,
        primary: action.primary,
        ghost: !action.primary
      });
      if (host === actions && more) actions.insertBefore(button, more);
    });
    if (more) installHostPopoverScope(more, options.app);
  }

  return hero;
}
