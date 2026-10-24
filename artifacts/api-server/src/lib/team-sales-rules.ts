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
  noteMinLength: 30,
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
  creditRank?: string | null; // A..E | unknown
  checkStatus?: "none" | "physical" | "digital" | "both" | "any" | null;
  canPromissory?: "yes" | "no" | null;
  salaryDeduct?: "yes" | "no" | null;
  bouncedCheque?: "yes" | "no" | null;
  guarantorCount?: number | null;
  gRank?: string | null;
  gPhysical?: boolean; gDigital?: boolean; gPromissory?: boolean; gSalary?: boolean;
  docsReady?: "all" | "partial" | "none" | null;
  recallAt?: string | null;
};

const JOBS = ["employee_with_insurance", "employee_no_insurance", "business", "no_doc", "retired", "unemployed"];
const RANKS = ["A", "B", "C", "D", "E", "unknown"];

/** Validates the answers for a call result. Returns a Persian error or null. */
export function validateAnswers(a: QualifierAnswers, now: Date = new Date()): string | null {
  if (!a || !CALL_RESULTS.includes(a.callResult)) return "نتیجهٔ تماس معتبر نیست.";
  if (a.callResult === "callback") {
    const at = a.callbackAt ? Date.parse(a.callbackAt) : Number.NaN;
    if (Number.isNaN(at)) return "زمان تماس بعدی را مشخص کنید.";
    if (at <= now.getTime()) return "زمان تماس بعدی باید در آینده باشد.";
    return null;
  }
  if (a.callResult !== "answered") return null;
  if (!a.urgency || !["now", "month", "later", "curious"].includes(a.urgency)) return "فوریت را مشخص کنید.";
  if (a.urgency === "curious") return null;
  if (!(Number(a.amountMillion) > 0)) return "مبلغ درخواستی را وارد کنید.";
  if (a.loanPref && !["goods", "score", "both"].includes(a.loanPref)) return "نوع وام معتبر نیست.";
  const simple = a.mode === "simple";
  if (simple ? a.jobType != null && !JOBS.includes(a.jobType) : !a.jobType || !JOBS.includes(a.jobType)) return "شغل متقاضی را مشخص کنید.";
  if (!a.creditRank || !RANKS.includes(a.creditRank)) return "رتبهٔ اعتباری را مشخص کنید (یا «نمی‌دانم»).";
  if (!a.checkStatus || !["none", "physical", "digital", "both", ...(simple ? ["any"] : [])].includes(a.checkStatus)) return "وضعیت چک متقاضی را مشخص کنید.";
  if (!a.bouncedCheque || !["yes", "no"].includes(a.bouncedCheque)) return "چک برگشتی را مشخص کنید.";
  if (!a.docsReady || !["all", "partial", "none"].includes(a.docsReady)) return "وضعیت مدارک را مشخص کنید.";
  const g = Number(a.guarantorCount ?? 0);
  if (!Number.isInteger(g) || g < 0 || g > 5) return "تعداد ضامن معتبر نیست.";
  if (g > 0 && a.gRank && !RANKS.includes(a.gRank)) return "رتبهٔ ضامن معتبر نیست.";
  return null;
}

export type PlanCondition = {
  id: number | string; max: number; ranks: string[]; jobs: string[]; coll: string;
  guar: boolean; gRanks: string[]; gColl: string;
};
export type PlanForMatch = { planId: number; name: string; loanType: string; conds: PlanCondition[] };
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
      if (c.jobs.length && a.jobType != null && !c.jobs.includes(String(a.jobType))) continue;
      if (c.jobs.length && a.jobType == null && a.mode !== "simple") continue;
      if (c.ranks.length) {
        if (a.creditRank === "unknown") assumptions.push(`رتبهٔ متقاضی باید ${c.ranks.join("/")} باشد`);
        else if (!c.ranks.includes(String(a.creditRank))) continue;
      }
      if (!custHas(a, c.coll)) continue;
      if (o.cust && !o.cust.some((k) => custHas(a, k))) continue;
      const needG = c.guar || !!o.guar;
      if (needG) {
        if (gCount < (o.two ? 2 : 1)) continue;
        if (c.gRanks.length) {
          if (!a.gRank || a.gRank === "unknown") assumptions.push(`رتبهٔ ضامن باید ${c.gRanks.join("/")} باشد`);
          else if (!c.gRanks.includes(a.gRank)) continue;
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
  if (!matches.length) { reasons.push("با شرایط فعلی هیچ طرح فعالی تطبیق نکرد (H6)"); return r(3, "not_eligible", days(30)); }

  const top = matches[0];
  const handoffAt = addWorkingHours(now, cfg.closerFirstCallWorkingHours, cfg);
  if (a.urgency === "now" && a.docsReady === "all") {
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
  if (score >= cfg.p1MinScore && a.urgency !== "later") return r(1, "handoff", handoffAt, score);
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
    })) : [{
      id: "plan", max: Number(p.principal_amount ?? 0) || 0, ranks: arr(p.customer_ranks), jobs: arr(p.customer_jobs),
      coll: planColl(p), guar: Boolean(Number(p.needs_guarantor)), gRanks: arr(p.guarantor_ranks),
      gColl: String(p.guarantor_collateral_type || "none"),
    }];
    return { planId: Number(p.id), name: String(p.name), loanType: String(p.loan_type ?? ""), conds: mapped };
  });
}
