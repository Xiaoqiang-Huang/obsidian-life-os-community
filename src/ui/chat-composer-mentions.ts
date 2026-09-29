export type ComposerTriggerKind = "file" | "skill";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  start: number;
  end: number;
}

/** Only the unfinished token at the caret opens suggestions; ordinary prose is untouched. */
export function readComposerTrigger(value: string, caret: number): ComposerTrigger | null {
  const prefix = value.slice(0, Math.max(0, Math.min(value.length, caret)));
  // Vault names and paths may contain spaces and folder separators. Slash commands
  // keep their token boundary, while @ searches the whole unfinished reference.
  const match = /(^|\s)(@)([^\n@]*)$/u.exec(prefix)
    ?? /(^|\s)(\/)([^\s@/]*)$/u.exec(prefix);
  if (!match) return null;
  // A picked file is rendered as @「name」. It is a committed reference, not
  // another unfinished @ query, even after the user continues typing.
  if (match[2] === "@" && /^「[^」]*」/u.test(match[3])) return null;
  return {
    kind: match[2] === "@" ? "file" : "skill",
    query: match[3].trim().toLocaleLowerCase(),
    start: prefix.length - match[2].length - match[3].length,
    end: prefix.length
  };
}

export interface ComposerSearchFile {
  basename: string;
  path: string;
  extension: string;
  stat: { mtime: number };
}

const REFERENCE_EXTENSIONS = new Set([
  "md", "markdown", "txt", "csv", "json", "pdf", "docx", "doc",
  "png", "jpg", "jpeg", "webp", "gif"
]);

/** Search the whole vault; limit only the rendered page, never the result set. */
export function findComposerFiles<T extends ComposerSearchFile>(files: readonly T[], query: string): T[] {
  const term = query.trim().toLocaleLowerCase();
  const terms = term.split(/\s+/u).filter(Boolean);
  return files
    .filter((file) => REFERENCE_EXTENSIONS.has(file.extension.toLocaleLowerCase())
      && !/\/DocumentRecognition\//iu.test(file.path)
      && terms.every((word) => `${file.basename} ${file.path}`.toLocaleLowerCase().includes(word)))
    .sort((a, b) => Number(b.basename.toLocaleLowerCase().startsWith(terms[0] ?? ""))
      - Number(a.basename.toLocaleLowerCase().startsWith(terms[0] ?? "")) || b.stat.mtime - a.stat.mtime);
}

export interface ComposerSearchSkill { id: string; name: string; description: string; }

export function findComposerSkills<T extends ComposerSearchSkill>(skills: readonly T[], query: string): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return skills.filter((skill) => terms.every((word) =>
    `${skill.name} ${skill.id} ${skill.description}`.toLocaleLowerCase().includes(word)));
}

export function replaceComposerTrigger(value: string, trigger: ComposerTrigger, replacement: string): { value: string; caret: number } {
  const before = value.slice(0, trigger.start);
  const after = value.slice(trigger.end);
  const inserted = replacement + (after && !/^\s/u.test(after) && !/\s$/u.test(replacement) ? " " : "");
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

export function composerSkillLabel(name: string): string {
  return `/${name.replace(/^\/+\s*/u, "").trim()} `;
}

export function composerFileLabel(name: string): string {
  return `@「${name}」 `;
}

/** The visible Skill marker controls the selected Skill; it is not a slash command or prompt text. */
export function promptWithoutSelectedSkill(value: string, name: string | undefined): string {
  const prompt = value.trim();
  if (!name) return prompt;
  const label = composerSkillLabel(name).trimEnd();
  const at = prompt.indexOf(label);
  if (at < 0 || (at > 0 && !/\s/u.test(prompt.charAt(at - 1)))) return prompt;
  const end = at + label.length;
  if (end < prompt.length && !/\s/u.test(prompt.charAt(end))) return prompt;
  return `${prompt.slice(0, at)}${prompt.slice(end)}`.replace(/[ \t]{2,}/gu, " ").trim();
}

export function promptWithoutFileLabel(value: string, name: string): string {
  const label = composerFileLabel(name).trimEnd();
  const at = value.indexOf(label);
  if (at < 0) return value;
  return `${value.slice(0, at)}${value.slice(at + label.length)}`.replace(/[ \t]{2,}/gu, " ");
}
