import { Modal, Notice, TFile, type App } from "obsidian";
import type { IPlugin } from "../plugin-api";
import { buildSystemPrompt } from "../ai";
import { requireProFeature } from "../licensing/entitlement";
import { getCivilServiceInterviewThinkingModelPrompt } from "../settings";
import { formatDate } from "../utils";
import { listExamFiles, parseFrontmatter } from "./data";

// ── 完整评分维度（9维，对齐公务员面试官方标准）──

const EVALUATION_DIMENSIONS: Record<string, string> = {
  "综合分析能力": "能否准确理解问题、抓住本质、进行多角度分析并提出合理判断。",
  "言语表达能力": "表达是否清楚、准确、流畅，是否具备机关工作需要的规范表达。",
  "应变能力": "面对突发情况、压力和冲突时，能否快速判断并稳妥处置。",
  "计划组织协调能力": "能否围绕目标制定方案、分解任务、协调资源并复盘效果。",
  "人际交往意识与技巧": "能否正确处理与领导、同事、群众等对象的关系。",
  "自我情绪控制": "面对质疑、压力或突发情况时，能否保持冷静克制。",
  "求职动机与拟任职位匹配性": "报考动机、价值观、经历能力是否与岗位要求匹配。",
  "举止仪表": "现场状态是否稳重自然，仪态、语速、礼貌是否符合面试场景。",
  "专业能力": "是否体现岗位所需专业知识、业务理解和解决实际问题的能力。"
};

// ── 题型指导（对齐 diary_web interview_standards.py）──

interface CategoryGuidance {
  name: string;
  measuredElements: string[];
  answerFramework: string[];
  timeLimitSeconds: number;
  pitfalls: string[];
  drill: string;
  knowledgeTips: string;
}

