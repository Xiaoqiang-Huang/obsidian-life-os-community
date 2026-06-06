import { Component, MarkdownRenderer, Modal, Notice, TFile, type App } from "obsidian";
import type { IPlugin } from "../plugin-api";
import { formatDate } from "../utils";
import { listExamFiles, parseFrontmatter } from "./data";
import { CATEGORY_GUIDANCE, IMPROVEMENT_TIPS, type EvalRecord } from "./interview";

interface PlanSection {
  title: string;
  items: string[];
}

interface TrainingPlan {
  sections: PlanSection[];
  summary: string;
}

interface InterviewAnalysis {
  recordCount: number;
  dimAverages: Record<string, number>;
  weakDims: { dim: string; avg: number; tips: string[] }[];
  nextDrill: string | null;
  practicedCategories: string[];
  recentAvg: number | null;
}

function buildInterviewSection(ia: InterviewAnalysis): PlanSection {
  if (ia.recordCount === 0) {
    // No records → suggest starting with core categories
    const starters = ["self_intro", "comprehensive", "emergency"];
    const items: string[] = [];
    items.push("还没有面试练习记录，建议从以下题型开始：");
    for (const key of starters) {
      const g = CATEGORY_GUIDANCE[key];
      items.push(`- **${g.name}**：${g.drill}`);
    }
    items.push("");
    items.push("完成练习后使用「结构化评分」获取 AI 评价和建议。");
    return { title: "面试练习", items };
  }

  const items: string[] = [];

  // Practice stats
  items.push(`已练习 ${ia.recordCount} 次` + (ia.recentAvg !== null ? `，最近 5 次均分 ${ia.recentAvg}/10` : ""));

  // Categories covered
  if (ia.practicedCategories.length > 0) {
    const allCats = Object.values(CATEGORY_GUIDANCE).map(g => g.name);
    const covered = ia.practicedCategories.map(c => CATEGORY_GUIDANCE[c]?.name ?? c);
    const missing = allCats.filter(c => !covered.includes(c) && !ia.practicedCategories.includes(c));
    items.push(`已练习题型：${covered.join("、")}`);
    if (missing.length > 0) {
      items.push(`建议补充练习：${missing.slice(0, 3).join("、")}${missing.length > 3 ? "等" : ""}`);
    }
  }

  // Weak dimensions with scores and tips
  if (ia.weakDims.length > 0) {
    items.push("");
    items.push("**需要提升的维度：**");
    for (const w of ia.weakDims) {
      const bar = "█".repeat(Math.round(w.avg)) + "░".repeat(10 - Math.round(w.avg));
      items.push(`- **${w.dim}** ${bar} ${w.avg}/10`);
      for (const tip of w.tips.slice(0, 2)) {
        items.push(`  · ${tip}`);
      }
    }
  }

  // Next drill from last practice
  if (ia.nextDrill) {
    items.push("");
    items.push(`**上次 AI 建议**：${ia.nextDrill}`);
  }

  return { title: "面试专项训练", items };
}

