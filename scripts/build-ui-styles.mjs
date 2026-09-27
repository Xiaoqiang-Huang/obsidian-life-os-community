import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';

// Parse balanced blocks, preserving strings/comments and at-rule structure.
// Unlike prefixing a selector, the subject guard excludes V3 even when the selector starts at body.
function splitRules(css) {
  const rules = []; let start = 0, open = -1, depth = 0, quote = '', comment = false;
  for (let i = 0; i < css.length; i++) {
    const c = css[i], n = css[i + 1];
    if (comment) { if (c === '*' && n === '/') { comment = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '*') { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') { if (!depth) open = i; depth++; }
    if (c === '}') { if (--depth < 0) throw Error('Unbalanced CSS'); if (!depth) { rules.push([css.slice(start, open), css.slice(open + 1, i)]); start = i + 1; } }
    if (c === ';' && !depth) { rules.push([css.slice(start, i + 1), null]); start = i + 1; }
  }
  if (depth || quote || comment) throw Error('Incomplete CSS');
  if (css.slice(start).trim()) rules.push([css.slice(start), null]);
  return rules;
}
function mapSelectors(value, guard) {
  let depth = 0, quote = '', start = 0; const parts = [];
  const add = s => {
    let nesting = 0, q = '', at = s.length;
    for (let i = 0; i < s.length; i++) {
      const c = s[i]; if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(' || c === '[') nesting++; if (c === ')' || c === ']') nesting--;
      if (!nesting && (s.slice(i, i + 2) === '::' || /^:(before|after|first-line|first-letter)(?![\w-])/u.test(s.slice(i)))) { at = i; break; }
    }
    return s.slice(0, at).trimEnd() + guard + s.slice(at);
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i]; if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    if (c === '(' || c === '[') depth++; if (c === ')' || c === ']') depth--;
    if (c === ',' && !depth) { parts.push(add(value.slice(start, i).trim())); start = i + 1; }
  }
  parts.push(add(value.slice(start).trim())); return parts.join(',');
}
export function scopeLegacy(css, compatibility = false) {
  return splitRules(css).map(([head, body]) => {
    const clean = head.replace(/\/\*[\s\S]*?\*\//gu, '').trim();
    if (body === null) return head;
    if (/^@(media|supports|container|layer|document|scope)\b/u.test(clean)) return `${head}{${scopeLegacy(body, compatibility)}}`;
    if (clean.startsWith('@')) return compatibility ? '' : `${head}{${body}}`;
    // All 15 registered pages and plugin dialogs now use V3. Keep the old
    // stylesheet only for styled Markdown leaves, not as 30,000 rejected
    // selectors on every new control. Original source remains for rollback.
    if (!compatibility && !/\.(?:lifeos-file-leaf|pls-life-file-leaf)\b/u.test(clean)) return '';
    // Neutral structural fallback for less common controls, not per-theme
    // colour/size locks. V3's semantic tokens own every supported palette.
    if (compatibility && /(?:\bbody\b|\bhtml\b|\.lifeos-theme-|\.theme-(?:dark|light))/u.test(clean)) return '';
    // These components are fully migrated. Their historic size/order/colour locks
    // are not carried into the compatibility layer, even at lower priority.
    if (compatibility && /\.lifeos-(?:settings|sidebar|brand|nav(?:-|\b)|mobile-nav|project-option|project-progress|chat-(?:top|main|shell|composer|compact|runtime|control-summary|send|log)|button|v2-button)/u.test(clean)) return '';
    const guard = compatibility ? ':where(.lifeos-v3, .lifeos-v3 *)' : ':not(:where(.lifeos-v3, .lifeos-v3 *))';
    // Legacy "transition: all" and snapshot-era filters visibly interpolate between
    // unrelated palettes. V3 owns its own interaction motion, never the old engine's.
    const declarations = compatibility ? body.replace(/\s*!important\b/gu, '')
      .replace(/(^|;)\s*(?:transition(?:-[\w-]+)?|animation(?:-[\w-]+)?|(?:-webkit-)?backdrop-filter|filter)\s*:[^;]*(?=;|$)/gu, '$1') : body;
    return `${mapSelectors(compatibility ? clean : clean.replace(/\.(lifeos-file-leaf|pls-life-file-leaf)\b/gu, '.$1:not(.lifeos-reader)'), guard)}{${declarations}}`;
  }).join('\n');
}
export async function buildUIStyles() {
  const legacy = await readFile(new URL('../src/styles/legacy.css', import.meta.url), 'utf8');
  const modules = await Promise.all(['foundation', 'navigation', 'pages', 'mobile', 'reading-assistant', 'project-documents'].map(name => readFile(new URL(`../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const source = `${scopeLegacy(legacy)}\n@layer lifeos-compat{${scopeLegacy(legacy, true)}}\n${modules.join('\n')}`;
  const result = await transform(source, { loader: 'css', minify: true, target: 'chrome105', legalComments: 'none' });
  if (result.warnings.length) throw new Error(result.warnings.map(w => w.text).join('\n'));
  await writeFile(new URL('../styles.css', import.meta.url), `/* Generated by scripts/build-ui-styles.mjs. Edit src/styles/*.css, not this file. */\n${result.code}${await readFile(new URL('../src/styles/deployment-preserved.css', import.meta.url), 'utf8')}`);
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/build-ui-styles.mjs')) await buildUIStyles();
