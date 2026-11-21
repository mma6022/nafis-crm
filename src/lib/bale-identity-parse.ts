/**
 * Bale customer-bot identity parser (t866).
 * Normalises Persian/Arabic/English digits, strips bidi/invisible marks,
 * validates national ID checksum, and parses Jalali/Gregorian birth dates.
 * No I/O, no SAPI, no logging of raw values.
 */

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";
const LAT = "0123456789";

const INVISIBLE_RE = /[\u200c\u200d\u200e\u200f\u202a-\u202e\ufeff\u2066-\u2069\u061c\u00a0\u202f]/g;

export const JALALI_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
] as const;

export function faDigits(v: string | number): string {
  return String(v).replace(/[0-9]/g, (d) => FA[Number(d)]!);
}

export function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));
}

export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE_RE, "");
}

/** Digits → Latin, drop bidi/ZWNJ/BOM, keep letters and ordinary separators. */
export function normalizeIdentityText(value: string): string {
  return normalizeDigits(stripInvisible(value)).normalize("NFC");
}

export function validNationalChecksum(code: string): boolean {
  if (!/^\d{10}$/.test(code) || /^(\d)\1{9}$/.test(code)) return false;
  const check = Number(code[9]);
  const sum = code.slice(0, 9).split("").reduce((n, d, i) => n + Number(d) * (10 - i), 0) % 11;
  return (sum < 2 ? sum : 11 - sum) === check;
}

export type NationalIdResult =
  | { ok: true; nid: string }
  | { ok: false; reason: "checksum" | "shape" };

export function parseNationalId(input: string): NationalIdResult {
  const text = normalizeIdentityText(input);
  const compact = text.replace(/[\s\-–—]/g, "");
  const digits = compact.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 10) return { ok: false, reason: "shape" };
  const nid = digits.padStart(10, "0");
  if (!validNationalChecksum(nid)) return { ok: false, reason: "checksum" };
  return { ok: true, nid };
}

export type JalaliDate = { year: number; month: number; day: number; jalali: string };

export type BirthDateResult =
  | { ok: true } & JalaliDate
  | { ok: false; reason: "shape" | "invalid" | "range" };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatJalali(y: number, m: number, d: number): string {
  return `${y}/${pad2(m)}/${pad2(d)}`;
}

export function currentJalali(now = new Date()): JalaliDate {
  const fmt = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Tehran",
  });
  const parts = fmt.formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  return { year, month, day, jalali: formatJalali(year, month, day) };
}

export function gregorianToJalali(y: number, m: number, d: number): JalaliDate | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const fmt = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC",
  });
  const parts = fmt.formatToParts(dt);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  if (!year || !month || !day) return null;
  return { year, month, day, jalali: formatJalali(year, month, day) };
}

function jalaliExists(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  if (m <= 6 && d > 31) return false;
  if (m >= 7 && m <= 11 && d > 30) return false;
  if (m === 12 && d > 30) return false;
  const target = formatJalali(y, m, d);
  const start = Date.UTC(y + 621, 1, 15);
  for (let offset = 0; offset < 420; offset++) {
    const candidate = new Date(start + offset * 86_400_000);
    const parts = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", {
      year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC",
    }).formatToParts(candidate);
    const actual = `${parts.find((p) => p.type === "year")?.value}/${parts.find((p) => p.type === "month")?.value}/${parts.find((p) => p.type === "day")?.value}`;
    if (actual === target) return true;
  }
  return false;
}

function notFutureAndPlausible(j: JalaliDate, now: Date): boolean {
  const cur = currentJalali(now);
  if (j.year > cur.year) return false;
  if (j.year === cur.year && (j.month > cur.month || (j.month === cur.month && j.day > cur.day))) return false;
  if (j.year < cur.year - 120) return false;
  if (j.year < 1200) return false;
  return true;
}

