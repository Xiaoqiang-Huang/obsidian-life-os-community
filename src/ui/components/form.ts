import { createUiElement } from "../dom";

export interface UiFieldOptions {
  label: string;
  helper?: string;
  error?: string;
  className?: string;
}

export interface UiFieldParts {
  root: HTMLElement;
  control: HTMLElement;
  message: HTMLElement;
}

export function createUiField(parent: HTMLElement, options: UiFieldOptions): UiFieldParts {
  const root = createUiElement(parent, "label", { className: ["lifeos-v2-field", options.className ?? ""] });
  createUiElement(root, "span", { className: "lifeos-v2-field-label", text: options.label });
  const control = createUiElement(root, "span", { className: "lifeos-v2-field-control" });
  const message = createUiElement(root, "span", {
    className: ["lifeos-v2-field-message", options.error ? "is-error" : ""],
    text: options.error ?? options.helper ?? ""
  });
  return { root, control, message };
}

export function createUiTextInput(parent: HTMLElement, options: UiFieldOptions & { value?: string; placeholder?: string }): HTMLInputElement {
  const field = createUiField(parent, options);
  const input = createUiElement(field.control, "input", {
    className: "lifeos-v2-input",
    attr: { type: "text", placeholder: options.placeholder ?? "" }
  });
  input.value = options.value ?? "";
  return input;
}

export function createUiTextarea(parent: HTMLElement, options: UiFieldOptions & { value?: string; placeholder?: string }): HTMLTextAreaElement {
  const field = createUiField(parent, options);
  const textarea = createUiElement(field.control, "textarea", {
    className: "lifeos-v2-textarea",
    attr: { placeholder: options.placeholder ?? "" }
  });
  textarea.value = options.value ?? "";
  return textarea;
}

export function createUiSelect<T extends string>(
  parent: HTMLElement,
  options: UiFieldOptions & { value: T; choices: Array<{ value: T; label: string }> }
): HTMLSelectElement {
  const field = createUiField(parent, options);
  const select = createUiElement(field.control, "select", { className: "lifeos-v2-select" });
  for (const choice of options.choices) {
    const option = createUiElement(select, "option", { text: choice.label, attr: { value: choice.value } });
    option.selected = choice.value === options.value;
  }
  return select;
}
