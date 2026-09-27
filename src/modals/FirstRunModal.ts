import { LifeOSModal as Modal } from "../components/LifeOSModal";
import { App, Notice, TFile } from "obsidian";
import type PersonalLifeSystemPlugin from "../main";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import { FileSystemService } from "../services/FileSystemService";
import { LocalCaptureService, type CaptureReceipt } from "../services/LocalCaptureService";

export class FirstRunModal extends Modal {
  private busy = false;
  private timer: number | null = null;
  private service: LocalCaptureService;
  constructor(app: App, private plugin: PersonalLifeSystemPlugin) {
    super(app);
    this.service = new LocalCaptureService(app, new FileSystemService(app, plugin.getRoot(), plugin.settings.directoryLanguage));
  }
  onOpen(): void { this.render(); }
  onClose(): void { if (this.timer !== null) window.clearTimeout(this.timer); void this.plugin.saveSettings().catch(() => {}); }
  private render(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-first-run-modal-host");
    const { body, footer } = createModalShell(this.contentEl, { title: "先记下一件小事", subtitle: "不必先配置 AI。记录先留在本地，联网是可选能力。", icon: "notebook-pen" });
    const state = this.plugin.settings.firstRunState;
    const status = body.createDiv({ cls: "lifeos-inline-status", attr: { role: "status", "aria-live": "polite" } });
    const run = async (action: () => Promise<void>) => {
      if (this.busy) return;
      this.busy = true;
      this.contentEl.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
      try { await action(); } catch (error) { const message = error instanceof Error ? error.message : String(error); status.textContent = message; new Notice(message, 7000); }
      finally { this.busy = false; this.contentEl.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = false); }
    };
    if (!state.receipt) {
      const presetLabel = body.createEl("label", { text: "我主要用来", cls: "lifeos-field" });
      const preset = presetLabel.createEl("select", { cls: "lifeos-input" });
      for (const [value, label] of [["life", "日常生活"], ["study", "学习成长"], ["research", "科研项目"]]) preset.createEl("option", { value, text: label });
      preset.value = state.preset || "life";
      preset.onchange = () => { state.preset = preset.value; this.saveDraft(); };
      const label = body.createEl("label", { text: "记一句", cls: "lifeos-field" });
      const input = label.createEl("textarea", { cls: "lifeos-input", attr: { rows: "5", maxlength: "16000", placeholder: "今天完成了什么，或想留住什么？" } });
      input.value = state.draft || "";
      input.oninput = () => { state.draft = input.value; this.saveDraft(); };
      body.createEl("p", { cls: "lifeos-muted", text: "草稿只保存在当前 Vault 的插件配置。保存不生成任务、不调用模型，也不发送到微信。" });
      createButton(footer, "先浏览", () => void run(() => this.finish()), { ghost: true });
      createButton(footer, "保存到本地", () => void run(async () => {
        if (!state.pending && (!state.draft.trim() || state.draft.length > 16000)) throw new Error("请填写 1–16000 字的记录。");
        state.id ||= `capture-${crypto.randomUUID()}`;
        // Keep the durable operation immutable while the draft remains editable.
        // After a receipt-config failure/restart, acknowledge A before saving A+B.
        state.pending ||= { id: state.id, snapshot: state.draft };
        const { id, snapshot } = state.pending;
        // Persist the operation identity before touching the Vault. A crash or
        // receipt-setting failure must retry the same file, not create a copy.
        if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
        await this.plugin.saveSettings();
        const receipt = await this.service.save(id, snapshot);
        state.receipt = receipt;
        // Input is still editable during I/O. Never discard text typed since save.
        if (state.draft === snapshot) state.draft = "";
        state.pending = undefined;
        try { await this.plugin.saveSettings(); } finally { this.render(); }
      }), { primary: true, icon: "save" });
    } else {
      const receipt = state.receipt as CaptureReceipt;
      body.createEl("p", { text: "上次保存的本地凭证", cls: "lifeos-save-receipt" });
      body.createEl("p", { text: receipt.path, cls: "lifeos-path", attr: { title: receipt.path } });
      if (state.draft) {
        body.createEl("p", { text: "保存期间的新输入仍保留在草稿中。" });
      }
      createButton(body, "继续编辑新草稿", () => { state.receipt = undefined; state.pending = undefined; state.id = ""; this.saveDraft(); this.render(); }, { icon: "pencil" });
      const result = body.createDiv({ cls: "lifeos-capture-result" });
      createButton(body, "我刚才记了什么？", () => void run(async () => { result.empty(); result.createEl("pre", { text: await this.service.find(receipt) }); }), { icon: "search" });
      const actions = body.createDiv({ cls: "lifeos-actions" });
      createButton(actions, "打开来源", () => void run(async () => {
        await this.service.find(receipt);
        const file = this.app.vault.getAbstractFileByPath(receipt.path);
        if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
      }), { icon: "file-text" });
      createButton(actions, "撤销这条记录", () => void run(async () => {
        await this.service.undo(receipt); state.receipt = undefined; state.id = "";
        await this.plugin.saveSettings(); this.render();
      }), { icon: "undo-2" });
      body.createEl("p", { cls: "lifeos-muted", text: "找回本地内容不依赖 AI。配置模型后，可在 AI 助手继续提问并引用资料。微信需要桌面插件和连接服务在线；手机不等于常驻服务器。记忆与自动建议可在设置中暂停。撤销保留空凭证文件，不删除后续人工编辑。" });
      createButton(footer, "进入今天", () => void run(() => this.finish()), { primary: true, icon: "arrow-right" });
    }
  }
  private saveDraft(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.plugin.saveSettings().catch(() => {}); }, 400);
  }
  private async finish(): Promise<void> {
    if (!this.plugin.settings.hasCompletedFirstRun) {
    const preset = this.plugin.settings.firstRunState.preset;
    this.plugin.settings.enableExamModule = preset === "study";
    this.plugin.settings.examProfileType = "custom";
    this.plugin.settings.customExamProfileName = preset === "study" ? "学习成长" : "日常记录";
    this.plugin.settings.sidebarPinnedItems = preset === "research" ? ["workspace", "chat", "tasks"]
      : preset === "study" ? ["dashboard", "checkins", "chat"] : ["dashboard", "chat", "tasks"];
    }
    this.plugin.settings.hasCompletedFirstRun = true;
    await this.plugin.saveSettings(); this.close();
    await this.plugin.activateDashboard();
  }
}
