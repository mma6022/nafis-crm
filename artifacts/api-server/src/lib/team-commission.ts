/**
 * Team-sales commission model (closer tier commission + qualifier P1 share + data-accuracy bonus + monthly team bonus).
 *
 * Safety:
 *  - Ships OFF: with no settings row (or enabled=false) nothing changes; legacy commission path runs untouched.
 *  - Additive schema only: new tables; existing tables are never altered.
 *  - Settings are versioned (append-only). Every posting stores the version it used; editing settings never recomputes posted rows.
 *  - No SMS, no staff notifications: bell rows fired by our own ledger/purchase writes are removed in the same transaction.
 *  - Trainees and every salesperson outside the team (qualifier + closers from team_sales_config) stay on the legacy path.
 */
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { getTeamSalesConfig } from "./team-sales";

const nowIso = () => new Date().toISOString();
const big = (v: unknown): bigint => {
  const s = String(v ?? "0");
  if (!/^-?\d{1,30}$/.test(s)) throw new Error("invalid_amount_toman");
  return BigInt(s);
};
const pct = (amount: bigint, bps: number) => amount * BigInt(bps) / 10000n;

export class TeamCommissionError extends Error {
  constructor(public status: number, message: string, public errors: Record<string, string> = {}) { super(message); }
}

// ---------------------------------------------------------------- calendar (Asia/Tehran, no DST since 1401)
export function persianMonthOf(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}
export function nextPersianMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m >= 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
export function previousPersianMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m <= 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
/** Jalali -> Gregorian (algorithm from jalaali-js). */
export function jalaliToGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097); days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const sal = [0, 31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  for (gm = 0; gm < 13 && gd > sal[gm]; gm++) gd -= sal[gm];
  return [gy, gm, gd];
}
/** "1405-08-02" -> Date at 00:00 Asia/Tehran (+03:30). */
export function jalaliDateStart(jalali: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(jalali);
  if (!m) throw new Error("invalid_jalali_date");
  const [gy, gm, gd] = jalaliToGregorian(Number(m[1]), Number(m[2]), Number(m[3]));
  return new Date(`${gy}-${String(gm).padStart(2, "0")}-${String(gd).padStart(2, "0")}T00:00:00+03:30`);
}
/** First instant of a Jalali month "1405-08". */
export const monthStart = (month: string) => jalaliDateStart(`${month}-01`);
export const monthEnd = (month: string) => new Date(monthStart(nextPersianMonth(month)).getTime() - 1);

// ---------------------------------------------------------------- settings
export type Basis = "deposit" | "legacy_base";
export type PostingMoment = "payment_paid" | "final_approval";
export type TeamBonusBasis = "total" | "above_threshold";
export type TeamCommissionSettings = {
  enabled: boolean;
  basis: Basis;
  postingMoment: PostingMoment;
  modelStartDate: string; // Jalali YYYY-MM-DD, Tehran midnight
  p1FirstCallBps: number;
  p1UpgradeBps: number;
  dataAccuracyBonusToman: string;
  teamBonusEnabled: boolean;
  teamBonusBps: number;
  teamBonusThresholdToman: string;
  teamBonusBasis: TeamBonusBasis;
  teamSplitBps: Record<string, number>; // salespersonId -> bps (sum 10000)
};
export const DEFAULT_SETTINGS: TeamCommissionSettings = {
  enabled: false,
  basis: "deposit",
  postingMoment: "payment_paid",
  modelStartDate: "1405-08-02",
  p1FirstCallBps: 50,
  p1UpgradeBps: 75,
  dataAccuracyBonusToman: "200000",
  teamBonusEnabled: false,
  teamBonusBps: 30,
  teamBonusThresholdToman: "10000000000",
  teamBonusBasis: "total",
  teamSplitBps: { "3": 4000, "4": 4000, "6": 2000 },
};
export type SettingsVersion = { versionId: number; effectiveAt: string | null; settings: TeamCommissionSettings };

let schemaReady = false;
export function ensureTeamCommissionSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS team_commission_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      effective_at TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_commission_purchases (
      purchase_id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      salesperson_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_payout','posted','reversed')),
      settings_version_id INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      basis TEXT NOT NULL,
      posting_moment TEXT NOT NULL,
      basis_amount_toman TEXT,
      commission_month TEXT,
      closer_rate_bps INTEGER,
      closer_commission_toman TEXT,
      qualifier_salesperson_id INTEGER,
      p1_history_id INTEGER,
      p1_kind TEXT,
      p1_share_bps INTEGER,
      p1_share_toman TEXT,
      last_error TEXT,
      entered_at TEXT NOT NULL,
      posted_at TEXT,
      reversed_at TEXT,
      reversal_month TEXT,
      reversal_reason TEXT,
      reversed_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_team_commission_purchases_month ON team_commission_purchases(commission_month, salesperson_id);
    CREATE TABLE IF NOT EXISTS team_commission_ledger_meta (
      ledger_id INTEGER PRIMARY KEY,
      salesperson_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      commission_month TEXT NOT NULL,
      settings_version_id INTEGER,
      customer_id INTEGER,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_team_commission_ledger_meta_sp ON team_commission_ledger_meta(salesperson_id, commission_month, kind);
    CREATE TABLE IF NOT EXISTS team_data_accuracy_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      priority_history_id INTEGER NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      qualifier_salesperson_id INTEGER NOT NULL,
      closer_salesperson_id INTEGER,
      p1_kind TEXT NOT NULL,
      correct INTEGER NOT NULL,
      reason TEXT,
      note TEXT,
      bonus_toman TEXT NOT NULL DEFAULT '0',
      settings_version_id INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      reviewed_by INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL,
      updated_by INTEGER,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_team_data_accuracy_customer ON team_data_accuracy_reviews(customer_id);
    CREATE TABLE IF NOT EXISTS team_bonus_runs (
      month TEXT PRIMARY KEY,
      settings_version_id INTEGER NOT NULL,
      team_sales_toman TEXT NOT NULL,
      bonus_toman TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      run_by INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  schemaReady = true;
}

function parseSettings(json: string): TeamCommissionSettings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(json) }; } catch { return { ...DEFAULT_SETTINGS }; }
}
/** Version effective at `at` (latest row with effective_at <= at). Version 0 = built-in defaults (model OFF). */
export function settingsAt(at: Date = new Date()): SettingsVersion {
  ensureTeamCommissionSchema();
  const row = queryRow<{ id: number; effective_at: string; settings_json: string }>(
    "SELECT id,effective_at,settings_json FROM team_commission_settings WHERE effective_at<=? ORDER BY effective_at DESC,id DESC LIMIT 1", [at.toISOString()]);
  return row ? { versionId: row.id, effectiveAt: row.effective_at, settings: parseSettings(row.settings_json) } : { versionId: 0, effectiveAt: null, settings: { ...DEFAULT_SETTINGS } };
}
export function settingsVersion(id: number): SettingsVersion {
  if (!id) return { versionId: 0, effectiveAt: null, settings: { ...DEFAULT_SETTINGS } };
  const row = queryRow<{ id: number; effective_at: string; settings_json: string }>("SELECT id,effective_at,settings_json FROM team_commission_settings WHERE id=?", [id]);
  if (!row) throw new Error("settings_version_not_found");
  return { versionId: row.id, effectiveAt: row.effective_at, settings: parseSettings(row.settings_json) };
}

