import { App, Component, MarkdownRenderer, Modal, Notice } from "obsidian";
import type { IPlugin } from "./plugin-api";
import { buildSystemPrompt } from "./ai";
import { evaluateAnswer, formatEvaluation, generatePracticePlan } from "./exam/interview";
import { listExamFiles, parseFrontmatter } from "./exam/data";
import { requireProFeature } from "./licensing/entitlement";
import { getCivilServiceInterviewThinkingModelPrompt, normalizeExamProfileType } from "./settings";

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

export class FirstRunModal extends Modal {
  constructor(app: App, private plugin: IPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "欢迎使用个人人生系统" });
    contentEl.createEl("p", {
      text: "请选择数据目录。所有内容都会以 Markdown 保存到你的 Obsidian Vault 中。"
    });
    const grid = contentEl.createDiv({ cls: "pls-form-grid" });
    const input = grid.createEl("input", { value: this.plugin.settings.rootFolder });
    const row = contentEl.createDiv({ cls: "pls-button-row" });
    row.createEl("button", { text: "使用英文目录" }).onclick = () => {
      input.value = "PersonalLifeSystem";
    };
    row.createEl("button", { text: "使用中文目录" }).onclick = () => {
      input.value = "个人人生系统";
    };
    row.createEl("button", { text: "确认" }).onclick = async () => {
      this.plugin.settings.rootFolder = input.value.trim() || "PersonalLifeSystem";
      this.plugin.settings.hasCompletedFirstRun = true;
      await this.plugin.saveSettings();
      await this.plugin.ensureBaseStructure();
      this.close();
      new Notice("个人人生系统已初始化。");
    };
  }
}

export class XingceQuestionModal extends Modal {
  constructor(app: App, private plugin: IPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "新增行测错题" });
    const form = contentEl.createDiv({ cls: "pls-form-grid" });

    form.createEl("label", { text: "题型", cls: "pls-label" });
    const typeSelect = form.createEl("select");
    for (const [key, label] of [
      ["verbal", "言语理解"],
      ["quantitative", "数量关系"],
      ["reasoning", "判断推理"],
      ["data_analysis", "资料分析"],
      ["general", "常识判断"]
    ]) {
      typeSelect.createEl("option", { value: key, text: label });
    }

    form.createEl("label", { text: "标题", cls: "pls-label" });
    const title = form.createEl("input", { attr: { placeholder: "简要描述题目" } });

    form.createEl("label", { text: "难度", cls: "pls-label" });
    const difficulty = form.createEl("select");
    difficulty.createEl("option", { value: "easy", text: "简单" });
    difficulty.createEl("option", { value: "medium", text: "中等" });
    difficulty.createEl("option", { value: "hard", text: "困难" });
    difficulty.value = "medium";

    form.createEl("label", { text: "题目", cls: "pls-label" });
    const question = form.createEl("textarea", { attr: { placeholder: "题目内容" } });

    form.createEl("label", { text: "我的答案", cls: "pls-label" });
    const myAnswer = form.createEl("textarea", { attr: { placeholder: "你的作答" } });
    myAnswer.rows = 3;

    form.createEl("label", { text: "正确答案", cls: "pls-label" });
    const correctAnswer = form.createEl("textarea", { attr: { placeholder: "标准答案" } });
    correctAnswer.rows = 3;

    form.createEl("label", { text: "错因分析", cls: "pls-label" });
    const reason = form.createEl("textarea", { attr: { placeholder: "为什么会错？" } });

    form.createEl("label", { text: "知识点", cls: "pls-label" });
    const knowledge = form.createEl("textarea", { attr: { placeholder: "涉及的知识点" } });
    contentEl.createEl("button", { text: "创建", cls: "pls-btn-primary" }).onclick = async () => {
      const file = await this.plugin.createXingceQuestion({
        title: title.value,
        questionType: typeSelect.value || "general",
        difficulty: difficulty.value || "medium",
        question: question.value,
        myAnswer: myAnswer.value,
        correctAnswer: correctAnswer.value,
        reason: reason.value,
        knowledge: knowledge.value
      });
      await this.app.workspace.getLeaf(false).openFile(file);
      this.close();
    };
  }
}

const INTERVIEW_CATEGORIES = [
  { key: "self_intro", name: "自我介绍" },
  { key: "comprehensive", name: "综合分析" },
  { key: "emergency", name: "应急应变" },
  { key: "interpersonal", name: "人际关系" },
  { key: "organization", name: "组织协调" },
  { key: "vocational", name: "职位认知" },
  { key: "situation", name: "情景模拟" },
  { key: "leaderless_group", name: "无领导小组" },
  { key: "professional", name: "专业专项" }
];

export class InterviewPracticeModal extends Modal {
  private guidanceEl: HTMLElement;
  private mdComponent: Component;

