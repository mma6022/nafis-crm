/**
 * credit-panel v1 («کارهای امروز من» credit card + «اعتبارسنجی سریع»), design /nafis-design/mockups/credit-panel/spec.md.
 * Flag: flag.credit_panel_v1 (call_queue_settings, global, absent/≠'1' = OFF). OFF → every route answers 404 (falls through) and the UI is today's.
 * The debt bundle = UnpaidChequePro + ChequeColor + ActiveLoans through the existing sapi.ts client (same config path; no key handled here).
 * Storage: an additive table customer_debt_inquiries (one row per run; per-part raw provider `data` or the error). The national code is never stored
 * here (only a masked tail); provider amounts stay rial and dates stay compact Jalali — conversion is display-side (spec §3).
 * Validity: the «اعتبارسنجی» duration of «مدیریت فروش» (smc_settings.valid.credit), read-only; default 24 hours. Nothing is written to settings.
 */
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import { CREDIT_LIMITS, auditCredit } from "./credit-check-guard";
import { sapiDebt, type SapiDebtCheck } from "./sapi";

export const CP_FLAG = "flag.credit_panel_v1";
export const cpOn = (): boolean => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [CP_FLAG])?.value === "1"; } catch { return false; }
};

export const CP_PARTS = ["unpaidChequePro", "chequeColor", "activeLoans"] as const satisfies readonly SapiDebtCheck[];
export type CpPart = typeof CP_PARTS[number];
type Client = (part: CpPart, nationalCode: string, isCompany: boolean) => Promise<Record<string, unknown>>;
let client: Client = (part, code, isCompany) => sapiDebt(part, code, isCompany);
/** Fixture-only hook (tests never reach the provider). */
export function setCpClient(next: Client | null): void { client = next ?? ((part, code, isCompany) => sapiDebt(part, code, isCompany)); }

