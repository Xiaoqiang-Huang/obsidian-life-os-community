/** Preserve unrelated project bytes; the goal is a JSON string on one metadata line. */
export function decodeProjectGoal(value: string): string {
  if (value.startsWith('"')) { try { const parsed = JSON.parse(value); if (typeof parsed === "string") return parsed; } catch {} }
  return value;
}
export function replaceProjectGoal(markdown: string, id: string, expected: string, next: string): string {
  if (!id || next.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(next)) throw new Error("项目目标无效或超过 4000 字。");
  const blocks = Array.from(markdown.matchAll(/^- [^\r\n]+(?:\r?\n[ \t]+- [^\r\n]*)*/gm));
  const matches = blocks.filter(m => m[0].split(/\r?\n/).some(line => line.trim() === "- id: " + id));
  if (matches.length !== 1) throw new Error("项目已删除或标识重复，请刷新后重试。");
  const block = matches[0], goalLines = Array.from(block[0].matchAll(/^[ \t]+- goal:[ \t]*(.*)$/gm));
  if (goalLines.length > 1) throw new Error("项目目标字段重复，请先核对项目索引。");
  const current = goalLines[0] ? decodeProjectGoal(goalLines[0][1].replace(/\r$/, "").trim()) : "";
  if (current !== expected) throw new Error("目标已在其他位置修改；未覆盖，请重新打开后核对。");
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const value = next.trim();
  const lines = block[0].split(/\r?\n/).filter(line => !/^[ \t]+- goal:/.test(line));
  if (value) lines.push("  - goal: " + JSON.stringify(value));
  return markdown.slice(0, block.index!) + lines.join(eol) + markdown.slice(block.index! + block[0].length);
}
