/** Stop awaiting a stalled provider. The underlying host request may still finish; it cannot write files here. */
export async function withAiDeadline<T>(promise: Promise<T>, milliseconds = 120_000): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([promise, new Promise<T>((_,reject) => {
   timer=setTimeout(()=>reject(new Error('AI 请求超时。草稿和原文未覆盖，请检查模型连接后重试；底层请求可能仍在结束。')),milliseconds);
 })]); } finally { if(timer!==undefined) clearTimeout(timer); }
}