function resolveYear(y: number, now: Date): number | null {
  if (y >= 1200 && y <= 1599) return y;
  if (y >= 1900 && y <= 2100) return y; // gregorian, caller converts
  if (y >= 0 && y <= 99) {
    const cur = currentJalali(now);
    const cur2 = cur.year % 100;
    const as14 = 1400 + y;
    const as13 = 1300 + y;
    // Prefer 13xx for typical adult customers when yy is clearly in the past century;
    // prefer 14xx when yy is this century (up to next year).
    if (y <= cur2 + 1) return as14;
    return as13;
  }
  return null;
}

function buildJalali(y: number, m: number, d: number, now: Date): BirthDateResult {
  let year = y;
  let month = m;
  let day = d;
  if (year >= 1900 && year <= 2100) {
    const conv = gregorianToJalali(year, month, day);
    if (!conv) return { ok: false, reason: "invalid" };
    year = conv.year; month = conv.month; day = conv.day;
  }
  if (!jalaliExists(year, month, day)) return { ok: false, reason: "invalid" };
  const j: JalaliDate = { year, month, day, jalali: formatJalali(year, month, day) };
  if (!notFutureAndPlausible(j, now)) return { ok: false, reason: "range" };
  return { ok: true, ...j };
}


function monthFromName(name: string): number | null {
  const n = name.replace(/ي/g, "ی").replace(/ك/g, "ک");
  if (n === "امرداد") return 5;
  const i = JALALI_MONTHS.indexOf(n as (typeof JALALI_MONTHS)[number]);
  return i >= 0 ? i + 1 : null;
}

function splitNums(s: string): number[] {
  return (s.match(/\d+/g) ?? []).map((x) => Number(x));
}

export function parseBirthDate(input: string, now = new Date()): BirthDateResult {
  const text = normalizeIdentityText(input).trim();
  if (!text) return { ok: false, reason: "shape" };

  // Month-name forms: «۳ مرداد ۱۳۷۰», «1370 مرداد 3», «** مرداد ۱۳۵۰»
  const named = text.match(
    new RegExp(String.raw`(\d{1,4})?\s*(${JALALI_MONTHS.join("|")}|امرداد)\s*(\d{1,4})?`),
  );
  if (named) {
    const month = monthFromName(named[2]);
    const a = named[1] ? Number(named[1]) : NaN;
    const b = named[3] ? Number(named[3]) : NaN;
    if (month) {
      let year: number | null = null;
      let day: number | null = null;
      if (Number.isFinite(a) && Number.isFinite(b)) {
        if (a >= 1000 && b <= 31) { year = resolveYear(a, now); day = b; }
        else if (b >= 1000 && a <= 31) { year = resolveYear(b, now); day = a; }
        else if (a > 31 && b <= 31) { year = resolveYear(a, now); day = b; }
        else { year = resolveYear(b, now); day = a; }
      }
      if (year != null && day != null) return buildJalali(year, month, day, now);
    }
  }

  // Compact 8-digit YYYYMMDD (optionally the only digit run in the string)
  const compact = text.replace(/[\s.\-/\u060c]/g, "");
  const only8 = compact.replace(/\D/g, "");
  if (/^\d{8}$/.test(only8) || (/(^|\D)(\d{8})(\D|$)/.test(text.replace(/[\s.\-/\u060c]/g, " ")))) {
    const m8 = only8.length === 8 ? only8 : (text.replace(/\D/g, "").match(/\d{8}/)?.[0] ?? "");
    // Prefer a standalone 8-digit run if present
    const run8 = text.replace(/[\s.\-/\u060c]/g, " ").match(/(^|\D)(\d{8})(\D|$)/);
    const src = run8 ? run8[2] : m8;
    if (/^\d{8}$/.test(src)) {
      const y = Number(src.slice(0, 4));
      const mo = Number(src.slice(4, 6));
      const d = Number(src.slice(6, 8));
      const resolved = resolveYear(y, now);
      if (resolved != null && mo >= 1 && mo <= 12) {
        const built = buildJalali(resolved, mo, d, now);
        if (built.ok) return built;
      }
    }
  }

  // Split on common separators, including Persian comma
  const normalizedSeps = text.replace(/[.\-–—\\،,]/g, "/").replace(/\s+/g, "/");
  const parts = normalizedSeps.split("/").map((p) => p.trim()).filter((p) => p.length > 0);
  const nums = parts.map((p) => Number(p)).filter((n) => Number.isFinite(n));

  if (nums.length === 3) {
    const [a, b, c] = nums;
    // YYYY M D
    if (String(Math.trunc(a)).length === 4 || a >= 1000) {
      const y = resolveYear(a, now);
      if (y != null) return buildJalali(y, b, c, now);
    }
    // D M YYYY or D M YY
    if (String(Math.trunc(c)).length === 4 || c >= 1000 || (c >= 0 && c <= 99 && a <= 31)) {
      const y = resolveYear(c, now);
      if (y != null && a <= 31) return buildJalali(y, b, a, now);
    }
    // YY M D (70/5/3)
    if (a <= 99 && b <= 12 && c <= 31) {
      const y = resolveYear(a, now);
      if (y != null) return buildJalali(y, b, c, now);
    }
  }

  return { ok: false, reason: "shape" };
}

