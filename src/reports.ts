import { Component, MarkdownRenderer, Modal, Notice, TFile, type App, type TAbstractFile } from "obsidian";
import type { IPlugin } from "./plugin-api";
import { buildSystemPrompt } from "./ai";
import { getExamChatModeLabel, getExamProfileLabel } from "./settings";
import { formatDate } from "./utils";
import { listExamFiles, parseFrontmatter } from "./exam/data";
import { markLifeOsLeaf } from "./lifeos-shell";
import { requireProFeature } from "./licensing/entitlement";
import { applyWritebackItems, openWritebackPreview, type WritebackItem } from "./writeback-preview";

// ── 报告生成器 ──

export async function generateReport(
  app: App,
  plugin: IPlugin,
  period: "daily" | "weekly" | "monthly"
): Promise<void> {
  if (period === "daily") {
    await generateDailySummary(app, plugin);
    return;
  }
  await generatePeriodicReport(app, plugin, period);
}

async function generateDailySummary(
  app: App,
  plugin: IPlugin
): Promise<void> {
  const today = formatDate();
  new Notice("正在生成今日总结...");

  // Collect today's diary content
  let diaryContent = "";
  try {
    const todayPath = plugin.getTodayNotePath();
    const abstract = app.vault.getAbstractFileByPath(todayPath);
    if (abstract instanceof TFile) {
      const content = await app.vault.read(abstract);
      diaryContent = content.trim();
    }
  } catch { /* no diary today */ }

  // Collect today's exam chat records
  const chatContents: string[] = [];
  try {
    const chatFolder = app.vault.getAbstractFileByPath(plugin.path("Chat"));
    if (chatFolder) {
      const folder = chatFolder as unknown as { children: TAbstractFile[] };
      if (folder.children) {
        const todayChats = folder.children
          .filter((c): c is TFile => c instanceof TFile && c.name.startsWith(today))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const chatFile of todayChats) {
          const content = await app.vault.read(chatFile);
          const fm = parseFrontmatter(app, chatFile);
          // Include all chats, but label exam mode specifically
          const mode = fm?.mode === "exam" ? getExamChatModeLabel(plugin.settings) : "对话";
          chatContents.push(`### ${chatFile.basename}（${mode}）\n\n${content.replace(/^---[\s\S]*?---\n*/, "").trim()}`);
        }
      }
    }
  } catch { /* no chats today */ }

  if (!diaryContent && chatContents.length === 0) {
    new Notice("今日暂无记录，无法生成总结。");
    return;
  }

  const contextParts: string[] = [];
  if (diaryContent) {
    contextParts.push(`## 今日记录\n\n${diaryContent}`);
  }
  if (chatContents.length > 0) {
    contextParts.push(`## ${getExamProfileLabel(plugin.settings)}对话复盘\n\n${chatContents.join("\n\n---\n\n")}`);
  }

  const response = await plugin.ai.complete({
    messages: [
      { role: "system", content: buildSystemPrompt(plugin.settings) },
      {
        role: "user",
        content: `请基于以下今日记录生成一份日报总结。

要求：
1. 今日记录核心回顾（做了什么、进展如何）
2. ${getExamProfileLabel(plugin.settings)}学习复盘（如有备考对话：知识点掌握情况、错题分析、练习表现、需要加强的方面）
3. 情绪与状态
4. 明日重点计划

格式用 Markdown，简洁可执行，不超过 500 字。

${contextParts.join("\n\n---\n\n")}`
      }
    ]
  });

  if (!response.ok || !response.text) {
    new Notice(response.error ?? "日报生成失败。");
    return;
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
  const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  const reportContent = `# 📋 每日总结\n\n📅 **${dateStr} ${weekday} ${timeStr}**\n\n> 基于今日记录和备考对话生成\n\n${response.text}\n\n---\n\n*生成时间：${now.toISOString()}*\n`;

  const reportPath = plugin.path("Reports", `daily-${today}.md`);
  const item: WritebackItem = {
    id: `report-daily-${today}`,
    kind: "replace",
    title: "写入每日总结",
    content: reportContent,
    targetPath: reportPath,
    checked: true
  };
  const written = await openWritebackPreview(app, {
    title: "确认写入每日总结",
    description: "AI 生成内容会先预览，确认后才会保存到 Reports。",
    confirmText: "确认写入",
    items: [item],
    onConfirm: async (items) => applyWritebackItems(app, items)
  });
  if (written.length === 0) {
    new Notice("已取消写入，日报没有保存。");
    return;
  }
  const reportFile = app.vault.getAbstractFileByPath(reportPath);
  if (reportFile instanceof TFile) {
    await openReportFile(app, reportFile, "tab");
    new Notice(`日报已生成：${reportFile.name}`, 6000);
  }
}

