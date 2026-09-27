import { App, FuzzySuggestModal, TFile } from "obsidian";
import { isDocumentBackgroundPath } from "../ui/document-appearance";

export class DocumentBackgroundModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private choose: (file: TFile) => void) {
    super(app); this.setPlaceholder("搜索当前 Vault 的 PNG / JPEG / WebP 图片");
  }
  getItems(): TFile[] { return this.app.vault.getFiles().filter(file => isDocumentBackgroundPath(file.path)); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}
