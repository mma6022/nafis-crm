import { compactRankList, CREDIT_SUBGRADES, gradeMatches, isLegacyGradeLetter } from "./credit-subgrades";
import { MILITARY_STATUSES, profileReasons, profileReasonText, type ProfileReason, type ProfileReasonCode } from "./plan-profile-match";
/**
 * Team-sales model: pure rules (no DB). Ported from /workspace/nafis-sales/lead-form.html
 * (matchPlans / computePriority). The server recomputes priority; client values are previews only.
 * Working hours use Asia/Tehran (fixed UTC+03:30, Iran has no DST since 2022).
 */
export type TeamSalesConfig = {
  enabled: boolean;
  qualifierSalespersonId: number;
  closerSalespersonIds: number[];
  closerFirstCallWorkingHours: number;
  noteMinLength: number;
  workHours: { start: number; end: number };
  /** JS getDay() values in Tehran time; default Sat–Thu (Friday=5 is off). */
  workDays: number[];
  noAnswerRetryHours: number[];
  maxNoAnswerAttempts: number;
  p1MinScore: number;
  p2MinScore: number;
  bouncedChequeBlocks: boolean;
  p2DefaultRecallDays: Record<string, number>;
  curiousNurtureDays: number;
};

export const DEFAULT_TEAM_SALES_CONFIG: TeamSalesConfig = {
  enabled: false,
  qualifierSalespersonId: 6,
  closerSalespersonIds: [3, 4],
  closerFirstCallWorkingHours: 3,
  noteMinLength: 10, // crm-call-note-min (was 30)
  workHours: { start: 9, end: 18 },
  workDays: [6, 0, 1, 2, 3, 4],
  noAnswerRetryHours: [4, 24],
  maxNoAnswerAttempts: 3,
  p1MinScore: 70,
  p2MinScore: 40,
  bouncedChequeBlocks: true,
  p2DefaultRecallDays: { now: 1, month: 7, later: 30 },
  curiousNurtureDays: 30,
};

export function mergeTeamSalesConfig(raw: unknown): TeamSalesConfig {
  const c = { ...DEFAULT_TEAM_SALES_CONFIG };
  if (!raw || typeof raw !== "object") return c;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === "boolean") c.enabled = r.enabled;
  const int = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);
  c.qualifierSalespersonId = int(r.qualifierSalespersonId) ?? c.qualifierSalespersonId;
  if (Array.isArray(r.closerSalespersonIds) && r.closerSalespersonIds.length && r.closerSalespersonIds.every((x) => int(x)))
    c.closerSalespersonIds = r.closerSalespersonIds as number[];
  c.closerFirstCallWorkingHours = int(r.closerFirstCallWorkingHours) ?? c.closerFirstCallWorkingHours;
  c.noteMinLength = int(r.noteMinLength) ?? c.noteMinLength;
  c.maxNoAnswerAttempts = int(r.maxNoAnswerAttempts) ?? c.maxNoAnswerAttempts;
  const wh = r.workHours as { start?: unknown; end?: unknown } | undefined;
  if (wh && Number.isInteger(wh.start) && Number.isInteger(wh.end) && (wh.start as number) >= 0 &&
      (wh.end as number) <= 24 && (wh.start as number) < (wh.end as number))
    c.workHours = { start: wh.start as number, end: wh.end as number };
  if (Array.isArray(r.workDays) && r.workDays.length && r.workDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
    c.workDays = r.workDays as number[];
  return c;
}

/* ---------------- Tehran working hours ---------------- */
const TEHRAN_OFFSET_MS = 3.5 * 3600_000;
/** A Date whose UTC fields read as Tehran wall-clock time. */
const toWall = (d: Date) => new Date(d.getTime() + TEHRAN_OFFSET_MS);
const fromWall = (w: Date) => new Date(w.getTime() - TEHRAN_OFFSET_MS);

function isWorkDay(w: Date, cfg: TeamSalesConfig) { return cfg.workDays.includes(w.getUTCDay()); }

/** Move an instant forward to the nearest moment inside working hours (unchanged if already inside). */
export function shiftIntoWorkingHours(from: Date, cfg: TeamSalesConfig = DEFAULT_TEAM_SALES_CONFIG): Date {
  const w = toWall(from);
  for (let i = 0; i < 14; i++) {
    const minutes = w.getUTCHours() * 60 + w.getUTCMinutes() + w.getUTCSeconds() / 60;
    if (isWorkDay(w, cfg) && minutes >= cfg.workHours.start * 60 && minutes < cfg.workHours.end * 60) return fromWall(w);
    if (isWorkDay(w, cfg) && minutes < cfg.workHours.start * 60) {
      w.setUTCHours(cfg.workHours.start, 0, 0, 0);
      return fromWall(w);
    }
    w.setUTCDate(w.getUTCDate() + 1);
    w.setUTCHours(cfg.workHours.start, 0, 0, 0);
    if (isWorkDay(w, cfg)) return fromWall(w);
  }
  return from;
}

/** Add N working hours (only time inside working hours counts). */
export function addWorkingHours(from: Date, hours: number, cfg: TeamSalesConfig = DEFAULT_TEAM_SALES_CONFIG): Date {
  let remaining = hours * 3600_000;
  let cur = shiftIntoWorkingHours(from, cfg);
  for (let i = 0; i < 60 && remaining > 0; i++) {
    const w = toWall(cur);
    const end = new Date(w); end.setUTCHours(cfg.workHours.end, 0, 0, 0);
    const available = end.getTime() - w.getTime();
    if (remaining <= available) return new Date(cur.getTime() + remaining);
    remaining -= available;
    cur = shiftIntoWorkingHours(fromWall(end), cfg);
  }
  return cur;
}

