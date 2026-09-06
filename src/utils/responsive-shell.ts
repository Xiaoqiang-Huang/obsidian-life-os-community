import { Platform } from "obsidian";

const NARROW_PANE_WIDTH = 860;
const COMPACT_PANE_WIDTH = 760;
const PHONE_PANE_WIDTH = 520;
const MICRO_PANE_WIDTH = 380;

type ResponsiveRoot = HTMLElement & {
  __lifeosResponsiveCleanup?: () => void;
};

function toggleClass(el: HTMLElement, cls: string, enabled: boolean): void {
  el.toggleClass(cls, enabled);
}

function readPositiveWidth(el: Element | null | undefined): number | null {
  if (!el) return null;
  const htmlEl = el as HTMLElement;
  const width = Math.min(
    ...[el.getBoundingClientRect().width, htmlEl.clientWidth]
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  return Number.isFinite(width) ? width : null;
}

function readPositiveHeight(el: Element | null | undefined): number | null {
  if (!el) return null;
  const htmlEl = el as HTMLElement;
  const height = Math.min(
    ...[el.getBoundingClientRect().height, htmlEl.clientHeight]
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  return Number.isFinite(height) ? height : null;
}

/**
 * Measure the space the pane can actually use, rather than the root's intrinsic
 * width. Some legacy layouts have a min-width wider than their Obsidian leaf;
 * measuring only the root then misclassifies a phone-sized pane as desktop.
 */
function measureAvailableWidth(root: HTMLElement): number {
  const widths = [
    readPositiveWidth(root),
    readPositiveWidth(root.parentElement),
    readPositiveWidth(root.closest(".view-content")),
    window.visualViewport?.width ?? null,
    window.innerWidth,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return widths.length > 0 ? Math.min(...widths) : 0;
}

function measureAvailableHeight(root: HTMLElement): number {
  const heights = [
    readPositiveHeight(root.parentElement),
    readPositiveHeight(root.closest(".view-content")),
    window.visualViewport?.height ?? null,
    window.innerHeight,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return heights.length > 0 ? Math.min(...heights) : 0;
}

export function installLifeOSResponsiveShell(root: HTMLElement): () => void {
  const responsiveRoot = root as ResponsiveRoot;
  responsiveRoot.__lifeosResponsiveCleanup?.();

  let disposed = false;
  let resizeObserver: ResizeObserver | null = null;
  let detachObserver: MutationObserver | null = null;
  let layoutFrame = 0;

  const update = () => {
    if (disposed) return;
    const width = measureAvailableWidth(root);
    const height = measureAvailableHeight(root);
    toggleClass(root, "lifeos-is-narrow-pane", width > 0 && width <= NARROW_PANE_WIDTH);
    toggleClass(root, "lifeos-is-compact-pane", width > 0 && width <= COMPACT_PANE_WIDTH);
    toggleClass(root, "lifeos-is-phone-pane", width > 0 && width <= PHONE_PANE_WIDTH);
    toggleClass(root, "lifeos-is-micro-pane", width > 0 && width <= MICRO_PANE_WIDTH);
    toggleClass(root, "lifeos-is-mobile-runtime", Platform.isMobileApp);
    toggleClass(root, "lifeos-is-phone-runtime", Platform.isPhone);
    toggleClass(root, "lifeos-is-tablet-runtime", Platform.isTablet);
    if (height > 0) root.style.setProperty("--lifeos-pane-viewport-height", `${Math.round(height)}px`);
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    detachObserver?.disconnect();
    if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
    window.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("resize", update);
    root.style.removeProperty("--lifeos-pane-viewport-height");
    if (responsiveRoot.__lifeosResponsiveCleanup === cleanup) {
      delete responsiveRoot.__lifeosResponsiveCleanup;
    }
  };

  responsiveRoot.__lifeosResponsiveCleanup = cleanup;

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(root);
    if (root.parentElement) resizeObserver.observe(root.parentElement);
  } else {
    window.addEventListener("resize", update);
  }
  window.visualViewport?.addEventListener("resize", update);

  const parent = root.parentElement;
  if (parent && typeof MutationObserver === "function") {
    detachObserver = new MutationObserver(() => {
      if (!root.isConnected) cleanup();
    });
    detachObserver.observe(parent, { childList: true });
  }

  update();
  layoutFrame = window.requestAnimationFrame(update);
  return cleanup;
}