let ready = false;
export function ensureCpSchema(): void {
  if (ready) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS customer_debt_inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      requested_by_user_id INTEGER NOT NULL,
      national_code_tail TEXT,
      created_at TEXT NOT NULL,
      valid_hours INTEGER,
      unpaid_json TEXT, unpaid_error TEXT,
      color_json TEXT, color_error TEXT,
      loans_json TEXT, loans_error TEXT,
      ok_parts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_customer_debt_inquiries_customer ON customer_debt_inquiries(customer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_customer_debt_inquiries_user ON customer_debt_inquiries(requested_by_user_id, created_at);
  `);
  ready = true;
}

const COL: Record<CpPart, { json: string; err: string }> = {
  unpaidChequePro: { json: "unpaid_json", err: "unpaid_error" },
  chequeColor: { json: "color_json", err: "color_error" },
  activeLoans: { json: "loans_json", err: "loans_error" },
};

/** «اعتبارسنجی» duration from «مدیریت فروش» — read-only (no seed insert). null = forever. */
export function cpValidHours(): number | null {
  try {
    const r = queryRow<{ payload_json: string }>("SELECT payload_json FROM smc_settings WHERE section='valid'");
    const credit = r ? (JSON.parse(r.payload_json) as { credit?: { mode?: string; hours?: number } }).credit : undefined;
    if (credit?.mode === "forever") return null;
    const h = Number(credit?.hours);
    return Number.isFinite(h) && h > 0 ? Math.round(h) : 24;
  } catch { return 24; }
}

/** Drop identifiers before storing (the customer row already has the code). */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/^(nationalcode|national_code|legalid|legal_id)$/i.test(k)) continue;
      out[k] = scrub(x);
    }
    return out;
  }
  return v;
}

type Row = { id: number; created_at: string; valid_hours: number | null; ok_parts: number } & Record<string, string | number | null>;
export type CpPartView = { data: Record<string, unknown> | null; at: string | null; error: boolean };
export type CpView = {
  enabled: true;
  customerId: number;
  lastAt: string | null;
  validHours: number | null;
  validUntil: string | null;
  valid: boolean;
  parts: Record<CpPart, CpPartView>;
  lastErrors: CpPart[];
};

/** Last saved result: per part the newest successful data (a failed part keeps its previous value, spec §2.4). */
export function cpView(customerId: number, now = Date.now()): CpView {
  ensureCpSchema();
  const rows = queryRows<Row>("SELECT * FROM customer_debt_inquiries WHERE customer_id=? ORDER BY created_at DESC, id DESC LIMIT 50", [customerId]);
  const last = rows.find((r) => r.ok_parts > 0) ?? null;
  const parts = {} as Record<CpPart, CpPartView>;
  for (const p of CP_PARTS) {
    const hit = rows.find((r) => r[COL[p].json] != null);
    let data: Record<string, unknown> | null = null;
    try { data = hit ? JSON.parse(String(hit[COL[p].json])) as Record<string, unknown> : null; } catch { data = null; }
    const tried = rows.find((r) => r[COL[p].json] != null || r[COL[p].err] != null);
    parts[p] = { data, at: hit?.created_at ?? null, error: Boolean(tried && tried[COL[p].err] != null) };
  }
  const lastErrors = CP_PARTS.filter((p) => parts[p].error);
  const validHours = last ? (last.valid_hours == null ? null : Number(last.valid_hours)) : cpValidHours();
  const validUntil = last && validHours != null ? new Date(Date.parse(last.created_at) + validHours * 3_600_000).toISOString() : null;
  const valid = Boolean(last) && (validHours == null || (validUntil != null && Date.parse(validUntil) > now));
  return { enabled: true, customerId, lastAt: last?.created_at ?? null, validHours, validUntil, valid, parts, lastErrors };
}

const dayAgo = (now: number) => new Date(now - 24 * 3_600_000).toISOString();
/** Same caps as the ICS24 guard (expert role only), counted on the debt runs. */
export function cpLimit(user: { id: number; role: string }, customerId: number, now = Date.now()): string | null {
  if (user.role !== "salesperson") return null;
  ensureCpSchema();
  const since = dayAgo(now);
  const mine = queryRow<{ n: number }>("SELECT COUNT(*) n FROM customer_debt_inquiries WHERE requested_by_user_id=? AND created_at>=?", [user.id, since])?.n ?? 0;
  if (mine >= CREDIT_LIMITS.expertPerDay) return `سقف استعلام امروز شما (${CREDIT_LIMITS.expertPerDay} استعلام در ۲۴ ساعت) پر شده است.`;
  const forCustomer = queryRow<{ n: number }>("SELECT COUNT(*) n FROM customer_debt_inquiries WHERE customer_id=? AND created_at>=?", [customerId, since])?.n ?? 0;
  if (forCustomer >= CREDIT_LIMITS.customerPerDay) return `برای این مشتری در ۲۴ ساعت گذشته ${CREDIT_LIMITS.customerPerDay} استعلام انجام شده است؛ فردا دوباره امتحان کن.`;
  return null;
}

const running = new Set<number>();
export type CpRunResult = { status: number; body: Record<string, unknown> };
/**
 * Run the debt bundle (or only `only` parts for «تلاش دوباره» of one part). Order of guards: still-valid confirm → rate limit → one run at a time.
 * The national code comes from the customer row (validated by the caller).
 */
export async function cpRun(opts: {
  user: { id: number; role: string }; customerId: number; nationalCode: string; isCompany?: boolean; confirmFresh?: boolean; only?: CpPart[];
}): Promise<CpRunResult> {
  ensureCpSchema();
  const { user, customerId, nationalCode } = opts;
  const audit = (outcome: string, detail?: string) => auditCredit({ actorUserId: user.id, customerId, action: "initiate", source: "credit_panel", outcome, detail });
  const before = cpView(customerId);
  const parts = opts.only?.length ? CP_PARTS.filter((p) => opts.only!.includes(p)) : [...CP_PARTS];
  if (before.valid && !opts.only?.length && opts.confirmFresh !== true) {
    return { status: 409, body: { error: "استعلام قبلی هنوز معتبر است. استعلام تازه گرفته شود؟", code: "still_valid", validUntil: before.validUntil } };
  }
  const limited = cpLimit(user, customerId);
  if (limited) { audit("rate_limited"); return { status: 429, body: { error: limited, code: "credit_rate_limited" } }; }
  if (running.has(customerId)) return { status: 409, body: { error: "برای این مشتری یک استعلام در جریان است.", code: "running" } };
  running.add(customerId);
  try {
    const results = await Promise.all(parts.map(async (p) => {
      try { return { p, data: scrub(await client(p, nationalCode, opts.isCompany === true)) as Record<string, unknown>, err: null as string | null }; }
      catch (e) { return { p, data: null, err: e instanceof Error && e.message === "sapi_provider_no_credit" ? "provider_no_credit" : "failed" }; }
    }));
    const okParts = results.filter((r) => r.data).length;
    const vals: Record<string, string | null> = {};
    for (const p of CP_PARTS) { vals[COL[p].json] = null; vals[COL[p].err] = null; }
    for (const r of results) { vals[COL[r.p].json] = r.data ? JSON.stringify(r.data) : null; vals[COL[r.p].err] = r.err; }
    const now = new Date().toISOString();
    execute(`INSERT INTO customer_debt_inquiries (customer_id,requested_by_user_id,national_code_tail,created_at,valid_hours,
        unpaid_json,unpaid_error,color_json,color_error,loans_json,loans_error,ok_parts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [customerId, user.id, nationalCode.slice(-3), now, cpValidHours(), vals.unpaid_json, vals.unpaid_error, vals.color_json, vals.color_error,
        vals.loans_json, vals.loans_error, okParts]);
    audit(okParts === parts.length ? "ok" : okParts ? "partial" : "failed", parts.join(","));
    const view = cpView(customerId);
    if (!okParts) return { status: 502, body: { error: "استعلام الآن انجام نشد", code: "all_failed", view } };
    return { status: 200, body: { ...view, failed: results.filter((r) => !r.data).map((r) => r.p) } };
  } finally {
    running.delete(customerId);
  }
}
