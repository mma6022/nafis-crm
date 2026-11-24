/**
 * social-hub v1.1 §د — the customer side of the unified «نفیس وام» Bale bot, as pure functions (menu, plan pick, document checklist,
 * one-time national id + birth date). NOT wired to any poller in this build: nothing here sends, polls or reads a token.
 * The live wiring needs the unified bot connection, which stays with Mohammad's release decision.
 */
import { SH_BOT_NAME } from "./social-hub";

export const SHB_MENU = {
  pickPlan: "انتخاب طرح",
  idDocs: "آپلود مدارک هویتی",
  follow: "پیگیری پرونده‌ی تسهیلات",
  ai: "پرسش از هوش مصنوعی",
  expert: "گفتگو با کارشناس",
} as const;
export type ShbKeyboard = { text: string }[][];
/** d_menu: «انتخاب طرح» and, separately, «آپلود مدارک هویتی». */
export function shbMenu(): ShbKeyboard {
  return [[{ text: SHB_MENU.pickPlan }, { text: SHB_MENU.idDocs }], [{ text: SHB_MENU.follow }], [{ text: SHB_MENU.ai }, { text: SHB_MENU.expert }]];
}
export function shbWelcome(name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  return `${n ? `سلام ${n}، ` : "سلام، "}به ربات ${SH_BOT_NAME} خوش آمدید. یکی از گزینه‌ها را انتخاب کنید.`;
}
/** Plan buttons show only the customer label «لندتک / بانک» (never the internal name). */
export function shbPlanKeyboard(plans: { id: number; publicLabel: string }[]): { text: string; data: string }[][] {
  return plans.map((p) => [{ text: p.publicLabel, data: `shp:${p.id}` }]);
}

const lat = (s: string) => s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
/** Iranian national id checksum (10 digits). Accepts Persian digits, spaces and dashes. */
export function shbNationalId(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const v = lat(String(raw ?? "")).replace(/[\s-]/g, "");
  const bad = { ok: false as const, message: "کد ملی ۱۰ رقمی را درست بنویسید." };
  if (!/^\d{10}$/.test(v) || /^(\d)\1{9}$/.test(v)) return bad;
  const sum = [...v.slice(0, 9)].reduce((s, d, i) => s + Number(d) * (10 - i), 0) % 11;
  const chk = Number(v[9]);
  return (sum < 2 ? chk === sum : chk === 11 - sum) ? { ok: true, value: v } : bad;
}
/** Jalali birth date «۱۳۷۲/۰۵/۱۴» (also «-» or spaces). Year 1300..1400, plausible month/day. Returns «1372/05/14». */
export function shbBirthDate(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const m = lat(String(raw ?? "")).trim().match(/^(\d{4})\s*[/\-.\s]\s*(\d{1,2})\s*[/\-.\s]\s*(\d{1,2})$/);
  const bad = { ok: false as const, message: "تاریخ تولد را به شکل ۱۳۷۲/۰۵/۱۴ بنویسید." };
  if (!m) return bad;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1300 || y > 1400 || mo < 1 || mo > 12 || d < 1 || d > (mo <= 6 ? 31 : mo < 12 ? 30 : 30)) return bad;
  return { ok: true, value: `${y}/${String(mo).padStart(2, "0")}/${String(d).padStart(2, "0")}` };
}
export const SHB_ID_DOCS = [
  { type: "national_card_front", label: "روی کارت ملی" },
  { type: "national_card_back", label: "پشت کارت ملی" },
  { type: "birth_cert_p1", label: "صفحهٔ اول شناسنامه" },
] as const;
/** Plan-docs checklist: identity documents already on file are marked «از پرونده برداشته شد» and are not asked again. */
export function shbPlanChecklist(required: { key: string; label: string }[], onFile: Set<string>) {
  const map: Record<string, string> = { national_card: "national_card_front", national_card_front: "national_card_front", national_card_back: "national_card_back", birth_certificate: "birth_cert_p1", birth_cert_p1: "birth_cert_p1" };
  return required.map((r) => {
    const fromFile = map[r.key] ? onFile.has(map[r.key]) : false;
    return { key: r.key, label: r.label, state: fromFile ? ("from_file" as const) : ("needed" as const), note: fromFile ? "از پرونده برداشته شد" : null };
  });
}
/** Next step of «آپلود مدارک هویتی»: id info once, then each image in order; replace is always allowed. */
export function shbIdNext(have: { nationalId: boolean; birth: boolean; docs: Set<string> }): { step: "national_id" | "birth" | "doc" | "done"; doc?: string; label?: string } {
  if (!have.nationalId) return { step: "national_id" };
  if (!have.birth) return { step: "birth" };
  const next = SHB_ID_DOCS.find((d) => !have.docs.has(d.type));
  return next ? { step: "doc", doc: next.type, label: next.label } : { step: "done" };
}
