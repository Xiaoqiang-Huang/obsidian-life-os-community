import { Scope, type App } from "obsidian";

/** A visible popover owns Escape before Obsidian can act on its underlying pane.
 * Document/window observers exist only while open, never until plugin unload.
 */
export function installHostPopoverScope(popover: HTMLDetailsElement, app: App, initialFocus?: HTMLElement): void {
  const scope = new Scope(app.scope);
  let scoped = false;
  let detachObserver: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  const releaseScope = () => {
    if (scoped) app.keymap.popScope(scope);
    scoped = false;
    detachObserver?.disconnect(); detachObserver = null;
    resizeObserver?.disconnect(); resizeObserver = null;
    popover.ownerDocument.defaultView?.removeEventListener("resize", checkVisibility);
  };
  const checkVisibility = () => {
    if (scoped && (!popover.isConnected || !popover.getClientRects().length)) {
      popover.open = false; releaseScope();
    }
  };
  const close = () => {
    popover.open = false; releaseScope();
    const summary = popover.querySelector("summary");
    if (summary?.isConnected) summary.focus({ preventScroll: true });
  };
  scope.register([], "Escape", event => {
    event.preventDefault(); event.stopPropagation(); close(); return false;
  });
  popover.addEventListener("toggle", () => {
    releaseScope();
    if (!popover.open) return;
    // A restored child may still be inside a collapsed parent. Close it rather
    // than keeping open=true without a Scope when that parent later reopens.
    if (!popover.isConnected || !popover.getClientRects().length) { popover.open = false; return; }
    initialFocus?.focus({ preventScroll: true });
    app.keymap.pushScope(scope); scoped = true;
    detachObserver = new MutationObserver(checkVisibility);
    detachObserver.observe(popover.ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "style", "open"] });
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(checkVisibility); resizeObserver.observe(popover);
    }
    popover.ownerDocument.defaultView?.addEventListener("resize", checkVisibility);
  });
  popover.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }, true);
}