export const CATEGORY_GUIDANCE: Record<string, CategoryGuidance> = {
  self_intro: {
    name: "自我介绍",
    measuredElements: ["求职动机与拟任职位匹配性", "言语表达能力", "举止仪表"],
    answerFramework: ["身份背景", "关键经历", "岗位匹配", "入职态度"],
    timeLimitSeconds: 150,
    pitfalls: ["流水账式罗列经历", "只说优点不落岗位", "时间过长或背诵感太强"],
    drill: "用2分钟讲清楚退伍经历、技术背景和岗位匹配点。",
    knowledgeTips: `自我介绍应控制在2-3分钟，突出与岗位匹配的特质和经历。包含：基本信息、教育背景、实践经历、个人特质、岗位认知、匹配优势。语言简洁明了，条理清晰，诚实真实，展现积极向上的精神面貌。`
  },
  comprehensive: {
    name: "综合分析",
    measuredElements: ["综合分析能力", "言语表达能力", "专业能力"],
    answerFramework: ["表明判断", "分析原因/影响", "提出对策", "联系岗位表态"],
    timeLimitSeconds: 180,
    pitfalls: ["只喊口号", "只谈一面", "对策空泛", "没有公共治理视角"],
    drill: "每天选1个社会治理热点，用\"判断-分析-对策-落点\"复述。",
    knowledgeTips: `综合分析题考察对热点问题、社会现象、政策方针的理解和分析能力。答题思路：表明态度→分析原因→阐述影响→提出对策→总结提升。评分标准：观点明确正确，分析全面深入且逻辑清晰，对策可行有效，语言流畅。`
  },
  emergency: {
    name: "应急应变",
    measuredElements: ["应变能力", "自我情绪控制", "人际交往意识与技巧", "专业能力"],
    answerFramework: ["稳住现场", "查明情况", "依法处置", "汇报复盘"],
    timeLimitSeconds: 150,
    pitfalls: ["一上来就追责", "忽视群众情绪", "缺少程序意识", "没有后续改进"],
    drill: "练习先安抚、再核实、再处理的三段式表达。",
    knowledgeTips: `应急应变题考察面对突发状况的应变处理能力。答题思路：快速反应→控制局面→妥善处理→总结反思。原则：反应迅速措施得当，依法依规处理，以人为本服务群众，注重长效举一反三。`
  },
  interpersonal: {
    name: "人际关系",
    measuredElements: ["人际交往意识与技巧", "自我情绪控制", "言语表达能力"],
    answerFramework: ["摆正心态", "主动沟通", "以工作为重", "总结提升"],
    timeLimitSeconds: 150,
    pitfalls: ["抱怨领导同事", "把矛盾扩大化", "只退让不解决问题", "缺少工作结果"],
    drill: "围绕领导、同事、群众三类对象各练1题。",
    knowledgeTips: `人际关系题考察工作中处理人际关系的意识和能力。原则：工作第一以完成工作为目标，尊重理解不同立场，主动沟通化解矛盾，团结协作为重。不直接批评同事或领导，不激化矛盾，体现大局意识。`
  },
  organization: {
    name: "组织协调",
    measuredElements: ["计划组织协调能力", "综合分析能力", "言语表达能力"],
    answerFramework: ["明确目标", "前期准备", "组织实施", "总结评估"],
    timeLimitSeconds: 180,
    pitfalls: ["活动流程模板化", "没有资源协调", "没有风险预案", "没有效果评估"],
    drill: "把每个活动题拆成时间、人员、物资、风险、反馈五项。",
    knowledgeTips: `组织协调题考察策划、组织、协调能力。答题框架包含：准备阶段（调研了解、制定方案、请示汇报），实施阶段（人员分工、协调沟通、进度控制、应急准备），总结阶段（总结评估、宣传报道、资料归档、反思改进）。`
  },
  vocational: {
    name: "职位认知",
    measuredElements: ["求职动机与拟任职位匹配性", "专业能力", "言语表达能力"],
    answerFramework: ["岗位职责", "自身匹配", "短板改进", "入职计划"],
    timeLimitSeconds: 150,
    pitfalls: ["不了解岗位", "动机只讲稳定", "优势与岗位脱节", "缺少行动计划"],
    drill: "把目标岗位职责整理成3个关键词，再匹配个人经历。",
    knowledgeTips: `职位认知题考察对岗位的理解和自身匹配度。应准确把握岗位要求，客观分析自身优势，坦诚面对不足并提出改进计划，表达服务意识和长期承诺。`
  },
  situation: {
    name: "情景模拟",
    measuredElements: ["应变能力", "人际交往意识与技巧", "言语表达能力", "自我情绪控制"],
    answerFramework: ["进入角色", "共情沟通", "解释规则", "给出方案"],
    timeLimitSeconds: 150,
    pitfalls: ["不像现场说话", "只有道理没有对象感", "承诺超越权限", "语气生硬"],
    drill: "把答案改成可直接说出口的话，避免报告式语言。",
    knowledgeTips: `情景模拟题考察在特定场景下的角色扮演和沟通能力。要点：进入角色、有对象感、语言温度、依法依规。把答案改成可直接说出口的话，避免报告式语言。`
  },
  leaderless_group: {
    name: "无领导小组讨论",
    measuredElements: ["综合分析能力", "言语表达能力", "计划组织协调能力", "人际交往意识与技巧"],
    answerFramework: ["提出观点", "回应他人", "推进共识", "总结输出"],
    timeLimitSeconds: 240,
    pitfalls: ["抢话过多", "沉默无贡献", "只反驳不建设", "不能归纳小组共识"],
    drill: "练习30秒立论、20秒回应、30秒总结三种话术。",
    knowledgeTips: `无领导小组讨论考察讨论、协作、归纳和现场推进能力。重点：观点输出清晰、倾听回应及时、组织推进有力、总结陈词到位。避免抢话过多或沉默无贡献。`
  },
  professional: {
    name: "专业专项",
    measuredElements: ["专业能力", "综合分析能力", "言语表达能力"],
    answerFramework: ["专业判断", "依据说明", "实务处理", "风险提示"],
    timeLimitSeconds: 180,
    pitfalls: ["专业术语堆砌", "不结合岗位", "只讲技术不讲治理", "风险意识不足"],
    drill: "用公务员语境解释一个技术问题：是什么、为什么、怎么办。",
    knowledgeTips: `专业专项题考察岗位所需专业知识和解决实际问题的能力。要点：用公务员语境解释技术问题，体现风险意识、权限边界、安全保密意识，结合岗位职责说明实务处理方案。`
  }
};

