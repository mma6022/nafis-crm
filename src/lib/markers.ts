/** Placeholder markers ([تأیید محمد…] / [جای‌خالی…]) that must stay visible until approved. */
export const MARKER_RE = /\[\s*(?:تأیید|تایید)\s*محمد[^\]]*\]|\[\s*جای[‌\s]?خالی[^\]]*\]/g;

/** Split text into plain/marker parts so markers can be styled (.ph). */
export function splitMarkers(s: string): { text: string; marker: boolean }[] {
  const out: { text: string; marker: boolean }[] = [];
  let last = 0;
  for (const m of s.matchAll(MARKER_RE)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), marker: false });
    out.push({ text: m[0], marker: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), marker: false });
  return out;
}

/** Text without markers, for machine-readable output (JSON-LD). */
export const stripMarkers = (s: string) => s.replace(MARKER_RE, '').replace(/\s{2,}/g, ' ').trim();
