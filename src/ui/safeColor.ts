/**
 * A colour from an untrusted source (a URL parameter, a host page), or nothing.
 *
 * `?accent=` ends up in `--accent`, which the stylesheet uses inside
 * `background:` declarations — so a value like `url(https://tracker/x)` made
 * the browser fetch whatever it named. Only a value that is a colour, and
 * nothing that can reach the network or another variable, gets through.
 */
const PLAIN_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/+-]+\)|[a-z]{3,20})$/i;

export function safeColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (v.length > 64 || /url\(|var\(|image|expression|[;{}<>"'\\]/i.test(v)) return undefined;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', v) ? v : undefined;
  }
  return PLAIN_COLOR.test(v) ? v : undefined;
}
