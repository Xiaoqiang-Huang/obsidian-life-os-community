import { App, TFile, Notice } from "obsidian";
import { LifeOSModal } from "../components/LifeOSModal";
import { createModalShell } from "../components/ModalShell";
import { createButton } from "../components/Button";
import { LlmWikiChangeService, wikiChangeApproval, type WikiChangeSet } from "../services/LlmWikiChangeService";
import { LlmWikiDraftService } from "../services/LlmWikiDraftService";
import { LlmWikiUndoService } from "../services/LlmWikiUndoService";
import type { PersonalLifeSystemSettings } from "../settings";
import type { AiClient } from "../ai";

/** Existing Obsidian modal host owns focus/Escape; closing a preview never applies it. */
export class LlmWikiUpdateModal extends LifeOSModal {
  private service: LlmWikiChangeService;
  private busy = false;
  private closed = false;
  constructor(app: App, private settings: PersonalLifeSystemSettings, ai: AiClient, private canWrite: () => boolean = () => true) {
    super(app); this.service = new LlmWikiChangeService(app, settings, ai);
  }
  onOpen(): void { this.closed = false; void this.showHome(); }
  onClose(): void { this.closed = true; }
  private async run(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; button.disabled = true;
    try { await action(); } catch (e) { new Notice(e instanceof Error ? e.message : String(e), 9000); }
    finally { this.busy = false; button.disabled = false; }
  }
  private openFile(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
    else new Notice("来源已移动或删除。");
  }
  private async showHome(): Promise<void> {
    if (this.closed) return;
    const {body, footer} = createModalShell(this.contentEl, { title: "项目知识更新", icon: "git-merge", subtitle: "选择来源 → 生成提案 → 核对原文与差异 → 确认写入；不需要额外运行环境。", className: "lifeos-wiki-update" });
    const targetLabel = body.createEl("label", { text: "更新哪一页正式知识" });
    const target = targetLabel.createEl("select", { attr: { "aria-label": "正式知识目标" } });
    const targets = this.service.formalFiles();
    for (const file of targets) target.createEl("option", { text: file.path, value: file.path });
    if (!targets.length) body.createEl("p", {text: "目前没有正式 Wiki 页。请先把一条资料草稿确认到正式 Wiki，再为它合并新的资料。"});
    body.createEl("p", { text: "选取 2–6 份资料。仅发送本次选择的可引用正文和目标页给已配置的 AI；自动聊天记录不参与。", cls: "lifeos-muted" });
    const search = body.createEl("input", { attr: { type: "search", placeholder: "搜索资料路径或项目名称", "aria-label": "搜索更新来源" } });
    const list = body.createDiv({cls:"lifeos-wiki-source-list"});
    const selected = new Set<string>();
    const targetPaths = new Set(targets.map(f => f.path));
    const all = this.app.vault.getMarkdownFiles().filter(f => !targetPaths.has(f.path));
    const count = body.createDiv({text:"已选 0 份", attr:{role:"status"}});
    const render = () => {
      list.empty();
      const matching = all.filter(f => f.path.toLowerCase().includes(search.value.toLowerCase()));
      for (const file of matching.slice(0, 100)) {
        const row = list.createEl("label");
        const box = row.createEl("input", {attr:{type:"checkbox"}}); box.checked = selected.has(file.path);
        row.createSpan({text:file.path});
        box.onchange = () => { if (box.checked) selected.add(file.path); else selected.delete(file.path); count.setText(`已选 ${selected.size} 份`); };
      }
      if (matching.length > 100) list.createEl("p", {text:"仅显示前 100 份，请搜索缩小范围；已选项不会丢失。"});
    };
    render(); search.oninput = render;
    const generate = createButton(footer, "用当前模型生成提案", () => void this.run(generate, async () => {
      if (!this.canWrite()) return;
      const c = await this.service.propose(target.value, [...selected]);
      if (!this.closed) this.showPreview(c);
    }), {primary:true,icon:"sparkles"}); generate.disabled = !targets.length;
    createButton(footer,"关闭",()=>this.close());
    const history = body.createDiv(); history.createEl("h3",{text:"待审核与历史更新"});
    try {
      const records = await this.service.list();
      if (this.closed || !history.isConnected) return;
      const labels = {proposed:"待审核",applying:"写入待核对",applied:"已应用",undoing:"撤销待核对",undone:"已撤销"};
      for (const c of records.slice(0,40)) {
        const row = history.createDiv({cls:"lifeos-wiki-history"});
        row.createSpan({text:`${labels[c.state]} · ${c.targetPath} · ${c.createdAt}`});
        createButton(row,"查看差异 / 恢复",()=>this.showPreview(c));
      }
      if (!records.length) history.createEl("p",{text:"尚无知识更新记录。"});
      if (records.length > 40) history.createEl("p",{text:"显示最近 40 条，其余记录仍保存在 Reports/Changes。"});
    } catch(e) { history.createEl("p",{text:"更新记录读取失败："+String(e)}); }
  }
  private showPreview(c: WikiChangeSet): void {
    if (this.closed) return;
    const {body, footer} = createModalShell(this.contentEl,{title:"审核知识更新",icon:"file-check",subtitle:c.targetPath,className:"lifeos-wiki-update"});
    body.createEl("p",{text:"这里只校验引句是否存在于原文，不保证结论正确。请核对冲突和对话摘录；原页托管区之外的正文与顶部 tags 保持原样。"});
    for (const [title,items] of [["知识结论",c.claims],["待核实冲突",c.conflicts]] as const) {
      body.createEl("h3",{text:title});
      if (!items.length) body.createEl("p",{text:"模型未提出冲突，不代表已完成事实核验。"});
      for (const item of items) {
        const row = body.createDiv({cls:"lifeos-wiki-claim"}); row.createEl("p",{text:item.text});
        for (const ref of item.citations) {
          const s = c.sources.find(s=>s.id===ref.sourceId)!;
          row.createEl("blockquote",{text:ref.quote});
          createButton(row,`${s.id} · ${s.label} · 打开原文`,()=>this.openFile(s.path));
        }
      }
    }
    const versions = body.createDiv({cls:"lifeos-wiki-version-grid"});
    for (const [label,text] of [["更新前",c.before],["更新后",c.after]]) {
      const section = versions.createEl("details"); section.createEl("summary",{text:label}); section.createEl("pre",{text});
    }
    const consent = body.createEl("label",{cls:"lifeos-wiki-consent"});
    const checkbox = consent.createEl("input",{attr:{type:"checkbox"}});
    consent.createSpan({text:"我已核对本次差异和来源，确认执行所选操作"});
    const execute = (label:string, action:()=>Promise<WikiChangeSet>) => {
      const button = createButton(footer,label,()=>void this.run(button,async()=> {
        if (!checkbox.checked || !this.canWrite()) return;
        const result=await action();
        new Notice(result.state === "undone" ? "已恢复更新前的原页内容。" : "知识更新已写入并核对。撤销记录保存在 Vault，重启后仍可用。");
        if (!this.closed) this.showPreview(result);
      }),{primary:true}); button.disabled=true;
      checkbox.addEventListener("change",()=>{button.disabled=!checkbox.checked;});
    };
    if (["proposed","applying"].includes(c.state)) execute("确认应用 / 核对恢复",()=>new LlmWikiDraftService(this.app,this.settings.rootFolder,this.settings.directoryLanguage).applyKnowledgeUpdate(c.receiptPath,wikiChangeApproval(c)));
    if (["applied","applying","undoing"].includes(c.state)) execute("撤销这次更新",()=>new LlmWikiUndoService(this.app,this.settings.rootFolder,this.settings.directoryLanguage).undoKnowledgeUpdate(c.receiptPath,wikiChangeApproval(c,"undo")));
    if (c.state === "undone") body.createEl("p",{text:"这次更新已撤销。再次更新请生成新提案。"});
    createButton(footer,"返回更新列表",()=>void this.showHome());
    createButton(footer,"关闭，不再操作",()=>this.close());
  }
}
