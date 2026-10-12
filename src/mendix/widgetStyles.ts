/**
 * The app's stylesheet, made safe to put on someone else's page.
 *
 * `app.css` is written for a page the app owns: it styles `html`, `body`,
 * every `button` and every `h2`. Dropped into a Mendix page as it is, the
 * widget would restyle the host's own buttons and headings. Inside `@scope`
 * the same rules only reach the widget's own element and what is in it, and
 * the page-level rules (`:root`, `html, body`) move onto that element.
 *
 * A browser without `@scope` (before Chrome 118 / Safari 17.4) skips the whole
 * block: the widget comes out unstyled, and the host page is untouched. That is
 * the safe way round to fail.
 */
export const WIDGET_ROOT_CLASS = 'spatial-ar-widget';
const STYLE_ID = 'spatial-ar-widget-styles';

/** Rules that must stay at the top level: they do not belong to a scope. */
const HOISTED = /@(keyframes|font-face|import|property)\b/;

export function scopeForWidget(css: string): string {
  const hoisted: string[] = [];
  const kept: string[] = [];
  for (const block of topLevelBlocks(css)) {
    (HOISTED.test(block.trimStart().slice(0, 30)) ? hoisted : kept).push(block);
  }
  const body = kept.join('')
    // The page-level rules become the widget root's.
    .replace(/(^|[},;\s])(?:html\s*,\s*body\s*,\s*#root|html\s*,\s*body|:root|body)\s*\{/g, '$1:scope {');
  return `${hoisted.join('\n')}\n@scope (.${WIDGET_ROOT_CLASS}) {\n${body}\n}\n`;
}

/** The stylesheet's top-level blocks, each with its own braces balanced. */
function topLevelBlocks(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { out.push(css.slice(start, i + 1)); start = i + 1; }
    }
  }
  if (start < css.length && css.slice(start).trim()) out.push(css.slice(start));
  return out;
}

/** Put the scoped stylesheet on the page once, however many widgets there are. */
export function ensureWidgetStyles(css: string, doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = scopeForWidget(css);
  doc.head.appendChild(style);
}
