import { Modal, Notice, TFile, type App } from "obsidian";
import type { IPlugin } from "../plugin-api";
import { getExamTaskTypeOptions } from "../settings";
import { ensureFile, ensureFolder, formatDate, makeId } from "../utils";
import { listExamFiles, parseFrontmatter } from "./data";

interface StudyTask {
  title: string;
  type: string;
  target: number;
  completed: number;
  status: string;
}

interface DayTasks {
  date: string;
  tasks: StudyTask[];
  filePath: string;
}

export async function showTodayTasks(app: App, plugin: IPlugin): Promise<void> {
  const tasksPath = plugin.path("Exam", "Tasks");
  const today = formatDate();
  await ensureFolder(app, tasksPath);
  const todayFile = await ensureFile(app, `${tasksPath}/${today}.md`, `---\ndate: ${today}\ntasks:\n---\n\n# ${today} 学习任务\n`);
  const dayTasks = await loadTasksForDate(app, todayFile.path);
  new TasksModal(app, plugin, dayTasks).open();
}

async function loadTasksForDate(app: App, filePath: string): Promise<DayTasks> {
  const abstract = app.vault.getAbstractFileByPath(filePath);
  if (!(abstract instanceof TFile)) return { date: formatDate(), tasks: [], filePath };

  const fm = parseFrontmatter(app, abstract);
  const date = String(fm?.date ?? formatDate());
  const rawTasks = fm?.tasks;
  const tasks: StudyTask[] = [];

  if (Array.isArray(rawTasks)) {
    for (const item of rawTasks) {
      if (typeof item === "string") {
        tasks.push({ title: item, type: "xingce", target: 0, completed: 0, status: "open" });
      } else if (typeof item === "object" && item) {
        const t = item as Record<string, unknown>;
        tasks.push({
          title: String(t.title ?? ""),
          type: String(t.type ?? "xingce"),
          target: Number(t.target ?? 0),
          completed: Number(t.completed ?? 0),
          status: String(t.status ?? "open")
        });
      }
    }
  }

  return { date, tasks, filePath };
}

class TasksModal extends Modal {
  constructor(app: App, private plugin: IPlugin, private dayTasks: DayTasks) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: `今日学习任务 (${this.dayTasks.date})` });

    const btnRow = contentEl.createDiv({ cls: "pls-button-row" });
    btnRow.createEl("button", { text: "添加任务" }).onclick = () => {
      this.close();
      new AddTaskModal(this.app, this.plugin).open();
    };

    if (this.dayTasks.tasks.length === 0) {
      contentEl.createEl("p", { text: "今天还没有学习任务。", cls: "pls-muted" });
      return;
    }

    for (let i = 0; i < this.dayTasks.tasks.length; i++) {
      const task = this.dayTasks.tasks[i];
      const row = contentEl.createDiv({ cls: "pls-list-item" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      if (task.status === "done") {
        checkbox.checked = true;
      }

      const info = row.createDiv({ cls: "pls-item-info" });
      info.createEl("span", {
        text: task.title,
        cls: task.status === "done" ? "pls-done" : ""
      });
      if (task.target > 0) {
        info.createEl("span", {
          cls: "pls-muted",
          text: ` ${task.completed}/${task.target}`
        });
      }

      checkbox.onchange = async () => {
        task.status = checkbox.checked ? "done" : "open";
        await this.saveTasks();
        if (checkbox.checked) {
          new Notice(`任务完成：${task.title}`);
        }
      };

      const delBtn = row.createEl("button", { text: "✕" });
      delBtn.onclick = async () => {
        this.dayTasks.tasks.splice(i, 1);
        await this.saveTasks();
        this.close();
        new TasksModal(this.app, this.plugin, this.dayTasks).open();
      };
    }
  }

  private async saveTasks(): Promise<void> {
    const abstract = this.app.vault.getAbstractFileByPath(this.dayTasks.filePath);
    if (!(abstract instanceof TFile)) return;

    const taskLines = this.dayTasks.tasks.map((task) => {
      if (task.target > 0) {
        return `  - title: "${task.title}"\n    type: ${task.type}\n    target: ${task.target}\n    completed: ${task.completed}\n    status: ${task.status}`;
      }
      return `  - title: "${task.title}"\n    type: ${task.type}\n    status: ${task.status}`;
    });

    // Rebuild the file content
    const body = `---\ndate: ${this.dayTasks.date}\ntasks:\n${taskLines.join("\n")}\n---\n\n# ${this.dayTasks.date} 学习任务\n\n${
      this.dayTasks.tasks
        .map((t) => `- [${t.status === "done" ? "x" : " "}] ${t.title}${t.target > 0 ? ` (${t.completed}/${t.target})` : ""}`)
        .join("\n")
    }\n`;

    await this.app.vault.modify(abstract, body);
  }
}

class AddTaskModal extends Modal {
  constructor(app: App, private plugin: IPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "添加学习任务" });
    const form = contentEl.createDiv({ cls: "pls-form-grid" });

    const title = form.createEl("input", { attr: { placeholder: "任务描述" } });
    const typeSelect = form.createEl("select");
    for (const [value, label] of getExamTaskTypeOptions(this.plugin.settings)) {
      typeSelect.createEl("option", { text: label, value });
    }

    const target = form.createEl("input", {
      attr: { placeholder: "目标数量（可选）", inputmode: "numeric" }
    });

    contentEl.createEl("button", { text: "添加" }).onclick = async () => {
      if (!title.value.trim()) return;

      const today = formatDate();
      const tasksPath = this.plugin.path("Exam", "Tasks");
      const file = await ensureFile(this.app, `${tasksPath}/${today}.md`, `---\ndate: ${today}\ntasks:\n---\n\n# ${today} 学习任务\n`);

      // Read current content and append task
      const content = await this.app.vault.read(file);
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

      const targetNum = Number(target.value);
      const taskYaml = targetNum > 0
        ? `\n  - title: "${title.value}"\n    type: ${typeSelect.value}\n    target: ${targetNum}\n    completed: 0\n    status: open`
        : `\n  - title: "${title.value}"\n    type: ${typeSelect.value}\n    status: open`;

      if (match) {
        const newYaml = match[0].slice(0, -4) + taskYaml + "\n---";
        const body = content.slice(match[0].length);
        await this.app.vault.modify(file, newYaml + body);
        this.close();
        new Notice("任务已添加。");
      } else {
        this.close();
        new Notice("文件格式异常，任务未添加。请检查文件 frontmatter。");
      }
    };
  }
}