export type ExtractedIdentity = {
  nid?: string;
  nidReason?: "checksum" | "shape";
  birth?: JalaliDate;
  birthReason?: "shape" | "invalid" | "range";
};

/**
 * Pull a national ID and/or a birth date out of one free-text message.
 * Prefers a checksum-valid 10-digit (or padded 8–9-digit) run, then parses
 * the remainder (or the whole text) as a date.
 */
export function extractIdentity(input: string, now = new Date()): ExtractedIdentity {
  const text = normalizeIdentityText(input);
  const out: ExtractedIdentity = {};

  // Candidate digit runs of 8–10, allowing internal dashes/spaces
  const raw = stripInvisible(input);
  const norm = normalizeDigits(raw);
  const cands: { start: number; end: number; digits: string }[] = [];
  const re = /(?<!\d)[\d][\d \t\-–—]{6,18}[\d](?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm))) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 10) {
      cands.push({ start: m.index, end: m.index + m[0].length, digits });
    }
  }
  // Also plain 8–10 consecutive
  const re2 = /(?<!\d)(\d{8,10})(?!\d)/g;
  while ((m = re2.exec(norm))) {
    const digits = m[1];
    if (!cands.some((c) => c.start <= m!.index && c.end >= m!.index + digits.length)) {
      cands.push({ start: m.index, end: m.index + digits.length, digits });
    }
  }

  const scored = cands
    .map((c) => {
      const nid = c.digits.padStart(10, "0");
      return { ...c, nid, valid: validNationalChecksum(nid) };
    })
    .sort((a, b) => Number(b.valid) - Number(a.valid) || b.digits.length - a.digits.length);

  if (scored[0]?.valid) {
    out.nid = scored[0].nid;
  } else if (scored[0]) {
    out.nidReason = validNationalChecksum(scored[0].digits.padStart(10, "0")) ? undefined : (scored[0].digits.length >= 8 ? "checksum" : "shape");
    if (!out.nid) out.nidReason = scored[0].digits.length >= 8 && scored[0].digits.length <= 10 ? "checksum" : "shape";
  }

  let remainder = norm;
  if (out.nid && scored[0]) {
    remainder = (norm.slice(0, scored[0].start) + " " + norm.slice(scored[0].end)).trim();
  }
  const birthSrc = remainder.replace(/کد\s*ملی/g, " ").replace(/تاریخ\s*تولد/g, " ").trim();
  const birthTry = parseBirthDate(birthSrc || text, now);
  if (birthTry.ok) {
    out.birth = { year: birthTry.year, month: birthTry.month, day: birthTry.day, jalali: birthTry.jalali };
  } else if (birthSrc && /\d/.test(birthSrc)) {
    // If remainder has numbers but isn't a date, try the whole text
    // (unless remainder is only the nid digits we already consumed)
    const remDigits = birthSrc.replace(/\D/g, "");
    if (remDigits.length >= 4) {
      const again = parseBirthDate(birthSrc, now);
      if (again.ok) out.birth = { year: again.year, month: again.month, day: again.day, jalali: again.jalali };
      else out.birthReason = again.reason;
    }
  } else if (!out.nid) {
    const again = parseBirthDate(text, now);
    if (again.ok) out.birth = { year: again.year, month: again.month, day: again.day, jalali: again.jalali };
    else if (/\d/.test(text)) out.birthReason = again.reason;
  }

  if (!out.nid && !out.nidReason) {
    const loose = parseNationalId(input);
    if (loose.ok) out.nid = loose.nid;
    else if (/\d{6,}/.test(normalizeIdentityText(input))) out.nidReason = loose.reason;
  }

  return out;
}

