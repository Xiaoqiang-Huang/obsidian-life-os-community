import { Modal, Notice, TFile, type App } from "obsidian";
import type { IPlugin } from "../plugin-api";
import { ensureFile, ensureFolder, formatDate, makeId } from "../utils";
import { listExamFiles, parseFrontmatter } from "./data";

interface MaterialInfo {
  title: string;
  type: string;
  added: string;
  filePath: string;
}

export async function showUploadMaterial(app: App, plugin: IPlugin): Promise<void> {
  const materialsPath = plugin.path("Exam", "Materials");
  await ensureFolder(app, materialsPath);
  const materials = await loadMaterials(app, materialsPath);
  new MaterialsModal(app, plugin, materials).open();
}

async function loadMaterials(app: App, materialsPath: string): Promise<MaterialInfo[]> {
  const files = listExamFiles(app, materialsPath);
  const materials: MaterialInfo[] = [];

  for (const file of files) {
    if (file.name === ".gitkeep") continue;
    const fm = parseFrontmatter(app, file);

    materials.push({
      title: String(fm?.title ?? file.basename),
      type: String(fm?.material_type ?? "other"),
      added: String(fm?.added ?? ""),
      filePath: file.path
    });
  }

  return materials;
}

class MaterialsModal extends Modal {
  constructor(app: App, private plugin: IPlugin, private materials: MaterialInfo[]) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "学习资料" });

    const row = contentEl.createDiv({ cls: "pls-button-row" });
    row.createEl("button", { text: "添加资料" }).onclick = () => {
      this.close();
      new AddMaterialModal(this.app, this.plugin).open();
    };

    if (this.materials.length === 0) {
      contentEl.createEl("p", {
        text: "暂无资料。可通过「添加资料」手动创建学习资料笔记。",
        cls: "pls-muted"
      });
      return;
    }

    for (const mat of this.materials) {
      const card = contentEl.createDiv({ cls: "pls-list-item" });
      const info = card.createDiv({ cls: "pls-item-info" });
      info.createEl("strong", { text: mat.title });
      info.createEl("span", { cls: "pls-muted", text: ` [${mat.type}]` });
      if (mat.added) {
        info.createEl("span", { cls: "pls-muted", text: ` ${mat.added}` });
      }

      card.createEl("button", { text: "打开" }).onclick = async () => {
        const abstract = this.app.vault.getAbstractFileByPath(mat.filePath);
        if (abstract instanceof TFile) {
          this.close();
          await this.app.workspace.getLeaf(false).openFile(abstract);
        }
      };
    }
  }
}

class AddMaterialModal extends Modal {
  constructor(app: App, private plugin: IPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "添加学习资料" });
    const form = contentEl.createDiv({ cls: "pls-form-grid" });

    const title = form.createEl("input", { attr: { placeholder: "资料标题" } });
    const typeSelect = form.createEl("select");
    typeSelect.createEl("option", { text: "教材/讲义", value: "textbook" });
    typeSelect.createEl("option", { text: "真题", value: "past-exam" });
    typeSelect.createEl("option", { text: "视频", value: "video" });
    typeSelect.createEl("option", { text: "笔记", value: "note" });
    typeSelect.createEl("option", { text: "其他", value: "other" });

    const url = form.createEl("input", { attr: { placeholder: "链接（可选）" } });
    const note = form.createEl("textarea", { attr: { placeholder: "笔记/备注" } });

    contentEl.createEl("button", { text: "创建" }).onclick = async () => {
      const id = makeId("mat");
      const fileName = `material-${id.slice(-4)}.md`;
      const filePath = this.plugin.path("Exam", "Materials", fileName);
      const file = await ensureFile(this.app, filePath, `---
type: study-material
id: ${id}
title: "${title.value || "未命名资料"}"
material_type: ${typeSelect.value}
added: ${formatDate()}
url: "${url.value}"
---

# ${title.value || "未命名资料"}

${url.value ? `- 链接：${url.value}\n` : ""}
- 类型：${typeSelect.value}
- 添加日期：${formatDate()}

## 笔记

${note.value}
`);
      await this.app.workspace.getLeaf(false).openFile(file);
      this.close();
      new Notice("学习资料已添加。");
    };
  }
}
