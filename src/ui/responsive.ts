import { Platform } from "obsidian";
import type { UiBreakpoint, UiDisposer, UiResponsiveSnapshot } from "./types";

const BREAKPOINT_CLASSES: UiBreakpoint[] = ["phone", "compact", "tablet", "desktop", "wide"];

export interface UiResponsiveRootOptions {
  classPrefix?: string;
  onChange?: (snapshot: UiResponsiveSnapshot) => void;
}

export function getUiBreakpoint(width: number): UiBreakpoint {
  if (width <= 420) return "phone";
  if (width <= 680) return "compact";
  if (width <= 1024) return "tablet";
  if (width <= 1440) return "desktop";
  return "wide";
}

export function createUiResponsiveSnapshot(width: number): UiResponsiveSnapshot {
  const breakpoint = getUiBreakpoint(width);
  return {
    width,
    breakpoint,
    isPhone: breakpoint === "phone",
    isCompact: breakpoint === "phone" || breakpoint === "compact",
    isWide: breakpoint === "wide"
  };
}

export const getLifeOSSizeTier = getUiBreakpoint;

export function applyLifeOSSizeTier(
  root: HTMLElement,
  width: number,
  classPrefix = "lifeos-ui"
): UiResponsiveSnapshot {
  const snapshot = createUiResponsiveSnapshot(width);
  for (const breakpoint of BREAKPOINT_CLASSES) {
    root.classList.toggle(`${classPrefix}-bp-${breakpoint}`, snapshot.breakpoint === breakpoint);
  }
  root.classList.toggle(`${classPrefix}-is-mobile`, Platform.isMobileApp || snapshot.isCompact);
  root.classList.toggle(`${classPrefix}-is-phone`, Platform.isPhone || snapshot.isPhone);
  root.classList.toggle(`${classPrefix}-is-tablet`, Platform.isTablet || snapshot.breakpoint === "tablet");
  root.dataset.lifeosUiBreakpoint = snapshot.breakpoint;
  return snapshot;
}

export function installUiResponsiveRoot(
  root: HTMLElement,
  options: UiResponsiveRootOptions = {}
): UiDisposer {
  const prefix = options.classPrefix ?? "lifeos-ui";
  let disposed = false;
  let resizeObserver: ResizeObserver | null = null;

  const update = () => {
    if (disposed) return;
    const width = root.getBoundingClientRect().width || root.clientWidth || window.innerWidth || 0;
    const snapshot = applyLifeOSSizeTier(root, width, prefix);
    options.onChange?.(snapshot);
  };

  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(root);
  } else {
    window.addEventListener("resize", update);
  }

  update();
  return () => {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    window.removeEventListener("resize", update);
    for (const breakpoint of BREAKPOINT_CLASSES) {
      root.classList.remove(`${prefix}-bp-${breakpoint}`);
    }
    root.classList.remove(`${prefix}-is-mobile`, `${prefix}-is-phone`, `${prefix}-is-tablet`);
    delete root.dataset.lifeosUiBreakpoint;
  };
}
