import {
  getCivilServiceInterviewThinkingModelPrompt,
  getExamProfileLabel,
  normalizeExamProfileType,
  type PersonalLifeSystemSettings
} from "../settings";

export interface ChatInterviewPractice {
  category: string;
  question: string;
}

export type ChatInterviewAction = "answer" | "hint" | "new-question" | "cancel" | "normal-chat";

const QUESTION_REQUEST_PATTERN = /(面试题|模拟面试|结构化面试|出[一个道]?题|生成[一个道]?.*题|练一道|问我一道|考我|换一道|重新出?题|再来一道|下一题|来一道题)/u;
const NEGATED_CANCEL_PATTERN = /(不要|别|不用|无需|先别).{0,8}(取消|结束|停止|退出)/u;
const CANCEL_PRACTICE_PATTERN = /^(取消|结束|停止|退出)(本次|这次)?(面试)?(练习|作答)?$|^(先)?不练了$|^(暂停|中止)(本次|这次)?(面试)?(练习)?$/u;
const HINT_REQUEST_PATTERN = /(提示|思路|框架|怎么答|如何答|不会答|参考答案|解析|示范|帮我答|给点方向|分析.*题|题.*意图|出题意图|什么意思|解释.*题干|解释.*题目|题干.*解释|审题|怎么.*作答|如何.*作答|开头|结尾)/u;
const OFF_TOPIC_REQUEST_PATTERN = /^(帮我|请你?|能不能|可以|麻烦|帮忙).*(日记|任务|复盘|知识库|记忆|授权|购买|设置|导出|迁移|打卡|周报|月报|账单|记账)/u;

export function isInterviewQuestionRequest(content: string): boolean {
  const text = normalizeText(content);
  if (!text) return false;
  if (/(出题意图|题目意图|命题意图)/u.test(text)) return false;
  return QUESTION_REQUEST_PATTERN.test(text) && /(面试|考公|结构化|练习|题|一道|下一题)/u.test(text);
}

export function isInterviewPracticeCancel(content: string): boolean {
  const text = normalizeText(content);
  if (NEGATED_CANCEL_PATTERN.test(text)) return false;
  return CANCEL_PRACTICE_PATTERN.test(text);
}

export function isInterviewHintRequest(content: string): boolean {
  return HINT_REQUEST_PATTERN.test(normalizeText(content));
}

export function classifyInterviewPracticeInput(content: string): ChatInterviewAction {
  const text = normalizeText(content);
  if (!text) return "normal-chat";
  if (isInterviewPracticeCancel(content)) return "cancel";
  if (isInterviewQuestionRequest(content)) return "new-question";
  if (isInterviewHintRequest(content)) return "hint";
  if (OFF_TOPIC_REQUEST_PATTERN.test(text)) return "normal-chat";
  return "answer";
}

export function buildInterviewQuestionPrompt(
  settings: Partial<PersonalLifeSystemSettings>,
  category = "综合分析"
): string {
  const examLabel = getExamProfileLabel(settings);
  const isCivilServiceProfile = normalizeExamProfileType(settings.examProfileType) === "civil-service";
  const thinkingModel = isCivilServiceProfile
    ? `\n\n请让题目适合用下面的拆题模型回答：\n${getCivilServiceInterviewThinkingModelPrompt()}`
    : "";

  return [
    `请生成一道${examLabel}面试练习题。`,
    `题型倾向：${category || "综合分析"}。`,
    "只输出一道题，不要给解析、答案、评分或示范作答。",
    "必须使用以下格式，方便插件识别并进入等待作答状态：",
    "面试练习题",
    "题型：综合分析",
    "题目：<完整题目>",
    "作答要求：请用户直接回复自己的作答，建议 2 分钟内完成。",
    thinkingModel
  ].filter(Boolean).join("\n");
}

export function parseInterviewQuestion(content: string): ChatInterviewPractice | null {
  const source = stripFooter(content);
  if (!/面试练习题/u.test(source)) return null;

  const categoryMatch = source.match(/题型[：:]\s*([^\n\r]+)/u);
  const questionMatch = source.match(/题目[：:]\s*([\s\S]*?)(?:\n\s*(?:作答要求|回答要求|参考答案|解析|评分|AI生成)[：:]|$)/u);
  const question = cleanQuestion(questionMatch?.[1] ?? "");
  if (!question) return null;

  return {
    category: normalizeCategoryLabel(categoryMatch?.[1] ?? "面试练习"),
    question
  };
}

export function buildInterviewHintPrompt(
  settings: Partial<PersonalLifeSystemSettings>,
  practice: ChatInterviewPractice,
  userRequest: string
): string {
  const examLabel = getExamProfileLabel(settings);
  const isCivilServiceProfile = normalizeExamProfileType(settings.examProfileType) === "civil-service";
  const thinkingModel = isCivilServiceProfile
    ? `\n\n可以引用这个拆题模型做提示，但不要替用户完整作答：\n${getCivilServiceInterviewThinkingModelPrompt()}`
    : "";

  return [
    `你正在担任${examLabel}面试教练。用户还没有正式作答，只是在追问上一道面试题。`,
    "请给作答思路或提示，不要评分，不要结束练习，不要重新出题，也不要输出最终写回预览。",
    `题型：${practice.category}`,
    `题目：${practice.question}`,
    `用户追问：${userRequest}`,
    thinkingModel,
    "输出要求：先给 3-5 个作答要点，再给一个 20 秒开头示范，最后提醒用户继续直接回复完整作答。"
  ].filter(Boolean).join("\n\n");
}

export function buildInterviewEvaluationPrompt(
  settings: Partial<PersonalLifeSystemSettings>,
  practice: ChatInterviewPractice,
  answer: string
): string {
  const examLabel = getExamProfileLabel(settings);
  const isCivilServiceProfile = normalizeExamProfileType(settings.examProfileType) === "civil-service";
  const thinkingModel = isCivilServiceProfile
    ? `\n\n本题评价必须检查考生是否形成“输入问题 - 处理实操 - 输出闭环”：\n${getCivilServiceInterviewThinkingModelPrompt()}`
    : "";

  return [
    `你正在担任${examLabel}面试教练。用户这轮是在回答上一道面试题，不要重新出题。`,
    "请只评价本次作答，不要改写成普通聊天回复。",
    `题型：${practice.category}`,
    `题目：${practice.question}`,
    `考生回答：${answer}`,
    thinkingModel,
    "请按下面结构输出：",
    "## 结构化评分",
    "- 审题准确：0-10 分，说明依据。",
    "- 逻辑结构：0-10 分，说明是否有清晰层次。",
    "- 处理实操：0-10 分，说明动作是否具体可执行。",
    "- 输出闭环：0-10 分，说明是否落到群众、基层、治理或长期效果。",
    "- 表达呈现：0-10 分，说明是否像面试现场能说出口。",
    "## 主要优点",
    "## 主要问题",
    "## 示范优化",
    "给出一版更好的 60-90 秒作答，但不要脱离考生原意。",
    "## 下一步练习",
    "给出一条可立即练习的小任务。"
  ].filter(Boolean).join("\n\n");
}

function normalizeText(content: string): string {
  return content.replace(/\s+/g, "").trim();
}

function stripFooter(content: string): string {
  return content.replace(/(?:^|\n)\s*AI生成\s*$/u, "").trim();
}

function cleanQuestion(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/^["“]+|["”]+$/gu, "")
    .trim();
}

function normalizeCategoryLabel(content: string): string {
  return content.replace(/[。；;，,]+$/u, "").trim() || "面试练习";
}
