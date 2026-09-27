export const DASHBOARD_VIEW_TYPE = "personal-life-system-dashboard";
export const CHAT_VIEW_TYPE = "personal-life-system-chat";
export const AI_EDIT_PANEL_VIEW_TYPE = "personal-life-system-ai-edit-panel";
export const CALENDAR_VIEW_TYPE = "personal-life-system-calendar";
export const TASKS_VIEW_TYPE = "personal-life-system-tasks";
export const MEMORY_VIEW_TYPE = "personal-life-system-memory";
export const REVIEW_VIEW_TYPE = "personal-life-system-review";
export const DAILY_VIEW_TYPE = "personal-life-system-daily";
export const KNOWLEDGE_VIEW_TYPE = "personal-life-system-knowledge";
export const CHECKIN_VIEW_TYPE = "personal-life-system-checkin";
export const USER_GUIDE_VIEW_TYPE = "personal-life-system-user-guide";
export const PRO_LICENSE_VIEW_TYPE = "personal-life-system-pro-license";
export const PRO_COMPARE_VIEW_TYPE = "personal-life-system-pro-compare";
export const AI_WORKSPACE_VIEW_TYPE = "personal-life-system-ai-workspace";
export const SETTINGS_VIEW_TYPE = "personal-life-system-settings";

export const DEFAULT_LIGHT_DAILY_TEMPLATE = `---
type: daily-note
date: {{date}}
assistant: {{assistantName}}
analysis_status: pending
tags: []
---

## 今日重点

## 快速记录

## 今日小结

## 明日计划

## AI 分析

`;

export const FULL_DAILY_TEMPLATE = `---
type: daily-note
date: {{date}}
assistant: {{assistantName}}
analysis_status: pending
tags: []
---

## 今日重点

## 快速记录

## 能量与情绪

## 今日小结

## 深度思考

## 四圣谏言

### 曾国藩

### 芒格

### 巴菲特

### Karpathy

## 明日计划

`;
