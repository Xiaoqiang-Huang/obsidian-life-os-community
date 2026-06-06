export const DASHBOARD_VIEW_TYPE = "personal-life-system-dashboard";
export const CHAT_VIEW_TYPE = "personal-life-system-chat";
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

export const DEFAULT_LIGHT_DAILY_TEMPLATE = `---
type: daily-note
date: {{date}}
assistant: {{assistantName}}
analysis_status: pending
tags:
  - daily
---

# {{date}}

> 用四圣谏言日记体系 v2.0 记录

---

## 快速记录

### 今日要事（3件）
1.

### 一句话总结
今天：

### 能量状态
- 精力：___/10
- 情绪：___
- 睡眠：___h

### 待办延续
- [ ] 来自昨天的：___
- [ ] 明日要做：___

### 标签（必选1个）

#科研 #求职 #备考 #学习 #健康 #社交 #其他

---

## 深度思考

## AI 分析

## 明日计划

---

*创建日期：{{date}}*
*日记版本：v2.0*
`;

export const FULL_DAILY_TEMPLATE = `---
type: daily-note
date: {{date}}
assistant: {{assistantName}}
analysis_status: pending
tags:
  - daily
  - four-sages
---

# {{date}}

> 用四圣谏言日记体系 v2.0 记录

---

## 快速记录

### 今日要事（3件）
1.
2.
3.

### 一句话总结
今天：

### 能量状态
- 精力：___/10
- 情绪：___
- 睡眠：___h

### 待办延续
- [ ] 来自昨天的：___
- [ ] 明日要做：___

### 标签（必选1个）

#科研 #求职 #备考 #学习 #健康 #社交 #其他

---

## 深度思考

## 四圣谏言

### 曾国藩

### 芒格

### 巴菲特

### Karpathy

## 明日计划

---

*创建日期：{{date}}*
*日记版本：v2.0*
`;
