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
  let observedParent: HTMLElement | null = null;
  let wasConnected = root.isConnected;
  let lastHeight = 0;

  // The shell is initially built in a detached staging element. Follow it to
  // its real parent when committed, otherwise later removals are never seen.
  const followParent = () => {
    if (observedParent === root.parentElement) return;
    if (observedParent) resizeObserver?.unobserve(observedParent);
    detachObserver?.disconnect();
    observedParent = root.parentElement;
    if (observedParent) {
      resizeObserver?.observe(observedParent);
      detachObserver?.observe(observedParent, { childList: true });
    }
  };

  const update = () => {
    layoutFrame = 0;
    if (disposed) return;
    if (wasConnected && !root.isConnected) { cleanup(); return; }
    wasConnected ||= root.isConnected;
    followParent();
    const width = measureAvailableWidth(root);
    const height = measureAvailableHeight(root);
    toggleClass(root, "lifeos-is-narrow-pane", width > 0 && width <= NARROW_PANE_WIDTH);
    toggleClass(root, "lifeos-is-compact-pane", width > 0 && width <= COMPACT_PANE_WIDTH);
    toggleClass(root, "lifeos-is-phone-pane", width > 0 && width <= PHONE_PANE_WIDTH);
    toggleClass(root, "lifeos-is-micro-pane", width > 0 && width <= MICRO_PANE_WIDTH);
    toggleClass(root, "lifeos-is-mobile-runtime", Platform.isMobileApp);
    toggleClass(root, "lifeos-is-phone-runtime", Platform.isPhone);
    toggleClass(root, "lifeos-is-tablet-runtime", Platform.isTablet);
    const roundedHeight = Math.round(height);
    if (roundedHeight > 0 && roundedHeight !== lastHeight) {
      root.style.setProperty("--lifeos-pane-viewport-height", `${roundedHeight}px`);
      lastHeight = roundedHeight;
    }
  };

  const scheduleUpdate = () => {
    if (disposed) return;
    if (wasConnected && !root.isConnected) { cleanup(); return; }
    if (!layoutFrame) layoutFrame = window.requestAnimationFrame(update);
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    detachObserver?.disconnect();
    if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
    window.removeEventListener("resize", scheduleUpdate);
    window.visualViewport?.removeEventListener("resize", scheduleUpdate);
    root.style.removeProperty("--lifeos-pane-viewport-height");
    root.removeAttribute("data-lifeos-responsive-root");
    if (responsiveRoot.__lifeosResponsiveCleanup === cleanup) {
      delete responsiveRoot.__lifeosResponsiveCleanup;
    }
  };

  responsiveRoot.__lifeosResponsiveCleanup = cleanup;
  root.setAttribute("data-lifeos-responsive-root", "");

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(root);
  } else {
    window.addEventListener("resize", scheduleUpdate);
  }
  window.visualViewport?.addEventListener("resize", scheduleUpdate);

  if (typeof MutationObserver === "function") {
    detachObserver = new MutationObserver(() => {
      if (root.isConnected) {
        wasConnected = true;
        followParent();
        scheduleUpdate();
      } else if (wasConnected) cleanup();
    });
  }

  followParent();
  update();
  scheduleUpdate();
  return cleanup;
}

/** Release both mounted shells and staging shells whose render was discarded. */
export function disposeLifeOSResponsiveShells(scope: HTMLElement): void {
  (scope as ResponsiveRoot).__lifeosResponsiveCleanup?.();
  scope.querySelectorAll<ResponsiveRoot>("[data-lifeos-responsive-root]").forEach((root) => {
    root.__lifeosResponsiveCleanup?.();
  });
}
