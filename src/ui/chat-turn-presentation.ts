/** Plain terminal messages, independent of execution-trace UI. Partial output
 * is retained but cannot be mistaken for a completed SDK answer. */
export function chatFailureContent(partial: string, error: string): string {
  const message = `AI 请求失败：${error || "请求未完成"}`;
  return partial ? `${partial}\n\n> 回答未完成。${message}` : message;
}

export function chatStoppedContent(partial: string): string {
  return partial ? `${partial}\n\n> 已停止生成，以上为未完成内容。` : "已停止生成。";
}
