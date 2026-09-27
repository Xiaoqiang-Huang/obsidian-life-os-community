import { LifeOSModal as Modal } from "../components/LifeOSModal";
import { App, Notice, TFile } from "obsidian";
import type PersonalLifeSystemPlugin from "../main";
import { createModalShell } from "../components/ModalShell";
import { createButton } from "../components/Button";
import { FileSystemService } from "../services/FileSystemService";
import { TaskSuggestionService } from "../services/TaskSuggestionService";
import { parseTaskLine } from "../tasks/task-actions";

export class TaskSuggestionsModal extends Modal {
  private selected = new Set<string>();
  private busy = false;
  private closed = false;
  private service: TaskSuggestionService;
  constructor(app: App, private plugin: PersonalLifeSystemPlugin, private changed: () => void) {
    super(app);
    this.service = new TaskSuggestionService(app, new FileSystemService(app, plugin.getRoot(), plugin.settings.directoryLanguage));
  }
  onOpen(): void { this.closed = false; void this.render(); }
  onClose(): void { this.closed = true; }
  private async render(): Promise<void> {
    this.modalEl.addClass("lifeos-modal-host");
    const { body, footer } = createModalShell(this.contentEl, { title: "候选任务建议", subtitle: "后台建议先放在这里。只有确认后才加入任务；忽略后不会因重启或来源日期变化重复推荐。", icon: "list-filter" });
    const status = body.createEl("p", { text: "正在读取候选…", attr: { role: "status" } });
    try {
      const snapshot = await this.service.snapshot();
      if (this.closed) return;
      const visible = new Set(snapshot.pending.map(p => p.id));
      this.selected = new Set([...this.selected].filter(id => visible.has(id)));
      status.setText(`待确认 ${snapshot.pending.length} 条 · 今天已建议 ${snapshot.usedToday}/${this.plugin.settings.taskSuggestionDailyLimit} 条${this.plugin.settings.taskSuggestionsPaused ? " · 已暂停" : ""}`);
      const allLabel = body.createEl("label", { cls: "lifeos-suggestion-select-all" });
      const all = allLabel.createEl("input", { attr: { type: "checkbox", "aria-label": "全选候选建议" } });
      allLabel.createSpan({ text: "全选候选建议" });
      const checks = new Map<string, HTMLInputElement>();
      const sync = () => { all.checked = visible.size > 0 && this.selected.size === visible.size; all.indeterminate = this.selected.size > 0 && !all.checked; };
      all.onchange = () => { this.selected = all.checked ? new Set(visible) : new Set(); for (const [id, input] of checks) input.checked = this.selected.has(id); sync(); };
      for (const p of snapshot.pending) {
        const row = body.createDiv({ cls: "lifeos-suggestion-row" });
        const label = row.createEl("label");
        const input = label.createEl("input", { attr: { type: "checkbox", "aria-label": `选择 ${parseTaskLine(p.line)?.title ?? p.line}` } });
        input.checked = this.selected.has(p.id); checks.set(p.id, input);
        input.onchange = () => { if (input.checked) this.selected.add(p.id); else this.selected.delete(p.id); sync(); };
        label.createSpan({ text: parseTaskLine(p.line)?.title ?? p.line });
        createButton(row, `来源：${p.sourcePath.split("/").pop()}`, () => {
          const file = this.app.vault.getAbstractFileByPath(p.sourcePath);
          if (file instanceof TFile) void this.app.workspace.getLeaf(true).openFile(file);
          else new Notice("来源已移动或删除，候选内容仍保留。");
        }, { ghost: true, icon: "file-text" }).title = p.sourcePath;
      }
      if (!visible.size) body.createEl("p", { text: "没有待处理建议。你的任务不会因为启动或自动分析而直接增加。" });
      sync();
      const run = async (decision: "accept" | "reject") => {
        if (this.busy || !this.selected.size) return;
        this.busy = true;
        const buttons = Array.from(footer.querySelectorAll("button")); buttons.forEach(b => b.disabled = true);
        try {
          const result = await this.service.decide([...this.selected], decision);
          this.selected.clear();
          new Notice(decision === "accept" ? `已确认 ${result.handled} 条，实际新增 ${result.added.length} 个任务（已有/已删除的不会重复添加）。` : `已忽略 ${result.handled} 条建议。`);
          this.changed();
          if (!this.closed) await this.render();
        } catch (error) {
          status.setText(`处理失败，选择已保留：${error instanceof Error ? error.message : error}`);
          status.setAttr("role", "alert");
        } finally { this.busy = false; buttons.forEach(b => b.disabled = false); }
      };
      createButton(footer, "忽略所选", () => void run("reject"), { ghost: true, icon: "x" });
      createButton(footer, "确认加入任务", () => void run("accept"), { primary: true, icon: "check" });
    } catch (error) {
      status.setText(`读取失败：${error instanceof Error ? error.message : error}`); status.setAttr("role", "alert");
      createButton(footer, "重试读取", () => void this.render(), { icon: "refresh-cw" });
    }
    createButton(footer, "关闭", () => this.close(), { ghost: true });
  }
}