async function generatePeriodicReport(
  app: App,
  plugin: IPlugin,
  period: "weekly" | "monthly"
): Promise<void> {
  const date = formatDate();
  const diaryFiles = plugin.listDailyNotes();

  if (diaryFiles.length === 0) {
    new Notice("暂无日记记录。");
    return;
  }

  diaryFiles.sort((a, b) => b.name.localeCompare(a.name));
  const daysBack = period === "weekly" ? 7 : 30;
  const targetFiles = diaryFiles.slice(0, daysBack);

  if (targetFiles.length === 0) {
    new Notice("没有找到最近的日记。");
    return;
  }

  new Notice(`正在生成${period === "weekly" ? "周报" : "月报"}...`);

  const contents: string[] = [];
  for (const file of targetFiles.slice(0, 15)) {
    const content = await app.vault.read(file);
    contents.push(content.slice(0, 2000));
  }

  const periodLabel = period === "weekly" ? "周报" : "月报";
  const response = await plugin.ai.complete({
    messages: [
      { role: "system", content: buildSystemPrompt(plugin.settings) },
      {
        role: "user",
        content: `请基于以下日记内容生成一份${periodLabel}。\n\n要求：\n1. 核心进展\n2. 关键卡点\n3. 认知升级\n4. 数据概览（天数、情绪趋势等）\n5. 下一步行动\n\n日记内容：\n\n${contents.join("\n\n---\n\n")}`
      }
    ]
  });

  if (!response.ok || !response.text) {
    new Notice(response.error ?? "报告生成失败。");
    return;
  }

  let reportPath = plugin.path("Reports", `${date}-${period}.md`);
  const content = `# ${date} ${periodLabel}\n\n${response.text}\n`;

  // If file already exists, save as a new version after user confirmation.
  let versionLabel = "";
  if (app.vault.getAbstractFileByPath(reportPath) instanceof TFile) {
    let version = 2;
    while (app.vault.getAbstractFileByPath(plugin.path("Reports", `${date}-${period}-v${version}.md`)) instanceof TFile) {
      version++;
    }
    reportPath = plugin.path("Reports", `${date}-${period}-v${version}.md`);
    versionLabel = `（v${version}）`;
  }

  const item: WritebackItem = {
    id: `report-${period}-${date}${versionLabel}`,
    kind: "replace",
    title: `写入${periodLabel}${versionLabel}`,
    content,
    targetPath: reportPath,
    checked: true
  };
  const written = await openWritebackPreview(app, {
    title: `确认写入${periodLabel}`,
    description: "AI 生成内容会先预览，确认后才会保存到 Reports。",
    confirmText: "确认写入",
    items: [item],
    onConfirm: async (items) => applyWritebackItems(app, items)
  });
  if (written.length === 0) {
    new Notice(`已取消写入，${periodLabel}没有保存。`);
    return;
  }
  const file = app.vault.getAbstractFileByPath(reportPath);
  if (file instanceof TFile) {
    await openReportFile(app, file, false);
    new Notice(`${periodLabel}已生成${versionLabel}。`);
  }
}

async function openReportFile(app: App, file: TFile, leafType: "tab" | false): Promise<void> {
  await app.workspace.getLeaf(leafType).openFile(file);
  markLifeOsLeaf(app);
}

// ── 情绪追踪 ──

interface EmotionEntry {
  date: string;
  mood: string;
  summary: string;
  file: TFile;
}