/** Generate a daily training plan from goals, checkins, and weak areas */
function buildTrainingPlan(
  xingceWeakTypes: string[],
  interviewAnalysis: InterviewAnalysis,
  activeGoals: { title: string; progress: number; target: number }[],
  hasCheckedIn: boolean,
  todayTasks: { title: string; completed: number; target: number }[]
): TrainingPlan {
  const sections: PlanSection[] = [];

  // 1. Checkin status
  if (hasCheckedIn) {
    sections.push({ title: "今日打卡", items: ["今天已打卡，继续保持！"] });
  } else {
    sections.push({ title: "今日打卡", items: ["还没有打卡，完成后记得打卡记录。"] });
  }

  // 2. Goals progress
  if (activeGoals.length > 0) {
    const goalItems = activeGoals.map((g) => {
      const pct = g.target > 0 ? Math.round(g.progress / g.target * 100) : 0;
      const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
      return `**${g.title}** ${bar} ${pct}%（${g.progress}/${g.target}）`;
    });
    sections.push({ title: "目标进度", items: goalItems });
  }

  // 3. Today's tasks
  if (todayTasks.length > 0) {
    const items = todayTasks.map((t) => {
      const status = t.completed >= t.target ? "✓" : `进行中（${t.completed}/${t.target}）`;
      return `${t.title} — ${status}`;
    });
    sections.push({ title: "今日任务", items });
  }

  // 4. Xingce weak areas + recommended practice
  if (xingceWeakTypes.length > 0) {
    const typeDrills: Record<string, string> = {
      "言语理解": "做10道言语理解题，注意关键词和逻辑衔接",
      "数量关系": "做5道数量关系题，先练速算再练应用题",
      "判断推理": "做10道判断推理题，重点练习逻辑判断和定义判断",
      "资料分析": "做1套资料分析（4题），练习快速定位数据",
      "常识判断": "复习时政热点和法律法规，做10道常识题"
    };
    const items: string[] = [];
    items.push(`薄弱题型：${xingceWeakTypes.join("、")}`);
    for (const t of xingceWeakTypes) {
      const drill = typeDrills[t] ?? `做5道${t}题，记录错因`;
      items.push(`- ${drill}`);
    }
    sections.push({ title: "行测重点练习", items });
  } else {
    sections.push({
      title: "行测练习",
      items: ["各题型均衡练习，保持手感。建议每天至少做20道题。"]
    });
  }

  // 5. Interview — personalized
  sections.push(buildInterviewSection(interviewAnalysis));

  // Summary
  const summaryParts: string[] = [];
  if (!hasCheckedIn) summaryParts.push("记得学习完成后打卡");
  if (xingceWeakTypes.length > 0) summaryParts.push(`重点攻克${xingceWeakTypes[0]}`);
  if (interviewAnalysis.weakDims.length > 0) summaryParts.push(`面试重点提升${interviewAnalysis.weakDims[0].dim}`);
  const summary = summaryParts.length > 0
    ? `今日重点：${summaryParts.join("；")}。`
    : "今日保持均衡训练节奏。";

  return { sections, summary };
}

