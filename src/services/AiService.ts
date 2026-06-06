export class AiService {
  async mockReply(): Promise<string> {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    return "我会结合你的日记、任务和复盘内容，给出更贴合当前状态的建议。";
  }
}