export async function showEmotionTracking(app: App, plugin: IPlugin): Promise<void> {
  new Notice("正在分析情绪数据...");
  const entries: EmotionEntry[] = [];

  // Collect from checkins
  const checkinsPath = plugin.path("Exam", "Checkins");
  const checkinFiles = listExamFiles(app, checkinsPath);
  for (const file of checkinFiles) {
    const fm = parseFrontmatter(app, file);
    if (fm?.mood) {
      entries.push({
        date: String(fm.date ?? file.basename),
        mood: String(fm.mood),
        summary: String(fm.summary ?? ""),
        file
      });
    }
  }

  // Extract mood from daily notes
  const diaryFiles = plugin.listDailyNotes();
  for (const file of diaryFiles.slice(-30)) {
    try {
      const content = await app.vault.read(file);
      const moodMatch = content.match(/情绪[：:]\s*(.+)/);
      if (moodMatch && !entries.some((e) => e.date === file.basename.slice(0, 10))) {
        entries.push({
          date: file.basename.slice(0, 10),
          mood: moodMatch[1].trim(),
          summary: "",
          file
        });
      }
    } catch { /* skip */ }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));

  // ── AI infer emotion from recent diaries without explicit mood data ──
  try {
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 7);
    const boundary = formatDate(weekAgo);

    const diaryFilesWithoutMood = diaryFiles.filter(f => {
      const d = f.basename.slice(0, 10);
      return d >= boundary && d <= formatDate() && !entries.some(e => e.date === d);
    }).slice(-5);

    if (diaryFilesWithoutMood.length > 0) {
      const diaryTexts: string[] = [];
      for (const file of diaryFilesWithoutMood) {
        const content = await app.vault.read(file);
        const body = content.replace(/^---[\s\S]*?---\n*/, "").trim().slice(0, 500);
        if (body) {
          diaryTexts.push(`[${file.basename.slice(0, 10)}]\n${body}`);
        }
      }

      if (diaryTexts.length > 0) {
        const moodResponse = await plugin.ai.complete({
          responseFormat: "json",
          messages: [
            { role: "system", content: buildSystemPrompt(plugin.settings) },
            {
              role: "user",
              content:
                "根据以下日记内容，推断用户每天的主要情绪状态。只返回 JSON 数组，每项包含 date 和 mood（值为 happy/neutral/sad/anxious/tired 之一）。\n\n" +
                diaryTexts.join("\n\n---\n\n")
            }
          ]
        });

        if (moodResponse.ok && moodResponse.text) {
          const cleaned = moodResponse.text.replace(/```json\s*|\s*```/g, "").trim();
          const inferred = JSON.parse(cleaned) as Array<{ date: string; mood: string }>;
          if (Array.isArray(inferred)) {
            for (const item of inferred) {
              if (item.date && item.mood && !entries.some(e => e.date === item.date)) {
                const file = diaryFilesWithoutMood.find(f => f.basename.slice(0, 10) === item.date);
                if (file) {
                  entries.push({ date: item.date, mood: item.mood, summary: "AI 推断", file });
                }
              }
            }
            entries.sort((a, b) => a.date.localeCompare(b.date));
          }
        }
      }
    }
  } catch { /* best effort */ }

  if (entries.length === 0) {
    new Notice("暂无情绪数据。请先进行学习打卡或记录情绪。");
    return;
  }

  // AI emotion analysis
  const moodData = entries
    .slice(-30)
    .map((e) => `- ${e.date}: ${e.mood}${e.summary ? ` - ${e.summary}` : ""}`)
    .join("\n");

  let analysis = "";
  try {
    const response = await plugin.ai.complete({
      messages: [
        { role: "system", content: buildSystemPrompt(plugin.settings) },
        {
          role: "user",
          content: `以下是最近的情绪记录数据。请分析：\n1. 整体情绪趋势\n2. 积极/消极情绪比例\n3. 是否有值得关注的情绪波动\n4. 改善建议\n\n${moodData}`
        }
      ]
    });
    analysis = response.ok && response.text ? response.text : "分析生成失败。";
  } catch {
    analysis = "AI 分析暂时不可用。";
  }
  new EmotionTrackingModal(app, entries, analysis).open();
}

class EmotionTrackingModal extends Modal {
  private mdComponent: Component;

