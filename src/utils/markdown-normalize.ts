const PROTECTED_TOKEN_PREFIX = "\uE000LIFEOS_PROTECTED_";
const PROTECTED_TOKEN_SUFFIX = "_END\uE001";

const DISPLAY_MATH_ENVIRONMENT_PATTERN = /\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?|cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|array)\}[\s\S]*?\\end\{\1\}/g;

interface ProtectedSegment {
  token: string;
  value: string;
}
function protectMatches(
  source: string,
  pattern: RegExp,
  segments: ProtectedSegment[],
  transform: (match: string, ...groups: string[]) => string = (match) => match
): string {
  return source.replace(pattern, (match: string, ...args: unknown[]) => {
    const groups = args.slice(0, -2).map((value) => String(value ?? ""));
    const token = `${PROTECTED_TOKEN_PREFIX}${segments.length}${PROTECTED_TOKEN_SUFFIX}`;
    segments.push({ token, value: transform(match, ...groups) });
    return token;
  });
}

function restoreProtectedSegments(source: string, segments: ProtectedSegment[]): string {
  let restored = source;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    restored = restored.split(segment.token).join(segment.value);
  }
  return restored;
}

function isEscapedDelimiter(source: string, offset: number): boolean {
  let precedingBackslashes = 0;
  for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}

function protectAlternativeMathDelimiters(
  source: string,
  segments: ProtectedSegment[],
  pattern: RegExp,
  display: boolean
): string {
  return source.replace(pattern, (match: string, body: string, offset: number, input: string) => {
    if (isEscapedDelimiter(input, offset)) return match;

    const token = `${PROTECTED_TOKEN_PREFIX}${segments.length}${PROTECTED_TOKEN_SUFFIX}`;
    const content = body.trim();
    const value = display
      ? `$$\n${content}\n$$`
      : `$${content}$`;
    segments.push({ token, value });
    return token;
  });
}

/**
 * Normalizes user- and AI-authored Markdown before it reaches Obsidian's renderer.
 *
 * Obsidian reliably recognizes `$...$` and `$$...$$`, while many models emit the
 * LaTeX aliases `\\(...\\)` and `\\[...\\]`. Markdown consumes those delimiter
 * backslashes as escapes before MathJax sees them, so convert the aliases first.
 * Code samples are deliberately protected so documentation remains copyable.
 */
export function normalizeDisplayMarkdown(markdown: string): string {
  let normalized = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) return "";

  const protectedSegments: ProtectedSegment[] = [];

  // Preserve examples and source snippets exactly as authored.
  normalized = protectMatches(
    normalized,
    /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g,
    protectedSegments
  );
  normalized = protectMatches(
    normalized,
    /<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi,
    protectedSegments
  );
  normalized = protectMatches(
    normalized,
    /(^|\n)(?:(?: {4}|\t)[^\n]*(?:\n|$))+/g,
    protectedSegments
  );
  normalized = protectMatches(
    normalized,
    /(`+)([^\n]*?)\1/g,
    protectedSegments
  );

  // Existing Obsidian-compatible math must not be wrapped a second time.
  normalized = protectMatches(normalized, /\$\$[\s\S]*?\$\$/g, protectedSegments);
  normalized = protectMatches(
    normalized,
    /(^|[^\\$])\$(?!\$)([^\n$]+?)\$(?!\$)/g,
    protectedSegments
  );

  normalized = protectAlternativeMathDelimiters(
    normalized,
    protectedSegments,
    /\\\[([\s\S]*?)\\\]/g,
    true
  );
  normalized = protectAlternativeMathDelimiters(
    normalized,
    protectedSegments,
    /\\\(([^\n]*?)\\\)/g,
    false
  );

  // Some tools export complete LaTeX environments without delimiters.
  normalized = normalized.replace(
    DISPLAY_MATH_ENVIRONMENT_PATTERN,
    (environment) => `\n\n$$\n${environment.trim()}\n$$\n\n`
  );

  return restoreProtectedSegments(normalized, protectedSegments).trim();
}