/** Calendar delay, then pushed into working hours (no-answer retries, recall dates). */
export function addCalendarHoursInWork(from: Date, hours: number, cfg: TeamSalesConfig = DEFAULT_TEAM_SALES_CONFIG): Date {
  return shiftIntoWorkingHours(new Date(from.getTime() + hours * 3600_000), cfg);
}

/* ---------------- Qualifier answers ---------------- */
export const CALL_RESULTS = ["answered", "no_answer", "callback", "wrong_number"] as const;
export type QualifierAnswers = {
  /** "simple" = 3-step form (no job / guarantor questions; check type not asked). */
  mode?: "simple" | "full" | null;
  callResult: (typeof CALL_RESULTS)[number];
  callbackAt?: string | null;
  urgency?: "now" | "month" | "later" | "curious" | null;
  amountMillion?: number | null;
  loanPref?: "goods" | "score" | "both" | null;
  jobType?: string | null;
  creditRank?: string | null; // A1..E3 | unknown (a retired A–E letter only when kept unchanged from an earlier answer)
  checkStatus?: "none" | "physical" | "digital" | "both" | "any" | null;
  canPromissory?: "yes" | "no" | null;
  salaryDeduct?: "yes" | "no" | null;
  bouncedCheque?: "yes" | "no" | null;
  guarantorCount?: number | null;
  gRank?: string | null;
  gPhysical?: boolean; gDigital?: boolean; gPromissory?: boolean; gSalary?: boolean;
  docsReady?: "all" | "partial" | "none" | null;
  recallAt?: string | null;
  /** 2 = Kazemi's 6-step first-call form (crm-call-form-plans): guarantor yes/no/unknown + cheque + grade, plan cards. */
  formVersion?: 2 | null;
  guarantorAvailable?: Tri | null;
  guarantorCheque?: Tri | null;
  /**
   * crm-no-plan-option (first-call form, all optional so older clients keep working):
   * military service status, guarantor job (only with guarantor «بله»), city of residence,
   * and «هیچ طرحی به این مشتری نمی‌خوره» (never an automatic P1; exclusive with selected plans).
   * jobType may also be "unknown" («نمی‌دونه») in the first-call form.
   */
  military?: (typeof MILITARY_STATUSES)[number] | null;
  gJobType?: string | null;
  city?: string | null;
  noPlanFit?: boolean | null;
  /** HISTORY-A v1.2 (Armita §الف-۳): «متقاضی یا یکی از خانواده‌اش بازنشسته‌ی تأمین اجتماعی هست؟» — required in the first-call form; relation optional (family only). */
  ssoRetiree?: (typeof SSO_RETIREE)[number] | null;
  ssoRetireeRelation?: string | null;
};
export const SSO_RETIREE = ["self", "family", "none"] as const;
export const SSO_RELATION_MAX = 40;
export type Tri = "yes" | "no" | "unknown";
const TRI: readonly string[] = ["yes", "no", "unknown"];
export const isFirstCallForm = (a: QualifierAnswers | null | undefined) => !!a && a.mode === "simple" && a.formVersion === 2;

const JOBS = ["employee_with_insurance", "employee_no_insurance", "business", "no_doc", "retired", "unemployed"];
export const RANKS: readonly string[] = [...CREDIT_SUBGRADES, "unknown"];
/** Previous answers for the same customer: a retired A–E letter is accepted only when it is that unchanged value. */
export type LegacyRankRef = { creditRank?: string | null; gRank?: string | null };
const rankAccepted = (value: string, legacy: string | null | undefined) =>
  RANKS.includes(value) || (isLegacyGradeLetter(value) && value === legacy);

