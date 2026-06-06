import { TFile, type App } from "obsidian";

/** Get frontmatter from the Obsidian metadata cache. Returns null if not indexed or no frontmatter. */
export function parseFrontmatter(app: App, file: TFile): Record<string, unknown> | null {
  const cache = app.metadataCache.getFileCache(file);
  return cache?.frontmatter ?? null;
}

/** List all markdown files under a folder path, using the vault's cached file list. */
export function listExamFiles(app: App, folderPath: string): TFile[] {
  const prefix = folderPath.endsWith("/") ? folderPath : folderPath + "/";
  return app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix));
}

/** Aggregate statistics from files with frontmatter, grouping by a key field. */
export function aggregateByField(
  app: App,
  folderPath: string,
  field: string
): Record<string, number> {
  const counts: Record<string, number> = {};
  const files = listExamFiles(app, folderPath);

  for (const file of files) {
    const fm = parseFrontmatter(app, file);
    if (!fm) continue;
    const value = fm[field];
    if (typeof value === "string") {
      counts[value] = (counts[value] ?? 0) + 1;
    }
  }

  return counts;
}

/** Get structured xingce statistics. */
export interface XingceStats {
  total: number;
  byType: Record<string, { total: number; wrong: number; correctRate: number }>;
  byDifficulty: Record<string, number>;
  recentWrong: { title: string; questionType: string; file: TFile }[];
}

export function getXingceStatistics(app: App, xingcePath: string): XingceStats {
  const files = listExamFiles(app, xingcePath);
  const stats: XingceStats = {
    total: 0,
    byType: {},
    byDifficulty: {},
    recentWrong: []
  };

  for (const file of files) {
    const fm = parseFrontmatter(app, file);
    if (!fm || fm.type !== "xingce-question") continue;

    stats.total++;
    const qType = String(fm.question_type ?? "other");
    const difficulty = String(fm.difficulty ?? "medium");
    const status = String(fm.status ?? "wrong");
    const title = String(fm.title ?? file.basename);

    if (!stats.byType[qType]) {
      stats.byType[qType] = { total: 0, wrong: 0, correctRate: 0 };
    }
    stats.byType[qType].total++;
    if (status === "wrong") {
      stats.byType[qType].wrong++;
    }

    stats.byDifficulty[difficulty] = (stats.byDifficulty[difficulty] ?? 0) + 1;

    if (status === "wrong") {
      stats.recentWrong.push({ title, questionType: qType, file });
    }
  }

  // Compute correct rates
  for (const type of Object.values(stats.byType)) {
    type.correctRate = type.total > 0 ? Math.round(((type.total - type.wrong) / type.total) * 100) : 0;
  }

  // Sort recent wrong by most recent (files are roughly ordered)
  stats.recentWrong.reverse();
  stats.recentWrong = stats.recentWrong.slice(0, 10);

  return stats;
}
