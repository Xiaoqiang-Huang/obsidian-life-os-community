import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import type { IPlugin } from "./plugin-api";
import { ensureFile, formatDate, makeId } from "./utils";
import { FileSystemService } from "./services/FileSystemService";
import { MemoryService } from "./services/MemoryService";

type CaptureTarget = "daily" | "inbox" | "task" | "memory-inbox";

interface CaptureTargetOption {
  value: CaptureTarget;
  label: string;
  icon: string;
  hint: string;
}

const CAPTURE_TARGETS: CaptureTargetOption[] = [
  { value: "daily", label: "每日记录", icon: "sun", hint: "写入今日记录" },
  { value: "inbox", label: "收集箱", icon: "inbox", hint: "稍后处理" },
  { value: "task", label: "待办任务", icon: "check-square", hint: "进入任务池" },
  { value: "memory-inbox", label: "记忆候选", icon: "sprout", hint: "沉淀长期记忆" }
];

export class QuickCaptureModal extends Modal {
  constructor(
    app: App,
    private plugin: IPlugin,
    private initialText = ""
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal", "pls-quick-capture-modal");
    const header = contentEl.createDiv({ cls: "pls-modal-hero" });
    const title = header.createDiv();
    const titleLine = title.createEl("h2");
    setIcon(titleLine.createSpan({ cls: "pls-section-title-icon" }), "zap");
    titleLine.createSpan({ text: "快速记录" });
    title.createEl("p", {
      cls: "pls-muted",
      text: "想到就记，自动归档到合适的位置。"
    });

    const form = contentEl.createDiv({ cls: "pls-form-grid" });
    const targetSelect = form.createEl("select");
    for (const target of CAPTURE_TARGETS) {
      targetSelect.createEl("option", { value: target.value, text: target.label });
    }
    targetSelect.value = "inbox";

    const textarea = form.createEl("textarea", {
      attr: { placeholder: "此刻的想法、灵感或待办..." }
    });
    textarea.value = this.initialText;
    textarea.rows = 7;

    const targetCards = contentEl.createDiv({ cls: "pls-capture-target-grid" });
    for (const target of CAPTURE_TARGETS) {
      const card = targetCards.createEl("button", {
        cls: target.value === targetSelect.value ? "pls-capture-target is-active" : "pls-capture-target",
        attr: { type: "button" }
      });
      setIcon(card.createSpan({ cls: "pls-capture-target-icon" }), target.icon);
      card.createSpan({ cls: "pls-capture-target-title", text: target.label });
      card.createSpan({ cls: "pls-capture-target-hint", text: target.hint });
      card.onclick = () => {
        targetSelect.value = target.value;
        targetCards.querySelectorAll(".pls-capture-target").forEach((el) => el.removeClass("is-active"));
        card.addClass("is-active");
      };
    }

    const destination = contentEl.createDiv({ cls: "pls-capture-destination" });
    destination.createSpan({ cls: "pls-muted", text: "自动归档到" });
    destination.appendChild(targetSelect);

    const row = contentEl.createDiv({ cls: "pls-button-row" });
    row.createEl("button", { text: "取消" }).onclick = () => this.close();
    row.createEl("button", { text: "记录", cls: "pls-btn-primary" }).onclick = async () => {
      const content = textarea.value.trim();
      if (!content) {
        new Notice("请输入要记录的内容。");
        return;
      }
      const path = await this.capture(targetSelect.value as CaptureTarget, content);
      this.close();
      new Notice(`已保存到 ${path}`);
    };
  }

  private async capture(target: CaptureTarget, content: string): Promise<string> {
    await this.plugin.ensureBaseStructure();
    const now = new Date();
    const date = formatDate(now);
    const time = now.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    });
    const active = this.app.workspace.getActiveFile();
    const source = active ? `\n> 来源：${active.path}` : "";

    if (target === "daily") {
      const file = await this.plugin.ensureTodayNote(false);
      await this.app.vault.append(
        file,
        `\n\n## ${time} 快速记录${source}\n\n${content}\n`
      );
      return file.path;
    }

    if (target === "task") {
      const path = this.plugin.path("Tasks", "open.md");
      const file = await ensureFile(this.app, path, "# 未完成待办\n\n");
      const sourceText = active ? ` #source/${active.basename.replace(/\s+/g, "-")}` : "";
      await this.app.vault.append(
        file,
        `\n- [ ] ${content} #pls/task${sourceText} ^${makeId("pls-task")}\n`
      );
      return path;
    }

    if (target === "memory-inbox") {
      const path = this.plugin.path("Memory", "Inbox", "pending-memories.md");
      await new MemoryService(this.app, new FileSystemService(this.app, this.plugin.getRoot(), this.plugin.settings.directoryLanguage))
        .appendCandidate({ content, source: active?.path || "quick-capture", created: `${date} ${time}` });
      return path;
    }

    const path = this.plugin.path("Inbox", `${date}.md`);
    const file = await ensureFile(this.app, path, `# ${date} Inbox\n\n`);
    await this.app.vault.append(
      file,
      `\n## ${time} 快速记录${source}\n\n${content}\n`
    );
    return file.path;
  }
}