  constructor(
    app: App,
    private entries: EmotionEntry[],
    private analysis: string
  ) {
    super(app);
    this.mdComponent = new Component();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal");
    contentEl.createEl("h2", { text: "情绪追踪" });

    // Mood distribution with bar chart
    const moodCounts: Record<string, number> = {};
    for (const entry of this.entries) {
      moodCounts[entry.mood] = (moodCounts[entry.mood] ?? 0) + 1;
    }

    const distSection = contentEl.createDiv({ cls: "pls-section" });
    distSection.createEl("h3", { text: "情绪分布" });
    const total = this.entries.length;
    const moodBar = distSection.createDiv();
    for (const [mood, count] of Object.entries(moodCounts).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((count / total) * 100);
      const barEl = moodBar.createDiv({ cls: "pls-mood-bar" });
      const fill = barEl.createDiv({
        cls: `pls-mood-fill pls-mood-${mood}`,
        attr: { style: `width: ${pct}%` }
      });
      fill.createSpan({ text: `${mood}: ${count}天 (${pct}%)` });
    }

    // Timeline
    const timeline = contentEl.createDiv({ cls: "pls-section" });
    timeline.createEl("h3", { text: "最近记录" });
    for (const entry of this.entries.slice(-14)) {
      const moodEmoji =
        entry.mood === "happy" ? "😊" :
        entry.mood === "neutral" ? "😐" :
        entry.mood === "sad" ? "😢" :
        entry.mood === "anxious" ? "😰" :
        entry.mood === "tired" ? "😴" : "❓";
      timeline.createEl("p", { text: `${entry.date}: ${moodEmoji} ${entry.mood}` });
    }

    // AI analysis (rendered as Markdown)
    const analysisSection = contentEl.createDiv({ cls: "pls-section" });
    analysisSection.createEl("h3", { text: "AI 分析" });
    const body = analysisSection.createDiv();
    void MarkdownRenderer.renderMarkdown(
      this.analysis,
      body,
      this.entries[0]?.file.path ?? "",
      this.mdComponent
    );
  }

  onClose(): void {
    this.mdComponent?.unload();
  }
}

// ── 日记检索 ──

interface SearchResult {
  date: string;
  relevance: string;
  answer: string;
  file?: TFile;
}

export async function showDiarySearch(app: App, plugin: IPlugin): Promise<void> {
  new DiarySearchModal(app, plugin).open();
}

class DiarySearchModal extends Modal {
  private mdComponent: Component;

