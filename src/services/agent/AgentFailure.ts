/** Structured recovery hints; never automatically retries a mutation. */
export function classifyAgentFailure(error: string, mutation: boolean) {
 const category = /(?:只读|权限|拒绝|permission|denied|forbidden|\b403\b)/iu.test(error) ? "permission"
 : /(?:\b401\b|api.?key|unauthori[sz]ed|密钥|鉴权)/iu.test(error) ? "authentication"
 : /(?:\b429\b|rate.?limit|限流)/iu.test(error) ? "rate-limit"
 : /(?:abort|取消)/iu.test(error) ? "cancelled"
 : /(?:timeout|timed out|超时)/iu.test(error) ? "timeout"
 : /(?:ECONN|ENOTFOUND|network|网络)/iu.test(error) ? "network"
 : /(?:ENOENT|not found|不存在|未找到)/iu.test(error) ? "not-found"
 : /(?:参数|invalid|parse|解析)/iu.test(error) ? "invalid-input"
 : "unknown";
 const retryable = !mutation && ["rate-limit", "timeout", "network"].includes(category);
 return { errorCategory: category, retryable, recovery: mutation ? "核查写入是否已经发生，禁止自动重复写入" : retryable ? "可在预算内重试读取" : "修正输入或配置后重试；权限限制不可绕过" };
}
