import { Modal, type App } from "obsidian";
import type { IPlugin } from "../plugin-api";
import { getXingceStatistics } from "./data";

export function showXingceStats(app: App, plugin: IPlugin): void {
  const xingcePath = plugin.path("Exam", "Xingce");
  const stats = getXingceStatistics(app, xingcePath);
  new XingceStatsModal(app, stats).open();
}

class XingceStatsModal extends Modal {
  constructor(app: App, private stats: ReturnType<typeof getXingceStatistics>) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "行测统计" });

    // Summary
    const summary = contentEl.createDiv({ cls: "pls-section" });
    summary.createEl("p", {
      text: `总题数：${this.stats.total} 题`,
      cls: "pls-stat"
    });

    if (this.stats.total === 0) {
      contentEl.createEl("p", { text: "暂无行测错题记录。请先添加行测错题。", cls: "pls-muted" });
      return;
    }

    // By type table
    const typeSection = contentEl.createDiv({ cls: "pls-section" });
    typeSection.createEl("h3", { text: "按题型" });

    const typeTable = typeSection.createEl("table", { cls: "pls-table" });
    const thead = typeTable.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "题型" });
    headerRow.createEl("th", { text: "数量" });
    headerRow.createEl("th", { text: "正确率" });

    const tbody = typeTable.createEl("tbody");
    const sortedTypes = Object.entries(this.stats.byType).sort((a, b) => b[1].total - a[1].total);
    for (const [type, data] of sortedTypes) {
      const row = tbody.createEl("tr");
      row.createEl("td", { text: type });
      row.createEl("td", { text: String(data.total) });
      const rateCell = row.createEl("td");
      rateCell.createEl("span", {
        text: `${data.correctRate}%`,
        cls: data.correctRate >= 70 ? "pls-good" : data.correctRate >= 50 ? "pls-warn" : "pls-bad"
      });
    }

    // By difficulty
    if (Object.keys(this.stats.byDifficulty).length > 0) {
      const diffSection = contentEl.createDiv({ cls: "pls-section" });
      diffSection.createEl("h3", { text: "按难度" });
      for (const [diff, count] of Object.entries(this.stats.byDifficulty)) {
        diffSection.createEl("p", { text: `${diff}: ${count} 题` });
      }
    }

    // Recent wrong
    if (this.stats.recentWrong.length > 0) {
      const wrongSection = contentEl.createDiv({ cls: "pls-section" });
      wrongSection.createEl("h3", { text: "最近错题" });
      for (const item of this.stats.recentWrong) {
        const row = wrongSection.createDiv({ cls: "pls-list-item" });
        row.createEl("span", { text: `[${item.questionType}] ${item.title}`, cls: "pls-item-title" });
        row.createEl("button", { text: "打开" }).onclick = () => {
          void this.app.workspace.getLeaf(false).openFile(item.file);
          this.close();
        };
      }
    }
  }
}
