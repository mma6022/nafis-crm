/**
 * v82 «ثبت درخواست» — the site's apply wizard (Armita site-apply-wizard v1.0.1; Mohammad t129u/t130u/t131u/t134u).
 * site-credit-noinst v1.0/v1.1 (Mohammad «اکیه بده بسازه», 2026-11-12): 8 steps — new optional `credit_rank` (A–E | unknown);
 * the wizard is now the site's ONLY form, so only name + mobile are required: every answer key is optional (a skipped step
 * is simply absent and the file shows «بپرسید»). Min fill: 8 s when any answer is sent, the general 3 s for name + mobile only.
 * Skipped answers are stored as '' ('[]' for documents) in the existing NOT NULL columns (no table rebuild); the read side maps
 * them back to null. `credit_rank` is an additive column.
 *
 * POST /api/public/leads with `type:'apply'` (same endpoint, CORS, attempt limiter, per-IP/per-phone caps and 10-minute
 * duplicate window as the other public intakes) → validateSiteApply (own key set, 8 s minimum fill time — this form only)
 * → recordSiteApply in ONE write transaction:
 *   - new mobile  → customer created with the computed priority; owner chosen HERE, «قانون ثبت» and the allocation program
 *                   are bypassed for this form only (their settings are untouched): P1 → the existing team-sales closer
 *                   round-robin (nextCloserSalespersonId, same cursor as Kazemi's hand-offs), P2/P3 → the qualifier (Kazemi);
 *                   one customer_priority_history row source 'site_apply_form' (old NULL → new).
 *   - known mobile → no new customer; the current owner is kept; priority → 1 (history row source 'site_apply_form' when it
 *                   changes); tag «درخواست چند باره» (repeat_request) + a pending customer_repeat_requests row.
 *   - always       → public_leads row (source 'website'), site_lead_requests row (top of list / deadline), and the answers in
 *                   the additive table site_apply_answers.
 * Nothing here sends anything; the caller sends the usual staff Telegram (customerSms:false). No rate/percentage/amount offer
 * is ever produced — only the customer's own answers.
 */
