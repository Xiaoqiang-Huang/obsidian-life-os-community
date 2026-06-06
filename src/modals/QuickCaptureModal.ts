import { App, Modal, Notice, setIcon } from "obsidian";
import { createButton } from "../components/Button";
import { createModalShell } from "../components/ModalShell";
import type PersonalLifeSystemPlugin from "../main";
import { DailyNoteService } from "../services/DailyNoteService";
import { FileSystemService } from "../services/FileSystemService";
import { MemoryService } from "../services/MemoryService";
import type { QuickCaptureTarget } from "../types";
import { formatTime, today } from "../utils/dates";
import { randomId } from "../utils/ids";
import { ensureFile } from "../utils/vault";

const TARGETS: Array<{ id: QuickCaptureTarget; label: string; icon: string; hint: string; success: string }> = [
  { id: "daily", label: "今日日记", icon: "sun", hint: "记录今天", success: "已写入今日日记" },
  { id: "inbox", label: "收集箱", icon: "inbox", hint: "稍后整理", success: "已放入收集箱" },
  { id: "task", label: "待办", icon: "check-square", hint: "变成行动", success: "已添加到任务" },
  { id: "memory", label: "记忆候选", icon: "brain", hint: "确认后沉淀", success: "已加入记忆候选" }
];

export class QuickCaptureModal extends Modal {
  private selected: QuickCaptureTarget;

  constructor(
    app: App,
    private plugin: PersonalLifeSystemPlugin,
    private initialText = "",
    initialTarget: QuickCaptureTarget = "daily"
  ) {
    super(app);
    this.selected = initialTarget;
  }

  onOpen(): void {
    this.modalEl.addClass("lifeos-modal-host", "lifeos-quick-capture-modal-host", "lifeos-quick-modal-host");

    const { body, footer } = createModalShell(this.contentEl, {
      title: "快速记录",
      subtitle: "想到什么，先放进 Life OS。",
      icon: "pencil-line",
      className: "lifeos-quick-modal lifeos-command-modal"
    });

    const textarea = body.createEl("textarea", {
      cls: "lifeos-input lifeos-soft-input lifeos-glass-input lifeos-capture-textarea",
      attr: { placeholder: "写下一条想法、待办、灵感或日记片段..." }
    });
    textarea.value = this.initialText;
    textarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void this.submit(textarea.value);
      }
    });

    const grid = body.createDiv({ cls: "lifeos-capture-targets" });
    let sourceEl: HTMLElement | null = null;
    const renderTargets = () => {
      grid.empty();
      for (const target of TARGETS) {
        const button = grid.createEl("button", {
          cls: target.id === this.selected
            ? "lifeos-capture-target lifeos-chip lifeos-glass-button is-active"
            : "lifeos-capture-target lifeos-chip lifeos-glass-button",
          attr: { type: "button" }
        });
        setIcon(button.createSpan({ cls: "lifeos-capture-target-icon" }), target.icon);
        button.createSpan({ cls: "lifeos-capture-target-label", text: target.label });
        button.setAttr("aria-label", `${target.label}：${target.hint}`);
        button.onclick = () => {
          this.selected = target.id;
          sourceEl?.setText(this.currentLocationText());
          renderTargets();
        };
      }
    };
    renderTargets();

    footer.addClass("lifeos-quick-footer");
    sourceEl = footer.createDiv({ cls: "lifeos-capture-source", text: this.currentLocationText() });
    const actions = footer.createDiv({ cls: "lifeos-toolbar lifeos-glass-toolbar" });
    createButton(actions, "取消", () => this.close(), { ghost: true });
    createButton(actions, "保存", () => void this.submit(textarea.value), { icon: "send", primary: true });

    window.setTimeout(() => textarea.focus(), 20);
  }

  private currentLocationText(): string {
    if (this.selected === "daily") return "保存到：今日日记";
    if (this.selected === "inbox") return "保存到：收集箱";
    if (this.selected === "task") return "保存到：待办任务";
    return "保存到：记忆候选";
  }

  private async submit(value: string): Promise<void> {
    const content = value.trim();
    if (!content) {
      new Notice("先写一点内容，再保存到 Life OS。");
      return;
    }

    await this.capture(this.selected, content);
    const target = TARGETS.find((item) => item.id === this.selected);
    new Notice(target?.success ?? "已保存到 Life OS", 5000);
    this.close();
  }

  private async capture(target: QuickCaptureTarget, content: string): Promise<string> {
    await this.plugin.ensureBaseStructure();
    const fs = new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage);
    const daily = new DailyNoteService(this.app, fs, this.plugin.settings);
    const date = today();
    const time = formatTime();

    if (target === "daily") {
      const file = await daily.appendQuickRecord(content);
      return file.path;
    }

    if (target === "inbox") {
      const path = fs.path("Inbox", `${date}.md`);
      const file = await ensureFile(this.app, path, `# ${date} 收集箱\n\n`);
      await this.app.vault.append(file, `- ${time} ${content}\n`);
      return path;
    }

    if (target === "task") {
      const path = fs.path("Tasks", "open.md");
      const file = await ensureFile(this.app, path, "# 未完成待办\n\n");
      await this.app.vault.append(file, `- [ ] ${content} #pls/task ^${randomId("task")}\n`);
      return path;
    }

    const path = fs.path("Memory", "Inbox", "pending-memories.md");
    await new MemoryService(this.app, fs).appendCandidate({
      content,
      source: "quick-capture",
      created: `${date} ${time}`
    });
    return path;
  }
}