/** Validates the answers for a call result. Returns a Persian error or null. */
export function validateAnswers(a: QualifierAnswers, now: Date = new Date(), legacy: LegacyRankRef = {},
  opts: { forPlans?: boolean } = {}): string | null {
  if (!a || !CALL_RESULTS.includes(a.callResult)) return "نتیجهٔ تماس معتبر نیست.";
  if (opts.forPlans && (a.callResult !== "answered" || !isFirstCallForm(a))) return "طرح‌ها فقط برای تماس پاسخ‌داده در فرم تماس اول محاسبه می‌شوند.";
  if (a.callResult === "callback") {
    const at = a.callbackAt ? Date.parse(a.callbackAt) : Number.NaN;
    if (Number.isNaN(at)) return "زمان تماس بعدی را مشخص کنید.";
    if (at <= now.getTime()) return "زمان تماس بعدی باید در آینده باشد.";
    return null;
  }
  if (a.callResult !== "answered") return null;
  // First-call form: urgency is the LAST question (asked after the plans), so the plans step validates without it.
  // There is no early «فقط کنجکاوه» exit there: every question is answered even for «curious».
  if (!opts.forPlans) {
    if (!a.urgency || !["now", "month", "later", "curious"].includes(a.urgency)) return "فوریت را مشخص کنید.";
    if (a.urgency === "curious" && !isFirstCallForm(a)) return null;
  }
  if (!(Number(a.amountMillion) > 0)) return "مبلغ درخواستی را وارد کنید.";
  if (a.loanPref && !["goods", "score", "both"].includes(a.loanPref)) return "نوع وام معتبر نیست.";
  const simple = a.mode === "simple";
  if (simple ? a.jobType != null && !JOBS.includes(a.jobType) && !(isFirstCallForm(a) && a.jobType === "unknown")
    : !a.jobType || !JOBS.includes(a.jobType)) return "شغل متقاضی را مشخص کنید.";
  if (!a.creditRank || !rankAccepted(a.creditRank, legacy.creditRank)) return "رتبهٔ اعتباری را مشخص کنید (یا «نمی‌دانم»).";
  if (!a.checkStatus || !["none", "physical", "digital", "both", ...(simple ? ["any"] : [])].includes(a.checkStatus)) return "وضعیت چک متقاضی را مشخص کنید.";
  if (!a.bouncedCheque || !["yes", "no"].includes(a.bouncedCheque)) return "چک برگشتی را مشخص کنید.";
  if (!a.docsReady || !["all", "partial", "none"].includes(a.docsReady)) return "وضعیت مدارک را مشخص کنید.";
  const g = Number(a.guarantorCount ?? 0);
  if (!Number.isInteger(g) || g < 0 || g > 5) return "تعداد ضامن معتبر نیست.";
  if (g > 0 && a.gRank && !rankAccepted(a.gRank, legacy.gRank)) return "رتبهٔ ضامن معتبر نیست.";
  if (isFirstCallForm(a)) {
    if (!a.guarantorAvailable || !TRI.includes(a.guarantorAvailable)) return "معرفی ضامن را مشخص کنید (یا «نمی‌دونه»).";
    if (a.guarantorAvailable === "yes") {
      // PM: after «بله» BOTH follow-ups are always asked (cheque and grade), «نمی‌دونه» counts as an answer.
      if (!a.guarantorCheque || !TRI.includes(a.guarantorCheque)) return "چک ضامن را مشخص کنید (یا «نمی‌دونه»).";
      if (!a.gRank || !rankAccepted(a.gRank, legacy.gRank)) return "رتبهٔ اعتباری ضامن را مشخص کنید (یا «نمی‌دونه»).";
    }
    if (a.military != null && !(MILITARY_STATUSES as readonly string[]).includes(a.military)) return "وضعیت نظام وظیفه معتبر نیست.";
    if (a.gJobType != null && !JOBS.includes(a.gJobType) && a.gJobType !== "unknown") return "شغل ضامن معتبر نیست.";
    if (a.city != null && (typeof a.city !== "string" || [...a.city.trim()].length > 60)) return "شهر محل سکونت معتبر نیست (حداکثر ۶۰ نویسه).";
    if (a.noPlanFit != null && typeof a.noPlanFit !== "boolean") return "گزینه‌ی «هیچ طرحی نمی‌خوره» معتبر نیست.";
    // Required in the new form UI (and by «ذخیره‌ی پرونده»); the server tolerates it missing so a tab still on the previous bundle can finish its call.
    if (a.ssoRetiree != null && !(SSO_RETIREE as readonly string[]).includes(a.ssoRetiree)) return "بازنشستگی تأمین اجتماعی (متقاضی یا خانواده) معتبر نیست.";
    if (a.ssoRetireeRelation != null && (typeof a.ssoRetireeRelation !== "string" || [...a.ssoRetireeRelation.trim()].length > SSO_RELATION_MAX))
      return `نسبت عضو خانواده معتبر نیست (حداکثر ${SSO_RELATION_MAX} نویسه).`;
  } else if (a.noPlanFit) return "گزینه‌ی «هیچ طرحی نمی‌خوره» فقط در فرم تماس اول است.";
  return null;
}

/**
 * First-call form → the legacy answer fields (stored answers stay readable by the old code and the priority rules):
 * guarantor «بله» = one guarantor (no «چند ضامن؟» question), guarantor cheque «بله» = either cheque type.
 * Follow-up answers are dropped when the guarantor is not «بله».
 */
export function normalizeFirstCallAnswers(a: QualifierAnswers): QualifierAnswers {
  if (!isFirstCallForm(a)) return a;
  const yes = a.guarantorAvailable === "yes";
  const cheque = yes ? a.guarantorCheque ?? null : null;
  return {
    ...a, guarantorCheque: cheque, gRank: yes ? a.gRank ?? null : null, guarantorCount: yes ? 1 : 0,
    gJobType: yes ? a.gJobType ?? null : null, city: typeof a.city === "string" ? a.city.trim().replace(/\s+/g, " ") || null : null,
    noPlanFit: a.noPlanFit === true,
    ssoRetiree: a.ssoRetiree ?? null,
    ssoRetireeRelation: a.ssoRetiree === "family" && typeof a.ssoRetireeRelation === "string" ? a.ssoRetireeRelation.trim().replace(/\s+/g, " ") || null : null,
    gPhysical: cheque === "yes", gDigital: cheque === "yes", gPromissory: false, gSalary: false,
  };
}

export type PlanCondition = {
  id: number | string; max: number; ranks: string[]; jobs: string[]; coll: string;
  guar: boolean; gRanks: string[]; gColl: string;
  /** crm-no-plan-option: guarantor job rule and military-service requirement (first-call evaluator only). */
  gJobs?: string[]; needsMilitary?: boolean;
  /** needs_* flags of the condition row (first-call evaluator only; the legacy matcher ignores them). */
  flags?: { cCheck?: boolean; cPromissory?: boolean; cSalary?: boolean; gCheck?: boolean; gPromissory?: boolean; gSalary?: boolean };
};
export type PlanForMatch = { planId: number; name: string; loanType: string; conds: PlanCondition[];
  bankName?: string; installments?: number[] };
export type PlanMatch = { planId: number; planName: string; conditionId: number | string; max: number;
  assumptions: string[]; amountFits: boolean };

/* Plan 17 (Saman) and plan 10 (Khorshid): rules only written in row notes. */
const COND_OVERRIDES: Record<string, { cust?: string[]; guar?: string[]; two?: boolean }> = {
  374: { cust: ["check"] }, 375: { cust: ["salary"] },
  376: { guar: ["salary"] }, 377: { guar: ["check"] },
  378: { cust: ["check"], guar: ["check"] }, 379: { cust: ["salary"], guar: ["salary"] },
  380: { cust: ["salary"], guar: ["check"] }, 381: { cust: ["check"], guar: ["salary"] },
  382: { cust: ["salary"], guar: ["salary"], two: true }, 383: { cust: ["check"], guar: ["check"], two: true },
  384: { cust: ["salary"], guar: ["check"], two: true }, 385: { cust: ["salary"], guar: ["check"], two: true },
  126: { two: true }, 127: { two: true }, 128: { two: true }, 129: { two: true },
};