function getCategoryGuidance(category: string): CategoryGuidance {
  return CATEGORY_GUIDANCE[category] ?? CATEGORY_GUIDANCE["comprehensive"];
}

// ── 面试评价 ──

export interface ScoreResult {
  scores: Record<string, number>;
  strengths: string[];
  weaknesses: string[];
  suggestions: string;
  totalScore: number;
  objectiveAssessment?: string;
  encouragement?: string;
  nextDrill?: string;
}

export async function evaluateAnswer(
  plugin: IPlugin,
  question: string,
  answer: string,
  category: string
): Promise<ScoreResult | null> {
  if (!requireProFeature(plugin, "aiExamCoach")) return null;
  const guidance = getCategoryGuidance(category);
  const dimText = Object.entries(EVALUATION_DIMENSIONS)
    .map(([name, desc]) => `- ${name}：${desc}`)
    .join("\n");

  const measured = guidance.measuredElements.join("、");
  const framework = guidance.answerFramework.join(" → ");
  const pitfalls = guidance.pitfalls.join("、");

  const response = await plugin.ai.complete({
    responseFormat: "json",
    messages: [
      { role: "system", content: buildSystemPrompt(plugin.settings) },
      {
        role: "user",
        content: `你是公务员结构化面试考官。请对以下面试回答进行结构化评分。

**题型**: ${guidance.name}
**本题重点测评要素**: ${measured}
**建议作答框架**: ${framework}
**常见失分点**: ${pitfalls}

**参考知识**:
${guidance.knowledgeTips}

**软工拆题模型**:
${getCivilServiceInterviewThinkingModelPrompt()}

请额外判断考生是否按“输入问题-处理实操-输出闭环”拆题：输入端是否说明现实矛盾和政策背景，处理端是否讲清运转机制，输出端是否落到群众、基层和长期治理结果。

公务员面试常见测评要素如下，请优先评价"本题重点测评要素"，并保留"言语表达能力"（每项1-10分）：
${dimText}

**题目**: ${question}

**考生回答**: ${answer}

评价顺序必须是：先客观评价，再指出真实优点，最后给出鼓励和下一步训练。鼓励必须基于考生本次回答里的真实表现。

请返回 JSON：
{
  "scores": { "综合分析能力": 8, "言语表达能力": 7 },
  "strengths": ["基于本次回答的真实优点"],
  "weaknesses": ["本次回答的具体不足"],
  "suggestions": "综合改进建议",
  "objectiveAssessment": "先客观说明本次回答的完成度、主要问题和评分依据",
  "encouragement": "基于本次真实表现的鼓励，并接上一句可执行的小行动",
  "nextDrill": "下一次最该练什么"
}

只返回 JSON，不要附带其他文字。`
      }
    ]
  });

  if (!response.ok || !response.text) return null;

  try {
    const cleaned = response.text.replace(/```json\s*|\s*```/g, "").trim();
    const parsed = JSON.parse(cleaned) as ScoreResult;

    if (!parsed.scores || typeof parsed.scores !== "object") return null;

    const scoreValues = Object.values(parsed.scores);
    parsed.totalScore = scoreValues.length > 0
      ? Math.round(scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length * 10) / 10
      : 0;

    return parsed;
  } catch {
    return null;
  }
}

