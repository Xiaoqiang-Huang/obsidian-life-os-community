import { Modal } from "obsidian";
import { applyExperienceTheme } from "../ui/theme";

/** Scoped modal host. Native Obsidian still owns focus trapping, Escape and focus return. */
export class LifeOSModal extends Modal {
  open(): void {
    this.modalEl.classList.add("lifeos-v3", "lifeos-v3-modal");
    applyExperienceTheme(this.modalEl);
    super.open();
    // Obsidian 1.13 uses a header action instead of the legacy close class.
    // Keep the host's click handler and Escape/focus management intact.
    const close = this.modalEl.querySelector<HTMLElement>(
      ".modal-close-button, .modal-header-button:has(svg.lucide-x)"
    );
    if (close) {
      close.classList.add("modal-close-button");
      close.setAttribute("aria-label", "关闭弹窗");
      close.setAttribute("title", "关闭弹窗");
      close.setAttribute("role", "button");
      close.tabIndex = 0;
      if (close.tagName !== "BUTTON" && !close.dataset.lifeosCloseKeyboard) {
        close.dataset.lifeosCloseKeyboard = "true";
        close.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            close.click();
          }
        });
      }
    }
    if (!this.contentEl.classList.contains("lifeos-modal-shell")) this.contentEl.classList.add("lifeos-v3-plain-modal");
  }
}
