import type { UiPageKey } from "../settings";
import { createUiDisposerStack, type UiDisposerStack } from "./events";
import type { UiDisposer } from "./types";

export class LifeOSPageController {
  readonly disposers: UiDisposerStack;
  private destroyed = false;

  constructor(
    readonly root: HTMLElement,
    readonly page: UiPageKey
  ) {
    this.disposers = createUiDisposerStack();
    root.classList.add("lifeos-v2", `lifeos-v2-page-${page}`);
  }

  add(disposer: UiDisposer | undefined | null): UiDisposer {
    if (this.destroyed) {
      disposer?.();
      return () => undefined;
    }
    return this.disposers.add(disposer);
  }

  listen(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions
  ): UiDisposer {
    if (this.destroyed) return () => undefined;
    return this.disposers.listen(target, type, handler, options);
  }

  setBusy(isBusy: boolean): void {
    this.root.classList.toggle("is-busy", isBusy);
    this.root.setAttribute("aria-busy", isBusy ? "true" : "false");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disposers.clear();
    this.root.classList.remove("lifeos-v2", `lifeos-v2-page-${this.page}`, "is-busy");
    this.root.removeAttribute("aria-busy");
  }
}
