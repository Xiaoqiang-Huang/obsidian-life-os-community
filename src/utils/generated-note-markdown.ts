/** Shared instruction for generated diary/review prose, not user-authored notes. */
export const GENERATED_NOTE_TAG_RULE = "不要自动添加 #话题标签、正文标签栏或 YAML 标签元数据；关键词用普通文字表达，标签由用户在属性栏自行管理。Markdown 标题使用 # 后加空格的规范语法，代码、链接和原始引用中的字面符号保持正确。";

type Range = [start: number, end: number];

/**
 * Prevent model-invented hashtags from polluting the Vault's tag index.
 * Call only at AI-generation boundaries, never on a complete existing note,
 * manual review edits, or an explicit user write. This is not an HTML sanitizer.
 */
export function normalizeGeneratedNoteMarkdown(text: string): string {
  const protectedRanges: Range[] = [];
  const protect = (start: number, end: number) => protectedRanges.push([start, end]);
  const escaped = (index: number): boolean => {
    let slashes = 0;
    while (index > 0 && text[--index] === "\\") slashes++;
    return slashes % 2 === 1;
  };

  // Block code wins over inline Markdown; an unclosed fence protects to EOF.
  let fence: { char: string; length: number; start: number; indent: number } | undefined;
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!line[0]) continue;
    const offset = line.index!;
    const body = line[0].replace(/\r?\n$|\r$/u, "").replace(/^(?: {0,3}>[ \t]?)+/u, "");
    const listPrefix = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/u.exec(body);
    const markerBody = fence?.indent
      ? body.replace(new RegExp(`^ {0,${fence.indent}}`), "")
      : !fence && listPrefix ? body.slice(listPrefix[0].length) : body;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(markerBody);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        protect(fence.start, offset + line[0].length);
        fence = undefined;
      }
    } else if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length, start: offset, indent: listPrefix?.[0].length ?? 0 };
    } else if (/^(?: {4}|\t)/u.test(body)) {
      protect(offset, offset + line[0].length);
    }
  }
  if (fence) protect(fence.start, text.length);

  // Preserve syntax where a hash is data, not a prose label.
  for (const pattern of [
    /<(pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu,
    /<!--[\s\S]*?(?:-->|$)/gu,
    /<\/?[a-zA-Z](?:[^"'<>]|"[^"]*"|'[^']*')*>/gu,
    /\[\[[^\]\r\n]*(?:\]\]|$)/gu,
    /\b(?:[a-z][a-z\d+.-]*:\/\/|mailto:|www\.)[^\s<>]+/giu,
    /&#(?:\d+|x[\da-f]+);/giu,
    /^ {0,3}\[[^\]\r\n]+\]:[^\r\n]*/gmu,
    /\$\$[\s\S]*?(?:\$\$|$)|\$(?![\s$])[^\r\n$]*?\$/gu,
    /\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/gu
  ]) {
    for (const match of text.matchAll(pattern)) protect(match.index!, match.index! + match[0].length);
  }

  // References are syntax, including shortcut/collapsed forms. Keep their IDs
  // consistent with definitions while normalizing unrelated visible labels.
  const referenceKey = (label: string) => label.trim().replace(/\s+/gu, " ").toLowerCase();
  const references = new Set(Array.from(text.matchAll(/^ {0,3}\[([^\]\r\n]+)\]:/gmu), (match) => referenceKey(match[1])));
  if (references.size) {
    for (const match of text.matchAll(/\[([^\]\r\n]+)\]/gu)) {
      if (references.has(referenceKey(match[1])) && !escaped(match.index!)) protect(match.index!, match.index! + match[0].length);
    }
  }

  // Inline backticks must close with the same run length. A stray backtick
  // must not hide the rest of a paragraph from tag normalization.
  const ticks = Array.from(text.matchAll(/`+/gu));
  for (let i = 0; i < ticks.length; i++) {
    const start = ticks[i];
    if (escaped(start.index!) || protectedRanges.some(([a, b]) => start.index! >= a && start.index! < b)) continue;
    const close = ticks.findIndex((tick, j) => j > i && tick[0].length === start[0].length);
    if (close < 0) continue;
    protect(start.index!, ticks[close].index! + ticks[close][0].length);
    i = close;
  }

  // Protect destinations (including balanced parentheses), but allow visible
  // link labels to be normalized: [a #label](url#anchor).
  for (const match of text.matchAll(/\]\(/gu)) {
    if (escaped(match.index!)) continue;
    const start = match.index! + 1;
    let depth = 1;
    for (let i = start + 1; i < text.length; i++) {
      if (escaped(i)) continue;
      if (text[i] === "(") depth++;
      if (text[i] === ")" && --depth === 0) {
        protect(start, i + 1);
        break;
      }
    }
  }

  const ranges: Range[] = [];
  for (const range of protectedRanges.sort((a, b) => a[0] - b[0])) {
    const last = ranges[ranges.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([...range]);
  }
  let rangeIndex = 0;
  // Unicode letters, marks and symbols cover Chinese and emoji tags too.
  return text.replace(/#+([\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200d\ufe0f_\/-]+)/gu, (match, tag: string, offset: number) => {
    while (ranges[rangeIndex] && ranges[rangeIndex][1] <= offset) rangeIndex++;
    if (ranges[rangeIndex] && ranges[rangeIndex][0] <= offset) return match;
    if (escaped(offset)) return match;
    const before = Array.from(text.slice(Math.max(0, offset - 2), offset)).pop() || "";
    if (/[\p{L}\p{M}\p{N}_/\\&]/u.test(before)) return match;
    // Numeric issue references and unambiguous hexadecimal colors are literals.
    if (/^\d+$/u.test(tag) || /^(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/iu.test(tag)) return match;
    return tag;
  });
}
