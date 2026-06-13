import type { GlassConfig, LiquidGlass as LiquidGlassClass } from "@ybouane/liquidglass";

type LiquidGlassInstance = LiquidGlassClass;

interface LiquidGlassModule {
  LiquidGlass: {
    init(options: {
      root: HTMLElement;
      glassElements: HTMLElement[];
      defaults?: Partial<GlassConfig>;
    }): Promise<LiquidGlassInstance>;
  };
  invalidateFontEmbedCache?: () => void;
}

const activeInstances = new WeakMap<HTMLElement, LiquidGlassInstance>();
const activeRoots = new Set<HTMLElement>();
let liquidGlassModulePromise: Promise<LiquidGlassModule> | null = null;

const GLASS_DEFAULTS: Partial<GlassConfig> = {
  blurAmount: 0.24,
  refraction: 0.82,
  chromAberration: 0.085,
  edgeHighlight: 0.2,
  specular: 0.34,
  fresnel: 1,
  distortion: 0.08,
  cornerRadius: 28,
  zRadius: 42,
  opacity: 0.96,
  saturation: 0.18,
  tintStrength: 0.13,
  brightness: 0.05,
  shadowOpacity: 0.22,
  shadowSpread: 18,
  shadowOffsetY: 10,
  floating: false,
  button: false,
  bevelMode: 0
};

export function destroyLifeOSLiquidGlassRuntime(scope?: ParentNode): void {
  for (const root of Array.from(activeRoots)) {
    if (!scope || root === scope || (scope instanceof Node && scope.contains(root))) {
      destroyRoot(root);
    }
  }
}

export async function refreshLifeOSLiquidGlassRuntime(scope: ParentNode = document): Promise<void> {
  destroyDetachedOrDisabledRoots();
  if (!supportsLiquidGlassRuntime()) return;

  const roots = collectLiquidGlassRoots(scope);
  if (roots.length === 0) return;

  const module = await loadLiquidGlassModule();
  for (const root of roots) {
    await mountRoot(root, module);
  }
}

function supportsLiquidGlassRuntime(): boolean {
  const canvas = document.createElement("canvas");
  return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
}

async function loadLiquidGlassModule(): Promise<LiquidGlassModule> {
  if (!liquidGlassModulePromise) {
    liquidGlassModulePromise = import("@ybouane/liquidglass") as Promise<unknown> as Promise<LiquidGlassModule>;
  }
  return liquidGlassModulePromise;
}

function collectLiquidGlassRoots(scope: ParentNode): HTMLElement[] {
  const roots = new Set<HTMLElement>();
  const selector = ".lifeos-root.lifeos-theme-liquid-glass .lifeos-main, .lifeos-settings.lifeos-theme-liquid-glass";
  if (scope instanceof HTMLElement && scope.matches(selector)) roots.add(scope);
  scope.querySelectorAll?.(selector).forEach((element) => {
    if (element instanceof HTMLElement) roots.add(element);
  });
  return Array.from(roots).filter((root) => root.isConnected && root.offsetWidth >= 80 && root.offsetHeight >= 80);
}

async function mountRoot(root: HTMLElement, module: LiquidGlassModule): Promise<void> {
  const glassElements = collectGlassElements(root);
  if (glassElements.length === 0) {
    destroyRoot(root);
    return;
  }

  const signature = glassElements.map((element, index) => `${index}:${Array.from(element.classList).sort().join(".")}`).join("|");
  if (root.dataset.lifeosLiquidglassSignature === signature && activeInstances.has(root)) {
    activeInstances.get(root)?.markChanged();
    return;
  }

  destroyRoot(root);
  ensureBackdrop(root);
  root.addClass("lifeos-liquidglass-root");
  root.dataset.lifeosLiquidglassSignature = signature;

  for (const element of glassElements) {
    element.addClass("lifeos-liquidglass-target");
    element.dataset.config = JSON.stringify({
      ...GLASS_DEFAULTS,
      button: element.matches("button, .lifeos-button, .lifeos-action-tile, .lifeos-nav-item")
    });
  }

  try {
    const instance = await module.LiquidGlass.init({
      root,
      glassElements,
      defaults: GLASS_DEFAULTS
    });
    activeInstances.set(root, instance);
    activeRoots.add(root);
    root.removeClass("lifeos-liquidglass-runtime-fallback");
  } catch (error) {
    console.warn("[Life OS] LiquidGlass runtime fell back to CSS glass.", error);
    root.addClass("lifeos-liquidglass-runtime-fallback");
    cleanupRootAttributes(root, { keepFallback: true });
  }
}

function collectGlassElements(root: HTMLElement): HTMLElement[] {
  ensureBackdrop(root);
  return Array.from(root.children).filter((element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.hasClass("lifeos-liquidglass-backdrop")) return false;
    if (element.hasClass("lifeos-liquidglass-no-runtime")) return false;
    if (element.offsetWidth < 80 || element.offsetHeight < 44) return false;
    return true;
  }).slice(0, 8);
}

function ensureBackdrop(root: HTMLElement): HTMLElement {
  const existing = Array.from(root.children).find((child) => child instanceof HTMLElement && child.hasClass("lifeos-liquidglass-backdrop"));
  if (existing instanceof HTMLElement) return existing;

  const backdrop = document.createElement("div");
  backdrop.className = "lifeos-liquidglass-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  root.insertBefore(backdrop, root.firstChild);
  return backdrop;
}

function destroyDetachedOrDisabledRoots(): void {
  for (const root of Array.from(activeRoots)) {
    const themeRoot = root.closest(".lifeos-root.lifeos-theme-liquid-glass, .lifeos-settings.lifeos-theme-liquid-glass");
    if (!root.isConnected || !themeRoot) destroyRoot(root);
  }
}

function destroyRoot(root: HTMLElement): void {
  const instance = activeInstances.get(root);
  if (instance) {
    try {
      instance.destroy();
    } catch (error) {
      console.warn("[Life OS] LiquidGlass runtime destroy failed.", error);
    }
  }
  activeInstances.delete(root);
  activeRoots.delete(root);
  cleanupRootAttributes(root);
}

function cleanupRootAttributes(root: HTMLElement, options: { keepFallback?: boolean } = {}): void {
  root.removeClass("lifeos-liquidglass-root");
  if (!options.keepFallback) root.removeClass("lifeos-liquidglass-runtime-fallback");
  delete root.dataset.lifeosLiquidglassSignature;
  root.querySelectorAll<HTMLElement>(".lifeos-liquidglass-target").forEach((element) => {
    element.removeClass("lifeos-liquidglass-target");
    delete element.dataset.config;
  });
}