import { createHash } from "node:crypto";
import { execute, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { insertCustomerRecord } from "./customer-create";
import { ensureSiteLeadSchema, recordSiteLeadRequest } from "./site-leads-store";
import { getTeamSalesConfig, logPriorityChange, nextCloserSalespersonId } from "./team-sales";
import { assignLeadOwner, mtFlagOn } from "./multi-team";
import { srcLineFa } from "./link-src";
import {
  LEAD_SOURCE, WEBSITE_LEAD_TAG, UTM_KEYS, canonicalCustomerByMobile, ensurePublicLeadSchema, intakeGate, normalizeLeadName,
  normalizeLeadPhone, oneOf, optionalInt, readSrcAndUtm, uniqueTrackingCode, type PublicLead,
} from "./public-leads";

export const SITE_APPLY_SOURCE = "site_apply_form" as const;
/** Mohammad (via PM, 2026-10-28): this form needs at least 8 seconds when answers are sent; every other intake keeps 3 s. */
export const SITE_APPLY_MIN_FILL_MS = 8_000;
/** site-credit-noinst v1.1: «فعلاً فقط تماس بگیرید» (name + mobile only) uses the general public-intake minimum. */
export const SITE_APPLY_QUICK_MIN_FILL_MS = 3_000;
export const REPEAT_REQUEST_TAG = "repeat_request";

export const AMOUNT_RANGES = ["up_to_50m", "50m_100m", "100m_300m", "300m_500m", "over_500m", "not_sure"] as const;
export const LOAN_PURPOSES = ["goods", "wedding", "medical", "home", "business", "other"] as const;
export const JOB_STATUSES = ["employee", "retired", "self_employed", "no_fixed_income"] as const;
export const DOCUMENTS = ["payslip", "salary_deduction_cert", "sayadi_cheque", "guarantor", "none"] as const;
export const MILITARY = ["yes", "no", "not_applicable"] as const;
export const YES_NO = ["yes", "no"] as const;
export const NEED_TIMINGS = ["this_week", "this_month", "just_browsing"] as const;
/** site-credit-noinst v1.0 §4: letters only on the site (+ «نمی‌دونم»); the expert refines to A1–E3 in the file. */
export const SITE_CREDIT_RANKS = ["A", "B", "C", "D", "E", "unknown"] as const;

/** null = the customer skipped that step (v1.1); documents [] = skipped. */
export type SiteApplyAnswers = {
  amount_range: (typeof AMOUNT_RANGES)[number] | null;
  loan_purpose: (typeof LOAN_PURPOSES)[number] | null;
  job_status: (typeof JOB_STATUSES)[number] | null;
  credit_rank: (typeof SITE_CREDIT_RANKS)[number] | null;
  documents: (typeof DOCUMENTS)[number][];
  has_military_card: (typeof MILITARY)[number] | null;
  can_refer_retiree: (typeof YES_NO)[number] | null;
  has_bounced_or_overdue: (typeof YES_NO)[number] | null;
  need_timing: (typeof NEED_TIMINGS)[number] | null;
};
export type SiteApply = {
  name: string; phone: string; answers: SiteApplyAnswers; planId: number | null; term: number | null;
  src: string | null; utm: PublicLead["utm"]; fillMs: number | null;
};
export type SiteApplyValidation =
  | { ok: true; apply: SiteApply }
  | { ok: false; status: 400 | 422; error: "invalid" | "spam" | "too_fast" | "expired"; fields?: string[] };

const ANSWER_KEYS = ["amount_range", "loan_purpose", "job_status", "credit_rank", "documents", "has_military_card",
  "can_refer_retiree", "has_bounced_or_overdue", "need_timing"] as const;
const absent = (v: unknown) => v === undefined || v === null || v === "";
/** any answer key present → the 8 s rule; name + mobile only → 3 s */
const sendsAnswers = (body: unknown): boolean => {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return ANSWER_KEYS.some((k) => (k === "documents" ? Array.isArray(b[k]) && (b[k] as unknown[]).length > 0 : !absent(b[k])));
};
/** optional enum: absent → null, present must be valid */
function optEnum<T extends readonly string[]>(set: T, v: unknown, key: string, fields: string[]): T[number] | null {
  if (absent(v)) return null;
  if (!oneOf(set, v)) { fields.push(key); return null; }
  return v as T[number];
}
const APPLY_KEYS = new Set<string>([
  "type", "name", "phone", ...ANSWER_KEYS, "planId", "term", "src", "consent", "website", "startedAt", "fillMs", ...UTM_KEYS,
]);

/** Strict validation of the apply wizard body. */
export function validateSiteApply(body: unknown, now = Date.now()): SiteApplyValidation {
  const gate = intakeGate(body, APPLY_KEYS, now, sendsAnswers(body) ? SITE_APPLY_MIN_FILL_MS : SITE_APPLY_QUICK_MIN_FILL_MS);
  if ("ok" in gate) return gate;
  const { input } = gate;
  const fields: string[] = [];
  if (input.type !== "apply") fields.push("type");
  const name = normalizeLeadName(input.name);
  if (!name) fields.push("name");
  const phone = normalizeLeadPhone(input.phone);
  if (!phone) fields.push("phone");
  const amount_range = optEnum(AMOUNT_RANGES, input.amount_range, "amount_range", fields);
  const purpose = optEnum(LOAN_PURPOSES, input.loan_purpose, "loan_purpose", fields);
  const job_status = optEnum(JOB_STATUSES, input.job_status, "job_status", fields);
  const credit_rank = optEnum(SITE_CREDIT_RANKS, input.credit_rank, "credit_rank", fields);
  const docs = input.documents;
  let documents: SiteApplyAnswers["documents"] = [];
  if (docs === undefined || docs === null || (Array.isArray(docs) && docs.length === 0)) documents = [];
  else if (!Array.isArray(docs) || docs.length > DOCUMENTS.length
    || !docs.every((d) => oneOf(DOCUMENTS, d)) || new Set(docs).size !== docs.length
    || (docs.includes("none") && docs.length > 1)) fields.push("documents");
  else documents = DOCUMENTS.filter((d) => (docs as string[]).includes(d)); // canonical order
  const has_military_card = optEnum(MILITARY, input.has_military_card, "has_military_card", fields);
  const can_refer_retiree = optEnum(YES_NO, input.can_refer_retiree, "can_refer_retiree", fields);
  const has_bounced_or_overdue = optEnum(YES_NO, input.has_bounced_or_overdue, "has_bounced_or_overdue", fields);
  const need_timing = optEnum(NEED_TIMINGS, input.need_timing, "need_timing", fields);
  const planId = optionalInt(input.planId, 1, 9_999_999);
  if (planId === undefined) fields.push("planId");
  const term = optionalInt(input.term, 1, 120);
  if (term === undefined) fields.push("term");
  if (input.consent !== true) fields.push("consent");
  const { src, utm } = readSrcAndUtm(input, fields);
  if (fields.length) return { ok: false, status: 422, error: "invalid", fields };
  return {
    ok: true,
    apply: {
      name: name!, phone: phone!, planId: planId ?? null, term: term ?? null, src, utm,
      fillMs: typeof input.fillMs === "number" ? input.fillMs : null,
      answers: { amount_range, loan_purpose: purpose, job_status, credit_rank, documents, has_military_card, can_refer_retiree,
        has_bounced_or_overdue, need_timing },
    },
  };
}

export type SiteApplyPriority = { priority: 1 | 2 | 3; rule: "retiree_referral" | "core_docs_clean_this_week" | "no_docs_or_browsing" | "other" };

/**
 * Core documents = (payslip OR salary_deduction_cert) AND (sayadi_cheque OR guarantor).
 */
export function hasCoreDocuments(documents: readonly string[]): boolean {
  const income = documents.includes("payslip") || documents.includes("salary_deduction_cert");
  const security = documents.includes("sayadi_cheque") || documents.includes("guarantor");
  return income && security;
}

/**
 * Pure priority rule (Mohammad t131u/t134u, PM 2026-10-28):
 *   can_refer_retiree = yes                                         → P1 (overrides everything)
 *   core documents AND has_bounced_or_overdue = no AND this_week   → P1
 *   documents = none OR need_timing = just_browsing                 → P3
 *   anything else                                                   → P2
 * has_military_card and loan_purpose / amount never change the priority.
 */
export function computeSiteApplyPriority(a: Pick<SiteApplyAnswers, "documents" | "can_refer_retiree" | "has_bounced_or_overdue" | "need_timing">): SiteApplyPriority {
  if (a.can_refer_retiree === "yes") return { priority: 1, rule: "retiree_referral" };
  if (hasCoreDocuments(a.documents) && a.has_bounced_or_overdue === "no" && a.need_timing === "this_week")
    return { priority: 1, rule: "core_docs_clean_this_week" };
  if (a.documents.includes("none") || a.need_timing === "just_browsing") return { priority: 3, rule: "no_docs_or_browsing" };
  return { priority: 2, rule: "other" };
}

// ---- Persian labels (Armita sa.js LB; staff-facing) ----
export const AMOUNT_FA: Record<(typeof AMOUNT_RANGES)[number], string> = {
  up_to_50m: "تا ۵۰ میلیون تومان", "50m_100m": "۵۰ تا ۱۰۰ میلیون تومان", "100m_300m": "۱۰۰ تا ۳۰۰ میلیون تومان",
  "300m_500m": "۳۰۰ تا ۵۰۰ میلیون تومان", over_500m: "بیشتر از ۵۰۰ میلیون تومان", not_sure: "هنوز نمی‌داند",
};
export const PURPOSE_FA: Record<(typeof LOAN_PURPOSES)[number], string> = {
  goods: "خرید کالا", wedding: "جهیزیه و ازدواج", medical: "درمان", home: "خانه و تعمیرات", business: "کسب‌وکار", other: "کار دیگر",
};
export const JOB_FA: Record<(typeof JOB_STATUSES)[number], string> = {
  employee: "کارمند", retired: "بازنشسته", self_employed: "آزاد", no_fixed_income: "بدون درآمد ثابت",
};
export const DOC_FA: Record<(typeof DOCUMENTS)[number], string> = {
  payslip: "فیش حقوقی", salary_deduction_cert: "گواهی کسر از حقوق", sayadi_cheque: "چک صیادی", guarantor: "ضامن", none: "هیچ‌کدام",
};
export const MILITARY_FA: Record<(typeof MILITARY)[number], string> = { yes: "دارد", no: "ندارد", not_applicable: "مشمول نیست" };
export const TIMING_FA: Record<(typeof NEED_TIMINGS)[number], string> = {
  this_week: "همین هفته", this_month: "این ماه", just_browsing: "فقط دارد بررسی می‌کند",
};

/** Staff summary of ONLY the customer's own answers (Telegram «این درخواست» + repeat-request text). */
export const CREDIT_RANK_FA = (v: SiteApplyAnswers["credit_rank"]): string => (v === "unknown" ? "نمی‌داند" : v ?? "");
const SKIPPED = "بی‌جواب";
export function siteApplySummary(a: SiteApplyAnswers, planName?: string | null, planId?: number | null, term?: number | null): string {
  const yn = (v: string | null, yes: string) => (v == null ? SKIPPED : v === "yes" ? yes : "خیر");
  const answered = !!(a.amount_range || a.loan_purpose || a.job_status || a.credit_rank || a.documents.length || a.has_military_card
    || a.can_refer_retiree || a.has_bounced_or_overdue || a.need_timing);
  const lines = answered ? [
    "فرم ثبت درخواست سایت (همه اعلامی مشتری)",
    `مبلغ: ${a.amount_range ? AMOUNT_FA[a.amount_range] : SKIPPED}`,
    `برای: ${a.loan_purpose ? PURPOSE_FA[a.loan_purpose] : `${SKIPPED} (اختیاری)`}`,
    `شغل: ${a.job_status ? JOB_FA[a.job_status] : SKIPPED}`,
    `رتبه‌ی اعتباری: ${a.credit_rank ? CREDIT_RANK_FA(a.credit_rank) : SKIPPED}`,
    `مدارک: ${a.documents.length ? a.documents.map((d) => DOC_FA[d]).join("، ") : SKIPPED}`,
    `پایان خدمت: ${a.has_military_card ? MILITARY_FA[a.has_military_card] : SKIPPED}`,
    `معرفی بازنشسته: ${yn(a.can_refer_retiree, "بله، می‌تواند معرفی کند")}`,
    `چک برگشتی / معوق: ${yn(a.has_bounced_or_overdue, "بله، دارد")}`,
    `زمان نیاز: ${a.need_timing ? TIMING_FA[a.need_timing] : SKIPPED}`,
  ] : ["فرم ثبت درخواست سایت: فقط نام و موبایل (مشتری فعلاً فقط تماس خواست)"];
  if (planId) lines.push(`طرح انتخابی: ${planName ? `${planName} ` : ""}(#${planId})${term ? `، ${term} ماهه` : ""}`);
  return lines.join("\n");
}

export function ensureSiteApplySchema(): void {
  execute(`CREATE TABLE IF NOT EXISTS site_apply_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_lead_id INTEGER,
    customer_id INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('new_customer','existing_customer')),
    amount_range TEXT NOT NULL,
    loan_purpose TEXT,
    job_status TEXT NOT NULL,
    documents_json TEXT NOT NULL,
    has_military_card TEXT NOT NULL,
    can_refer_retiree TEXT NOT NULL,
    has_bounced_or_overdue TEXT NOT NULL,
    need_timing TEXT NOT NULL,
    plan_id INTEGER,
    term INTEGER,
    priority_computed INTEGER NOT NULL,
    priority_rule TEXT NOT NULL,
    old_priority INTEGER,
    routed_salesperson_id INTEGER,
    src TEXT,
    fill_ms INTEGER,
    ip_hash TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL
  )`);
  execute("CREATE INDEX IF NOT EXISTS idx_site_apply_answers_customer ON site_apply_answers(customer_id, id)");
  // site-credit-noinst v1.0 (additive, guarded): the customer's own credit-rank letter (A–E | unknown); NULL = skipped/older row
  const cols = queryRows<{ name: string }>("PRAGMA table_info(site_apply_answers)").map((c) => c.name);
  if (!cols.includes("credit_rank")) execute("ALTER TABLE site_apply_answers ADD COLUMN credit_rank TEXT");
}

export type SiteApplyResult = {
  customerId: number; created: boolean; trackingCode: string; priority: 1 | 2 | 3; rule: SiteApplyPriority["rule"];
  ownerSalespersonId: number | null; answersId: number; planName: string | null;
};

function cleanUa(ua: string | null | undefined): string | null {
  if (typeof ua !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const v = ua.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
  return v || null;
}

export function recordSiteApply(apply: SiteApply, ipHash: string, userAgent: string | null, now = new Date()): SiteApplyResult {
  ensurePublicLeadSchema();
  ensureSiteLeadSchema();
  ensureSiteApplySchema();
  const cfg = getTeamSalesConfig();
  const qualifier = cfg.qualifierSalespersonId;
  const { priority, rule } = computeSiteApplyPriority(apply.answers);
  return runImmediateTransaction(() => {
    const timestamp = now.toISOString();
    const planName = apply.planId
      ? queryRow<{ name: string }>("SELECT name FROM loan_plans WHERE id=?", [apply.planId])?.name ?? null
      : null;
    const summary = siteApplySummary(apply.answers, planName, apply.planId, apply.term);
    let customerId = canonicalCustomerByMobile(apply.phone);
    let created = false;
    let owner: number | null;
    let oldPriority: number | null = null;
    if (customerId === undefined) {
      if (mtFlagOn()) {
        try {
          const pri = priority === 1 || priority === 2 || priority === 3 ? priority : null;
          owner = assignLeadOwner(pri, now, "site_leads").salespersonId;
        } catch {
          owner = qualifier;
        }
      } else {
        owner = qualifier;
        // No active closer (TeamSalesError 409) → the lead must not be lost: it stays with the qualifier, still P1.
        if (priority === 1) { try { owner = nextCloserSalespersonId(cfg); } catch { owner = qualifier; } }
      }
      const description = ["درخواست از فرم سایت nafisvam.com", ...(apply.src ? [`منبع صفحه: ${srcLineFa(apply.src)}`] : [])].join("\n");
      customerId = insertCustomerRecord({
        name: apply.name, phone: apply.phone, description, priority, registeredByUserId: null, registrationSource: "site_lead",
        skipDefaultOwnerRule: true, assignedSalespersonId: owner, siteRequest: true,
      });
      created = true;
      logPriorityChange({ customerId, oldPriority: null, newPriority: priority, oldSalespersonId: null, newSalespersonId: owner,
        actorUserId: null, source: SITE_APPLY_SOURCE, reason: `فرم سایت: اولویت ${priority} (${rule})`, at: timestamp, always: true });
    } else {
      const c = queryRow<{ priority: number | null; salesperson_id: number | null }>(
        "SELECT priority, salesperson_id FROM customers WHERE id=?", [customerId]);
      owner = c?.salesperson_id == null ? null : Number(c.salesperson_id);
      oldPriority = c?.priority == null ? null : Number(c.priority);
      if (oldPriority !== 1) {
        execute("UPDATE customers SET priority=1 WHERE id=?", [customerId]);
        logPriorityChange({ customerId, oldPriority, newPriority: 1, oldSalespersonId: owner, newSalespersonId: owner,
          actorUserId: null, source: SITE_APPLY_SOURCE, reason: "فرم سایت: درخواست چندباره → اولویت ۱", at: timestamp, always: true });
      }
      execute(
        `INSERT INTO customer_repeat_requests
          (customer_id,requested_name,submitted_description,explanation,status,created_by_user_id,provenance,lead_source,created_at)
         VALUES (?,?,?,?, 'pending',NULL,'human','site',?)`,
        [customerId, apply.name, summary.slice(0, 2000), "درخواست تازه از فرم ثبت درخواست سایت (همان شماره موبایل)", timestamp],
      );
      execute("INSERT OR IGNORE INTO customer_tag_catalog(tag,label_fa,canonical_label) VALUES (?,?,?)",
        [REPEAT_REQUEST_TAG, "درخواست چند باره", "درخواست چند باره"]);
      execute("INSERT OR IGNORE INTO customer_tags(customer_id,tag,created_at) VALUES (?,?,?)", [customerId, REPEAT_REQUEST_TAG, timestamp]);
    }
    execute("INSERT OR IGNORE INTO customer_tags(customer_id,tag,created_at) VALUES (?,?,?)", [customerId, WEBSITE_LEAD_TAG, timestamp]);
    const trackingCode = uniqueTrackingCode();
    const leadId = execute(
      `INSERT INTO public_leads
        (source, customer_id, outcome, name, phone, need, amount_band, plan_id, term, contact_time, src,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term, ip_hash, created_at, tracking_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        LEAD_SOURCE, customerId, created ? "new_customer" : "existing_customer", apply.name, apply.phone,
        "help", `apply:${apply.answers.amount_range ?? "skipped"}`, apply.planId, apply.term, "any", apply.src,
        apply.utm.utm_source ?? null, apply.utm.utm_medium ?? null, apply.utm.utm_campaign ?? null,
        apply.utm.utm_content ?? null, apply.utm.utm_term ?? null, ipHash, timestamp, trackingCode,
      ],
    );
    recordSiteLeadRequest({ customerId, source: "lead", sourceId: leadId, requestedAt: timestamp, contactTime: "any", isRepeat: !created });
    const a = apply.answers;
    const answersId = execute(
      `INSERT INTO site_apply_answers
        (public_lead_id, customer_id, outcome, amount_range, loan_purpose, job_status, documents_json, has_military_card,
         can_refer_retiree, has_bounced_or_overdue, need_timing, plan_id, term, priority_computed, priority_rule, old_priority,
         routed_salesperson_id, src, fill_ms, ip_hash, user_agent, created_at, credit_rank)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      // skipped answers → '' in the legacy NOT NULL columns (read side maps '' back to null)
      [leadId, customerId, created ? "new_customer" : "existing_customer", a.amount_range ?? "", a.loan_purpose, a.job_status ?? "",
        JSON.stringify(a.documents), a.has_military_card ?? "", a.can_refer_retiree ?? "", a.has_bounced_or_overdue ?? "", a.need_timing ?? "",
        apply.planId, apply.term, created ? priority : 1, created ? rule : "repeat_request", oldPriority,
        created ? owner : null, apply.src, apply.fillMs, ipHash, cleanUa(userAgent), timestamp, a.credit_rank],
    );
    return { customerId, created, trackingCode, priority: created ? priority : 1, rule, ownerSalespersonId: owner, answersId, planName };
  });
}

// ---- CRM read side (GET /api/customers/:id/site-answers) ----
type AnswerRow = {
  id: number; customer_id: number; amount_range: string; loan_purpose: string | null; job_status: string; documents_json: string;
  has_military_card: string; can_refer_retiree: string; has_bounced_or_overdue: string; need_timing: string; plan_id: number | null;
  term: number | null; src: string | null; created_at: string; outcome: string; credit_rank?: string | null;
};
export type SiteAnswersView = {
  id: number; submittedAt: string; src: string | null; outcome: string; planId: number | null; planName: string | null; term: number | null;
  answers: SiteApplyAnswers;
};

function tableExists(name: string): boolean {
  return Boolean(queryRow("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", [name]));
}

const pick = <T extends readonly string[]>(set: T, v: unknown): T[number] | null => (oneOf(set, v) ? (v as T[number]) : null);

/** Every submission for this customer (newest first; merged duplicates included). Read only; no priority/owner exposed. */
export function siteAnswersForCustomer(customerId: number): { count: number; latest: SiteAnswersView | null; previous: SiteAnswersView[] } {
  if (!tableExists("site_apply_answers")) return { count: 0, latest: null, previous: [] };
  const ids = queryRows<{ id: number }>("SELECT id FROM customers WHERE id=? OR merged_into_customer_id=?", [customerId, customerId]).map((r) => Number(r.id));
  if (!ids.length) return { count: 0, latest: null, previous: [] };
  const rows = queryRows<AnswerRow & { plan_name: string | null }>(
    `SELECT s.*, lp.name AS plan_name FROM site_apply_answers s LEFT JOIN loan_plans lp ON lp.id=s.plan_id
     WHERE s.customer_id IN (${ids.map(() => "?").join(",")}) ORDER BY s.created_at DESC, s.id DESC LIMIT 50`, ids);
  const view = (r: AnswerRow & { plan_name: string | null }): SiteAnswersView => {
    let documents: SiteApplyAnswers["documents"] = [];
    try { const d = JSON.parse(r.documents_json); if (Array.isArray(d)) documents = d.filter((x) => oneOf(DOCUMENTS, x)); } catch { documents = []; }
    return {
      id: Number(r.id), submittedAt: r.created_at, src: r.src, outcome: r.outcome, planId: r.plan_id == null ? null : Number(r.plan_id),
      planName: r.plan_name ?? null, term: r.term == null ? null : Number(r.term),
      // '' (skipped, v1.1) and unknown values → null
      answers: {
        amount_range: pick(AMOUNT_RANGES, r.amount_range), loan_purpose: pick(LOAN_PURPOSES, r.loan_purpose),
        job_status: pick(JOB_STATUSES, r.job_status), credit_rank: pick(SITE_CREDIT_RANKS, r.credit_rank), documents,
        has_military_card: pick(MILITARY, r.has_military_card), can_refer_retiree: pick(YES_NO, r.can_refer_retiree),
        has_bounced_or_overdue: pick(YES_NO, r.has_bounced_or_overdue), need_timing: pick(NEED_TIMINGS, r.need_timing),
      },
    };
  };
  const all = rows.map(view);
  return { count: all.length, latest: all[0] ?? null, previous: all.slice(1) };
}

/** Stable short hash for logs (never the phone itself). */
export const phoneLogKey = (phone: string): string => createHash("sha256").update(`site-apply:${phone}`).digest("hex").slice(0, 10);
