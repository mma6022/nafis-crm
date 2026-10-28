/**
 * v82 «ثبت درخواست» — the site's 7-step apply wizard (Armita site-apply-wizard v1.0.1; Mohammad t129u/t130u/t131u/t134u).
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
import {
  LEAD_SOURCE, WEBSITE_LEAD_TAG, UTM_KEYS, canonicalCustomerByMobile, ensurePublicLeadSchema, intakeGate, normalizeLeadName,
  normalizeLeadPhone, oneOf, optionalInt, readSrcAndUtm, uniqueTrackingCode, type PublicLead,
} from "./public-leads";

export const SITE_APPLY_SOURCE = "site_apply_form" as const;
/** Mohammad (via PM, 2026-10-28): this 7-step form needs at least 8 seconds; every other intake keeps 3 s. */
export const SITE_APPLY_MIN_FILL_MS = 8_000;
export const REPEAT_REQUEST_TAG = "repeat_request";

export const AMOUNT_RANGES = ["up_to_50m", "50m_100m", "100m_300m", "300m_500m", "over_500m", "not_sure"] as const;
export const LOAN_PURPOSES = ["goods", "wedding", "medical", "home", "business", "other"] as const;
export const JOB_STATUSES = ["employee", "retired", "self_employed", "no_fixed_income"] as const;
export const DOCUMENTS = ["payslip", "salary_deduction_cert", "sayadi_cheque", "guarantor", "none"] as const;
export const MILITARY = ["yes", "no", "not_applicable"] as const;
export const YES_NO = ["yes", "no"] as const;
export const NEED_TIMINGS = ["this_week", "this_month", "just_browsing"] as const;

export type SiteApplyAnswers = {
  amount_range: (typeof AMOUNT_RANGES)[number];
  loan_purpose: (typeof LOAN_PURPOSES)[number] | null;
  job_status: (typeof JOB_STATUSES)[number];
  documents: (typeof DOCUMENTS)[number][];
  has_military_card: (typeof MILITARY)[number];
  can_refer_retiree: (typeof YES_NO)[number];
  has_bounced_or_overdue: (typeof YES_NO)[number];
  need_timing: (typeof NEED_TIMINGS)[number];
};
export type SiteApply = {
  name: string; phone: string; answers: SiteApplyAnswers; planId: number | null; term: number | null;
  src: string | null; utm: PublicLead["utm"]; fillMs: number | null;
};
export type SiteApplyValidation =
  | { ok: true; apply: SiteApply }
  | { ok: false; status: 400 | 422; error: "invalid" | "spam" | "too_fast" | "expired"; fields?: string[] };

const ANSWER_KEYS = ["amount_range", "loan_purpose", "job_status", "documents", "has_military_card", "can_refer_retiree",
  "has_bounced_or_overdue", "need_timing"] as const;
const APPLY_KEYS = new Set<string>([
  "type", "name", "phone", ...ANSWER_KEYS, "planId", "term", "src", "consent", "website", "startedAt", "fillMs", ...UTM_KEYS,
]);