function custHas(a: QualifierAnswers, kind: string) {
  // "any" (simple form: «چک دارد») satisfies either check type.
  if (kind === "physical_check") return a.checkStatus === "physical" || a.checkStatus === "both" || a.checkStatus === "any";
  if (kind === "digital_check") return a.checkStatus === "digital" || a.checkStatus === "both" || a.checkStatus === "any";
  if (kind === "check") return !!a.checkStatus && a.checkStatus !== "none";
  if (kind === "promissory") return a.canPromissory === "yes";
  if (kind === "salary") return a.salaryDeduct === "yes";
  return kind === "none" || !kind;
}
function guarHas(a: QualifierAnswers, kind: string) {
  if (kind === "physical_check") return !!a.gPhysical;
  if (kind === "digital_check") return !!a.gDigital;
  if (kind === "check") return !!(a.gPhysical || a.gDigital);
  if (kind === "promissory") return !!a.gPromissory;
  if (kind === "salary") return !!a.gSalary;
  return kind === "none" || !kind;
}

export function matchPlans(a: QualifierAnswers, plans: PlanForMatch[]): PlanMatch[] {
  const want = (Number(a.amountMillion) || 0) * 1e6;
  const gCount = Number(a.guarantorCount) || 0;
  type Cand = PlanMatch & { _rank: number };
  const out: Cand[] = [];
  for (const p of plans) {
    if (a.loanPref && a.loanPref !== "both" && p.loanType !== a.loanPref) continue;
    let best: Cand | null = null;
    for (const c of p.conds) {
      const o = COND_OVERRIDES[String(c.id)] ?? {};
      const assumptions: string[] = [];
      // Simple form does not ask the job: plans are matched on rank and check/promissory only.
      const jobType = a.jobType === "unknown" ? null : a.jobType;
      if (c.jobs.length && jobType != null && !c.jobs.includes(String(jobType))) continue;
      if (c.jobs.length && jobType == null && a.mode !== "simple") continue;
      if (c.ranks.length) {
        if (a.creditRank === "unknown") assumptions.push(`رتبهٔ متقاضی باید ${compactRankList(c.ranks).join("/")} باشد`);
        else if (!gradeMatches(a.creditRank, c.ranks)) continue;
      }
      if (!custHas(a, c.coll)) continue;
      if (o.cust && !o.cust.some((k) => custHas(a, k))) continue;
      const needG = c.guar || !!o.guar;
      if (needG) {
        if (gCount < (o.two ? 2 : 1)) continue;
        if (c.gRanks.length) {
          if (!a.gRank || a.gRank === "unknown") assumptions.push(`رتبهٔ ضامن باید ${compactRankList(c.gRanks).join("/")} باشد`);
          else if (!gradeMatches(a.gRank, c.gRanks)) continue;
        }
        if (!guarHas(a, c.gColl)) continue;
        if (o.guar && !o.guar.some((k) => guarHas(a, k))) continue;
      }
      const amountFits = want <= c.max;
      const _rank = (amountFits ? 1000 : 0) - assumptions.length * 10 + c.max / 1e9;
      const cand: Cand = { planId: p.planId, planName: p.name, conditionId: c.id, max: c.max, assumptions, amountFits, _rank };
      if (!best || cand._rank > best._rank) best = cand;
    }
    if (best) out.push(best);
  }
  out.sort((x, y) => (Number(y.amountFits) - Number(x.amountFits)) ||
    (x.assumptions.length - y.assumptions.length) || (y.max - x.max));
  return out.map(({ _rank, ...m }) => m);
}

export type LeadOutcome = {
  /** null = no priority decided (a no-answer before the last attempt: nobody talked to the customer). */
  priority: 1 | 2 | 3 | null;
  outcome: "handoff" | "recall" | "no_answer" | "cold_archive" | "nurture" | "not_eligible" | "invalid";
  nextActionAt: string | null;
  score: number | null;
  reasons: string[];
  attempts: number;
  /** cfg.maxNoAnswerAttempts, so the client can show «بی‌پاسخ ۱ از ۳». */
  maxAttempts: number;
};

/**
 * crm-no-plan-p2: "the customer responded well" for a no-plan first-call form, from explicit form answers only:
 * step 1 «نتیجه‌ی تماس» = «جواب داد و صحبت کردیم» (callResult "answered") AND the last question «فوریت» is a real intent
 * («همین الان / این هفته» now, «تا یک ماه» month, «بعداً» later), i.e. NOT «فقط کنجکاوه» (curious).
 * The form has no separate cooperation/quality question; «فقط کنجکاوه» is its only explicit "not engaged" answer.
 */
export const NO_PLAN_GOOD_URGENCIES: readonly string[] = ["now", "month", "later"];
export function noPlanRespondedWell(a: QualifierAnswers | null | undefined): boolean {
  return !!a && isFirstCallForm(a) && a.noPlanFit === true && a.callResult === "answered" && NO_PLAN_GOOD_URGENCIES.includes(String(a.urgency));
}

