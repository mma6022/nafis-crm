/**
 * Placeholder pills (designer ANSWERS-1, mismatch 3): visitors see the mockup pill WITHOUT brackets
 * («تأیید محمد»، «جای‌خالی: …»); the original bracketed marker is kept in `data-marker` so
 * scripts/check-markers.mjs still finds every one of them in dist/.
 *
 * Applied to the final HTML (src/middleware.ts) so source files keep their greppable «[تأیید محمد…]» markers:
 *  - `<span class="ph …">[X]</span>`  → `<span class="ph …" data-marker="[X]">X</span>`
 *  - a bare «[X]» in body text (MDX paragraphs) → wrapped the same way
 * Never touches tag attributes, <script>/<style>/<title>/<textarea>, or JSON-LD.
 */
import { MARKER_RE } from './markers';

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pill = (m: string, cls = 'ph') => `<span class="${cls}" data-marker="${attr(m)}">${m.slice(1, -1).trim()}</span>`;
const RAW = /^<(script|style|title|textarea)\b/i;

export function pillMarkers(html: string): string {
  // 1) explicit pills
  html = html.replace(/<span class="(ph(?: [^"]*)?)">\s*(\[[^\]<]*\])\s*<\/span>/g, (all, cls: string, m: string) => {
    MARKER_RE.lastIndex = 0;
    return MARKER_RE.test(m) ? pill(m, cls) : all;
  });
  // 2) bare markers in text nodes only
  const parts = html.split(/(<[^>]*>)/);
  let raw: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith('<')) {
      if (raw) {
        if (new RegExp(`^</${raw}\\s*>`, 'i').test(p)) raw = null;
      } else {
        const m = p.match(RAW);
        if (m && !p.endsWith('/>')) raw = m[1]!.toLowerCase();
      }
      continue;
    }
    if (raw || !p.includes('[')) continue;
    parts[i] = p.replace(MARKER_RE, (m) => pill(m));
  }
  return parts.join('');
}
