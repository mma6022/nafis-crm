/**
 * Browser half of the fail-closed rate rule (lib/rates.ts; design HANDOFF §0 v1.2: «این بررسی هم در build و هم در
 * مرورگر انجام می‌شود»). The HTML was built on some earlier day; from the first Tehran day a shown rate is stale
 * (`data-rate-exp` = updated_at + N + 1):
 * - FAQ answers with a number (`[data-rate-fb]`) switch to their approved no-number answer, and the FAQPage JSON-LD
 *   text is switched the same way, so page and structured data never disagree;
 * - plan rate boxes (`.rate[data-rate-exp]`) turn into «از کارشناس بپرسید» → /request/ and the number is removed.
 */
import { tehranToday } from '../lib/rates';

const today = tehranToday();
const due = (el: Element) => {
  const exp = el.getAttribute('data-rate-exp');
  return !!exp && today >= exp;
};
const swaps = new Map<string, string>();
for (const el of document.querySelectorAll<HTMLElement>('[data-rate-fb]')) {
  if (!due(el)) continue;
  const fb = el.getAttribute('data-rate-fb') ?? '';
  swaps.set(el.textContent ?? '', fb);
  el.textContent = fb;
  el.removeAttribute('data-rate-exp');
}
if (swaps.size) {
  for (const s of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent ?? '');
      let hit = false;
      for (const d of Array.isArray(j) ? j : [j])
        for (const q of d?.['@type'] === 'FAQPage' ? (d.mainEntity ?? []) : []) {
          const t = q?.acceptedAnswer?.text;
          if (typeof t === 'string' && swaps.has(t)) {
            q.acceptedAnswer.text = swaps.get(t);
            hit = true;
          }
        }
      if (hit) s.textContent = JSON.stringify(j);
    } catch {
      /* leave unparsable blocks alone */
    }
  }
}
for (const box of document.querySelectorAll<HTMLElement>('.rate[data-rate-exp]')) {
  if (!due(box)) continue;
  const src = box.getAttribute('data-rate-src') || 'plan';
  box.className = `${box.className} rate--ask`.trim();
  box.removeAttribute('data-rate-exp');
  box.setAttribute('data-why', 'stale');
  box.innerHTML = '';
  const l = document.createElement('span');
  l.className = 'rate-l';
  l.textContent = 'نرخ';
  const a = document.createElement('a');
  a.className = 'rate-ask';
  a.href = `/request/?src=${encodeURIComponent(src)}-rate`;
  a.textContent = 'از کارشناس بپرسید';
  box.append(l, a);
}