/** Server-side priority. `previousNoAnswers` = consecutive no-answer attempts before this one. */
export function computeLeadPriority(a: QualifierAnswers, matches: PlanMatch[], previousNoAnswers: number,
  now: Date = new Date(), cfg: TeamSalesConfig = DEFAULT_TEAM_SALES_CONFIG): LeadOutcome {
  const reasons: string[] = [];
  const attempts = a.callResult === "no_answer" ? previousNoAnswers + 1 : 0;
  const r = (priority: LeadOutcome["priority"], outcome: LeadOutcome["outcome"], next: Date | null, score: number | null = null): LeadOutcome =>
    ({ priority, outcome, nextActionAt: next ? next.toISOString() : null, score, reasons, attempts, maxAttempts: cfg.maxNoAnswerAttempts });
  const days = (d: number) => addCalendarHoursInWork(now, d * 24, cfg);

  if (a.callResult === "wrong_number") { reasons.push("شماره اشتباه است (H1)"); return r(3, "invalid", null); }
  if (a.callResult === "no_answer") {
    if (attempts >= cfg.maxNoAnswerAttempts) { reasons.push(`${attempts} بار بی‌پاسخ (H2) → بایگانی سرد`); return r(3, "cold_archive", null); }
    const h = cfg.noAnswerRetryHours[Math.min(attempts - 1, cfg.noAnswerRetryHours.length - 1)];
    reasons.push(`تلاش ${attempts} از ${cfg.maxNoAnswerAttempts} بی‌پاسخ (H2) → بدون اولویت می‌ماند؛ تماس دوباره ${h} ساعت بعد`);
    // Mohammad 2026-10-24 09:26: «جواب نداد» never sets a priority (only a real conversation does);
    // it only bumps the no-answer counter. The last attempt archives (below).
    return r(null, "no_answer", addCalendarHoursInWork(now, h, cfg));
  }
  if (a.callResult === "callback") {
    reasons.push("مشتری خواست بعداً تماس بگیریم (H3)");
    const at = a.callbackAt && !Number.isNaN(Date.parse(a.callbackAt)) ? new Date(a.callbackAt) : days(1);
    return r(2, "recall", at);
  }
  if (a.urgency === "curious") { reasons.push("فعلاً قصد گرفتن وام ندارد (H4)"); return r(3, "nurture", days(cfg.curiousNurtureDays)); }
  if (cfg.bouncedChequeBlocks && a.bouncedCheque === "yes") { reasons.push("چک برگشتی رفع‌نشده دارد (H5)"); return r(3, "not_eligible", days(30)); }
  // crm-no-plan-p2 (Mohammad 2026-10-24 15:43): «هیچ طرحی به این مشتری نمی‌خوره» + the customer responded well
  // → EXACTLY P2 (never P1, never P3: score and «هیچ طرحی تطبیق نکرد» do not lower it).
  // Order (Mohammad 15:50): H4 «فقط کنجکاوه» and H5 «چک برگشتی» = P3 win over this; otherwise the existing rules apply (never an automatic P1).
  if (noPlanRespondedWell(a)) {
    reasons.push("کارشناس «هیچ طرحی به این مشتری نمی‌خوره» را زد و مشتری جواب داد و قصد وام دارد (فوریت ≠ «فقط کنجکاوه») → اولویت ۲");
    const rec = a.recallAt && !Number.isNaN(Date.parse(a.recallAt)) ? new Date(a.recallAt)
      : days(cfg.p2DefaultRecallDays[String(a.urgency)] ?? 7);
    return r(2, "recall", rec, null);
  }
  if (!matches.length) { reasons.push("با شرایط فعلی هیچ طرح فعالی تطبیق نکرد (H6)"); return r(3, "not_eligible", days(30)); }

  const top = matches[0];
  const handoffAt = addWorkingHours(now, cfg.closerFirstCallWorkingHours, cfg);
  // crm-no-plan-option: «هیچ طرحی به این مشتری نمی‌خوره» never gets an automatic P1 (no H7 shortcut, score ≥ P1 → P2).
  const noPlanFit = isFirstCallForm(a) && a.noPlanFit === true;
  if (noPlanFit) reasons.push("کارشناس «هیچ طرحی به این مشتری نمی‌خوره» را زد → اولویت ۱ خودکار نمی‌گیرد");
  if (!noPlanFit && a.urgency === "now" && a.docsReady === "all") {
    reasons.push(a.mode === "simple"
      ? `فوری + مدارک کامل + حداقل یک طرح مناسب از روی رتبه و چک، مثل «${top.planName}» (H7)`
      : `فوری + مدارک کامل + طرح «${top.planName}» (H7)`);
    if (top.assumptions.length) reasons.push(top.assumptions.join("؛ "));
    return r(1, "handoff", handoffAt, 100);
  }
  let score = 0;
  score += ({ now: 40, month: 25, later: 5 } as Record<string, number>)[String(a.urgency)] ?? 0;
  score += ({ all: 25, partial: 10, none: 0 } as Record<string, number>)[String(a.docsReady)] ?? 0;
  score += top.assumptions.length ? 10 : 20;
  score += top.amountFits ? 15 : 5;
  reasons.push(`امتیاز ${score} (فوریت، مدارک، تطبیق با «${top.planName}»، سقف مبلغ)`);
  if (!noPlanFit && score >= cfg.p1MinScore && a.urgency !== "later") return r(1, "handoff", handoffAt, score);
  if (score >= cfg.p2MinScore) {
    const rec = a.recallAt && !Number.isNaN(Date.parse(a.recallAt)) ? new Date(a.recallAt)
      : days(cfg.p2DefaultRecallDays[String(a.urgency)] ?? 7);
    return r(2, "recall", rec, score);
  }
  return r(3, "nurture", days(cfg.curiousNurtureDays), score);
}

