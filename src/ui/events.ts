import type { UiDisposer } from "./types";

export interface UiDisposerStack {
  add(disposer: UiDisposer | undefined | null): UiDisposer;
  listen(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): UiDisposer;
  clear(): void;
  readonly size: number;
}

export function onUiEvent(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions
): UiDisposer {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export function createUiDisposerStack(): UiDisposerStack {
  const disposers: UiDisposer[] = [];
  return {
    add(disposer) {
      if (!disposer) return () => undefined;
      disposers.push(disposer);
      return disposer;
    },
    listen(target, type, handler, options) {
      const disposer = onUiEvent(target, type, handler, options);
      disposers.push(disposer);
      return disposer;
    },
    clear() {
      while (disposers.length > 0) {
        const disposer = disposers.pop();
        try {
          disposer?.();
        } catch (error) {
          console.warn("[Life OS UI] disposer failed", error);
        }
      }
    },
    get size() {
      return disposers.length;
    }
  };
}
