import { App, TFile, Notice } from "obsidian";
import { LifeOSModal } from "../components/LifeOSModal";
import { createModalShell } from "../components/ModalShell";
import { createButton } from "../components/Button";
import { ReviewTagService, type ReviewTagPlan } from "../services/ReviewTagService";
import { requireProFeature } from "../licensing/entitlement";
import type PersonalLifeSystemPlugin from "../main";

/** Explicit generate/confirm flow; opening the dialog does not send content. */
export class DocumentTagsModal extends LifeOSModal {
 private busy=false;
 private closed=false;
 private plan: ReviewTagPlan | null=null;
 private after="";
 private service: ReviewTagService;
 constructor(app: App, private plugin: PersonalLifeSystemPlugin, private file: TFile) {
   super(app); this.service=new ReviewTagService(app,plugin.getRoot(),"document");
 }
 onClose(): void { this.closed=true; }
 onOpen(): void {
  this.closed=false;
  const boundPath=this.file.path;
  const {body,footer}=createModalShell(this.contentEl,{title:"提炼文档标签",subtitle:this.file.name,icon:"tags"});
  body.createEl("p",{text:"点击生成后，将文档正文交给已配置的 AI。最多提炼五个主题；确认后仅更新顶部 tags，保留手工标签，不向正文添加井号。"});
  const status=body.createDiv({attr:{role:"status","aria-live":"polite"}});
  const preview=body.createDiv();
  const generate=createButton(footer,"生成标签建议",async()=>{
   if(this.busy||this.closed||!requireProFeature(this.plugin,"aiReviewGenerate"))return;
   this.busy=true;generate.disabled=true;save.disabled=true;this.plan=null;preview.empty();
   status.textContent="正在读取正文并提炼主题…";
   try {
    if(this.file.path!==boundPath||this.app.vault.getAbstractFileByPath(boundPath)!==this.file)throw new Error("文档已移动，请重新打开标签工具。");
    const before=await this.app.vault.read(this.file);
    const vocabulary:string[]=[];
    for(const file of this.app.vault.getMarkdownFiles()) {
      const tags=this.app.metadataCache.getFileCache(file)?.frontmatter?.tags;
      for(const tag of Array.isArray(tags)?tags:typeof tags==="string"?[tags]:[]) {
       if(typeof tag==="string"&&/^[\p{L}\p{N}_/-]+$/u.test(tag)&&!vocabulary.includes(tag))vocabulary.push(tag);
       if(vocabulary.length>=200)break;
      }
      if(vocabulary.length>=200)break;
    }
    const plan=await this.service.prepare(this.plugin.ai,boundPath,before,vocabulary);
    if(this.closed)return;
    this.plan=plan;
    if(!plan.candidates.length){status.textContent="没有足够的可引用正文，未生成或写入标签。";return;}
    const existing=this.app.metadataCache.getFileCache(this.file)?.frontmatter?.tags;
    preview.createEl("p",{text:"现有标签（手工标签会保留）："+JSON.stringify(existing||[])});
    for(const item of plan.candidates) {
      const row=preview.createDiv();row.createEl("strong",{text:item.tag});row.createEl("p",{text:"依据："+item.evidence});
    }
    status.textContent="请核对候选与原文依据。旧 AI 标签将更新，手工标签保留；正文不变。";save.disabled=false;
   } catch(error) {if(!this.closed)status.textContent=error instanceof Error?error.message:"标签生成失败，原文未改变。";}
   finally {this.busy=false;if(!this.closed)generate.disabled=false;}
  });
  const save=createButton(footer,"确认写入顶部标签",async()=>{
   if(this.busy||!this.plan||this.closed||!requireProFeature(this.plugin,"aiWriteback"))return;
   this.busy=true;save.disabled=true;generate.disabled=true;
   try {const result=await this.service.apply(this.plan,boundPath);this.after=result.confirmedMarkdown||"";
    if(!this.closed){status.textContent=result.status==="updated"?"顶部标签已更新，正文未改变。":result.message||"标签无需更新。";undo.disabled=!this.after;}
   } catch(error){if(!this.closed){status.textContent=error instanceof Error?error.message:"写入失败。";save.disabled=false;}}
   finally{this.busy=false;}
  },{primary:true});save.disabled=true;
  const undo=createButton(footer,"撤销本次标签更新",async()=>{
    if(this.busy||!this.after||!this.plan||this.closed)return;
    this.busy=true;undo.disabled=true;const after=this.after,before=this.plan.before;
    try{await this.app.vault.process(this.file,current=>{
      if(this.file.path!==boundPath||current!==after)throw new Error("文档已变化，不能覆盖新内容；请使用文件历史恢复。");
      return before;
    });this.after="";if(!this.closed){status.textContent="已撤销，本次更新前的文档已恢复。";generate.disabled=false;}}
    catch(error){new Notice(error instanceof Error?error.message:"撤销失败。");if(!this.closed)undo.disabled=false;}
    finally{this.busy=false;}
  },{ghost:true});undo.disabled=true;
  createButton(footer,"关闭",()=>this.close(),{ghost:true});
 }
}