export function formatEvaluation(result: ScoreResult): string {
  const lines: string[] = [];
  lines.push("## 结构化评分\n");

  // Score table
  lines.push("| 维度 | 分数 |");
  lines.push("|------|------|");
  for (const [dim, score] of Object.entries(result.scores)) {
    const bar = "★".repeat(Math.round(score)) + "☆".repeat(10 - Math.round(score));
    lines.push(`| ${dim} | ${bar} (${score}/10) |`);
  }
  lines.push(`\n**综合均分：${result.totalScore}/10**\n`);

  if (result.objectiveAssessment) {
    lines.push(`### 客观评价\n\n${result.objectiveAssessment}\n`);
  }

  if (result.strengths.length > 0) {
    lines.push("### 优点");
    for (const s of result.strengths) {
      lines.push(`- ✅ ${s}`);
    }
  }

  if (result.weaknesses.length > 0) {
    lines.push("\n### 待改进");
    for (const w of result.weaknesses) {
      lines.push(`- ⚠ ${w}`);
    }
  }

  if (result.suggestions) {
    lines.push(`\n### 建议\n\n${result.suggestions}`);
  }

  if (result.nextDrill) {
    lines.push(`\n### 下次练习\n\n${result.nextDrill}`);
  }

  if (result.encouragement) {
    lines.push(`\n> ${result.encouragement}`);
  }

  return lines.join("\n");
}

// ── 练习计划生成（基于用户历史数据个性化）──

export function generatePracticePlan(
  focusCategories: string[],
  history?: {
    totalPractices: number;
    averageScore: number;
    practicedCategories: string[];
    weakDimensions: string[];
  }
): string {
  const lines: string[] = [];
  const cats = focusCategories.length > 0 ? focusCategories : ["self_intro", "comprehensive", "emergency"];
  const total = history?.totalPractices ?? 0;
  const avg = history?.averageScore ?? 0;

  // ── 无记录：简洁引导，完全不像旧模板 ──
  if (total === 0 || !history) {
    lines.push("还没有面试练习记录，先做一次练习吧。");
    lines.push("");
    lines.push("推荐从以下题型开始：");
    for (const cat of cats) {
      const g = getCategoryGuidance(cat);
      lines.push(`- ${g.name}：${g.drill}`);
    }
    lines.push("");
    lines.push("填写题目和回答后，点击「AI 结构化评分」获取评价。");
    lines.push("评价满意后点击「保存记录」，系统会记住你的练习数据。");
    lines.push("有了足够记录后，这里会生成个性化的阶段目标和里程碑。");
    return lines.join("\n");
  }

  // ── 有记录：个性化计划 ──
  lines.push("### 每日练习");
  for (const cat of cats) {
    const g = getCategoryGuidance(cat);
    lines.push(`- ${g.name}：${g.drill}`);
  }

  // 周目标
  const weeklyTarget = total < 5 ? "10" : total < 20 ? "15" : "20";
  const reviewTarget = total < 5 ? "3" : "5";
  lines.push("");
  lines.push("### 周目标");
  lines.push(`- 完成至少 ${weeklyTarget} 道面试题`);
  lines.push(`- 录制并复盘 ${reviewTarget} 次回答`);
  lines.push("- 背诵并熟练运用 2 个答题框架");

  if (history.weakDimensions.length > 0) {
    lines.push(`- 重点突破：${history.weakDimensions.slice(0, 2).join("、")}`);
  }
  const allCats = Object.values(CATEGORY_GUIDANCE).map(g => g.name);
  const covered = new Set(history.practicedCategories);
  const missing = allCats.filter(c => !covered.has(c));
  if (missing.length > 0) {
    lines.push(`- 拓展新题型：${missing.slice(0, 2).join("、")}${missing.length > 2 ? "等" : ""}`);
  }

  // 4周里程碑
  lines.push("");
  lines.push("### 4周里程碑");
  if (avg < 5) {
    lines.push("- 第1周：掌握基本答题框架，流畅度提升");
    lines.push("- 第2周：熟练掌握3类题型的答题方法");
    lines.push("- 第3周：形成个人答题风格，自信度提升");
    lines.push("- 第4周：能够应对各类题型，无明显短板");
  } else if (avg < 7) {
    const focus = history.weakDimensions[0] ?? "薄弱维度";
    lines.push("- 第1周：巩固已有题型，重点提升 " + focus);
    lines.push("- 第2周：拓展未练题型，补充答题素材");
    lines.push("- 第3周：强化弱项维度针对性训练");
    lines.push("- 第4周：全题型模拟，均分稳定在7分以上");
  } else {
    const focus = history.weakDimensions[0] ?? "细节表现";
    lines.push("- 第1周：打磨 " + focus + "，追求精细化表达");
    lines.push("- 第2周：限时高压训练，提升应变速度");
    lines.push("- 第3周：全真模拟实战，适应考场节奏");
    lines.push("- 第4周：实战稳定在8分以上，冲刺高分");
  }

  lines.push(`\n当前进度：已练习 ${total} 次，均分 ${avg}/10`);
  return lines.join("\n");
}