/** Strict validation of the apply wizard body. */
export function validateSiteApply(body: unknown, now = Date.now()): SiteApplyValidation {
  const gate = intakeGate(body, APPLY_KEYS, now, SITE_APPLY_MIN_FILL_MS);
  if ("ok" in gate) return gate;
  const { input } = gate;
  const fields: string[] = [];
  if (input.type !== "apply") fields.push("type");
  const name = normalizeLeadName(input.name);
  if (!name) fields.push("name");
  const phone = normalizeLeadPhone(input.phone);
  if (!phone) fields.push("phone");
  if (!oneOf(AMOUNT_RANGES, input.amount_range)) fields.push("amount_range");
  const purposeRaw = input.loan_purpose;
  const purpose = purposeRaw === undefined || purposeRaw === null || purposeRaw === "" ? null : purposeRaw;
  if (purpose !== null && !oneOf(LOAN_PURPOSES, purpose)) fields.push("loan_purpose");
  if (!oneOf(JOB_STATUSES, input.job_status)) fields.push("job_status");
  const docs = input.documents;
  let documents: SiteApplyAnswers["documents"] = [];
  if (!Array.isArray(docs) || docs.length < 1 || docs.length > DOCUMENTS.length
    || !docs.every((d) => oneOf(DOCUMENTS, d)) || new Set(docs).size !== docs.length
    || (docs.includes("none") && docs.length > 1)) fields.push("documents");
  else documents = DOCUMENTS.filter((d) => (docs as string[]).includes(d)); // canonical order
  if (!oneOf(MILITARY, input.has_military_card)) fields.push("has_military_card");
  if (!oneOf(YES_NO, input.can_refer_retiree)) fields.push("can_refer_retiree");
  if (!oneOf(YES_NO, input.has_bounced_or_overdue)) fields.push("has_bounced_or_overdue");
  if (!oneOf(NEED_TIMINGS, input.need_timing)) fields.push("need_timing");
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
      answers: {
        amount_range: input.amount_range as SiteApplyAnswers["amount_range"],
        loan_purpose: purpose as SiteApplyAnswers["loan_purpose"],
        job_status: input.job_status as SiteApplyAnswers["job_status"],
        documents,
        has_military_card: input.has_military_card as SiteApplyAnswers["has_military_card"],
        can_refer_retiree: input.can_refer_retiree as SiteApplyAnswers["can_refer_retiree"],
        has_bounced_or_overdue: input.has_bounced_or_overdue as SiteApplyAnswers["has_bounced_or_overdue"],
        need_timing: input.need_timing as SiteApplyAnswers["need_timing"],
      },
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
export const AMOUNT_FA: Record<SiteApplyAnswers["amount_range"], string> = {
  up_to_50m: "تا ۵۰ میلیون تومان", "50m_100m": "۵۰ تا ۱۰۰ میلیون تومان", "100m_300m": "۱۰۰ تا ۳۰۰ میلیون تومان",
  "300m_500m": "۳۰۰ تا ۵۰۰ میلیون تومان", over_500m: "بیشتر از ۵۰۰ میلیون تومان", not_sure: "هنوز نمی‌داند",
};
export const PURPOSE_FA: Record<(typeof LOAN_PURPOSES)[number], string> = {
  goods: "خرید کالا", wedding: "جهیزیه و ازدواج", medical: "درمان", home: "خانه و تعمیرات", business: "کسب‌وکار", other: "کار دیگر",
};
export const JOB_FA: Record<SiteApplyAnswers["job_status"], string> = {
  employee: "کارمند", retired: "بازنشسته", self_employed: "آزاد", no_fixed_income: "بدون درآمد ثابت",
};
export const DOC_FA: Record<(typeof DOCUMENTS)[number], string> = {
  payslip: "فیش حقوقی", salary_deduction_cert: "گواهی کسر از حقوق", sayadi_cheque: "چک صیادی", guarantor: "ضامن", none: "هیچ‌کدام",
};
export const MILITARY_FA: Record<SiteApplyAnswers["has_military_card"], string> = { yes: "دارد", no: "ندارد", not_applicable: "مشمول نیست" };
export const TIMING_FA: Record<SiteApplyAnswers["need_timing"], string> = {
  this_week: "همین هفته", this_month: "این ماه", just_browsing: "فقط دارد بررسی می‌کند",
};

/** Staff summary of ONLY the customer's own answers (Telegram «این درخواست» + repeat-request text). */
export function siteApplySummary(a: SiteApplyAnswers, planName?: string | null, planId?: number | null, term?: number | null): string {
  const lines = [
    "فرم ۷ مرحله‌ای سایت (همه اعلامی مشتری)",
    `مبلغ: ${AMOUNT_FA[a.amount_range]}`,
    `برای: ${a.loan_purpose ? PURPOSE_FA[a.loan_purpose] : "بی‌جواب (اختیاری)"}`,
    `شغل: ${JOB_FA[a.job_status]}`,
    `مدارک: ${a.documents.map((d) => DOC_FA[d]).join("، ")}`,
    `پایان خدمت: ${MILITARY_FA[a.has_military_card]}`,
    `معرفی بازنشسته: ${a.can_refer_retiree === "yes" ? "بله، می‌تواند معرفی کند" : "خیر"}`,
    `چک برگشتی / معوق: ${a.has_bounced_or_overdue === "yes" ? "بله، دارد" : "خیر"}`,
    `زمان نیاز: ${TIMING_FA[a.need_timing]}`,
  ];
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
      owner = qualifier;
      // No active closer (TeamSalesError 409) → the lead must not be lost: it stays with the qualifier, still P1.
      if (priority === 1) { try { owner = nextCloserSalespersonId(cfg); } catch { owner = qualifier; } }
      const description = ["درخواست از فرم سایت nafisvam.com", ...(apply.src ? [`منبع صفحه: ${apply.src}`] : [])].join("\n");
      customerId = insertCustomerRecord({
        name: apply.name, phone: apply.phone, description, priority, registeredByUserId: null, registrationSource: "site_lead",
        skipDefaultOwnerRule: true, assignedSalespersonId: owner,
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
        [customerId, apply.name, summary.slice(0, 2000), "درخواست تازه از فرم ۷ مرحله‌ای سایت (همان شماره موبایل)", timestamp],
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
        "help", `apply:${apply.answers.amount_range}`, apply.planId, apply.term, "any", apply.src,
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
         routed_salesperson_id, src, fill_ms, ip_hash, user_agent, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [leadId, customerId, created ? "new_customer" : "existing_customer", a.amount_range, a.loan_purpose, a.job_status,
        JSON.stringify(a.documents), a.has_military_card, a.can_refer_retiree, a.has_bounced_or_overdue, a.need_timing,
        apply.planId, apply.term, created ? priority : 1, created ? rule : "repeat_request", oldPriority,
        created ? owner : null, apply.src, apply.fillMs, ipHash, cleanUa(userAgent), timestamp],
    );
    return { customerId, created, trackingCode, priority: created ? priority : 1, rule, ownerSalespersonId: owner, answersId, planName };
  });
}

