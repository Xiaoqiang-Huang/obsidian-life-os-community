import { createUiIcon, createUiElement, setUiBusy } from "../dom";
import { onUiEvent, type UiDisposerStack } from "../events";
import type { UiAction } from "../types";

export interface UiButtonOptions extends UiAction {
  className?: string;
  type?: "button" | "submit" | "reset";
  disposers?: Pick<UiDisposerStack, "listen">;
}

export function createUiButton(parent: HTMLElement, options: UiButtonOptions): HTMLButtonElement {
  const classes = [
    "lifeos-v2-button",
    `is-${options.tone ?? "neutral"}`,
    `is-${options.size ?? "md"}`,
    options.primary ? "is-primary" : "",
    options.ghost ? "is-ghost" : "",
    options.className ?? ""
  ];
  const button = createUiElement(parent, "button", {
    className: classes,
    attr: {
      type: options.type ?? "button",
      "aria-label": options.ariaLabel ?? options.label
    }
  });
  if (options.icon) createUiIcon(button, options.icon, "lifeos-v2-button-icon");
  const label = createUiElement(button, "span", { className: "lifeos-v2-button-label", text: options.label });
  if (options.disabledReason) button.title = options.disabledReason;
  button.disabled = options.disabled === true;

  if (options.onClick) {
    const listen = options.disposers?.listen.bind(options.disposers) ?? onUiEvent;
    listen(button, "click", (event: Event) => {
      if (button.disabled) return;
      const result = options.onClick?.(event as MouseEvent);
      if (!result || typeof (result as Promise<void>).then !== "function") return;
      const original = label.textContent ?? options.label;
      button.disabled = true;
      setUiBusy(button, true);
      if (options.loadingLabel) label.textContent = options.loadingLabel;
      void Promise.resolve(result).finally(() => {
        button.disabled = options.disabled === true;
        setUiBusy(button, false);
        label.textContent = original;
      });
    });
  }

  return button;
}

export const createLifeOSButton = createUiButton;
