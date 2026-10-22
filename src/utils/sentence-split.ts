/** iOS <16.4 has no lookbehind support. These helpers keep the same sentence
 * and coordinated-subject boundaries using forward scans and lookahead only. */
export function splitSentenceFragments(text: string): string[] {
  const value = String(text ?? "");
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/[。！？!?；;]/u.test(char)) {
      out.push(value.slice(start, index + 1));
      start = index + 1;
      continue;
    }
    if (char === "." && index + 2 < value.length && /\s/u.test(value[index + 1]) && /[A-Z“"']/u.test(value[index + 2])) {
      out.push(value.slice(start, index + 1));
      start = index + 2;
      index += 1;
    }
  }
  if (start < value.length) out.push(value.slice(start));
  return out.map(fragment => fragment.trim()).filter(Boolean);
}

/** Split only at a known entity suffix followed by a conjunction. The
 * conjunction is removed; the suffix stays on the left fragment. */
export function splitCoordinatedSubject(subject: string): string[] {
  const value = String(subject ?? "");
  const pattern = /(公司|集团|科技|大学|机构|组织|团队)(以及|和|与|及)(?=.{2,})/gu;
  const pieces: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const cut = match.index + match[1].length;
    if (cut <= last) continue;
    pieces.push(value.slice(last, cut));
    last = cut + match[2].length;
  }
  if (pieces.length === 0) return [value];
  pieces.push(value.slice(last));
  return pieces.filter(piece => piece.length > 0);
}