// ---- CRM read side (GET /api/customers/:id/site-answers) ----
type AnswerRow = {
  id: number; customer_id: number; amount_range: string; loan_purpose: string | null; job_status: string; documents_json: string;
  has_military_card: string; can_refer_retiree: string; has_bounced_or_overdue: string; need_timing: string; plan_id: number | null;
  term: number | null; src: string | null; created_at: string; outcome: string;
};
export type SiteAnswersView = {
  id: number; submittedAt: string; src: string | null; outcome: string; planId: number | null; planName: string | null; term: number | null;
  answers: SiteApplyAnswers;
};

function tableExists(name: string): boolean {
  return Boolean(queryRow("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", [name]));
}

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
      answers: {
        amount_range: r.amount_range as SiteApplyAnswers["amount_range"], loan_purpose: (r.loan_purpose ?? null) as SiteApplyAnswers["loan_purpose"],
        job_status: r.job_status as SiteApplyAnswers["job_status"], documents,
        has_military_card: r.has_military_card as SiteApplyAnswers["has_military_card"],
        can_refer_retiree: r.can_refer_retiree as SiteApplyAnswers["can_refer_retiree"],
        has_bounced_or_overdue: r.has_bounced_or_overdue as SiteApplyAnswers["has_bounced_or_overdue"],
        need_timing: r.need_timing as SiteApplyAnswers["need_timing"],
      },
    };
  };
  const all = rows.map(view);
  return { count: all.length, latest: all[0] ?? null, previous: all.slice(1) };
}

/** Stable short hash for logs (never the phone itself). */
export const phoneLogKey = (phone: string): string => createHash("sha256").update(`site-apply:${phone}`).digest("hex").slice(0, 10);
