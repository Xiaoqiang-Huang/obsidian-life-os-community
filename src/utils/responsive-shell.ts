import { Platform } from "obsidian";

const NARROW_PANE_WIDTH = 860;

type ResponsiveRoot = HTMLElement & {
  __lifeosResponsiveCleanup?: () => void;
};

function toggleClass(el: HTMLElement, cls: string, enabled: boolean): void {
  el.toggleClass(cls, enabled);
}

export function installLifeOSResponsiveShell(root: HTMLElement): () => void {
  const responsiveRoot = root as ResponsiveRoot;
  responsiveRoot.__lifeosResponsiveCleanup?.();

  let disposed = false;
  let resizeObserver: ResizeObserver | null = null;
  let detachObserver: MutationObserver | null = null;

  const update = () => {
    if (disposed) return;
    const width = root.getBoundingClientRect().width || root.clientWidth || 0;
    toggleClass(root, "lifeos-is-narrow-pane", width > 0 && width <= NARROW_PANE_WIDTH);
    toggleClass(root, "lifeos-is-mobile-runtime", Platform.isMobileApp);
    toggleClass(root, "lifeos-is-phone-runtime", Platform.isPhone);
    toggleClass(root, "lifeos-is-tablet-runtime", Platform.isTablet);
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    detachObserver?.disconnect();
    window.removeEventListener("resize", update);
    if (responsiveRoot.__lifeosResponsiveCleanup === cleanup) {
      delete responsiveRoot.__lifeosResponsiveCleanup;
    }
  };

  responsiveRoot.__lifeosResponsiveCleanup = cleanup;

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(root);
  } else {
    window.addEventListener("resize", update);
  }

  const parent = root.parentElement;
  if (parent && typeof MutationObserver === "function") {
    detachObserver = new MutationObserver(() => {
      if (!root.isConnected) cleanup();
    });
    detachObserver.observe(parent, { childList: true });
  }

  update();
  return cleanup;
}