export async function showTrainingPlan(app: App, plugin: IPlugin): Promise<void> {
  // Collect data from all exam sub-modules
  const today = formatDate();

  // ── Active goals ──
  const goalsPath = plugin.path("Exam", "Goals");
  const goalFiles = listExamFiles(app, goalsPath);
  const activeGoals: { title: string; progress: number; target: number }[] = [];
  for (const file of goalFiles) {
    const fm = parseFrontmatter(app, file);
    if (!fm || fm.type !== "study-goal" || fm.status !== "active") continue;
    activeGoals.push({
      title: String(fm.title ?? file.basename),
      progress: Number(fm.current_progress ?? 0),
      target: Number(fm.target ?? 0)
    });
  }

  // ── Today's tasks ──
  const tasksPath = plugin.path("Exam", "Tasks", `${today}.md`);
  const tasksAbstract = app.vault.getAbstractFileByPath(tasksPath);
  const todayTasks: { title: string; completed: number; target: number }[] = [];
  if (tasksAbstract instanceof TFile) {
    const fm = parseFrontmatter(app, tasksAbstract);
    const tasks = fm?.tasks;
    if (Array.isArray(tasks)) {
      for (const t of tasks) {
        if (t && typeof t === "object") {
          const obj = t as Record<string, unknown>;
          todayTasks.push({
            title: String(obj.title ?? ""),
            completed: Number(obj.completed ?? 0),
            target: Number(obj.target ?? 0)
          });
        }
      }
    }
  }

  // ── Checkin status ──
  const checkinPath = plugin.path("Exam", "Checkins", `${today}.md`);
  const checkinAbstract = app.vault.getAbstractFileByPath(checkinPath);
  const hasCheckedIn = checkinAbstract instanceof TFile;

  // ── Xingce weak types ──
  const xingcePath = plugin.path("Exam", "Xingce");
  const xingceFiles = listExamFiles(app, xingcePath);
  const typeStats: Record<string, { correct: number; total: number }> = {};
  for (const file of xingceFiles) {
    const fm = parseFrontmatter(app, file);
    if (!fm || fm.type !== "xingce-question") continue;
    const qType = String(fm.question_type ?? "");
    const isCorrect = fm.is_correct === true || String(fm.is_correct) === "true";
    if (!qType) continue;
    if (!typeStats[qType]) typeStats[qType] = { correct: 0, total: 0 };
    typeStats[qType].total++;
    if (isCorrect) typeStats[qType].correct++;
  }
  const xingceWeakTypes = Object.entries(typeStats)
    .filter(([, d]) => d.total >= 3 && d.correct / d.total < 0.6)
    .sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total)
    .map(([type]) => type);

  // ── Interview analysis (personalized) ──
  const interviewPath = plugin.path("Exam", "Interview");
  const interviewFiles = listExamFiles(app, interviewPath);
  const evalRecords: EvalRecord[] = [];
  let latestNextDrill: string | null = null;

  for (const file of interviewFiles) {
    const fm = parseFrontmatter(app, file);
    if (!fm || fm.type !== "interview-practice") continue;
    const scores = fm.scores;
    if (scores && typeof scores === "object") {
      evalRecords.push({
        date: String(fm.created ?? ""),
        category: String(fm.category ?? ""),
        scores: scores as Record<string, number>
      });
      // Grab nextDrill from the most recent entry
      if (!latestNextDrill && fm.nextDrill && typeof fm.nextDrill === "string") {
        latestNextDrill = fm.nextDrill;
      }
    }
  }

  // Build per-dim averages
  const dimTotals: Record<string, { sum: number; count: number }> = {};
  for (const rec of evalRecords) {
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

  // Weak dimensions (avg < 7, sorted by weakest first)
  const weakDims = Object.entries(dimAverages)
    .filter(([, avg]) => avg < 7)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 4)
    .map(([dim, avg]) => ({
      dim,
      avg,
      tips: IMPROVEMENT_TIPS[dim] ?? ["继续练习，巩固基础。"]
    }));

  // Practiced categories
  const practicedSet = new Set(evalRecords.map(r => r.category));

  // Recent average (last 5)
  const sortedRecords = [...evalRecords].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sortedRecords.slice(-5);
  const recentAvg = recent.length > 0
    ? Math.round(recent.reduce((s, r) => {
        const vals = Object.values(r.scores);
        return s + (vals.reduce((a, b) => a + b, 0) / vals.length);
      }, 0) / recent.length * 10) / 10
    : null;

  const interviewAnalysis: InterviewAnalysis = {
    recordCount: evalRecords.length,
    dimAverages,
    weakDims,
    nextDrill: latestNextDrill,
    practicedCategories: Array.from(practicedSet),
    recentAvg
  };

  const plan = buildTrainingPlan(
    xingceWeakTypes,
    interviewAnalysis,
    activeGoals,
    hasCheckedIn,
    todayTasks
  );

  new TrainingPlanModal(app, plugin, plan).open();
}

class TrainingPlanModal extends Modal {
  private mdComponent: Component;

  constructor(
    app: App,
    private plugin: IPlugin,
    private plan: TrainingPlan
  ) {
    super(app);
    this.mdComponent = new Component();
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "今日训练计划" });

    // Summary banner
    const banner = contentEl.createDiv({ cls: "pls-section pls-training-banner" });
    banner.createEl("p", { text: this.plan.summary, cls: "pls-stat" });

    // Sections (render as Markdown to support **bold** etc.)
    for (const section of this.plan.sections) {
      const sec = contentEl.createDiv({ cls: "pls-section" });
      sec.createEl("h3", { text: section.title });
      const markdown = section.items
        .filter(item => item !== "")
        .join("\n\n");
      if (markdown) {
        const body = sec.createDiv();
        await MarkdownRenderer.renderMarkdown(markdown, body, "", this.mdComponent);
      }
    }

    const row = contentEl.createDiv({ cls: "pls-button-row" });
    row.createEl("button", { text: "关闭" }).onclick = () => this.close();
    row.createEl("button", { text: "今日打卡", cls: "pls-btn-primary" }).onclick = () => {
      this.close();
      void this.plugin.showCheckinModal();
    };
    row.createEl("button", { text: "今日任务" }).onclick = () => {
      this.close();
      void this.plugin.showTodayTasks();
    };
  }

  onClose(): void {
    this.mdComponent?.unload();
  }
}
