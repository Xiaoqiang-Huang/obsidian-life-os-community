import { createUiButton } from "../ui/components/button";

export function createButton(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  options: { icon?: string; primary?: boolean; ghost?: boolean; className?: string } = {}
): HTMLButtonElement {
  const classes = ["lifeos-button", "lifeos-glass-button"];
  if (options.primary) classes.push("lifeos-button-primary");
  if (options.ghost) classes.push("lifeos-button-ghost");
  if (options.className) classes.push(options.className);
  const button = createUiButton(parent, {
    label,
    icon: options.icon,
    primary: options.primary,
    ghost: options.ghost,
    className: classes.join(" "),
    onClick
  });
  button.querySelector<HTMLElement>(".lifeos-v2-button-icon")?.classList.add("lifeos-button-icon");
  return button;
}