// ── 弱点分析 ──

export interface EvalRecord {
  date: string;
  category: string;
  scores: Record<string, number>;
}

export const IMPROVEMENT_TIPS: Record<string, string[]> = {
  "综合分析能力": ["练习多角度分析社会热点", "使用\"判断-分析-对策-落点\"结构", "关注官方媒体的评论文章"],
  "言语表达能力": ["大声朗读练习增强语感", "对着录音练习回听检查", "控制语速保持适中节奏"],
  "应变能力": ["练习先安抚再处理的三段式", "限时作答训练快速反应", "整理常见突发场景应对模板"],
  "计划组织协调能力": ["拆解活动为时间/人员/物资/风险/反馈五项", "练习制定完整方案", "关注风险评估和预案"],
  "人际交往意识与技巧": ["练习换位思考", "以工作为重的表达方式", "整理领导/同事/群众三类对象话术"],
  "自我情绪控制": ["练习深呼吸冷静技巧", "限制作答时间训练抗压", "准备应对质疑的过渡话术"],
  "求职动机与拟任职位匹配性": ["深入研究目标岗位职责", "整理个人经历与岗位的匹配点", "表达服务意识和长期承诺"],
  "举止仪表": ["对着镜子练习仪态", "控制语速和手势", "录音回听检查语调和停顿"],
  "专业能力": ["用公务员语境解释技术问题", "关注岗位相关的政策法规", "练习\"是什么-为什么-怎么办\"表达"]
};

export function analyzeWeaknesses(records: EvalRecord[]): {
  dimAverages: Record<string, number>;
  weakestDim: string;
  weakestAvg: number;
  tips: string[];
} {
  const dimTotals: Record<string, { sum: number; count: number }> = {};
  for (const rec of records) {
    for (const [dim, score] of Object.entries(rec.scores)) {
      if (!dimTotals[dim]) dimTotals[dim] = { sum: 0, count: 0 };
      dimTotals[dim].sum += score;
      dimTotals[dim].count++;
    }
  }

  const dimAverages: Record<string, number> = {};
  for (const [dim, d] of Object.entries(dimTotals)) {
    dimAverages[dim] = Math.round(d.sum / d.count * 10) / 10;
  }

  const sorted = Object.entries(dimAverages).sort((a, b) => a[1] - b[1]);
  const weakest = sorted[0] ?? ["综合分析能力", 0];

  return {
    dimAverages,
    weakestDim: weakest[0],
    weakestAvg: weakest[1],
    tips: IMPROVEMENT_TIPS[weakest[0]] ?? ["继续全面练习，巩固基础。"]
  };
}

// ── 趋势分析 ──

interface TrendEntry {
  date: string;
  category: string;
  scores: Record<string, number>;
  totalScore: number;
  file: TFile;
}

export async function showInterviewTrends(app: App, plugin: IPlugin): Promise<void> {
  const interviewPath = plugin.path("Exam", "Interview");
  const files = listExamFiles(app, interviewPath);
  const entries: TrendEntry[] = [];

  for (const file of files) {
    const fm = parseFrontmatter(app, file);
    if (!fm || fm.type !== "interview-practice") continue;

    const scores = fm.scores;
    if (scores && typeof scores === "object") {
      const scoreValues = Object.values(scores as Record<string, unknown>)
        .filter((v): v is number => typeof v === "number");
      const totalScore = scoreValues.length > 0
        ? Math.round(scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length * 10) / 10
        : 0;

      entries.push({
        date: String(fm.created ?? ""),
        category: String(fm.category ?? ""),
        scores: scores as Record<string, number>,
        totalScore,
        file
      });
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));

  // Build eval records for weakness analysis
  const evalRecords: EvalRecord[] = entries.map(e => ({
    date: e.date,
    category: e.category,
    scores: e.scores
  }));

  const weaknessAnalysis = evalRecords.length >= 3 ? analyzeWeaknesses(evalRecords) : null;

  new InterviewTrendsModal(app, entries, weaknessAnalysis).open();
}

