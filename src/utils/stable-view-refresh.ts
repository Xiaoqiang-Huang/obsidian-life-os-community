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
  return { fixed, keyed };
}

export function restoreStableViewState(
  container: HTMLElement,
  state: StableViewState,
  isCurrent: () => boolean = () => true
): void {
  const apply = (): void => {
    if (!isCurrent() || !container.isConnected) return;
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

  apply();
  window.requestAnimationFrame(apply);
  window.setTimeout(apply, 80);
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
  const state = preserveScroll ? captureStableViewState(container) : null;
  const staging = document.createElement("div");
  await build(staging);
  if (!isCurrent()) return false;

  container.replaceChildren(...Array.from(staging.childNodes));
  if (state) restoreStableViewState(container, state, isCurrent);
  return true;
}
