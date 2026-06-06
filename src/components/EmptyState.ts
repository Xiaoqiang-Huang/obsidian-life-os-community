import { setIcon } from "obsidian";
import { createButton } from "./Button";

export interface EmptyStateAction {
  label: string;
  icon?: string;
  primary?: boolean;
  onClick: () => void;
}

export function createEmptyState(
  parent: HTMLElement,
  options: {
    icon: string;
    title: string;
    description: string;
    actions?: EmptyStateAction[];
    compact?: boolean;
  }
): HTMLElement {
  const state = parent.createDiv({
    cls: options.compact ? "lifeos-empty-state is-compact" : "lifeos-empty-state"
  });
  setIcon(state.createSpan({ cls: "lifeos-empty-icon" }), options.icon);
  state.createEl("h3", { text: options.title });
  state.createEl("p", { text: options.description });

  if (options.actions?.length) {
    const actions = state.createDiv({ cls: "lifeos-empty-actions" });
    for (const action of options.actions) {
      createButton(actions, action.label, action.onClick, {
        icon: action.icon,
        primary: action.primary,
        ghost: !action.primary
      });
    }
  }

  return state;
}
