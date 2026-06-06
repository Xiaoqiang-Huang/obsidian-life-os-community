export function createCard(parent: HTMLElement, className = ""): HTMLElement {
  return parent.createDiv({ cls: `lifeos-card lifeos-glass-card lifeos-v2-card ${className}`.trim() });
}
