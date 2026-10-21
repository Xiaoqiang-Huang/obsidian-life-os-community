/** Equivalent formatting only: never equate currencies, percentages or different dates. */
export function equivalentEvidenceNumbers(input: string): string[] {
  let text = String(input || "")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\[S\d+\]/gu, " ")
    .replace(/^\s*(?:[-*•]\s+|\d+[.)、](?!\d)\s*|[（(]?[一二三四五六七八九十]+[)）、.]\s*)/gmu, "");
  const tokens = new Set<string>();
  text = text.replace(/\b(20\d{2})(?:[-/.]|\s*年\s*)(\d{1,2})(?:[-/.]|\s*月\s*)(\d{1,2})(?:\s*日)?(?!\d)/gu,
    (whole, y: string, m: string, d: string) => {
      const year = Number(y), month = Number(m), day = Number(d), date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return whole;
      const md = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      tokens.add(`date:${year}-${md}`); tokens.add(`month-day:${md}`);
      return " ";
    });
  text = text.replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/gu, (whole, m: string, d: string) => {
    const month = Number(m), day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return whole;
    tokens.add(`month-day:${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`); return " ";
  });
  text = text.replace(/T?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):?(\d{2}))?(?!\d)/giu, (whole, h: string, m: string, s?: string, zone?: string, zoneSign?: string, zoneHour?: string, zoneMinute?: string) => {
    if (Number(h) > 23 || Number(m) > 59 || (s !== undefined && Number(s) > 59)) { tokens.add(`unparsed-time:${whole}`); return " "; }
    const hm = `${h.padStart(2, "0")}:${m}`;
    if (zone) {
      const hour = Number(zoneHour || 0), minute = Number(zoneMinute || 0);
      if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) { tokens.add(`unparsed-time:${whole}`); return " "; }
      tokens.add(`timezone:${(zoneSign === "-" ? -1 : 1) * (hour * 60 + minute)}`);
    }
    tokens.add(`time:${hm}`); if (s !== undefined) tokens.add(`time:${hm}:${s}`); return " ";
  });
  const shifts: Record<string, number> = { "千": 3, "万": 4, "亿": 8, "万亿": 12 };
  // Ambiguous Latin units (especially m = metres/million) are kept, not scaled.
  for (const match of text.matchAll(/([+\-−－])?\s*([$¥￥])?\s*([+\-−－])?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(万亿|亿|万|千)?\s*(%|％|美元|人民币|元|(?:usd|cny|rmb|mm|cm|km|m|kg|g|k|b)(?:[²³])?\b)?/giu)) {
    const [, leadingSign, symbol, trailingSign, raw, scale, unit] = match;
    const shift = shifts[String(scale || "").toLocaleLowerCase()] || 0;
    const [integer, fraction = ""] = raw.replace(/,/gu, "").split(".");
    let digits = (integer + fraction).replace(/^0+(?=\d)/u, "");
    const decimalPlaces = fraction.length - shift;
    let amount: string;
    if (decimalPlaces <= 0) amount = digits + "0".repeat(-decimalPlaces);
    else {
      digits = digits.padStart(decimalPlaces + 1, "0");
      amount = `${digits.slice(0, -decimalPlaces)}.${digits.slice(-decimalPlaces)}`.replace(/0+$/u, "").replace(/\.$/u, "");
    }
    amount = amount.replace(/^0+(?=\d)/u, "");
    if (/[\-−－]/u.test(leadingSign || trailingSign || "") && amount !== "0") amount = `-${amount}`;
    const lowerUnit = String(unit || "").toLocaleLowerCase();
    const unitKind = /^(?:美元|usd)$/u.test(lowerUnit) ? "usd"
      : /^(?:人民币|元|cny|rmb)$/u.test(lowerUnit) ? "cny"
        : lowerUnit === "%" || lowerUnit === "％" ? "percent" : lowerUnit ? `unit:${lowerUnit}` : "number";
    const symbolKind = symbol === "$" ? "usd" : symbol ? "cny" : "";
    if ((symbolKind && unitKind !== "number" && symbolKind !== unitKind) || (leadingSign && trailingSign)) {
      tokens.add(`ambiguous:${match[0].trim()}`); continue;
    }
    const kind = /^(?:美元|usd)$/u.test(lowerUnit) || symbol === "$" ? "usd"
      : /^(?:人民币|元|cny|rmb)$/u.test(lowerUnit) || symbol === "¥" || symbol === "￥" ? "cny"
        : unitKind;
    tokens.add(`${kind}:${amount}`);
  }
  return Array.from(tokens);
}
