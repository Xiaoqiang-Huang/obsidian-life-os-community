export function createSegmentedTabs<T extends string>(
  parent: HTMLElement,
  items: Array<{ id: T; label: string; count?: number; hint?: string }>,
  active: T,
  onChange: (id: T) => void
): HTMLElement {
  const tabs = parent.createDiv({ cls: "lifeos-segmented-tabs" });
  let currentActive = active;
  const buttons: Array<{ id: T; button: HTMLButtonElement }> = [];
  for (const item of items) {
    const button = tabs.createEl("button", {
      cls: item.id === active ? "is-active" : "",
      attr: { type: "button", "aria-pressed": item.id === active ? "true" : "false" }
    });
    button.createSpan({ text: item.label });
    if (typeof item.count === "number") button.createSpan({ cls: "lifeos-tab-count", text: String(item.count) });
    if (item.hint) button.setAttr("aria-label", `${item.label}，${item.hint}`);
    buttons.push({ id: item.id, button });
    button.onclick = () => {
      if (currentActive === item.id) return;
      currentActive = item.id;
      for (const entry of buttons) {
        const selected = entry.id === currentActive;
        entry.button.toggleClass("is-active", selected);
        entry.button.setAttr("aria-pressed", selected ? "true" : "false");
      }
      onChange(item.id);
    };
  }
  return tabs;
}

export function createChipGroup<T extends string>(
  parent: HTMLElement,
  label: string,
  items: Array<{ id: T; label: string }>,
  active: T,
  onChange: (id: T) => void
): HTMLElement {
  const group = parent.createDiv({ cls: "lifeos-chip-group" });
  group.createSpan({ cls: "lifeos-chip-label", text: label });
  const chips = group.createDiv({ cls: "lifeos-chips" });
  let currentActive = active;
  const buttons: Array<{ id: T; button: HTMLButtonElement }> = [];
  for (const item of items) {
    const button = chips.createEl("button", {
      cls: item.id === active ? "lifeos-chip is-active" : "lifeos-chip",
      attr: { type: "button", "aria-pressed": item.id === active ? "true" : "false" }
    });
    button.createSpan({ text: item.label });
    buttons.push({ id: item.id, button });
    button.onclick = () => {
      if (currentActive === item.id) return;
      currentActive = item.id;
      for (const entry of buttons) {
        const selected = entry.id === currentActive;
        entry.button.toggleClass("is-active", selected);
        entry.button.setAttr("aria-pressed", selected ? "true" : "false");
      }
      onChange(item.id);
    };
  }
  return group;
}
