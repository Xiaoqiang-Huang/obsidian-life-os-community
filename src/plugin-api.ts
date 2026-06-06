import type { App, TFile } from "obsidian";
import type { AiClient } from "./ai";
import type { PersonalLifeSystemSettings } from "./settings";

export interface IPlugin {
  app: App;
  settings: PersonalLifeSystemSettings;
  ai: AiClient;

  getRoot(): string;
  path(...parts: string[]): string;
  ensureBaseStructure(): Promise<void>;
  ensureTodayNote(fullTemplate?: boolean): Promise<TFile>;
  listDailyNotes(): TFile[];
  getTodayNotePath(date?: string): string;
  openTodayNote(fullTemplate: boolean): Promise<TFile>;
  finishTodayNote(): Promise<void>;
  summarizeFile(file: TFile | null): Promise<void>;
  extractTasksFromFile(file: TFile | null): Promise<void>;
  updateMemoryFromFile(file: TFile): Promise<void>;
  analyzeFourSages(text: string): Promise<string | null>;
  activateDashboard(mode?: string): Promise<void>;
  activateTasks(): Promise<void>;
  activateMemory(): Promise<void>;
  activateChat(): Promise<void>;
  activateUserGuide(): Promise<void>;
  activateProCompare(): Promise<void>;
  activateProLicense(): Promise<void>;
  activateCalendar(): Promise<void>;
  getBackgroundResourceUrl(): string | null;
  saveSettings(): Promise<void>;
  applyTheme(): void;
  setTheme(theme: string): Promise<void>;

  // 备考模块
  createXingceQuestion(data: XingceQuestionData): Promise<TFile>;
  createInterviewPractice(data: InterviewPracticeData): Promise<TFile>;
  showXingceStats(): void;
  showInterviewTrends(): Promise<void>;
  showCheckinModal(): Promise<void>;
  showGoalsList(): Promise<void>;
  showTodayTasks(): Promise<void>;
  showUploadMaterial(): Promise<void>;
  showTrainingPlan(): Promise<void>;

  // 报告
  generateReport(period: string): Promise<void>;
  showEmotionTracking(): Promise<void>;
  showDiarySearch(): Promise<void>;
}

export interface XingceQuestionData {
  title: string;
  questionType: string;
  difficulty: string;
  question: string;
  myAnswer: string;
  correctAnswer: string;
  reason: string;
  knowledge: string;
}

export interface InterviewPracticeData {
  category: string;
  question: string;
  answer: string;
  evaluation?: string;
}
