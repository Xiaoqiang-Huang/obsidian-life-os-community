/** Date-only arithmetic: never use UTC parsing or file modification dates. */
export type ReviewWindow = { start: string; end: string };
export type ReviewPeriod = 'daily' | 'weekly' | 'monthly' | 'custom';
export function parseReviewDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y,m,d] = value.split('-').map(Number);
  if (y < 100 || y > 9999) return null;
  const date = new Date(y,m-1,d,12);
  return date.getFullYear()===y && date.getMonth()===m-1 && date.getDate()===d ? date : null;
}
export function reviewDate(date: Date): string {
 return [String(date.getFullYear()).padStart(4,'0'),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
}
export function weeklyReviewWindow(reference: string, weekEndsOn: 'saturday' | 'sunday' = 'sunday', previous = false): ReviewWindow {
 const date = parseReviewDate(reference);
 if (!date) throw new Error('请选择有效的参考日期。');
 date.setDate(date.getDate()-(date.getDay()||7)+1-(previous?7:0));
 const start=reviewDate(date);
 date.setDate(date.getDate()+(weekEndsOn==='saturday'?5:6));
 const end=reviewDate(date);
 if(!parseReviewDate(start)||!parseReviewDate(end)) throw new Error('统计周期超出支持的日期范围。');
 return {start,end};
}