/** Map DB rows (loan_plans + loan_plan_conditions) to the matcher's shape. */
export function plansFromRows(
  plans: Array<Record<string, unknown>>, conds: Array<Record<string, unknown>>,
): PlanForMatch[] {
  const arr = (v: unknown): string[] => { try { const x = JSON.parse(String(v ?? "[]")); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
  const planColl = (p: Record<string, unknown>) =>
    p.collateral_type ? String(p.collateral_type)
      : p.customer_check === "physical" ? "physical_check" : p.customer_check === "digital" ? "digital_check"
      : Number(p.needs_customer_promissory) ? "promissory" : "none";
  return plans.map((p) => {
    const rows = conds.filter((c) => Number(c.plan_id) === Number(p.id));
    const mapped: PlanCondition[] = rows.length ? rows.map((c) => ({
      id: Number(c.id), max: Number(c.max_principal ?? p.principal_amount ?? 0) || 0,
      ranks: arr(c.customer_ranks), jobs: arr(c.customer_jobs), coll: String(c.collateral_type || "none"),
      guar: Boolean(Number(c.needs_guarantor)), gRanks: arr(c.guarantor_ranks), gColl: String(c.guarantor_collateral_type || "none"),
      gJobs: arr(c.guarantor_jobs), needsMilitary: Number(c.needs_military_service ?? 0) === 1,
      flags: {
        cCheck: Boolean(Number(c.needs_customer_check)), cPromissory: Boolean(Number(c.needs_customer_promissory)),
        cSalary: Boolean(Number(c.needs_customer_salary_deduct)), gCheck: Boolean(Number(c.needs_guarantor_check)),
        gPromissory: Boolean(Number(c.needs_guarantor_promissory)), gSalary: Boolean(Number(c.needs_guarantor_salary_deduct)),
      },
    })) : [{
      id: "plan", max: Number(p.principal_amount ?? 0) || 0, ranks: arr(p.customer_ranks), jobs: arr(p.customer_jobs),
      coll: planColl(p), guar: Boolean(Number(p.needs_guarantor)), gRanks: arr(p.guarantor_ranks),
      gColl: String(p.guarantor_collateral_type || "none"),
    }];
    const installments = String(p.installments ?? "").split(/[,،\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return { planId: Number(p.id), name: String(p.name), loanType: String(p.loan_type ?? ""), conds: mapped,
      bankName: String(p.bank_name ?? "").trim(), installments: [...new Set(installments)].sort((x, y) => x - y) };
  });
}

/* ---------------- First-call plan evaluation (crm-call-form-plans) ---------------- */
/**
 * Every active plan gets a status for the answers so far:
 *  - fit: every condition is met by the answers;
 *  - depends: nothing is violated, but at least one condition rests on a «نمی‌دونه» answer or on something the first
 *    call does not ask (salary deduction, guarantor promissory, a second guarantor, the job);
 *  - no: at least one condition is violated (cannot be selected).
 * Reasons are structured (code + values); the client builds the Persian text (planReasonText mirrors it here for logs).
 */
export type PlanReasonCode =
  | "rank_ok" | "rank_below" | "rank_not_allowed" | "rank_unknown"
  | "applicant_cheque_ok" | "applicant_cheque" | "applicant_promissory_ok" | "applicant_promissory" | "applicant_salary"
  | "guarantor_ok" | "guarantor_required" | "guarantor_unknown" | "two_guarantors"
  | "guarantor_cheque_ok" | "guarantor_cheque" | "guarantor_cheque_unknown" | "guarantor_salary" | "guarantor_promissory"
  | "guarantor_rank_ok" | "guarantor_rank_below" | "guarantor_rank_not_allowed" | "guarantor_rank_unknown"
  | ProfileReasonCode | "amount_over_cap";
export type PlanReason = {
  code: PlanReasonCode; kind: "met" | "unknown" | "violated" | "warning";
  /** the answer that was compared (grade) */
  have?: string;
  /** contiguous grade range from A1: the worst permitted grade (e.g. B3) */
  min?: string;
  /** non-contiguous permitted grades, compacted (e.g. ["B"], ["A1","B2"]) */
  allowed?: string[];
  two?: boolean;
  /** guarantor_unknown: what an introduced guarantor would also need */
  cheque?: boolean; salary?: boolean; promissory?: boolean; gMin?: string; gAllowed?: string[];
  jobs?: string[]; excludedJobs?: string[];
  max?: number; want?: number;
};
export type PlanStatus = "fit" | "depends" | "no";
export type PlanEvaluation = {
  planId: number; planName: string; bankName: string; loanType: string; installments: number[];
  conditionId: number | string; max: number; status: PlanStatus; amountFits: boolean; reasons: PlanReason[];
};

const CHECK_KINDS = ["physical_check", "digital_check", "check"];
const SUB_INDEX = (g: string) => CREDIT_SUBGRADES.indexOf(g as (typeof CREDIT_SUBGRADES)[number]);
/** Permitted list (letters and/or sub-grades) → {min} when it is A1..X, else {allowed}; null = no restriction. */
function rankRule(list: string[]): { min?: string; allowed?: string[] } | null {
  if (!list.length) return null;
  const subs = [...new Set(list.flatMap((v) => (isLegacyGradeLetter(v) ? CREDIT_SUBGRADES.filter((g) => g[0] === v) : SUB_INDEX(v) >= 0 ? [v] : [])))]
    .sort((x, y) => SUB_INDEX(x) - SUB_INDEX(y));
  if (!subs.length) return null;
  if (subs.length === CREDIT_SUBGRADES.length) return null;
  if (subs.every((g, i) => SUB_INDEX(g) === i)) return { min: subs[subs.length - 1] };
  return { allowed: compactRankList(subs) };
}
type Tri3 = "ok" | "unknown" | "no";
const best3 = (xs: Tri3[]): Tri3 => (xs.includes("ok") ? "ok" : xs.includes("unknown") ? "unknown" : "no");
function custState(a: QualifierAnswers, kind: string): Tri3 {
  if (!kind || kind === "none") return "ok";
  if (CHECK_KINDS.includes(kind)) return a.checkStatus && a.checkStatus !== "none" ? "ok" : "no";
  if (kind === "promissory") return a.canPromissory === "yes" ? "ok" : "no";
  if (kind === "salary") return a.salaryDeduct === "yes" ? "ok" : a.salaryDeduct === "no" ? "no" : "unknown";
  return "ok";
}
function guarState(a: QualifierAnswers, kind: string): Tri3 {
  if (!kind || kind === "none") return "ok";
  if (CHECK_KINDS.includes(kind)) return a.guarantorCheque === "yes" ? "ok" : a.guarantorCheque === "no" ? "no" : "unknown";
  return "unknown"; // promissory / salary deduction of the guarantor: not asked in the first call
}

function evaluateCondition(a: QualifierAnswers, c: PlanCondition): { reasons: PlanReason[]; amountFits: boolean } {
  const o = COND_OVERRIDES[String(c.id)] ?? {};
  const f = c.flags ?? {};
  const reasons: PlanReason[] = [];
  const add = (r: PlanReason) => reasons.push(r);
  // Applicant grade
  const rr = rankRule(c.ranks);
  if (rr) {
    if (!a.creditRank || a.creditRank === "unknown") add({ code: "rank_unknown", kind: "unknown", ...rr });
    else if (gradeMatches(a.creditRank, c.ranks)) add({ code: "rank_ok", kind: "met", have: a.creditRank, ...rr });
    else add({ code: rr.min ? "rank_below" : "rank_not_allowed", kind: "violated", have: a.creditRank, ...rr });
  }
  // Applicant job + military service (shared with the request wizard and the portal: plan-profile-match.ts).
  // Guarantor job is added below, once it is known whether the condition needs a guarantor.
  for (const pr of profileReasons({ jobs: c.jobs, gJobs: [], needsMilitary: !!c.needsMilitary }, a, null)) add(pr as PlanReason);
  // Applicant collateral: the condition's own type, the needs_* flags, and the note-only any-of overrides.
  const custReqs: string[][] = [];
  if (c.coll && c.coll !== "none") custReqs.push([c.coll]);
  if (f.cCheck) custReqs.push(["check"]);
  if (f.cPromissory) custReqs.push(["promissory"]);
  if (f.cSalary) custReqs.push(["salary"]);
  if (o.cust) custReqs.push(o.cust);
  for (const anyOf of custReqs) {
    const st = best3(anyOf.map((k) => custState(a, k)));
    const okKind = anyOf.find((k) => custState(a, k) === "ok");
    if (st === "ok") add({ code: okKind === "promissory" ? "applicant_promissory_ok" : okKind === "salary" ? "applicant_salary" : "applicant_cheque_ok", kind: "met" });
    else if (st === "unknown") add({ code: "applicant_salary", kind: "unknown" });
    else add({ code: anyOf.some((k) => CHECK_KINDS.includes(k)) ? "applicant_cheque" : anyOf.includes("promissory") ? "applicant_promissory" : "applicant_salary", kind: "violated" });
  }
  // Guarantor
  const guarReqs: string[][] = [];
  if (c.gColl && c.gColl !== "none") guarReqs.push([c.gColl]);
  if (f.gCheck) guarReqs.push(["check"]);
  if (f.gPromissory) guarReqs.push(["promissory"]);
  if (f.gSalary) guarReqs.push(["salary"]);
  if (o.guar) guarReqs.push(o.guar);
  const needG = c.guar || !!o.guar || !!(f.gCheck || f.gPromissory || f.gSalary);
  if (needG && c.gJobs?.length) {
    const avail = a.guarantorAvailable ?? (Number(a.guarantorCount) > 0 ? "yes" : "no");
    for (const pr of profileReasons({ jobs: [], gJobs: c.gJobs, needsMilitary: false }, a, avail === "yes" ? "yes" : avail === "unknown" ? "unknown" : null))
      add(pr as PlanReason);
  }
  if (needG) {
    const two = !!o.two;
    const avail = a.guarantorAvailable ?? (Number(a.guarantorCount) > 0 ? "yes" : "no");
    const gr = rankRule(c.gRanks);
    if (avail === "no") add({ code: "guarantor_required", kind: "violated", two });
    else if (avail === "unknown") {
      const flat = guarReqs.map((anyOf) => anyOf.some((k) => CHECK_KINDS.includes(k)) ? "check" : anyOf.includes("salary") ? "salary" : "promissory");
      add({ code: "guarantor_unknown", kind: "unknown", two, cheque: flat.includes("check"), salary: flat.includes("salary"),
        promissory: flat.includes("promissory"), gMin: gr?.min, gAllowed: gr?.allowed });
    } else {
      add(two ? { code: "two_guarantors", kind: "unknown", two } : { code: "guarantor_ok", kind: "met" });
      for (const anyOf of guarReqs) {
        // Only a cheque can be «ok» or «no» here (salary / promissory of the guarantor are never asked → unknown).
        const st = best3(anyOf.map((k) => guarState(a, k)));
        const hasCheck = anyOf.some((k) => CHECK_KINDS.includes(k));
        if (st === "ok") add({ code: "guarantor_cheque_ok", kind: "met" });
        else if (st === "no") add({ code: "guarantor_cheque", kind: "violated" });
        else if (hasCheck && a.guarantorCheque !== "no") add({ code: "guarantor_cheque_unknown", kind: "unknown" });
        else add({ code: anyOf.includes("salary") ? "guarantor_salary" : "guarantor_promissory", kind: "unknown" });
      }
      if (gr) {
        if (!a.gRank || a.gRank === "unknown") add({ code: "guarantor_rank_unknown", kind: "unknown", ...gr });
        else if (gradeMatches(a.gRank, c.gRanks)) add({ code: "guarantor_rank_ok", kind: "met", have: a.gRank, ...gr });
        else add({ code: gr.min ? "guarantor_rank_below" : "guarantor_rank_not_allowed", kind: "violated", have: a.gRank, ...gr });
      }
    }
  }
  const want = (Number(a.amountMillion) || 0) * 1e6;
  const amountFits = !want || want <= c.max;
  if (!amountFits) add({ code: "amount_over_cap", kind: "warning", max: c.max, want });
  return { reasons, amountFits };
}

const statusOf = (rs: PlanReason[]): PlanStatus =>
  rs.some((r) => r.kind === "violated") ? "no" : rs.some((r) => r.kind === "unknown") ? "depends" : "fit";
const countKind = (rs: PlanReason[], k: PlanReason["kind"]) => rs.filter((r) => r.kind === k).length;
const STATUS_ORDER: Record<PlanStatus, number> = { fit: 0, depends: 1, no: 2 };
/** Lower = better. fit/depends: amount fits, fewer unknowns, higher cap. no: fewer violations, then the same. */
function compareEval(x: PlanEvaluation, y: PlanEvaluation) {
  return (STATUS_ORDER[x.status] - STATUS_ORDER[y.status]) ||
    (x.status === "no" ? countKind(x.reasons, "violated") - countKind(y.reasons, "violated") : 0) ||
    (Number(y.amountFits) - Number(x.amountFits)) ||
    (countKind(x.reasons, "unknown") - countKind(y.reasons, "unknown")) ||
    (y.max - x.max) || (x.planId - y.planId);
}

/** All plans, each with its best condition's status and reasons. Not filtered by loan type or job (first call asks neither). */
export function evaluatePlans(a: QualifierAnswers, plans: PlanForMatch[]): PlanEvaluation[] {
  const answers = normalizeFirstCallAnswers(a);
  const out: PlanEvaluation[] = [];
  for (const p of plans) {
    let best: PlanEvaluation | null = null;
    for (const c of p.conds) {
      const { reasons, amountFits } = evaluateCondition(answers, c);
      const ev: PlanEvaluation = { planId: p.planId, planName: p.name, bankName: p.bankName ?? "", loanType: p.loanType,
        installments: p.installments ?? [], conditionId: c.id, max: c.max, status: statusOf(reasons), amountFits, reasons };
      if (!best || compareEval(ev, best) < 0) best = ev;
    }
    if (best) out.push(best);
  }
  return out.sort(compareEval);
}

/** fit + depends plans in the legacy PlanMatch shape, so computeLeadPriority stays unchanged (unknowns = assumptions). */
export function matchesFromEvaluation(evals: PlanEvaluation[]): PlanMatch[] {
  return evals.filter((e) => e.status !== "no").map((e) => ({
    planId: e.planId, planName: e.planName, conditionId: e.conditionId, max: e.max, amountFits: e.amountFits,
    assumptions: e.reasons.filter((r) => r.kind === "unknown").map(planReasonText),
  }));
}

const NOT_ASKED = "(در تماس اول پرسیده نمی‌شود)";
const joinFa = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join("، ")} و ${xs[xs.length - 1]}`);
const rankWord = (r: { min?: string; allowed?: string[] }) => (r.min ? `${r.min} یا بهتر` : (r.allowed ?? []).join(" یا "));
const millionFa = (n?: number) => `${Math.round((Number(n) || 0) / 1e6).toLocaleString("en-US").replace(/,/g, "٬").replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])} میلیون`;
/** Persian text of one reason (the dashboard has the same wording in features/team-sales/plan-reasons.ts). */
export function planReasonText(r: PlanReason): string {
  switch (r.code) {
    case "rank_ok": return r.min ? `رتبه ${r.have} (حداقل ${r.min})` : `رتبه ${r.have}`;
    case "rank_below": return `رتبه ${r.have} کمتر از ${r.min} است`;
    case "rank_not_allowed": return `رتبه ${r.have} جزو رتبه‌های مجاز این طرح نیست`;
    case "rank_unknown": return `اگر رتبه‌ی متقاضی ${rankWord(r)} باشد`;
    case "applicant_cheque_ok": return "چک متقاضی";
    case "applicant_cheque": return "چک متقاضی لازم است";
    case "applicant_promissory_ok": return "سفته‌ی متقاضی";
    case "applicant_promissory": return "سفته‌ی متقاضی لازم است";
    case "applicant_salary": return r.kind === "met" ? "کسر از حقوق" : r.kind === "violated" ? "کسر از حقوق لازم است" : `اگر کسر از حقوق داشته باشد ${NOT_ASKED}`;
    case "guarantor_ok": return "ضامن";
    case "guarantor_required": return r.two ? "دو ضامن لازم است" : "ضامن لازم است";
    case "guarantor_unknown": {
      const parts = [r.two ? "دو ضامن معرفی کند" : "ضامن معرفی کند"];
      if (r.cheque) parts.push("ضامن چک بدهد");
      if (r.gMin || r.gAllowed?.length) parts.push(`رتبه‌ی ضامن ${rankWord({ min: r.gMin, allowed: r.gAllowed })} باشد`);
      if (r.salary) parts.push("ضامن کسر از حقوق داشته باشد");
      if (r.promissory) parts.push("ضامن سفته بدهد");
      return `اگر ${joinFa(parts)}`;
    }
    case "two_guarantors": return "اگر دو ضامن معرفی کند";
    case "guarantor_cheque_ok": return "ضامن با چک";
    case "guarantor_cheque": return "چک ضامن لازم است";
    case "guarantor_cheque_unknown": return "اگر ضامن چک بدهد";
    case "guarantor_salary": return `اگر ضامن کسر از حقوق داشته باشد ${NOT_ASKED}`;
    case "guarantor_promissory": return `اگر ضامن سفته بدهد ${NOT_ASKED}`;
    case "guarantor_rank_ok": return `رتبه‌ی ضامن ${r.have}`;
    case "guarantor_rank_below": return `رتبه‌ی ضامن ${r.have} کمتر از ${r.min} است`;
    case "guarantor_rank_not_allowed": return `رتبه‌ی ضامن ${r.have} جزو رتبه‌های مجاز این طرح نیست`;
    case "guarantor_rank_unknown": return `اگر رتبه‌ی ضامن ${rankWord(r)} باشد`;
    case "job_ok": case "job_not_allowed": case "job_unknown":
    case "guarantor_job_ok": case "guarantor_job_not_allowed": case "guarantor_job_unknown":
    case "military_ok": case "military_required": case "military_unknown":
      return profileReasonText(r as ProfileReason);
    case "amount_over_cap": return `سقف ${millionFa(r.max)}؛ کمتر از ${millionFa(r.want)} درخواستی`;
    default: return "";
  }
}