export function formatJalaliConfirm(date: JalaliDate): string {
  const month = JALALI_MONTHS[date.month - 1] ?? String(date.month);
  return `تاریخ تولد شما ${faDigits(date.day)} ${month} ${faDigits(date.year)} است؟ بله/خیر`;
}

/** Prompts shown when flag.customer_bale_identity_steps_v1 is ON. */
export const CB_IDENTITY_STEPS_TEXTS = {
  askNid: "لطفاً فقط کد ملی‌تان را بفرستید.\nرقم‌های فارسی یا انگلیسی هر دو قبول است.\nمثال: ۰۰۱۲۳۴۵۶۷۸",
  askBirth: "حالا تاریخ تولد شمسی‌تان را بفرستید.\nرقم‌های فارسی یا انگلیسی و / یا - یا فاصله فرقی ندارد.\nمثال: ۱۳۷۰/۵/۳",
  retryNid: "کد ملی را نشناختم. ۱۰ رقم است و رقم‌های فارسی یا انگلیسی هر دو قبول است. دوباره فقط کد ملی را بفرستید.\nمثال: ۰۰۱۲۳۴۵۶۷۸",
  retryNidChecksum: "این کد ملی از نظر رقم کنترلی درست نیست. لطفاً دوباره بررسی کنید و فقط کد ملی را بفرستید.",
  retryBirth: "تاریخ تولد را نشناختم. سال و ماه و روز را بفرستید؛ فارسی یا انگلیسی و / یا - یا فاصله فرقی ندارد.\nمثال: ۱۳۷۰/۵/۳",
  retryBirthRange: "این تاریخ تولد در بازه‌ی قابل قبول نیست. لطفاً تاریخ تولد شمسی را دوباره بفرستید.\nمثال: ۱۳۷۰/۵/۳",
  confirm: formatJalaliConfirm,
  yes: "بله",
  no: "خیر",
  yesAliases: ["بله", "بلی", "آره", "اره", "yes"],
  noAliases: ["خیر", "نه", "نخیر", "no"],
} as const;

export function isYes(text: string): boolean {
  const t = stripInvisible(text).trim().replace(/[يى]/g, "ی");
  return (CB_IDENTITY_STEPS_TEXTS.yesAliases as readonly string[]).includes(t);
}

export function isNo(text: string): boolean {
  const t = stripInvisible(text).trim().replace(/[يى]/g, "ی");
  return (CB_IDENTITY_STEPS_TEXTS.noAliases as readonly string[]).includes(t);
}

/** Build a checksum-valid national ID from the first 9 digits (tests / fixtures). */
export function nidFromNine(first9: string): string {
  const d = normalizeDigits(first9).replace(/\D/g, "").padStart(9, "0").slice(-9);
  const sum = d.split("").reduce((n, ch, i) => n + Number(ch) * (10 - i), 0) % 11;
  const check = sum < 2 ? sum : 11 - sum;
  return d + String(check);
}