  constructor(app: App, private plugin: IPlugin) {
    super(app);
    this.mdComponent = new Component();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pls-modal", "pls-diary-search-modal");
    contentEl.createEl("h2", { text: "🔍 日记检索" });

    contentEl.createEl("p", {
      cls: "pls-muted",
      text: "支持自然语言查询和时间表达，例如「最近一周的学习进展」「昨天做了什么」「本月情绪怎么样」"
    });

    const searchPanel = contentEl.createDiv({ cls: "pls-search-panel" });
    const quickRow = searchPanel.createDiv({ cls: "pls-chip-row" });
    const input = searchPanel.createEl("input", {
      attr: { placeholder: "输入搜索内容（支持自然语言+时间表达）..." }
    }) as HTMLInputElement;
    input.addClass("pls-search-input");

    for (const label of ["今天", "昨天", "本周", "上周", "本月", "最近"]) {
      quickRow.createEl("button", { text: label }).onclick = () => {
        input.value = label;
        void this.doSmartSearch(label, resultsEl);
      };
    }

    const searchRow = searchPanel.createDiv({ cls: "pls-button-row pls-search-actions" });
    searchRow.createEl("button", { text: "关键词搜索", cls: "pls-btn-primary" }).onclick = () =>
      void this.doKeywordSearch(input.value, resultsEl);
    searchRow.createEl("button", { text: "AI 智能问答" }).onclick = () =>
      void this.doSmartSearch(input.value, resultsEl);
    const resultsEl = contentEl.createDiv({ cls: "pls-search-results" });

    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        void this.doKeywordSearch(input.value, resultsEl);
      }
    };
  }

  // Time expression parser (mirrors diary_web TimeParser)
  private parseTimeExpression(query: string): { start: string; end: string } | null {
    const today = new Date();
    const fmt = (d: Date) => formatDate(d);

    // Relative days
    const dayMap: Record<string, number> = {
      "今天": 0, "昨天": -1, "前天": -2, "大前天": -3
    };
    for (const [word, offset] of Object.entries(dayMap)) {
      if (query.includes(word)) {
        const d = new Date(today);
        d.setDate(d.getDate() + offset);
        const s = fmt(d);
        return { start: s, end: s };
      }
    }

    // Week
    if (query.includes("本周") || query.includes("这周")) {
      const day = today.getDay();
      const start = new Date(today); start.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
      const end = new Date(start); end.setDate(start.getDate() + 6);
      return { start: fmt(start), end: fmt(end) };
    }
    if (query.includes("上周")) {
      const day = today.getDay();
      const start = new Date(today); start.setDate(today.getDate() - (day === 0 ? 6 : day - 1) - 7);
      const end = new Date(start); end.setDate(start.getDate() + 6);
      return { start: fmt(start), end: fmt(end) };
    }

    // Month
    if (query.includes("本月") || query.includes("这个月")) {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { start: fmt(start), end: fmt(end) };
    }

    // Recent
    if (query.includes("最近") || query.includes("近期")) {
      const start = new Date(today); start.setDate(start.getDate() - 7);
      return { start: fmt(start), end: fmt(today) };
    }

    // YYYY-MM-DD or YYYY年MM月DD日
    const dateMatch = query.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})[日]?/);
    if (dateMatch) {
      const s = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
      return { start: s, end: s };
    }

    // YYYY年MM月
    const monthMatch = query.match(/(\d{4})年(\d{1,2})月/);
    if (monthMatch) {
      const y = parseInt(monthMatch[1]), m = parseInt(monthMatch[2]);
      const start = fmt(new Date(y, m - 1, 1));
      const end = fmt(new Date(y, m, 0));
      return { start, end };
    }

    return null;
  }

  // Classify question type (mirrors diary_web QueryEngine.classify_question)
  private classifyQuestion(query: string): string {
    const memoryKeywords = ["待办", "未完成", "没做完", "还没做", "提醒", "承诺", "明天要做", "我还有什么事"];
    if (memoryKeywords.some(k => query.includes(k))) return "memory";

    const profileKeywords = ["个人信息", "我的信息", "我是谁", "关于我", "我的情况", "我的背景", "我是什么样的人", "总结一下"];
    if (profileKeywords.some(k => query.includes(k))) return "profile";

    const trackKeywords = ["变化", "演变", "发展", "过程", "历史", "经历", "趋势"];
    if (trackKeywords.some(k => query.includes(k))) return "topic_track";

    const statsKeywords = ["怎么样", "如何", "平均", "统计", "多久", "频率", "多少"];
    if (statsKeywords.some(k => query.includes(k))) return "stats";

    const timeKeywords = ["昨天", "今天", "前天", "本周", "上周", "最近", "年", "月", "日", "周"];
    if (timeKeywords.some(k => query.includes(k))) return "time_query";

    return "keyword_search";
  }

  private async doKeywordSearch(query: string, resultsEl: HTMLElement): Promise<void> {
    resultsEl.empty();
    if (!query.trim()) {
      resultsEl.createEl("p", { cls: "pls-muted", text: "请输入搜索关键词。" });
      return;
    }

    resultsEl.createEl("p", { text: "搜索中..." });
    let files = this.plugin.listDailyNotes();

    // Apply time filter
    const timeRange = this.parseTimeExpression(query);
    if (timeRange) {
      files = files.filter(f => {
        const d = f.basename.slice(0, 10);
        return d >= timeRange.start && d <= timeRange.end;
      });
    }

    files.sort((a, b) => b.name.localeCompare(a.name));

    // Extract keywords (remove time/stop words)
    let cleanQuery = query;
    for (const w of ["今天", "昨天", "前天", "本周", "上周", "本月", "最近", "搜索", "查找", "请问", "帮我"]) {
      cleanQuery = cleanQuery.replace(w, " ");
    }
    const keywords = cleanQuery.split(/\s+/).filter(k => k.length >= 2);

    const results: SearchResult[] = [];
    for (const file of files.slice(0, 100)) {
      try {
        const content = await this.app.vault.read(file);
        const lowerContent = content.toLowerCase();
        const matched = keywords.some(kw => lowerContent.includes(kw.toLowerCase()));
        if (matched) {
          const idx = lowerContent.indexOf(keywords[0].toLowerCase());
          const start = Math.max(0, idx - 40);
          const end = Math.min(content.length, idx + keywords[0].length + 80);
          let excerpt = content.slice(start, end);
          if (start > 0) excerpt = "..." + excerpt;
          if (end < content.length) excerpt = excerpt + "...";
          results.push({
            date: file.basename.slice(0, 10),
            relevance: "匹配",
            answer: excerpt,
            file
          });
        }
      } catch { /* skip */ }
    }

    this.renderSearchResults(resultsEl, results);
  }

  private async doSmartSearch(query: string, resultsEl: HTMLElement): Promise<void> {
    resultsEl.empty();
    if (!query.trim()) {
      resultsEl.createEl("p", { cls: "pls-muted", text: "请输入搜索内容。" });
      return;
    }
    if (!requireProFeature(this.plugin, "aiDiarySmartSearch")) return;

    resultsEl.createEl("p", { text: "AI 正在分析..." });

    const qType = this.classifyQuestion(query);
    const timeRange = this.parseTimeExpression(query);
    let files = this.plugin.listDailyNotes();

    // Time filter
    if (timeRange) {
      files = files.filter(f => {
        const d = f.basename.slice(0, 10);
        return d >= timeRange.start && d <= timeRange.end;
      });
    }

    files.sort((a, b) => b.name.localeCompare(a.name));

    // Build context
    const snippets: string[] = [];
    for (const file of files.slice(0, 20)) {
      try {
        const content = await this.app.vault.read(file);
        snippets.push(`[${file.basename.slice(0, 10)}]\n${content.slice(0, 600)}`);
      } catch { /* skip */ }
    }

    // Build AI prompt based on question type
    let aiPrompt = `用户查询：「${query}」\n\n`;
    if (qType === "memory") {
      aiPrompt += `请根据日记内容，找出用户尚未完成的事项。返回 JSON 数组，每项包含 date、title、status。`;
    } else if (qType === "profile") {
      aiPrompt += `请根据日记内容，生成用户的个人画像分析。从身份、关注点、性格、习惯、近期状态等维度分析。返回 JSON 数组，每项包含 date、relevance（高）、answer（分析内容）。`;
    } else if (qType === "topic_track") {
      aiPrompt += `请根据日记内容，分析相关话题的变化趋势。返回 JSON 数组，每项包含 date、relevance、answer。`;
    } else if (qType === "stats") {
      aiPrompt += `请根据日记内容，回答用户的统计问题。返回 JSON 数组，每项包含 date、relevance、answer。`;
    } else {
      aiPrompt += `请从以下日记中找出与用户查询相关的信息。返回 JSON 数组，每项包含 date、relevance（高/中/低）、answer（基于日记内容的回答）。`;
    }

    aiPrompt += `\n\n日记内容：\n${snippets.join("\n\n---\n\n")}`;

    const response = await this.plugin.ai.complete({
      responseFormat: "json",
      messages: [
        { role: "system", content: buildSystemPrompt(this.plugin.settings) },
        { role: "user", content: aiPrompt }
      ]
    });

    if (response.ok && response.text) {
      try {
        const cleaned = response.text.replace(/```json\s*|\s*```/g, "").trim();
        const data = JSON.parse(cleaned);
        resultsEl.empty();
        if (Array.isArray(data) && data.length > 0) {
          const results: SearchResult[] = data.map((item: Record<string, unknown>) => ({
            date: String(item.date ?? ""),
            relevance: String(item.relevance ?? "相关"),
            answer: String(item.answer ?? JSON.stringify(item))
          }));
          this.renderSearchResults(resultsEl, results);
          return;
        }
      } catch {
        // Fall through to plain text
      }
    }

    // Fallback: display as markdown
    resultsEl.empty();
    if (response.ok && response.text) {
      void MarkdownRenderer.renderMarkdown(response.text, resultsEl, "", this.mdComponent);
    } else {
      resultsEl.createEl("p", { text: "搜索失败，请重试。" });
    }
  }

  onClose(): void {
    this.mdComponent?.unload();
  }

  private renderSearchResults(resultsEl: HTMLElement, results: SearchResult[]): void {
    resultsEl.empty();
    if (results.length === 0) {
      resultsEl.createEl("p", { cls: "pls-muted", text: "未找到匹配的日记。" });
      return;
    }

    resultsEl.createEl("p", { text: `找到 ${results.length} 条结果：` });
    for (const result of results.slice(0, 20)) {
      const card = resultsEl.createDiv({ cls: "pls-card" });
      card.createEl("strong", { text: `${result.date} [${result.relevance}]` });
      card.createEl("p", { text: result.answer, cls: "pls-muted" });
      if (result.file) {
        card.createEl("button", { text: "打开日记" }).onclick = () => {
          void this.app.workspace.getLeaf(false).openFile(result.file!);
          this.close();
        };
      }
    }
  }
}
