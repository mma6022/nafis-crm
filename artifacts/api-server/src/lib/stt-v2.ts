/**
 * STT v2 helpers for call-recording transcription only (stt-review proposals 1, 2, 5, 4-c).
 * Used only when the admin sttV2 toggle is effective (master × tab OpenAI key × saved).
 * Does not handle Bale voice messages or CRM voice-notes; those paths stay unchanged.
 * No shadow/parallel path: when effective, this is the live call-recording transcription path.
 * Never logs keys. loan_plans / salespersons are read, never written.
 */
import { queryRows } from "./crm-db";

export const STT_V2_MAX_SINGLE_SECONDS = 20 * 60;
export const STT_V2_MICRO_SECONDS = 3;
export const STT_V2_MICRO_SHARE = 0.05;

const STATIC_TERMS = [
  "نفیس وام",
  "ضامن",
  "چک صیادی",
  "رتبه اعتباری",
  "لندتک",
  "اعتبارسنجی",
  "اقساط",
  "سفته",
  "تومان",
  "کارمزد",
  "وثیقه",
  "امضا",
];

function namesFrom(sql: string, params: unknown[] = []): string[] {
  try {
    const rows = queryRows<{ n: string }>(sql, params);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const n = String(r?.n ?? "").trim();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      if (out.length >= 40) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Domain-vocabulary prompt only. No "don't guess" / "transcribe exactly" instructions. */
export function sttV2DomainPrompt(): string {
  const plans = namesFrom("SELECT name AS n FROM loan_plans WHERE COALESCE(active,1)=1 ORDER BY id");
  const experts = namesFrom("SELECT name AS n FROM salespersons WHERE name IS NOT NULL AND trim(name) != '' ORDER BY id");
  const banks = namesFrom(
    "SELECT DISTINCT bank_name AS n FROM loan_plans WHERE bank_name IS NOT NULL AND trim(bank_name) != '' ORDER BY 1",
  );
  const terms = [...STATIC_TERMS, ...plans, ...banks, ...experts];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const t of terms) {
    if (seen.has(t)) continue;
    seen.add(t);
    list.push(t);
  }
  return "مکالمهٔ تلفنی فارسی ایرانی نفیس وام. واژگان: " + list.join("، ") + ".";
}

const ZWNJ = "\u200c";

/** Deterministic post-cleanup (proposal 5). */
export function normalizeSttV2Text(text: string): string {
  if (!text) return text;
  let t = text.replace(/ي/g, "ی").replace(/ك/g, "ک");
  t = t.replace(/(?<![\w\u200c])(ن?می) (?=[\u0600-\u06FF]{2,})/g, `$1${ZWNJ}`);
  t = t.replace(/(?<=[\u0600-\u06FF]{2}) (ها|های|هایی|هام|هات|هاش|هامون|هاتون|هاشون)(?![\u0600-\u06FF])/g, `${ZWNJ}$1`);
  t = t.replace(/نفیس[\u200c ]?(?:وام|بام|بان)|نفیسوام|نصیب[\u200c ]?وام/g, "نفیس وام");
  t = t.replace(/\s+([،.؟!:])/g, "$1");
  t = t.replace(/(\.\.\.\s*){2,}/g, "... ");
  t = t.split("\n").filter((line) => !/^\s*(کارشناس|مشتری)\s*[^\s\u0600-\u06FF]*\s*:/.test(line)).join("\n");
  return t.trim();
}

export type SttSpeakerSeg = { speaker: string; start: number; end: number; text: string };

/**
 * Merge speakers whose total talk is under 3s or under 5% of talk time
 * into the nearest remaining speaker (proposal 4-c).
 */
export function mergeMicroSpeakers<T extends SttSpeakerSeg>(segments: T[], _duration: number): T[] {
  if (segments.length < 2) return segments;
  const totals = new Map<string, number>();
  let talk = 0;
  for (const s of segments) {
    const d = Math.max(0, s.end - s.start);
    totals.set(s.speaker, (totals.get(s.speaker) ?? 0) + d);
    talk += d;
  }
  if (talk <= 0) return segments;
  const micro = new Set<string>();
  for (const [sp, t] of totals) {
    if (t < STT_V2_MICRO_SECONDS || t / talk < STT_V2_MICRO_SHARE) micro.add(sp);
  }
  const keep = [...totals.keys()].filter((s) => !micro.has(s));
  if (!keep.length || !micro.size) return segments;
  const mid = (s: SttSpeakerSeg) => (s.start + s.end) / 2;
  return segments.map((seg) => {
    if (!micro.has(seg.speaker)) return seg;
    let best = keep[0];
    let bestDist = Infinity;
    for (const other of segments) {
      if (micro.has(other.speaker)) continue;
      const d = Math.abs(mid(other) - mid(seg));
      if (d < bestDist || (d === bestDist && other.start < seg.start && best === other.speaker)) {
        bestDist = d;
        best = other.speaker;
      }
    }
    return { ...seg, speaker: best };
  });
}