// ----- API <-> internal
const FA_DIGITS = /[۰-۹٠-٩]/g;
const latin = (v: unknown) => String(v ?? "").trim().replace(FA_DIGITS, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d) >= 0 ? "۰۱۲۳۴۵۶۷۸۹".indexOf(d) : "٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٫،]/g, ".").replace(/[,٬\s]/g, "");
const bpsToPercent = (bps: number) => { const s = (bps / 100).toFixed(2); return s.replace(/\.?0+$/, ""); };
function parsePercent(v: unknown): number | null {
  const s = latin(v);
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const bps = Number(w) * 100 + Number(f.padEnd(2, "0"));
  return bps > 10000 ? null : bps;
}
function parseAmount(v: unknown): string | null {
  const s = latin(v);
  if (!/^\d{1,20}$/.test(s) || BigInt(s) <= 0n) return null;
  return BigInt(s).toString();
}
export type SettingsView = {
  enabled: boolean; basis: Basis; postingMoment: PostingMoment; modelStartDate: string;
  p1FirstCallPercent: string; p1UpgradePercent: string; dataAccuracyBonusToman: string;
  teamBonusEnabled: boolean; teamBonusPercent: string; teamBonusThresholdToman: string; teamBonusBasis: TeamBonusBasis;
  teamSplit: Array<{ salespersonId: number; percent: string }>;
};
export function settingsView(s: TeamCommissionSettings): SettingsView {
  return {
    enabled: s.enabled, basis: s.basis, postingMoment: s.postingMoment, modelStartDate: s.modelStartDate,
    p1FirstCallPercent: bpsToPercent(s.p1FirstCallBps), p1UpgradePercent: bpsToPercent(s.p1UpgradeBps),
    dataAccuracyBonusToman: s.dataAccuracyBonusToman, teamBonusEnabled: s.teamBonusEnabled,
    teamBonusPercent: bpsToPercent(s.teamBonusBps), teamBonusThresholdToman: s.teamBonusThresholdToman, teamBonusBasis: s.teamBonusBasis,
    teamSplit: Object.entries(s.teamSplitBps).map(([id, bps]) => ({ salespersonId: Number(id), percent: bpsToPercent(bps) })),
  };
}
const PCT_ERR = "عدد باید بین ۰ تا ۱۰۰ باشد (حداکثر دو رقم اعشار).";
const AMT_ERR = "مبلغ باید عددی مثبت به تومان باشد.";
const faNum = (n: number | string) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]).replace(/\./g, "٫");
/** Server-side validation of PUT /goods-finance/team-settings. Throws TeamCommissionError(400) with per-field messages. */
export function validateSettingsInput(body: any, current: TeamCommissionSettings): TeamCommissionSettings {
  const errors: Record<string, string> = {};
  const b = body ?? {};
  const next: TeamCommissionSettings = { ...current, teamSplitBps: { ...current.teamSplitBps } };
  const bool = (k: keyof TeamCommissionSettings & string) => {
    if (b[k] === undefined) return;
    if (typeof b[k] !== "boolean") errors[k] = "مقدار نامعتبر است."; else (next as any)[k] = b[k];
  };
  bool("enabled"); bool("teamBonusEnabled");
  if (b.basis !== undefined) { if (b.basis === "deposit" || b.basis === "legacy_base") next.basis = b.basis; else errors.basis = "مبنا نامعتبر است."; }
  if (b.postingMoment !== undefined) { if (b.postingMoment === "payment_paid" || b.postingMoment === "final_approval") next.postingMoment = b.postingMoment; else errors.postingMoment = "زمان ثبت نامعتبر است."; }
  if (b.teamBonusBasis !== undefined) { if (b.teamBonusBasis === "total" || b.teamBonusBasis === "above_threshold") next.teamBonusBasis = b.teamBonusBasis; else errors.teamBonusBasis = "مبنای پاداش تیمی نامعتبر است."; }
  if (b.modelStartDate !== undefined) {
    const s = latin(b.modelStartDate).replace(/\//g, "-");
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    const ok = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= (Number(m[2]) <= 6 ? 31 : 30) && Number(m[1]) >= 1400 && Number(m[1]) <= 1500;
    if (!ok) errors.modelStartDate = "تاریخ شمسی نامعتبر است (مثل ۱۴۰۵/۰۸/۰۲).";
    else next.modelStartDate = `${m![1]}-${m![2].padStart(2, "0")}-${m![3].padStart(2, "0")}`;
  }
  const percentField = (key: string, target: "p1FirstCallBps" | "p1UpgradeBps" | "teamBonusBps") => {
    if (b[key] === undefined) return;
    const v = parsePercent(b[key]); if (v == null) errors[key] = PCT_ERR; else next[target] = v;
  };
  percentField("p1FirstCallPercent", "p1FirstCallBps");
  percentField("p1UpgradePercent", "p1UpgradeBps");
  percentField("teamBonusPercent", "teamBonusBps");
  const amountField = (key: "dataAccuracyBonusToman" | "teamBonusThresholdToman") => {
    if (b[key] === undefined) return;
    const v = parseAmount(b[key]); if (v == null) errors[key] = AMT_ERR; else next[key] = v;
  };
  amountField("dataAccuracyBonusToman"); amountField("teamBonusThresholdToman");
  if (b.teamSplit !== undefined) {
    if (!Array.isArray(b.teamSplit) || !b.teamSplit.length) errors.teamSplit = "تقسیم سهم‌ها نامعتبر است.";
    else {
      const split: Record<string, number> = {};
      let bad = false;
      for (const item of b.teamSplit) {
        const id = Number(item?.salespersonId), v = parsePercent(item?.percent);
        if (!Number.isInteger(id) || id <= 0 || v == null || split[String(id)] !== undefined) { bad = true; continue; }
        split[String(id)] = v;
      }
      if (bad) errors.teamSplit = PCT_ERR;
      else {
        const sum = Object.values(split).reduce((s, v) => s + v, 0);
        if (sum !== 10000) errors.teamSplit = `جمع سهم‌ها باید ۱۰۰٪ باشد؛ الان ${faNum(bpsToPercent(sum))}٪ است.`;
        else next.teamSplitBps = split;
      }
    }
  }
  const n = Object.keys(errors).length;
  if (n) throw new TeamCommissionError(400, `ذخیره نشد. ${faNum(n)} مورد را درست کن.`, errors);
  return next;
}
export function saveSettings(body: any, actorId: number): SettingsVersion {
  ensureTeamCommissionSchema();
  return runImmediateTransaction(() => {
    const current = settingsAt();
    const next = validateSettingsInput(body, current.settings);
    if (JSON.stringify(next) === JSON.stringify(current.settings) && current.versionId) return current;
    const at = nowIso();
    const id = execute("INSERT INTO team_commission_settings(effective_at,settings_json,created_by,created_at) VALUES(?,?,?,?)", [at, JSON.stringify(next), actorId, at]);
    return settingsVersion(id);
  });
}
export function listSettingsVersions(limit = 20) {
  ensureTeamCommissionSchema();
  return queryRows<any>("SELECT s.id versionId,s.effective_at effectiveAt,s.created_at createdAt,u.full_name createdByName,s.settings_json FROM team_commission_settings s LEFT JOIN users u ON u.id=s.created_by ORDER BY s.id DESC LIMIT ?", [limit])
    .map(r => ({ versionId: r.versionId, effectiveAt: r.effectiveAt, createdAt: r.createdAt, createdByName: r.createdByName ?? null, settings: settingsView(parseSettings(r.settings_json)) }));
}

// ---------------------------------------------------------------- membership & notifications
export function teamMembers() {
  const cfg = getTeamSalesConfig();
  return { qualifierId: cfg.qualifierSalespersonId, closerIds: cfg.closerSalespersonIds, all: [...cfg.closerSalespersonIds, cfg.qualifierSalespersonId] };
}
const hasNotificationTable = () => Boolean(queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_notification_events'"));
/** Run `fn` and delete bell rows fired by triggers on its writes (commission bookkeeping must never notify staff). */
function silently<T>(fn: () => T): T {
  const table = hasNotificationTable();
  const preMax = table ? Number(queryRow<{ m: number | null }>("SELECT MAX(id) m FROM site_notification_events")?.m ?? 0) : 0;
  const result = fn();
  if (table) executeChanges("DELETE FROM site_notification_events WHERE id>?", [preMax]);
  return result;
}

type LedgerInput = {
  purchaseId: number | null; planId: number | null; customerId: number | null; salespersonId: number;
  kind: string; amount: bigint; key: string; actorId: number | null; month: string; versionId: number | null; meta?: unknown;
};
/** Idempotent ledger + wallet + meta write. Returns false when the key already exists. Must run inside a transaction. */
function postLedger(e: LedgerInput): boolean {
  if (queryRow("SELECT 1 FROM goods_finance_ledger WHERE idempotency_key=?", [e.key])) return false;
  silently(() => {
    const id = execute("INSERT INTO goods_finance_ledger(purchase_id,plan_id,customer_id,salesperson_id,kind,amount_toman,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [e.purchaseId, e.planId, e.customerId, e.salespersonId, e.kind, e.amount.toString(), e.key, e.actorId, nowIso()]);
    execute("INSERT INTO team_commission_ledger_meta(ledger_id,salesperson_id,kind,commission_month,settings_version_id,customer_id,meta_json) VALUES(?,?,?,?,?,?,?)",
      [id, e.salespersonId, e.kind, e.month, e.versionId, e.customerId, e.meta === undefined ? null : JSON.stringify(e.meta)]);
    execute("INSERT OR IGNORE INTO goods_salesperson_wallets(salesperson_id,balance_toman) VALUES(?,'0')", [e.salespersonId]);
    const w = queryRow<{ balance_toman: string }>("SELECT balance_toman FROM goods_salesperson_wallets WHERE salesperson_id=?", [e.salespersonId])!;
    executeChanges("UPDATE goods_salesperson_wallets SET balance_toman=? WHERE salesperson_id=?", [(big(w.balance_toman) + e.amount).toString(), e.salespersonId]);
  });
  return true;
}

// ---------------------------------------------------------------- P1 event (from customer_priority_history)
export type P1Event = { historyId: number; kind: "first_call" | "upgrade"; at: string; closerSalespersonId: number | null; actorUserId: number | null };
/** Latest qualifier P1 handoff for the customer at/after the model start and at/before `until`. */
export function qualifierP1Event(customerId: number, s: TeamCommissionSettings, until: Date = new Date()): P1Event | null {
  if (!queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_priority_history'")) return null;
  const { qualifierId } = teamMembers();
  const start = jalaliDateStart(s.modelStartDate).toISOString();
  const row = queryRow<any>(
    `SELECT h.id,h.source,h.old_priority,h.new_salesperson_id,h.actor_user_id,h.created_at FROM customer_priority_history h
     JOIN users u ON u.id=h.actor_user_id
     WHERE h.customer_id=? AND h.new_priority=1 AND h.source IN ('qualifier_form','promote') AND u.salesperson_id=?
       AND h.created_at>=? AND h.created_at<=?
       AND (h.source='qualifier_form' OR h.old_priority IS NULL OR h.old_priority IN (2,3))
     ORDER BY h.created_at DESC,h.id DESC LIMIT 1`, [customerId, qualifierId, start, until.toISOString()]);
  if (!row) return null;
  return { historyId: row.id, kind: row.source === "qualifier_form" ? "first_call" : "upgrade", at: row.created_at, closerSalespersonId: row.new_salesperson_id ?? null, actorUserId: row.actor_user_id ?? null };
}

// ---------------------------------------------------------------- purchase posting
/**
 * Called inside completeGoodsPurchase's transaction (registrar final approval).
 * Returns "legacy" when the model does not apply (caller keeps the existing behaviour, untouched),
 * "deferred" when the purchase waits for its payment order to be paid, or "posted".
 */
export function onGoodsPurchaseCompletion(p: any, actorId: number, at: Date = new Date()): "legacy" | "deferred" | "posted" {
  ensureTeamCommissionSchema();
  const v = settingsAt(at);
  const s = v.settings;
  if (!s.enabled || at < jalaliDateStart(s.modelStartDate) || p.salesperson_id == null) return "legacy";
  if (!teamMembers().all.includes(Number(p.salesperson_id))) return "legacy";
  if (!p.commission_settings_json) throw new Error("salesperson_commission_configuration_required");
  execute(`INSERT OR IGNORE INTO team_commission_purchases(purchase_id,customer_id,salesperson_id,status,settings_version_id,settings_json,basis,posting_moment,entered_at)
    VALUES(?,?,?,'pending_payout',?,?,?,?,?)`, [p.id, p.customer_id, p.salesperson_id, v.versionId, JSON.stringify(s), s.basis, s.postingMoment, at.toISOString()]);
  executeChanges("UPDATE goods_purchases SET stage='completed',completed_at=? WHERE id=?", [at.toISOString(), p.id]);
  if (s.postingMoment === "final_approval") { postPurchaseCommission(p.id, actorId, at); return "posted"; }
  // Payment order already marked «پرداخت‌شده» before final approval: the posting moment has passed, post now.
  if (queryRow<any>("SELECT 1 x FROM customer_payment_orders WHERE purchase_id=? AND stage='paid'", [p.id])) { postPurchaseCommission(p.id, actorId, at); return "posted"; }
  return "deferred";
}

/** Called inside the payment-order «پرداخت‌شده» transaction. Never throws (a failure must not block the payment record). */
export function onPaymentOrderPaid(purchaseId: number, actorId: number, at: Date = new Date()): { posted: boolean; error?: string } {
  ensureTeamCommissionSchema();
  const st = queryRow<any>("SELECT status,posting_moment FROM team_commission_purchases WHERE purchase_id=?", [purchaseId]);
  if (!st || st.status !== "pending_payout") return { posted: false };
  crmDb.exec("SAVEPOINT team_commission_post");
  try {
    postPurchaseCommission(purchaseId, actorId, at);
    crmDb.exec("RELEASE team_commission_post");
    return { posted: true };
  } catch (e) {
    crmDb.exec("ROLLBACK TO team_commission_post");
    crmDb.exec("RELEASE team_commission_post");
    const msg = e instanceof Error ? e.message : "post_failed";
    executeChanges("UPDATE team_commission_purchases SET last_error=? WHERE purchase_id=?", [msg.slice(0, 300), purchaseId]);
    return { posted: false, error: msg };
  }
}

/** Posts the closer tier commission (+ qualifier P1 share). Idempotent. Must run inside a transaction. */
export function postPurchaseCommission(purchaseId: number, actorId: number | null, at: Date = new Date()): any {
  const st = queryRow<any>("SELECT * FROM team_commission_purchases WHERE purchase_id=?", [purchaseId]);
  if (!st) throw new Error("team_commission_not_applicable");
  if (st.status !== "pending_payout") return st;
  const p = queryRow<any>("SELECT * FROM goods_purchases WHERE id=?", [purchaseId]);
  if (!p) throw new Error("goods_purchase_not_found");
  const s: TeamCommissionSettings = parseSettings(st.settings_json);
  const config = JSON.parse(p.commission_settings_json);
  const basisAmount = big(s.basis === "deposit" ? p.payout_amount_toman : (p.base_payout_amount_toman ?? p.payout_amount_toman));
  const month = persianMonthOf(at);
  // Closer tier: month total over this salesperson's posted purchases (model rows use their stored basis; legacy rows their base payout).
  const prior = queryRows<any>(
    `SELECT COALESCE(t.basis_amount_toman,g.base_payout_amount_toman,g.payout_amount_toman) amt FROM goods_purchases g
     LEFT JOIN team_commission_purchases t ON t.purchase_id=g.id
     WHERE g.salesperson_id=? AND g.stage='completed' AND g.commission_month=? AND g.commission_toman IS NOT NULL AND g.id<>?
       AND (t.status IS NULL OR t.status<>'reversed')`,
    [p.salesperson_id, month, p.id]).reduce((sum, r) => sum + big(r.amt), 0n);
  const sales = prior + basisAmount;
  const tier = sales >= big(config.target3_toman) ? 3 : sales >= big(config.target2_toman) ? 2 : sales >= big(config.target1_toman) ? 1 : 0;
  const rate = Number(config[`rate${tier}_bps`]);
  const commission = pct(basisAmount, rate);
  const versionId = st.settings_version_id;
  postLedger({ purchaseId: p.id, planId: p.plan_id, customerId: p.customer_id, salespersonId: p.salesperson_id, kind: "salesperson_commission", amount: commission,
    key: `goods:${p.id}:salesperson_commission`, actorId, month, versionId, meta: { model: "team", basis: s.basis, basisAmountToman: basisAmount.toString(), tier, rateBps: rate, postSaleTotalToman: sales.toString() } });
  silently(() => executeChanges("UPDATE goods_purchases SET commission_bps=?,commission_toman=?,commission_month=? WHERE id=?", [rate, commission.toString(), month, p.id]));
  // Qualifier P1 share: only on closer sales, exactly one of first-call / upgrade, outside the qualifier's tier total, nothing deducted from the closer.
  const { qualifierId, closerIds } = teamMembers();
  let p1: P1Event | null = null, shareBps: number | null = null, share: bigint | null = null;
  if (closerIds.includes(Number(p.salesperson_id))) {
    p1 = qualifierP1Event(p.customer_id, s, at);
    if (p1) {
      shareBps = p1.kind === "first_call" ? s.p1FirstCallBps : s.p1UpgradeBps;
      share = pct(basisAmount, shareBps);
      postLedger({ purchaseId: p.id, planId: p.plan_id, customerId: p.customer_id, salespersonId: qualifierId, kind: "p1_referral_share", amount: share,
        key: `goods:${p.id}:p1_referral_share`, actorId, month, versionId, meta: { p1Kind: p1.kind, historyId: p1.historyId, rateBps: shareBps, basisAmountToman: basisAmount.toString(), closerSalespersonId: p.salesperson_id } });
    }
  }
  executeChanges(`UPDATE team_commission_purchases SET status='posted',basis_amount_toman=?,commission_month=?,closer_rate_bps=?,closer_commission_toman=?,
    qualifier_salesperson_id=?,p1_history_id=?,p1_kind=?,p1_share_bps=?,p1_share_toman=?,posted_at=?,last_error=NULL WHERE purchase_id=?`,
    [basisAmount.toString(), month, rate, commission.toString(), p1 ? qualifierId : null, p1?.historyId ?? null, p1?.kind ?? null, shareBps, share?.toString() ?? null, at.toISOString(), p.id]);
  silently(() => execute("INSERT INTO goods_purchase_events(purchase_id,action,actor_user_id,detail,created_at) VALUES(?,?,?,?,?)",
    [p.id, "team_commission_posted", actorId, JSON.stringify({ month, basis: s.basis, basisAmountToman: basisAmount.toString(), rateBps: rate, commissionToman: commission.toString(), p1Kind: p1?.kind ?? null, p1ShareToman: share?.toString() ?? null, settingsVersionId: versionId }), at.toISOString()]));
  return queryRow<any>("SELECT * FROM team_commission_purchases WHERE purchase_id=?", [purchaseId]);
}

/** Admin retry for a paid order whose posting failed (e.g. missing tier config). */
export function retryPurchasePosting(purchaseId: number, actorId: number) {
  ensureTeamCommissionSchema();
  return runImmediateTransaction(() => {
    const st = queryRow<any>("SELECT status FROM team_commission_purchases WHERE purchase_id=?", [purchaseId]);
    if (!st) throw new TeamCommissionError(404, "این خرید در مدل فروش تیمی نیست.");
    if (st.status !== "pending_payout") return queryRow<any>("SELECT * FROM team_commission_purchases WHERE purchase_id=?", [purchaseId]);
    const st2 = queryRow<any>("SELECT posting_moment FROM team_commission_purchases WHERE purchase_id=?", [purchaseId]);
    if (st2.posting_moment === "payment_paid" && !queryRow("SELECT 1 FROM customer_payment_orders WHERE purchase_id=? AND stage='paid'", [purchaseId]))
      throw new TeamCommissionError(409, "دستور پرداخت این خرید هنوز «پرداخت‌شده» نیست.");
    return postPurchaseCommission(purchaseId, actorId);
  });
}

/**
 * Case cancelled/returned after payout: every percentage commission posted for it (closer + qualifier share) is deducted
 * in the NEXT Persian month as `returned_case_deduction` (negative). The data-accuracy bonus is never deducted. Idempotent.
 */
export function reversePurchaseCommission(purchaseId: number, actorId: number, reason: string, at: Date = new Date()) {
  ensureTeamCommissionSchema();
  const why = String(reason ?? "").trim();
  if (why.length < 5) throw new TeamCommissionError(400, "دلیل برگشت را بنویس (حداقل ۵ حرف).", { reason: "دلیل برگشت را بنویس (حداقل ۵ حرف)." });
  return runImmediateTransaction(() => {
    const st = queryRow<any>("SELECT * FROM team_commission_purchases WHERE purchase_id=?", [purchaseId]);
    if (!st) throw new TeamCommissionError(404, "این خرید در مدل فروش تیمی نیست.");
    if (st.status === "reversed") return { alreadyReversed: true, state: st };
    if (st.status !== "posted") throw new TeamCommissionError(409, "پورسانت این خرید هنوز ثبت نشده است؛ چیزی برای کسر نیست.");
    const month = nextPersianMonth(persianMonthOf(at));
    const entries = queryRows<any>("SELECT * FROM goods_finance_ledger WHERE purchase_id=? AND kind IN ('salesperson_commission','p1_referral_share') AND CAST(amount_toman AS INTEGER)>0", [purchaseId]);
    for (const e of entries) {
      postLedger({ purchaseId, planId: e.plan_id, customerId: e.customer_id, salespersonId: e.salesperson_id, kind: "returned_case_deduction", amount: -big(e.amount_toman),
        key: `goods:${purchaseId}:returned_case_deduction:${e.kind}`, actorId, month, versionId: st.settings_version_id, meta: { reversedLedgerId: e.id, reversedKind: e.kind, reason: why } });
    }
    executeChanges("UPDATE team_commission_purchases SET status='reversed',reversed_at=?,reversal_month=?,reversal_reason=?,reversed_by=? WHERE purchase_id=?", [at.toISOString(), month, why, actorId, purchaseId]);
    silently(() => execute("INSERT INTO goods_purchase_events(purchase_id,action,actor_user_id,detail,created_at) VALUES(?,?,?,?,?)",
      [purchaseId, "team_commission_reversed", actorId, JSON.stringify({ month, reason: why, entries: entries.length }), at.toISOString()]));
    return { alreadyReversed: false, deductionMonth: month, entries: entries.length };
  });
}

// ---------------------------------------------------------------- data accuracy («درستی اطلاعات تماس اول»)
export const ACCURACY_REASONS = ["unreported_bounced_cheque", "unreported_document", "other"] as const;
export type AccuracyReason = typeof ACCURACY_REASONS[number];
export const REASON_LABELS: Record<AccuracyReason, string> = { unreported_bounced_cheque: "چک برگشتی اعلام‌نشده", unreported_document: "مدرک اعلام‌نشده", other: "سایر" };
type Actor = { id: number; role: string; salespersonId?: number | null; fullName?: string | null };
const spName = (id: number | null | undefined) => id == null ? null : queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [id])?.name ?? null;

function reviewView(r: any) {
  if (!r) return null;
  return { id: r.id, correct: r.correct === 1, reason: r.reason, reasonLabel: r.reason ? REASON_LABELS[r.reason as AccuracyReason] ?? r.reason : null, note: r.note,
    bonusToman: r.bonus_toman, revision: r.revision, reviewedAt: r.reviewed_at, reviewedByName: queryRow<any>("SELECT full_name FROM users WHERE id=?", [r.reviewed_by])?.full_name ?? null,
    updatedAt: r.updated_at ?? null };
}
export function dataAccuracyState(customerId: number, actor: Actor) {
  ensureTeamCommissionSchema();
  const v = settingsAt();
  const c = queryRow<any>("SELECT id,name,salesperson_id FROM customers WHERE id=?", [customerId]);
  if (!c) throw new TeamCommissionError(404, "مشتری پیدا نشد.");
  const isAdmin = actor.role === "admin";
  const { qualifierId, closerIds } = teamMembers();
  const owner = c.salesperson_id != null && actor.salespersonId === c.salesperson_id;
  if (!isAdmin && !owner && actor.salespersonId !== qualifierId) throw new TeamCommissionError(403, "دسترسی ندارید.");
  const hidden = { visible: false as const };
  if (!v.settings.enabled) return hidden;
  const p1 = qualifierP1Event(customerId, v.settings);
  if (!p1) return hidden;
  const review = queryRow<any>("SELECT * FROM team_data_accuracy_reviews WHERE priority_history_id=?", [p1.historyId]);
  const closerId = c.salesperson_id != null && closerIds.includes(c.salesperson_id) ? c.salesperson_id : null;
  return {
    visible: true as const,
    customerId, customerName: c.name,
    p1: { historyId: p1.historyId, kind: p1.kind, at: p1.at, qualifierName: spName(qualifierId), closerName: spName(p1.closerSalespersonId) },
    closerSalespersonId: closerId, closerName: spName(closerId),
    bonusToman: review ? review.bonus_toman !== "0" ? review.bonus_toman : v.settings.dataAccuracyBonusToman : v.settings.dataAccuracyBonusToman,
    status: review ? (review.correct === 1 ? "correct" : "incorrect") : "pending",
    review: reviewView(review),
    canReview: !review && closerId != null && owner && actor.salespersonId === closerId,
    canOverride: isAdmin && closerId != null,
    viewer: isAdmin ? "admin" : owner ? "closer" : actor.salespersonId === qualifierId ? "qualifier" : "other",
    reasons: ACCURACY_REASONS.map(k => ({ key: k, label: REASON_LABELS[k] })),
  };
}

/** One transaction: review record + ledger + wallet + timeline history. Idempotent. Only the case's closer, once; admin may change later. */
export function recordDataAccuracy(customerId: number, actor: Actor, body: any) {
  ensureTeamCommissionSchema();
  const correct = body?.correct;
  if (typeof correct !== "boolean") throw new TeamCommissionError(400, "مقدار «درست بود / نبود» لازم است.", { correct: "لازم است." });
  let reason: AccuracyReason | null = null;
  const note = String(body?.note ?? "").trim().slice(0, 2000) || null;
  if (!correct) {
    if (!ACCURACY_REASONS.includes(body?.reason)) throw new TeamCommissionError(400, "یک دلیل انتخاب کن.", { reason: "یک دلیل انتخاب کن." });
    reason = body.reason;
    if (reason === "other" && (note ?? "").replace(/\s+/g, "").length < 10) throw new TeamCommissionError(400, "برای «سایر» توضیح لازم است (حداقل ۱۰ حرف).", { note: "برای «سایر» توضیح لازم است (حداقل ۱۰ حرف)." });
  }
  return runImmediateTransaction(() => {
    const v = settingsAt();
    if (!v.settings.enabled) throw new TeamCommissionError(409, "مدل فروش تیمی خاموش است.");
    const c = queryRow<any>("SELECT id,name,salesperson_id FROM customers WHERE id=?", [customerId]);
    if (!c) throw new TeamCommissionError(404, "مشتری پیدا نشد.");
    const { qualifierId, closerIds } = teamMembers();
    const isAdmin = actor.role === "admin";
    const closerId = c.salesperson_id != null && closerIds.includes(c.salesperson_id) ? c.salesperson_id : null;
    if (closerId == null) throw new TeamCommissionError(409, "این پرونده کارشناس پیگیری ندارد.");
    const isCloser = actor.salespersonId === closerId;
    if (!isAdmin && !isCloser) throw new TeamCommissionError(403, "فقط کارشناس پیگیری همین پرونده می‌تواند این را ثبت کند.");
    const p1 = qualifierP1Event(customerId, v.settings);
    if (!p1) throw new TeamCommissionError(409, "این پرونده معرفی اولویت ۱ از کارشناس تماس اول ندارد.");
    const existing = queryRow<any>("SELECT * FROM team_data_accuracy_reviews WHERE priority_history_id=?", [p1.historyId]);
    const at = nowIso();
    const actorName = queryRow<any>("SELECT full_name FROM users WHERE id=?", [actor.id])?.full_name ?? spName(actor.salespersonId ?? null) ?? "کاربر";
    const month = persianMonthOf(new Date(at));
    const same = existing && (existing.correct === 1) === correct && (correct || existing.reason === reason);
    if (existing && same) return { idempotent: true, state: dataAccuracyState(customerId, actor) };
    if (existing && !isAdmin) throw new TeamCommissionError(409, "قبلاً ثبت شده؛ فقط مدیر می‌تواند تغییرش دهد.");
    let reviewId: number, revision = 1, bonus = 0n, bonusDelta = 0n;
    if (!existing) {
      bonus = correct ? big(v.settings.dataAccuracyBonusToman) : 0n;
      bonusDelta = bonus;
      reviewId = execute(`INSERT INTO team_data_accuracy_reviews(priority_history_id,customer_id,qualifier_salesperson_id,closer_salesperson_id,p1_kind,correct,reason,note,bonus_toman,settings_version_id,revision,reviewed_by,reviewed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`, [p1.historyId, customerId, qualifierId, closerId, p1.kind, correct ? 1 : 0, reason, note, bonus.toString(), v.versionId, actor.id, at]);
    } else {
      // Admin override: revision + compensating ledger entry; the original bonus row is never edited.
      revision = existing.revision + 1; reviewId = existing.id;
      const prevBonus = big(existing.bonus_toman);
      bonus = correct ? (prevBonus > 0n ? prevBonus : big(v.settings.dataAccuracyBonusToman)) : 0n;
      bonusDelta = bonus - prevBonus;
      executeChanges("UPDATE team_data_accuracy_reviews SET correct=?,reason=?,note=?,bonus_toman=?,revision=?,updated_by=?,updated_at=? WHERE id=?",
        [correct ? 1 : 0, reason, note, bonus.toString(), revision, actor.id, at, reviewId]);
    }
    if (bonusDelta !== 0n) {
      postLedger({ purchaseId: null, planId: null, customerId, salespersonId: existing ? existing.qualifier_salesperson_id : qualifierId, kind: "data_accuracy_bonus", amount: bonusDelta,
        key: `accuracy:${p1.historyId}:rev${revision}`, actorId: actor.id, month, versionId: v.versionId, meta: { reviewId, revision, p1Kind: p1.kind, correct, closerSalespersonId: closerId } });
    }
    // Timeline (customer history) row; its bell trigger row is removed — no staff notification.
    const qualName = spName(qualifierId) ?? "کارشناس تماس اول";
    const subject = correct ? "اطلاعات تماس اول درست بود" : "اطلاعات تماس اول درست نبود";
    const lines = [
      existing ? `تغییر توسط مدیر (${actorName}) — بازبینی ${revision}` : null,
      correct ? `پاداش درستی داده: ${bonus.toString()} تومان برای ${qualName}` : `دلیل: ${REASON_LABELS[reason!]}${note ? ` — «${note}»` : ""} · پاداش تعلق نگرفت`,
      correct && note ? `توضیح: ${note}` : null,
    ].filter(Boolean).join("\n");
    silently(() => execute(`INSERT INTO call_logs (customer_id, salesperson_id, subject, customer_request, expert_notes, created_at, salesperson_name_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [customerId, actor.salespersonId ?? null, subject, null, lines, at, actorName]));
    return { idempotent: false, state: dataAccuracyState(customerId, actor) };
  });
}

// ---------------------------------------------------------------- monthly team bonus (default OFF)
export function teamSalesForMonth(month: string): bigint {
  ensureTeamCommissionSchema();
  const { all } = teamMembers();
  if (!all.length) return 0n;
  return queryRows<any>(`SELECT basis_amount_toman FROM team_commission_purchases WHERE commission_month=? AND status IN ('posted','reversed') AND salesperson_id IN (${all.map(() => "?").join(",")})`, [month, ...all])
    .reduce((s, r) => s + big(r.basis_amount_toman ?? "0"), 0n);
}
/** Pure: monthly team bonus for a team-sales total under one settings version (floor toman at each step). */
export function teamBonusAmounts(total: bigint, s: TeamCommissionSettings) {
  const threshold = big(s.teamBonusThresholdToman);
  const base = total > threshold ? (s.teamBonusBasis === "total" ? total : total - threshold) : 0n;
  const bonus = pct(base, s.teamBonusBps);
  const shares = bonus > 0n ? Object.entries(s.teamSplitBps).map(([sp, bps]) => ({ salespersonId: Number(sp), bps, amountToman: pct(bonus, bps).toString() })) : [];
  return { threshold, base, bonus, shares };
}
/** Idempotent per month. Runs only when the model AND the team bonus are enabled in the version effective at month end. */
export function runTeamBonus(month: string, actorId: number | null, now: Date = new Date()) {
  ensureTeamCommissionSchema();
  if (!/^\d{4}-\d{2}$/.test(month)) throw new TeamCommissionError(400, "ماه نامعتبر است.");
  if (now <= monthEnd(month)) throw new TeamCommissionError(409, "این ماه هنوز تمام نشده است.");
  return runImmediateTransaction(() => {
    const done = queryRow<any>("SELECT * FROM team_bonus_runs WHERE month=?", [month]);
    if (done) return { ran: false, reason: "already_ran", run: { ...done, detail: JSON.parse(done.detail_json) } };
    const v = settingsAt(monthEnd(month));
    const s = v.settings;
    if (!s.enabled || !s.teamBonusEnabled) return { ran: false, reason: "disabled" };
    if (monthEnd(month) < jalaliDateStart(s.modelStartDate)) return { ran: false, reason: "before_model_start" };
    const total = teamSalesForMonth(month);
    const { threshold, bonus, shares } = teamBonusAmounts(total, s);
    if (bonus > 0n) {
      for (const { salespersonId: sp, bps, amountToman } of shares) {
        const amount = BigInt(amountToman);
        if (amount > 0n) postLedger({ purchaseId: null, planId: null, customerId: null, salespersonId: Number(sp), kind: "team_bonus", amount, key: `team_bonus:${month}:${sp}`, actorId, month, versionId: v.versionId,
          meta: { teamSalesToman: total.toString(), thresholdToman: threshold.toString(), basis: s.teamBonusBasis, rateBps: s.teamBonusBps, splitBps: bps } });
      }
    }
    const detail = { teamSalesToman: total.toString(), thresholdToman: threshold.toString(), basis: s.teamBonusBasis, rateBps: s.teamBonusBps, shares };
    execute("INSERT INTO team_bonus_runs(month,settings_version_id,team_sales_toman,bonus_toman,detail_json,run_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [month, v.versionId, total.toString(), bonus.toString(), JSON.stringify(detail), actorId, nowIso()]);
    return { ran: true, month, bonusToman: bonus.toString(), ...detail };
  });
}
let teamBonusTimer: NodeJS.Timeout | null = null;
/** Hourly: if enabled, settle the previous Persian month once. Inert while the model or the team bonus is OFF. */
export function startTeamBonusScheduler(): void {
  if (teamBonusTimer) return;
  const tick = () => {
    try {
      const s = settingsAt().settings;
      if (!s.enabled || !s.teamBonusEnabled) return;
      const prev = previousPersianMonth(persianMonthOf(new Date()));
      runTeamBonus(prev, null);
    } catch (e) { console.warn("team bonus job skipped:", e instanceof Error ? e.message : e); }
  };
  teamBonusTimer = setInterval(tick, 60 * 60 * 1000);
  teamBonusTimer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}

// ---------------------------------------------------------------- report
export const COMMISSION_KINDS = ["salesperson_commission", "p1_referral_share", "data_accuracy_bonus", "returned_case_deduction", "team_bonus"] as const;
/** Month of a ledger row: model rows carry it in meta; legacy salesperson_commission rows use the purchase's commission_month. */
const MONTH_SQL = "COALESCE(m.commission_month,g.commission_month,'')";
export function salespersonBreakdown(salespersonId: number, month: string, kind: string | null) {
  ensureTeamCommissionSchema();
  const kinds = COMMISSION_KINDS as readonly string[];
  const rows = queryRows<any>(`SELECT l.kind,COUNT(*) n,GROUP_CONCAT(l.amount_toman) amounts FROM goods_finance_ledger l
    LEFT JOIN team_commission_ledger_meta m ON m.ledger_id=l.id LEFT JOIN goods_purchases g ON g.id=l.purchase_id
    WHERE l.salesperson_id=? AND l.kind IN (${kinds.map(() => "?").join(",")}) AND ${MONTH_SQL}=? GROUP BY l.kind`, [salespersonId, ...kinds, month]);
  const byKind = new Map(rows.map(r => [r.kind, { count: Number(r.n), totalToman: String(r.amounts ?? "").split(",").filter(Boolean).reduce((s: bigint, a: string) => s + big(a), 0n).toString() }]));
  const breakdown = kinds.map(k => ({ kind: k, count: byKind.get(k)?.count ?? 0, totalToman: byKind.get(k)?.totalToman ?? "0" }));
  const monthTotalToman = breakdown.reduce((s, r) => s + big(r.totalToman), 0n).toString();
  const p1Counts = queryRow<any>(`SELECT SUM(CASE WHEN json_extract(m.meta_json,'$.p1Kind')='first_call' THEN 1 ELSE 0 END) fc, SUM(CASE WHEN json_extract(m.meta_json,'$.p1Kind')='upgrade' THEN 1 ELSE 0 END) up
    FROM team_commission_ledger_meta m WHERE m.salesperson_id=? AND m.kind='p1_referral_share' AND m.commission_month=?`, [salespersonId, month]);
  const start = monthStart(month).toISOString(), end = monthStart(nextPersianMonth(month)).toISOString();
  const accuracy = queryRow<any>(`SELECT COUNT(*) n, SUM(correct) ok FROM team_data_accuracy_reviews WHERE qualifier_salesperson_id=? AND reviewed_at>=? AND reviewed_at<?`, [salespersonId, start, end]);
  const handoffs = queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_priority_history'")
    ? Number(queryRow<any>(`SELECT COUNT(*) n FROM customer_priority_history WHERE new_salesperson_id=? AND new_priority=1 AND source IN ('qualifier_form','promote') AND created_at>=? AND created_at<?`, [salespersonId, start, end])?.n ?? 0) : 0;
  const reversedCases = Number(queryRow<any>("SELECT COUNT(DISTINCT l.purchase_id) n FROM goods_finance_ledger l JOIN team_commission_ledger_meta m ON m.ledger_id=l.id WHERE l.salesperson_id=? AND l.kind='returned_case_deduction' AND m.commission_month=?", [salespersonId, month])?.n ?? 0);
  const where = kind && kinds.includes(kind) ? "AND l.kind=?" : "";
  const transactions = queryRows<any>(`SELECT l.id,l.purchase_id purchaseId,l.amount_toman amountToman,l.kind,l.created_at createdAt,${MONTH_SQL} month,
      c.name customerName,m.meta_json metaJson,m.settings_version_id settingsVersionId
    FROM goods_finance_ledger l LEFT JOIN team_commission_ledger_meta m ON m.ledger_id=l.id LEFT JOIN goods_purchases g ON g.id=l.purchase_id
    LEFT JOIN customers c ON c.id=l.customer_id
    WHERE l.salesperson_id=? AND l.kind IN (${kinds.map(() => "?").join(",")}) ${where} ORDER BY l.id DESC LIMIT 500`, [salespersonId, ...kinds, ...(where ? [kind] : [])])
    .map(({ metaJson, ...t }) => ({ ...t, meta: metaJson ? JSON.parse(metaJson) : null }));
  return {
    breakdown, monthTotalToman, transactions,
    stats: {
      p1FirstCall: Number(p1Counts?.fc ?? 0), p1Upgrade: Number(p1Counts?.up ?? 0),
      accuracyReviewed: Number(accuracy?.n ?? 0), accuracyCorrect: Number(accuracy?.ok ?? 0),
      p1Received: handoffs, reversedCases,
    },
  };
}