  constructor(app: App, private plugin: IPlugin) {
    super(app);
    this.mdComponent = new Component();
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal", "pls-interview-modal");
    contentEl.createEl("h2", { text: "面试练习" });

    // Load practice history for personalized plan
    const history = await this.loadPracticeHistory();

    const form = contentEl.createDiv({ cls: "pls-form-grid" });
    form.createEl("label", { text: "题型", cls: "pls-field-label" });
    const categorySelect = form.createEl("select");
    for (const cat of INTERVIEW_CATEGORIES) {
      categorySelect.createEl("option", { value: cat.key, text: cat.name });
    }

    this.guidanceEl = contentEl.createDiv({ cls: "pls-section pls-guidance-section" });
    this.updateGuidance(categorySelect.value);
    this.renderThinkingModel(contentEl);

    categorySelect.onchange = () => this.updateGuidance(categorySelect.value);

    form.createEl("label", { text: "题目", cls: "pls-field-label" });
    const question = form.createEl("textarea", {
      attr: { placeholder: "题目，可手写或点击 AI 生成" }
    });
    question.rows = 4;

    form.createEl("label", { text: "我的回答", cls: "pls-field-label" });
    const answer = form.createEl("textarea", {
      attr: { placeholder: "我的回答（计时作答，建议2-3分钟）" }
    });
    answer.rows = 7;

    form.createEl("label", { text: "AI 评价", cls: "pls-field-label" });
    const evaluationArea = form.createEl("textarea", {
      attr: { placeholder: "点击 AI 评价或 AI 结构化评分后显示结果..." }
    });
    evaluationArea.rows = 7;

    const row = contentEl.createDiv({ cls: "pls-button-row" });
    row.createEl("button", { text: "🤖 AI 生成题目" }).onclick = async () => {
      if (!requireProFeature(this.plugin, "aiExamCoach")) return;
      const catName = INTERVIEW_CATEGORIES.find(c => c.key === categorySelect.value)?.name ?? "综合分析";
      const response = await this.plugin.ai.complete({
        messages: [
          { role: "system", content: buildSystemPrompt(this.plugin.settings) },
          { role: "user", content: `请生成一道公务员结构化面试题，题型：${catName}。只输出题目，不要解释。` }
        ]
      });
      if (response.ok && response.text) {
        question.value = response.text;
      }
    };
    row.createEl("button", { text: "⭐ AI 结构化评分" }).onclick = async () => {
      if (!question.value || !answer.value) {
        new Notice("请先填写题目和回答。");
        return;
      }
      if (!requireProFeature(this.plugin, "aiExamCoach")) return;
      new Notice("正在进行结构化评分...");
      const result = await evaluateAnswer(
        this.plugin,
        question.value,
        answer.value,
        categorySelect.value
      );
      if (result) {
        evaluationArea.value = formatEvaluation(result);
        new Notice(`评分完成：${result.totalScore}/10`);
      } else {
        new Notice("结构化评分失败，请重试。");
      }
    };
    row.createEl("button", { text: "💾 保存记录" }).onclick = async () => {
      const catName = INTERVIEW_CATEGORIES.find(c => c.key === categorySelect.value)?.name ?? "面试练习";
      const file = await this.plugin.createInterviewPractice({
        category: catName,
        question: question.value,
        answer: answer.value,
        evaluation: evaluationArea.value
      });
      await this.app.workspace.getLeaf(false).openFile(file);
      this.close();
    };

    // Practice plan section (personalized, rendered as Markdown)
    const planSection = contentEl.createDiv({ cls: "pls-section" });
    planSection.createEl("h3", { text: "练习计划" });
    const planText = generatePracticePlan([categorySelect.value], history ?? undefined);
    const planBody = planSection.createDiv();
    void MarkdownRenderer.renderMarkdown(planText, planBody, "", this.mdComponent);
  }

  onClose(): void {
    this.mdComponent?.unload();
  }

  private renderThinkingModel(contentEl: HTMLElement): void {
    if (normalizeExamProfileType(this.plugin.settings.examProfileType) !== "civil-service") return;

    const model = getCivilServiceInterviewThinkingModelPrompt();
    const section = contentEl.createDiv({ cls: "pls-section pls-interview-thinking-model" });
    section.createEl("h3", { text: "软工拆题模型" });
    section.createEl("p", {
      text: "把面试题当成一个系统问题来拆：先找输入端矛盾，再讲处理链路，最后落到可验证结果。",
      cls: "pls-muted"
    });

    const grid = section.createDiv({ cls: "pls-interview-model-grid" });
    for (const item of [
      ["输入问题", "政策不会凭空出现：先拆现实问题、政策背景、群众需求、资源约束和风险变化。"],
      ["处理实操", "不要只喊口号：讲清谁来做、怎么做、用什么资源、如何轻开发和长运营。"],
      ["输出闭环", "不要虚写成效：落到群众获得什么、基层留下什么、长期风险如何降低。"]
    ]) {
      const card = grid.createDiv({ cls: "pls-interview-model-step" });
      card.createEl("strong", { text: item[0] });
      card.createEl("span", { text: item[1] });
    }

    section.createDiv({
      cls: "pls-interview-model-source",
      text: model.split("\n").slice(-1)[0]
    });
  }