class InterviewTrendsModal extends Modal {
  constructor(
    app: App,
    private entries: TrendEntry[],
    private weaknessAnalysis: ReturnType<typeof analyzeWeaknesses> | null
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "📈 面试趋势分析" });

    if (this.entries.length === 0) {
      contentEl.createEl("p", {
        text: "暂未有结构化评分的面试记录。请在面试练习中使用「AI 结构化评价」功能。",
        cls: "pls-muted"
      });
      return;
    }

    // Summary
    const summary = contentEl.createDiv({ cls: "pls-section" });
    summary.createEl("h3", { text: "概览" });
    const avgScore = Math.round(
      this.entries.reduce((s, e) => s + e.totalScore, 0) / this.entries.length * 10
    ) / 10;
    const recentScores = this.entries.slice(-5);
    const recentAvg = recentScores.length > 0
      ? Math.round(recentScores.reduce((s, e) => s + e.totalScore, 0) / recentScores.length * 10) / 10
      : 0;
    const trend = recentAvg > avgScore ? "↑ 上升" : recentAvg < avgScore ? "↓ 下降" : "→ 持平";

    const grid = summary.createDiv({ cls: "pls-stat-grid" });
    for (const [label, value] of [
      ["练习次数", `${this.entries.length}次`],
      ["历史均分", `${avgScore}/10`],
      ["最近5次均分", `${recentAvg}/10`],
      ["趋势", trend]
    ]) {
      const card = grid.createDiv({ cls: "pls-stat-card" });
      card.createDiv({ cls: "pls-stat-value", text: value });
      card.createDiv({ cls: "pls-stat-label", text: label });
    }

    // Dimension averages
    const dimTotals: Record<string, { sum: number; count: number }> = {};
    for (const entry of this.entries) {
      for (const [dim, score] of Object.entries(entry.scores)) {
        if (!dimTotals[dim]) dimTotals[dim] = { sum: 0, count: 0 };
        dimTotals[dim].sum += score;
        dimTotals[dim].count++;
      }
    }

    const dimSection = contentEl.createDiv({ cls: "pls-section" });
    dimSection.createEl("h3", { text: "各维度均分" });
    const sorted = Object.entries(dimTotals)
      .map(([dim, d]) => ({ dim, avg: Math.round(d.sum / d.count * 10) / 10 }))
      .sort((a, b) => b.avg - a.avg);

    for (const { dim, avg } of sorted) {
      const bar = "█".repeat(Math.round(avg)) + "░".repeat(10 - Math.round(avg));
      dimSection.createEl("p", { text: `${dim}: ${bar} ${avg}/10` });
    }

    // Weakness analysis (when >= 3 records)
    if (this.weaknessAnalysis) {
      const weakSection = contentEl.createDiv({ cls: "pls-section" });
      weakSection.createEl("h3", { text: "🎯 弱点分析" });
      weakSection.createEl("p", {
        text: `最弱维度：${this.weaknessAnalysis.weakestDim}（均分 ${this.weaknessAnalysis.weakestAvg}/10）`
      });
      weakSection.createEl("p", { text: "针对性建议：" });
      for (const tip of this.weaknessAnalysis.tips) {
        weakSection.createEl("p", { text: `- ${tip}` });
      }
    }

    // Recent entries
    const recents = contentEl.createDiv({ cls: "pls-section" });
    recents.createEl("h3", { text: "最近记录" });
    for (const entry of this.entries.slice(-10).reverse()) {
      const row = recents.createDiv({ cls: "pls-list-item" });
      row.createEl("span", { text: `${entry.date} [${entry.category}] ${entry.totalScore}/10` });
      row.createEl("button", { text: "打开" }).onclick = () => {
        void this.app.workspace.getLeaf(false).openFile(entry.file);
        this.close();
      };
    }
  }
}
