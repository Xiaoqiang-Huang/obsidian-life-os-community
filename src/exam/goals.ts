import { Modal, Notice, TFile, type App } from "obsidian";
import type { IPlugin } from "../plugin-api";
import { getExamTaskTypeOptions } from "../settings";
import { ensureFile, ensureFolder, formatDate, makeId } from "../utils";
import { listExamFiles, parseFrontmatter } from "./data";

interface StudyGoal {
  id: string;
  title: string;
  goalType: string;
  target: number;
  unit: string;
  startDate: string;
  endDate: string;
  priority: string;
  status: string;
  currentProgress: number;
  filePath: string;
}

export async function showGoalsList(app: App, plugin: IPlugin): Promise<void> {
  const goalsPath = plugin.path("Exam", "Goals");
  try {
    await ensureFolder(app, goalsPath);
    const goals = await loadGoals(app, goalsPath);
    new GoalsListModal(app, plugin, goals).open();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`学习目标打开失败：${message}`);
  }
}

async function loadGoals(app: App, goalsPath: string): Promise<StudyGoal[]> {
  const files = listExamFiles(app, goalsPath);
  const goals: StudyGoal[] = [];

  for (const file of files) {
    const fm = parseFrontmatter(app, file);
    if (!fm || fm.type !== "study-goal") continue;

    goals.push({
      id: String(fm.id ?? ""),
      title: String(fm.title ?? file.basename),
      goalType: String(fm.goal_type ?? "comprehensive"),
      target: Number(fm.target ?? 0),
      unit: String(fm.unit ?? ""),
      startDate: String(fm.start_date ?? ""),
      endDate: String(fm.end_date ?? ""),
      priority: String(fm.priority ?? "medium"),
      status: String(fm.status ?? "active"),
      currentProgress: Number(fm.current_progress ?? 0),
      filePath: file.path
    });
  }

  return goals;
}

class GoalsListModal extends Modal {
  constructor(app: App, private plugin: IPlugin, private goals: StudyGoal[]) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "学习目标" });

    const row = contentEl.createDiv({ cls: "pls-button-row" });
    row.createEl("button", { text: "新增目标" }).onclick = () => {
      this.close();
      new AddGoalModal(this.app, this.plugin).open();
    };

    if (this.goals.length === 0) {
      contentEl.createEl("p", { text: "暂无学习目标。", cls: "pls-muted" });
      return;
    }

    for (const goal of this.goals) {
      const card = contentEl.createDiv({ cls: "pls-card" });
      const header = card.createDiv({ cls: "pls-card-header" });
      header.createEl("strong", { text: goal.title });
      const badge = header.createEl("span", {
        cls: `pls-badge pls-badge-${goal.priority}`,
        text: goal.priority === "high" ? "高" : goal.priority === "medium" ? "中" : "低"
      });

      const progress = card.createDiv({ cls: "pls-progress" });
      const pct = goal.target > 0 ? Math.round((goal.currentProgress / goal.target) * 100) : 0;
      progress.createEl("progress", { attr: { value: String(pct), max: "100" } });
      progress.createEl("span", { text: ` ${goal.currentProgress}/${goal.target} ${goal.unit} (${pct}%)` });

      card.createEl("p", {
        cls: "pls-muted",
        text: `${goal.goalType} · ${goal.startDate} ~ ${goal.endDate} · ${goal.status}`
      });

      const btnRow = card.createDiv({ cls: "pls-button-row" });
      btnRow.createEl("button", { text: "打开" }).onclick = async () => {
        const abstract = this.app.vault.getAbstractFileByPath(goal.filePath);
        if (abstract instanceof TFile) {
          this.close();
          await this.app.workspace.getLeaf(false).openFile(abstract);
        }
      };
      if (goal.status === "active") {
        btnRow.createEl("button", { text: "完成" }).onclick = async () => {
          const updated = await updateGoalStatus(this.app, goal, "completed");
          this.close();
          if (updated) {
            new Notice(`目标「${goal.title}」已标记完成。`);
          } else {
            new Notice(`目标「${goal.title}」状态更新失败，请检查文件。`);
          }
        };
      }
    }
  }
}

async function updateGoalStatus(app: App, goal: StudyGoal, status: string): Promise<boolean> {
  const abstract = app.vault.getAbstractFileByPath(goal.filePath);
  if (!(abstract instanceof TFile)) return false;
  const content = await app.vault.read(abstract);
  const updated = content.replace(/^status:\s*\w+/m, `status: ${status}`);
  if (updated === content) return false;
  await app.vault.modify(abstract, updated);
  return true;
}

class AddGoalModal extends Modal {
  constructor(app: App, private plugin: IPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "新增学习目标" });
    const form = contentEl.createDiv({ cls: "pls-form-grid" });

    const title = form.createEl("input", { attr: { placeholder: "目标标题" } });
    const typeSelect = form.createEl("select");
    for (const [value, label] of getExamTaskTypeOptions(this.plugin.settings)) {
      typeSelect.createEl("option", { text: label, value });
    }

    const target = form.createEl("input", {
      attr: { placeholder: "目标数值，如 70", inputmode: "decimal" },
      value: "70"
    });
    const unit = form.createEl("input", { attr: { placeholder: "单位，如 分/题/天" }, value: "分" });
    const startDate = form.createEl("input", { value: formatDate(), attr: { type: "date" } });
    const endDate = form.createEl("input", { value: formatDate(), attr: { type: "date" } });

    const prioritySelect = form.createEl("select");
    prioritySelect.createEl("option", { text: "中", value: "medium" });
    prioritySelect.createEl("option", { text: "高", value: "high" });
    prioritySelect.createEl("option", { text: "低", value: "low" });

    contentEl.createEl("button", { text: "创建" }).onclick = async () => {
      const id = makeId("goal");
      const fileName = `goal-${id.slice(-4)}.md`;
      const filePath = this.plugin.path("Exam", "Goals", fileName);
      const file = await ensureFile(this.app, filePath, `---
type: study-goal
id: ${id}
title: "${title.value}"
goal_type: ${typeSelect.value}
target: ${target.value || "0"}
unit: "${unit.value}"
start_date: ${startDate.value}
end_date: ${endDate.value}
priority: ${prioritySelect.value}
status: active
current_progress: 0
---

# ${title.value || "新目标"}

- 目标：${target.value} ${unit.value}
- 类型：${typeSelect.value}
- 日期：${startDate.value} ~ ${endDate.value}
`);
      await this.app.workspace.getLeaf(false).openFile(file);
      this.close();
      new Notice("学习目标已创建。");
    };
  }
}