  private async loadPracticeHistory(): Promise<{
    totalPractices: number;
    averageScore: number;
    practicedCategories: string[];
    weakDimensions: string[];
  } | null> {
    const interviewPath = this.plugin.path("Exam", "Interview");
    const files = listExamFiles(this.app, interviewPath);
    if (files.length === 0) return null;

    const records: { scores: Record<string, number>; category: string }[] = [];
    for (const file of files) {
      const fm = parseFrontmatter(this.app, file);
      if (!fm || fm.type !== "interview-practice") continue;
      const scores = fm.scores;
      if (scores && typeof scores === "object") {
        records.push({
          scores: scores as Record<string, number>,
          category: String(fm.category ?? "")
        });
      }
    }
    if (records.length === 0) return null;

    // Total avg score
    const allScores = records.flatMap(r => Object.values(r.scores));
    const averageScore = allScores.length > 0
      ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length * 10) / 10
      : 0;

    // Practiced categories
    const practicedSet = new Set(records.map(r => r.category));

    // Weak dimensions (avg < 7)
    const dimTotals: Record<string, { sum: number; count: number }> = {};
    for (const rec of records) {
      for (const [dim, score] of Object.entries(rec.scores)) {
        if (!dimTotals[dim]) dimTotals[dim] = { sum: 0, count: 0 };
        dimTotals[dim].sum += score;
        dimTotals[dim].count++;
      }
    }
    const weakDimensions = Object.entries(dimTotals)
      .map(([dim, d]) => ({ dim, avg: d.sum / d.count }))
      .filter(d => d.avg < 7)
      .sort((a, b) => a.avg - b.avg)
      .slice(0, 3)
      .map(d => d.dim);

    return {
      totalPractices: records.length,
      averageScore,
      practicedCategories: Array.from(practicedSet),
      weakDimensions
    };
  }

  private updateGuidance(categoryKey: string): void {
    this.guidanceEl.empty();
    const cat = INTERVIEW_CATEGORIES.find(c => c.key === categoryKey);
    if (!cat) return;

    const guidance: Record<string, { framework: string; pitfalls: string; drill: string; time: number }> = {
      self_intro: { framework: "身份背景 → 关键经历 → 岗位匹配 → 入职态度", pitfalls: "流水账式罗列、只说优点不落岗位", drill: "用2分钟讲清楚经历和岗位匹配点", time: 150 },
      comprehensive: { framework: "表明判断 → 分析原因/影响 → 提出对策 → 联系岗位表态", pitfalls: "只喊口号、只谈一面、对策空泛", drill: "每天选1个社会热点用四步法复述", time: 180 },
      emergency: { framework: "稳住现场 → 查明情况 → 依法处置 → 汇报复盘", pitfalls: "一上来就追责、忽视群众情绪", drill: "练习先安抚、再核实、再处理的三段式", time: 150 },
      interpersonal: { framework: "摆正心态 → 主动沟通 → 以工作为重 → 总结提升", pitfalls: "抱怨领导同事、只退让不解决问题", drill: "围绕领导、同事、群众各练1题", time: 150 },
      organization: { framework: "明确目标 → 前期准备 → 组织实施 → 总结评估", pitfalls: "模板化、没资源协调、没风险预案", drill: "拆成时间/人员/物资/风险/反馈五项", time: 180 },
      vocational: { framework: "岗位职责 → 自身匹配 → 短板改进 → 入职计划", pitfalls: "动机只讲稳定、优势与岗位脱节", drill: "把岗位职责整理成3个关键词匹配经历", time: 150 },
      situation: { framework: "进入角色 → 共情沟通 → 解释规则 → 给出方案", pitfalls: "不像现场说话、只有道理没对象感", drill: "把答案改成可直接说出口的话", time: 150 },
      leaderless_group: { framework: "提出观点 → 回应他人 → 推进共识 → 总结输出", pitfalls: "抢话过多、沉默无贡献", drill: "练习30秒立论、20秒回应、30秒总结", time: 240 },
      professional: { framework: "专业判断 → 依据说明 → 实务处理 → 风险提示", pitfalls: "术语堆砌、只讲技术不讲治理", drill: "用公务员语境解释技术问题", time: 180 }
    };

    const g = guidance[categoryKey];
    if (!g) return;

    this.guidanceEl.createEl("p", { text: `答题框架：${g.framework}`, cls: "pls-muted" });
    this.guidanceEl.createEl("p", { text: `常见失分：${g.pitfalls}`, cls: "pls-muted" });
    this.guidanceEl.createEl("p", { text: `练习重点：${g.drill}`, cls: "pls-muted" });
    this.guidanceEl.createEl("p", { text: `建议时间：${g.time}秒（约${Math.round(g.time / 60)}分钟）`, cls: "pls-muted" });
  }
}
