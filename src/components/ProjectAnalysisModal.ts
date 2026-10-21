import { Modal, Notice, type App } from "obsidian";
import { ProjectAnalysisService, defaultAnalysisLimits, type AnalysisPreparation } from "../services/ProjectAnalysisService";
import type { AnalysisJob } from "../services/agent/analysis";
import { analysisErrorMessage, analysisStateGuidance } from "../services/agent/analysis/diagnostics";

/** Native Obsidian Modal owns focus/escape. No opening, polling or reload starts a model. */
export class ProjectAnalysisModal extends Modal {
  private projectId: string;
  private request: string;
  private inputTokens = 12000;
  private outputTokens = 2000;
  private overheadTokens = 4000;
  private limits = defaultAnalysisLimits();
  private safeWindowConfirmed = false;
  private allowDerivedReport = false;
  private consent = false;
  private dirty = true;
  private job?: AnalysisJob;
  private active = false;
  private opened = false;
  private timer?: ReturnType<typeof setInterval>;
  private closeCompletion: Promise<void> = Promise.resolve();
  private message = "未启动。先确认安全输入窗口并建立本地清单，再审批外发。";
  private projects: Array<{ id: string; name: string }> = [];
  private reloadId = "";
  private editRevision = 0;
  private statusEl?: HTMLElement;
  private guidanceEl?: HTMLElement;
  private buttons: Array<{ element: HTMLButtonElement; disabled: () => boolean }> = [];
  constructor(app: App, private readonly service: ProjectAnalysisService, projectId = "", request = "") {
    super(app); this.projectId = projectId; this.request = request || "分析全部项目文档的观点、论据、条件、反例与分歧。";
  }
  onOpen(): void {
    this.opened = true; this.render();
    void this.service.projects().then(p => { this.projects = p; this.render(); }).catch(e => { this.message = analysisErrorMessage(e); this.render(); });
    this.timer = setInterval(() => {
      const id = this.job?.jobId; if (!id) return;
      void this.service.observe(id).then(job => {
        if (!this.opened || this.job?.jobId !== id || job.stateRevision < this.job.stateRevision) return;
        if (job.identityHash !== this.job.identityHash || job.authorizationRevision !== this.job.authorizationRevision) this.changed();
        this.job = job; this.updateStatus(); this.updateButtons();
      }).catch(e => { if (this.opened && this.statusEl) this.statusEl.textContent = analysisErrorMessage(e); });
    }, 1500);
  }
  onClose(): void {
    if (!this.opened) return;
    this.opened = false; if (this.timer) clearInterval(this.timer); this.service.cancelPreparation();
    // Obsidian's close hook is synchronous. Retain the actual pause completion so
    // host teardown/tests can await persistence, not infer it from a hot read loop.
    this.closeCompletion = this.job ? this.service.pause(this.job.jobId).then(() => undefined) : Promise.resolve();
    void this.closeCompletion.catch(e => { new Notice(`关闭后暂停失败，请检查 checkpoint：${analysisErrorMessage(e)}`); });
    this.contentEl.empty(); this.statusEl = undefined; this.guidanceEl = undefined; this.buttons = [];
  }
  /** Await close's checkpoint pause; rejects on IO failure (Notice is also shown). */
  whenClosed(): Promise<void> { return this.closeCompletion; }
  private changed(): void { this.editRevision++; this.dirty = true; this.consent = false; this.updateButtons(); }
  private preparation(): AnalysisPreparation { return { projectId: this.projectId, request: this.request,
    inputTokens: this.inputTokens, outputTokens: this.outputTokens, overheadTokens: this.overheadTokens,
    safeWindowConfirmed: this.safeWindowConfirmed, limits: { ...this.limits }, allowDerivedReport: this.allowDerivedReport }; }
  private async action(operation: () => Promise<void>, busy = true): Promise<void> {
    if (busy && this.active) return;
    if (busy) this.active = true; this.render();
    try { await operation(); this.message = "操作已返回，见状态与实际用量。"; }
    catch (e) { this.message = analysisErrorMessage(e); }
    finally { if (busy) this.active = false; this.render(); }
  }
  private updateButtons(): void {
    for (const b of this.buttons) b.element.disabled = b.disabled();
    for (const el of Array.from(this.contentEl.querySelectorAll<HTMLInputElement>("[data-analysis-control]"))) {
      if (el.dataset.analysisControl?.startsWith("我批准")) el.checked = this.consent;
      if (el.dataset.analysisControl?.startsWith("我确认以上安全")) el.checked = this.safeWindowConfirmed;
    }
  }
  private button(label: string, operation: () => Promise<void>, disabled: () => boolean = () => false, busy = true): void {
    const b = this.contentEl.createEl("button", { text: label }); b.type = "button"; b.disabled = disabled();
    this.buttons.push({ element: b, disabled });
    b.addEventListener("click", () => { if (this.opened && !b.disabled) void this.action(operation, busy); });
  }
  private checkbox(label: string, value: boolean, change: (value: boolean) => void): void {
    const line = this.contentEl.createEl("label"), box = line.createEl("input"); box.type = "checkbox"; box.checked = value;
    box.dataset.analysisControl = label;
    line.createSpan({ text: label }); box.addEventListener("change", () => { change(box.checked); this.updateButtons(); });
  }
  private number(label: string, value: number, change: (value: number) => void): void {
    const line = this.contentEl.createEl("label"); line.createSpan({ text: label });
    const input = line.createEl("input"); input.type = "number"; input.min = "0"; input.step = "1"; input.value = String(value);
    input.dataset.analysisControl = label;
    input.addEventListener("input", () => { change(Number(input.value)); this.changed(); });
  }
  private statusText(): string {
    if (!this.job) return "尚无 checkpoint。";
    const j = this.job;
    return JSON.stringify({ jobId: j.jobId, status: j.status, waitReason: j.waitReason, authorizationRevision: j.authorizationRevision,
      parametersNeedRefresh: this.dirty, reportedTurnAllowance: j.authorization.profile.sdkReportedTurnAllowance || j.authorization.profile.sdkTurnLimit || 1,
      stateRevision: j.stateRevision, requests: j.budget.requests, sdkTurns: j.budget.sdkTurns, tokens: j.budget.tokens,
      cost: j.budget.receipts.some(r => r.cost === null) ? "unknown" : j.budget.cost, unknownConsumption: j.budget.unknown,
      chunksDone: j.chunks.filter(c => c.status === "done").length, chunksTotal: j.chunks.length }, null, 2);
  }
  private updateStatus(): void {
    if (this.statusEl) this.statusEl.textContent = this.statusText();
    if (this.guidanceEl) this.guidanceEl.textContent = analysisStateGuidance(this.job?.status || "", !!this.job?.budget.unknown, this.job?.waitReason);
  }
  private render(): void {
    if (!this.opened) return;
    const el = this.contentEl, scroll = el.scrollTop;
    const focused = el.ownerDocument?.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const focusKey = focused?.dataset?.analysisControl;
    const selection = focused && (focused.type === "text" || focused.tagName === "TEXTAREA") ? [focused.selectionStart, focused.selectionEnd] : null;
    el.empty(); this.buttons = []; el.createEl("h2", { text: "项目全文观点分析" });
    el.createEl("p", { text: "使用当前普通 AI 配置，逐文档、逐块提取后分层综合，不按搜索排名抽样。只读原件、已有识别缓存和 PDF/DOCX 可提取正文；不隐式启动新 OCR、联网或写入原文。扫描页缺少可用缓存时会列为待识别，不冒充已读。模型调用可能产生费用；结构与引用核验不代表语义完整性已得到保证。" });
    const projectLabel = el.createEl("label"); projectLabel.createSpan({ text: "项目 ID（仅当前项目 Documents + Attachments）" });
    const project = projectLabel.createEl("input"); project.value = this.projectId;
    project.dataset.analysisControl = "project";
    project.addEventListener("input", () => { this.projectId = project.value.trim(); this.changed(); });
    el.createEl("p", { text: this.projects.map(p => `${p.name} [${p.id}]`).join("；") || "未读取到项目索引；可输入已知项目 ID。" });
    const requestLabel = el.createEl("label"); requestLabel.createSpan({ text: "分析请求" });
    const request = requestLabel.createEl("textarea"); request.value = this.request;
    request.dataset.analysisControl = "request";
    request.addEventListener("input", () => { this.request = request.value; this.changed(); });
    try { const id = this.service.identity(); el.createEl("pre", { text: JSON.stringify(id, null, 2) }); }
    catch (e) { el.createEl("p", { text: `AI 配置尚不可用：${analysisErrorMessage(e)}` }); }
    el.createEl("p", { text: "contextTokens 未知；以下仅为你显式确认的保守本地操作窗口，不是实测模型能力。小夹具成功不证明 16k/更大窗口。字符切片与请求全文还受保守 UTF-8 字节估算门禁；过大请求暂停，不自动放大。" });
    this.number("输入 token 安全额度", this.inputTokens, n => { this.inputTokens = n; this.safeWindowConfirmed = false; });
    this.number("单次输出 token 上限", this.outputTokens, n => { this.outputTokens = n; this.safeWindowConfirmed = false; });
    this.number("系统/协议上下文预留", this.overheadTokens, n => { this.overheadTokens = n; this.safeWindowConfirmed = false; });
    this.checkbox("我确认以上安全操作窗口（不是已知模型上下文）", this.safeWindowConfirmed, v => { this.safeWindowConfirmed = v; this.changed(); });
    this.number("整项任务模型查询次数上限（含修复/综合）", this.limits.sdk, n => { this.limits.sdk = n; this.limits.sdkTurns = n * 4; });
    el.createEl("p", { text: "SDK query 次数、CLI maxTurns 工具往返（固定 1，工具关闭）、terminal num_turns、内部 HTTP 次数不是同一单位。每 query 按 4 个 reported turns 保守预留 token/turn 预算；不承诺 SDK 内部最多 4。实际收据超预留或未知即暂停，不抹零、不补造 1。整个 job reported-turn 上限 = 查询次数 × 4。" });
    this.number("整个 job token 上限", this.limits.tokens || 0, n => { this.limits.tokens = n; });
    this.number("整个 job 总持续毫秒上限（暂停时间也计入）", this.limits.durationMs || 0, n => { this.limits.durationMs = n; });
    el.createEl("p", { text: `报价/金额用量 unknown；currency=${this.limits.currency || "unknown"} 只是单位标签，不保证金额上限。当前驱动无可信报价上界，因此不接受金额硬上限。恢复/加预算不会清零已用额度。` });
    this.checkbox("授权另存派生分析报告（不会自动写，仍需点击保存）", this.allowDerivedReport, v => { this.allowDerivedReport = v; this.changed(); });
    this.button("建立本地清单（不调用模型）", async () => {
      const revision = this.editRevision, input = this.preparation(), job = await this.service.prepare(input);
      this.job = job; this.reloadId = job.jobId; this.dirty = this.editRevision !== revision; this.consent = false;
    }, () => this.active || !this.safeWindowConfirmed || !this.projectId);
    this.button("重建当前清单/调整预算并撤销旧审批", async () => {
      const revision = this.editRevision, input = this.preparation(), job = await this.service.reprepare(this.job!.jobId, input);
      this.job = job; this.dirty = this.editRevision !== revision; this.consent = false;
    }, () => this.active || !this.job || !this.safeWindowConfirmed);
    const reloadLabel = el.createEl("label"); reloadLabel.createSpan({ text: "恢复已有 job ID（仅本地读取，无自动付费）" });
    const reload = reloadLabel.createEl("input"); reload.value = this.reloadId;
    reload.dataset.analysisControl = "reload";
    reload.addEventListener("input", () => { this.reloadId = reload.value.trim(); this.editRevision++; });
    this.button("读取 checkpoint", async () => {
      const revision = this.editRevision, job = await this.service.reload(this.reloadId);
      if (this.editRevision !== revision || !this.opened) { this.dirty = true; this.consent = false; return; }
      this.job = job;
      this.projectId = job.manifest.scope; this.request = job.request; this.limits = { ...job.authorization.limits };
      const p = job.authorization.profile; this.inputTokens = p.inputTokens; this.outputTokens = p.outputTokens; this.overheadTokens = p.overheadTokens;
      this.allowDerivedReport = job.authorization.permissions.derivedWrite; this.safeWindowConfirmed = true;
      this.dirty = false; this.consent = false;
    }, () => this.active);
    if (this.job) {
      const j = this.job;
      el.createEl("h3", { text: "清单与审批范围快照（实时进度见底部独立状态）" });
      el.createEl("pre", { text: JSON.stringify({ jobId: j.jobId,
        authorizationRevision: j.authorizationRevision, identityHash: j.identityHash,
        manifestHash: j.manifest.manifestHash, documents: j.manifest.documents.length,
        unknownTotals: j.manifest.documents.filter(d => d.totalUnits === null).length,
        sourcePaths: j.manifest.documents.map(d => ({ source: d.originalPath, effective: d.effectivePath, sourceHash: d.sourceHash, effectiveHash: d.effectiveTextHash })) }, null, 2) });
      if (this.dirty) el.createEl("p", { text: "参数已改：重建当前清单后再审批/继续，原预算与结果不清零。" });
      this.checkbox("我批准所列全部项目内容发送给以上服务商/模型/端点，并接受当前总预算及未知金额风险", this.consent, v => { this.consent = v; });
      this.button("记录当前版本审批（不调用模型）", async () => { this.job = await this.service.approve(j.jobId,
        { identityHash: j.identityHash, authorizationRevision: j.authorizationRevision, accepted: true }); }, () => this.active || this.dirty || !this.consent);
      this.button("明确开始/继续模型分析", async () => { if (this.opened) this.job = await this.service.continue(j.jobId, true); }, () => this.active || this.dirty || !this.consent || !this.job?.approval || this.job.budget.unknown || this.job.status === "cancelled" || this.job.status === "completed");
      this.button("暂停（保留已确认结果）", async () => { this.job = await this.service.pause(j.jobId); }, () => false, false);
      this.button("取消（停止后续调用）", async () => { this.service.cancelPreparation(); this.job = await this.service.cancel(j.jobId); }, () => false, false);
      this.button("查看当前完整观点索引/partial 报告（不调用模型）", async () => {
        const text = await this.service.report(j.jobId); new AnalysisReportModal(this.app, text).open();
      }, () => this.active);
      this.button("明确保存派生报告", async () => { this.job = await this.service.saveReport(j.jobId, true); }, () => this.active || this.dirty || !this.consent || !this.job?.approval || !this.job.authorization.permissions.derivedWrite);
    }
    this.button("取消本地清单读取", async () => { this.service.cancelPreparation(); }, () => false, false);
    this.statusEl = el.createEl("pre"); this.statusEl.dataset.analysisControl = "status"; this.updateStatus();
    const guidance = el.createEl("p", { text: analysisStateGuidance(this.job?.status || "", !!this.job?.budget.unknown, this.job?.waitReason) });
    guidance.dataset.analysisControl = "guidance"; guidance.setAttribute?.("role", "status");
    this.guidanceEl = guidance;
    el.createEl("p", { text: this.message });
    if (focusKey) {
      const control = Array.from(el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-analysis-control]")).find(e => e.dataset.analysisControl === focusKey);
      if (control) { control.focus({ preventScroll: true }); if (selection && selection[0] !== null && selection[1] !== null) control.setSelectionRange(selection[0], selection[1]); }
    }
    el.scrollTop = scroll;
  }
}
class AnalysisReportModal extends Modal {
  constructor(app: App, private readonly report: string) { super(app); }
  onOpen(): void { this.contentEl.createEl("h2", { text: "结构核验报告（语义质量未验收）" }); this.contentEl.createEl("pre", { text: this.report }); }
  onClose(): void { this.contentEl.empty(); }
}
