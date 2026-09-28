import { App, TFile, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { LifeOSModal } from "../components/LifeOSModal";
import { createModalShell } from "../components/ModalShell";
import { createButton } from "../components/Button";

type Operation = "new" | "rename" | "tags" | "trash";
const running = new WeakSet<App>();
/** Explicit preview/confirm batch operations; originals/attachments are never deleted together. */
export class ResourceBatchModal extends LifeOSModal {
  constructor(app: App, private files: TFile[], private folder: string,
    private changed: () => void | Promise<void>, private allowed: (path: string) => boolean) { super(app); }
  onOpen(): void {
    const { body, footer } = createModalShell(this.contentEl, { title: "批量管理资料", subtitle: "统一管理同一份文件；先预览，再确认。只将所选文件移入 Obsidian 回收站，不自动连带删除其他附件。", icon: "files" });
    const controls = body.createDiv({ cls: "lifeos-resource-batch-controls" });
    const search = controls.createEl("input", { attr: { type: "search", placeholder: "搜索文件名或路径", "aria-label": "批量资料搜索" } });
    const mode = controls.createEl("select", { attr: { "aria-label": "批量操作" } });
    for (const [value, text] of [["rename", "批量重命名（加前缀）"], ["tags", "批量追加标签"], ["trash", "批量移入回收站"], ["new", "批量新建文档"]]) mode.createEl("option", { value, text });
    const value = body.createEl("textarea", { cls: "lifeos-resource-batch-value", attr: { "aria-label": "操作内容", placeholder: "重命名：输入前缀；标签：逗号分隔；新建：每行一个文档名。" } });
    const selected = new Set<TFile>();
    const list = body.createDiv({ cls: "lifeos-resource-batch-list" });
    const status = body.createEl("pre", { cls: "lifeos-resource-batch-status", attr: { role: "status", "aria-live": "polite" } });
    let busy = false;
    let planning = false;
    let plan: Array<{ file?: TFile; path: string; next?: string; content?: string; mtime?: number; size?: number }> = [];
    let capturedMode: Operation = "rename", capturedValue = "";
    const confirm = createButton(footer, "确认执行", async () => {
      if (busy || !plan.length || running.has(this.app)) return;
      busy = true; running.add(this.app); confirm.disabled = true; preview.disabled = true;
      const results: string[] = [];
      try {
        for (const item of plan) {
          try {
            if (!this.allowed(item.path)) throw new Error("文件超出管理范围");
            if (capturedMode === "new") {
              if (this.app.vault.getAbstractFileByPath(item.path)) throw new Error("同名文件已存在，未覆盖");
              if (!this.app.vault.getAbstractFileByPath(this.folder)) await this.app.vault.createFolder(this.folder);
              const created = await this.app.vault.create(item.path, `---\ntags: []\n---\n\n# ${item.next}\n`);
              this.files.push(created);
            } else {
              const file = item.file!;
              if (file.path !== item.path || this.app.vault.getAbstractFileByPath(item.path) !== file
                || file.stat.mtime !== item.mtime || file.stat.size !== item.size
                || (file.extension.toLowerCase() === "md" && await this.app.vault.read(file) !== item.content)) {
                throw new Error("文件已变化，请重新预览");
              }
              if (capturedMode === "trash") await this.app.fileManager.trashFile(file);
              else if (capturedMode === "rename") {
                if (!item.next || !this.allowed(item.next) || this.app.vault.getAbstractFileByPath(item.next)) throw new Error("目标文件已存在或名称不合法");
                await this.app.fileManager.renameFile(file, item.next);
              } else {
                if (file.extension.toLowerCase() !== "md" || file.path.includes("/Originals/")) throw new Error("原文件不能追加 Markdown 标签");
                await this.app.vault.process(file, current => {
                  if (current !== item.content || file.path !== item.path) throw new Error("文件已变化，未覆盖");
                  const match = current.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
                  if (current.startsWith("---") && !match) throw new Error("属性格式异常，未修改");
                  const metadata = match ? parseYaml(match[1]) : {};
                  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("属性必须是映射");
                  const tags = capturedValue.split(/[,，\n]/u).map(t => t.trim().replace(/^#/u, "")).filter(Boolean);
                  const old = metadata.tags == null ? [] : Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
                  if (old.some((tag: unknown) => typeof tag !== "string")) throw new Error("原标签格式异常，未修改");
                  metadata.tags = Array.from(new Set([...old, ...tags]));
                  return `---\n${stringifyYaml(metadata)}---\n${match ? current.slice(match[0].length) : current}`;
                });
              }
              selected.delete(file);
            }
            results.push(`成功：${item.path}`);
          } catch (error) { results.push(`失败：${item.path}：${error instanceof Error ? error.message : String(error)}`); }
        }
        status.setText(results.join("\n"));
        await this.changed();
        render();
      } finally { busy = false; running.delete(this.app); preview.disabled = false; plan = []; }
    }, { primary: true });
    confirm.disabled = true;
    let revision = 0;
    const invalidate = () => { revision++; plan = []; confirm.disabled = true; };
    const filtered = () => this.files.filter(f => this.app.vault.getAbstractFileByPath(f.path) === f && this.allowed(f.path) && f.path.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
    const render = () => {
      list.empty();
      for (const file of filtered()) {
        const row = list.createEl("label", { attr: { title: file.path } });
        const check = row.createEl("input", { attr: { type: "checkbox" } }); check.checked = selected.has(file);
        check.onchange = () => { if (check.checked) selected.add(file); else selected.delete(file); invalidate(); };
        row.createSpan({ text: file.name });
      }
    };
    createButton(controls, "全选当前搜索结果", () => { for (const file of filtered()) selected.add(file); invalidate(); render(); });
    createButton(controls, "清空选择", () => { selected.clear(); invalidate(); render(); });
    const preview = createButton(footer, "预览操作", async () => {
      if (busy || planning || running.has(this.app)) return;
      planning = true; preview.disabled = true;
      invalidate();
      const requestRevision = revision;
      try {
        capturedMode = mode.value as Operation; capturedValue = value.value.trim();
        if (capturedMode !== "trash" && !capturedValue) throw new Error("请填写操作内容");
        if (capturedMode === "tags" && capturedValue.split(/[,，\n]/u).some(t => !/^#?[\p{L}\p{N}_/-]+$/u.test(t.trim()))) throw new Error("标签仅支持文字、数字、下划线、横线和层级斜线");
        const validName = (name: string) => name.length <= 180 && !/[<>:"/\\|?*\x00-\x1f]/u.test(name) && !/[. ]$/u.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
        if (capturedMode === "new") {
          if (this.folder.endsWith("/Originals")) throw new Error("原文件目录不能新建 Markdown；请使用导入文件。");
          const names = Array.from(new Set(capturedValue.split(/\r?\n/u).map(v => v.trim().replace(/\.md$/iu, "")).filter(Boolean)));
          for (const name of names) {
            if (!validName(name)) throw new Error(`不合法文件名：${name}`);
            const path = normalizePath(`${this.folder}/${name}.md`);
            if (!this.allowed(path) || this.app.vault.getAbstractFileByPath(path)) throw new Error(`文件已存在或不在范围：${name}`);
            plan.push({ path, next: name });
          }
        } else for (const file of selected) {
          if (capturedMode === "tags" && (file.extension.toLowerCase() !== "md" || file.path.includes("/Originals/"))) throw new Error("原文件不能追加 Markdown 标签，请只选择 Markdown 文档。");
          const path = file.path, nextName = `${capturedValue}${file.basename}`;
          const next = capturedMode === "rename" ? normalizePath(`${file.parent?.path}/${nextName}.${file.extension}`) : undefined;
          if (capturedMode === "rename" && (!validName(nextName) || !next || !this.allowed(next) || this.app.vault.getAbstractFileByPath(next))) throw new Error(`重命名冲突或名称不合法：${file.name}`);
          plan.push({ file, path, next, content: file.extension.toLowerCase() === "md" ? await this.app.vault.read(file) : undefined,
            mtime: file.stat.mtime, size: file.stat.size });
        }
        if (requestRevision !== revision) { invalidate(); return; }
        if (!plan.length) throw new Error("请先选择文档；新建时每行填写一个文件名");
        status.setText(`待确认 ${plan.length} 项（${mode.selectedOptions[0].text}）：\n` + plan.map(p => p.next ? `${p.path} → ${p.next}` : p.path).join("\n"));
        confirm.disabled = false;
      } catch (error) { invalidate(); status.setText(error instanceof Error ? error.message : String(error)); }
      finally { planning = false; preview.disabled = false; }
    });
    createButton(footer, "关闭", () => { if (!busy) this.close(); });
    search.oninput = render; mode.onchange = invalidate; value.oninput = invalidate; render();
  }
}
