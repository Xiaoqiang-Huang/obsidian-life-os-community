import { disposeLifeOSResponsiveShells } from "./responsive-shell";

interface ScrollPosition {
  element: HTMLElement;
  top: number;
  left: number;
}

interface KeyedScrollPosition {
  key: string;
  top: number;
  left: number;
}

export interface StableViewState {
  fixed: ScrollPosition[];
  keyed: KeyedScrollPosition[];
  focus?: { key: string; start: number | null; end: number | null };
}

export interface StableViewRenderOptions {
  preserveScroll?: boolean;
  isCurrent?: () => boolean;
}

function scrollableAncestors(container: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];
  let current: HTMLElement | null = container;
  while (current) {
    elements.push(current);
    current = current.parentElement;
  }
  return elements;
}

export function captureStableViewState(container: HTMLElement): StableViewState {
  const fixed = scrollableAncestors(container).map((element) => ({
    element,
    top: element.scrollTop,
    left: element.scrollLeft
  }));
  const keyed = Array.from(container.querySelectorAll<HTMLElement>("[data-lifeos-scroll-key]"))
    .map((element) => ({
      key: element.dataset.lifeosScrollKey ?? "",
      top: element.scrollTop,
      left: element.scrollLeft
    }))
    .filter((entry) => Boolean(entry.key));
  const active = container.ownerDocument.activeElement as HTMLInputElement | null;
  const key = active && container.contains(active) ? active.getAttribute("data-lifeos-focus-key") : null;
  const focus = key ? {key, start: active!.selectionStart ?? null, end: active!.selectionEnd ?? null} : undefined;
  return { fixed, keyed, focus };
}

export function restoreStableViewState(
  container: HTMLElement,
  state: StableViewState,
  isCurrent: () => boolean = () => true
): void {
  let cancelled = false;
  let frame = 0;
  let timer = 0;
  const interactionEvents = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
  const cancelPendingRestore = (): void => {
    cancelled = true;
    if (frame) window.cancelAnimationFrame(frame);
    if (timer) window.clearTimeout(timer);
    for (const event of interactionEvents) window.removeEventListener(event, cancelPendingRestore, true);
  };
  const apply = (): void => {
    if (cancelled || !isCurrent() || !container.isConnected) return;
    for (const entry of state.fixed) {
      entry.element.scrollTop = entry.top;
      entry.element.scrollLeft = entry.left;
    }
    for (const entry of state.keyed) {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(entry.key)
        : entry.key.replace(/["\\]/g, "\\$&");
      const element = container.querySelector<HTMLElement>(`[data-lifeos-scroll-key="${escaped}"]`);
      if (!element) continue;
      element.scrollTop = entry.top;
      element.scrollLeft = entry.left;
    }
  };

  // Keep the late layout correction, but never let it undo a new gesture.
  // Otherwise the 80ms callback scrolls the next clicked control out from
  // under the pointer. Capture early enough to see input before its handlers.
  for (const event of interactionEvents) {
    window.addEventListener(event, cancelPendingRestore, { capture: true, passive: true });
  }
  // Only explicitly keyed controls opt into focus restoration. Do this once,
  // never in late layout callbacks that could steal a user's newer focus.
  if (state.focus && isCurrent() && container.isConnected) {
    const next = Array.from(container.querySelectorAll<HTMLInputElement>("[data-lifeos-focus-key]"))
      .find((element) => element.dataset.lifeosFocusKey === state.focus!.key);
    if (next && !next.disabled) {
      next.focus({preventScroll: true});
      if (state.focus.start !== null && typeof next.setSelectionRange === "function") {
        try { next.setSelectionRange(state.focus.start, state.focus.end); } catch { /* Non-text input. */ }
      }
    }
  }
  apply();
  frame = window.requestAnimationFrame(() => { frame = 0; apply(); });
  timer = window.setTimeout(() => {
    timer = 0;
    try { apply(); } finally { cancelPendingRestore(); }
  }, 80);
}

/**
 * Build a complete view away from the visible DOM, then swap it in once.
 * This prevents the blank frame caused by `empty()` followed by asynchronous
 * reads, while retaining the reader's main and nested scroll positions.
 */
export async function renderStableView(
  container: HTMLElement,
  build: (staging: HTMLElement) => void | Promise<void>,
  options: StableViewRenderOptions = {}
): Promise<boolean> {
  const preserveScroll = options.preserveScroll !== false;
  const isCurrent = options.isCurrent ?? (() => true);
  if (!isCurrent()) return false;
  const staging = document.createElement("div");
  let committed = false;
  try {
    await build(staging);
    if (!isCurrent()) return false;
    // The old DOM remains interactive while build awaits I/O. Snapshot at the
    // commit boundary, not before the read, so new scrolling is never undone.
    const state = preserveScroll ? captureStableViewState(container) : null;
    disposeLifeOSResponsiveShells(container);
    container.replaceChildren(...Array.from(staging.childNodes));
    committed = true;
    if (state) restoreStableViewState(container, state, isCurrent);
    return true;
  } finally {
    if (!committed) disposeLifeOSResponsiveShells(staging);
  }
}
