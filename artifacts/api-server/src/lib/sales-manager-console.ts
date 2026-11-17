/**
 * «مدیریت تیم فروش» v1.1 (sales-manager-console), flag.sales_manager_console_v1 (global, default OFF; when ON, admin-role users only — t815s2681).
 * Mohammad t349u/t350u/t351u/t352u; design: Armita sales-manager-console v1.1 (HANDOFF.md, spec.md).
 *
 * Storage is additive only: every table is new (smc_*), created lazily on first use while the flag is ON.
 *  - smc_settings(section): one versioned JSON document per section (teams, daily blocks, access, valid, model, dist, steps).
 *  - smc_draft(user, section): per-user server-side draft; smc_audit: every apply/revert with before/after (kept forever).
 *  - smc_daily_override: manager add/remove/move rows for one expert-day; smc_dist_counter / smc_dist_log for distribution.
 * Never written from here: sales_teams / sales_team_members, team_sales_config, notification_settings, users, voip_extensions,
 * contracts, loan_plans, contract templates. The console's teams are seeded read-only from the live team tables on first open.
 * Customers are written only by an applied «انتقال» with keep_customers=false (owner change, logged, reverted by «برگرداندن»).
 * User 29 is never listed, linked or counted.
 */
import type { AuthUser } from "./auth";
import { getAuthUserById } from "./auth";
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { dqBlocks, dqQueue, type DqItem, type DqKind } from "./dci-queue";

export const SMC_FLAG = "flag.sales_manager_console_v1";
export const SMC_NEVER_USER = 29;
export const SECTIONS = ["teams", "daily", "access", "valid", "model", "dist", "steps"] as const;
export type Section = (typeof SECTIONS)[number];
export const SECTION_FA: Record<Section | "audit", string> = {
  teams: "تیم‌ها", daily: "لیست روزانه", access: "دسترسی", valid: "مدت اعتبار", model: "مدل", dist: "تقسیم", steps: "مراحل", audit: "تاریخچه",
};
export const isSection = (s: unknown): s is Section => typeof s === "string" && (SECTIONS as readonly string[]).includes(s);

/* ---------------- flag, roles, digits, dates ---------------- */
export function smcFlagOn(): boolean {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [SMC_FLAG])?.value === "1"; } catch { return false; }
}
/** t815s2681: only users.role='admin'. Sales managers (effective admin), team leads, experts, and user 29 never. */
export function smcCanManage(u: AuthUser | null | undefined): boolean {
  if (!u || Number(u.id) === SMC_NEVER_USER || !u.active) return false;
  const dbRole = queryRow<{ role: string }>("SELECT role FROM users WHERE id=?", [u.id])?.role;
  return dbRole === "admin";
}
const FA = "۰۱۲۳۴۵۶۷۸۹";
export const fa = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FA[Number(d)]!);
export const toLatin = (v: unknown) => String(v ?? "").replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const TZ = "Asia/Tehran";
const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("fa-IR", { timeZone: TZ, ...o }).format(d);
export const jDay = (d: Date) => `${fmt(d, { weekday: "long" })} ${fmt(d, { day: "numeric" })} ${fmt(d, { month: "long" })}`;
export const jDate = (d: Date) => `${fmt(d, { day: "numeric" })} ${fmt(d, { month: "long" })}`;
export const jFull = (d: Date) => `${jDay(d)} ${fmt(d, { year: "numeric" })}`;
export const jTime = (d: Date) => fmt(d, { hour: "2-digit", minute: "2-digit", hour12: false });
export function ymdTehran(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00+03:30`));
export const noon = (ymd: string) => new Date(`${ymd}T12:00:00+03:30`);
export function addDays(ymd: string, n: number): string { return ymdTehran(new Date(noon(ymd).getTime() + n * 86_400_000)); }
export function relWhen(iso: string, now = new Date()): string {
  const d = new Date(iso); if (!Number.isFinite(d.getTime())) return "";
  const a = ymdTehran(d), t = ymdTehran(now);
  const day = a === t ? "امروز" : a === addDays(t, -1) ? "دیروز" : jDate(d);
  return `${day} ${jTime(d)}`;
}
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const hmFa = (m: number) => fa(m % 60 ? hm(m) : String(Math.floor(m / 60)));

/* ---------------- schema ---------------- */
let schemaReady = false;
export function ensureSmcSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS smc_settings(section TEXT PRIMARY KEY, payload_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS smc_draft(user_id INTEGER NOT NULL, section TEXT NOT NULL, payload_json TEXT NOT NULL, base_version INTEGER NOT NULL,
      changes INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, section));
    CREATE TABLE IF NOT EXISTS smc_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER NOT NULL, section TEXT NOT NULL,
      summary_fa TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, effects_json TEXT, revert_of INTEGER);
    CREATE INDEX IF NOT EXISTS idx_smc_audit_section ON smc_audit(section, id);
    CREATE TABLE IF NOT EXISTS smc_daily_override(id INTEGER PRIMARY KEY AUTOINCREMENT, expert_id TEXT NOT NULL, day TEXT NOT NULL,
      customer_id INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('add','remove','move')), block_idx INTEGER, sort REAL, at_time TEXT,
      by_user_id INTEGER NOT NULL, created_at TEXT NOT NULL, undone_at TEXT, audit_id INTEGER);
    CREATE INDEX IF NOT EXISTS idx_smc_override_day ON smc_daily_override(expert_id, day);
    CREATE TABLE IF NOT EXISTS smc_dist_counter(rule_key TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS smc_dist_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, customer_id INTEGER NOT NULL, team_id TEXT,
      expert_id TEXT, team_rule INTEGER, member_rule INTEGER, reason_fa TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'lead');
  `);
  schemaReady = true;
}

/* ---------------- section documents ---------------- */
export type Block = { from: number; to: number; k: "actual" | "potential" | "any" };
export type Expert = {
  id: string; displayName: string; extension: string | null; role: "expert" | "lead"; status: "active" | "leave" | "inactive";
  leaveUntil: string | null; userId: number | null; salespersonId: number | null; teamId: string | null;
};
export type Team = { id: string; name: string; leadExpertId: string | null; deleted?: boolean };
export type Move = { expertId: string; from: string | null; to: string; keepCustomers: boolean };
export type TeamsDoc = { teams: Team[]; experts: Expert[]; moves?: Move[] };
export type DailyOp = { op: "add" | "remove" | "move" | "restore"; expertId: string; date: string; customerId: number; blockIdx?: number; sort?: number; atTime?: string | null; toDate?: string | null; ref?: number };
export type DailyDoc = { blocks: { global: Block[] | null; team: Record<string, Block[]>; expert: Record<string, Block[]> }; ops?: DailyOp[] };
export type Level = "locked" | "own" | "team" | "all";
export type AccessDoc = { policies: Record<string, { customers: Level; loan_files: Level }> };
export type Validity = { mode: "forever" | "hours"; hours: number };
export type ValidDoc = { identity: Validity; credit: Validity; appliedAt?: { identity: string | null; credit: string | null } };
export type Rule = { id: string; subject: string; op: string; value: unknown; outcome: string; outcomeValue?: unknown };
export type Model = {
  id: string; name: string; capacity: number; mix: { followup: number; lead: number; actual: number; cold: number };
  rules: Rule[]; weights: Record<string, number>; retryHours: number; useTeamBlocks: boolean;
  assign: { scope: "expert" | "team"; id: string }[];
};
export type ModelDoc = { models: Model[] };
export type Cond = { field: string; values: string[] };
export type Method = { method: "direct" | "ratio" | "percent" | "round_robin" | "capacity"; targets: { id: string; weight?: number }[] };
export type DistRule = { id: string; conds: Cond[] } & Method;
export type DistDoc = {
  team: { rules: DistRule[]; fallback: Method };
  member: Record<string, { rules: DistRule[]; fallback: Method }>;
  caps: Record<string, { percent: number; dailyCap: number }>;
};
export type Stage = { key: string; label: string; phase: number; turn: "us" | "customer"; enabled: boolean; optional: boolean; docs: string[]; custom?: boolean };
export type StepsDoc = { plans: Record<string, Stage[] | null> };
export type Docs = { teams: TeamsDoc; daily: DailyDoc; access: AccessDoc; valid: ValidDoc; model: ModelDoc; dist: DistDoc; steps: StepsDoc };

/* ---------------- defaults (§6 1–19, all approved: t352u) ---------------- */
/** §6-13: surname only, no «خانم/آقای», until Mohammad gives full names. */
const SURNAME_ONLY: Record<number, string> = { 5: "اصلانیان", 20: "خردکار" };
const TEAM1_TITLES: Record<number, string> = { 3: "خانم حسنی", 4: "خانم قاسمی", 6: "آقای کاظمی" };

export const SYSTEM_STAGES: Stage[] = ([
  ["draft", "تکمیل قرارداد توسط کارشناس", 1, "us"], ["primary_contract_pending_signature", "امضای قرارداد اولیه", 1, "customer"],
  ["customer_documents_upload", "بارگذاری مدارک", 2, "customer"], ["customer_documents_review", "بررسی مدارک", 2, "us"],
  ["guarantor_registration", "ثبت ضامن", 2, "customer"], ["guarantor_documents_upload", "بارگذاری مدارک ضامن", 2, "customer"],
  ["guarantor_documents_review", "بررسی مدارک ضامن", 2, "us"], ["collateral_upload", "ثبت وثیقه", 2, "customer"], ["collateral_review", "بررسی وثیقه", 2, "us"],
  ["expert_approval", "تصمیم تأمین‌کننده", 3, "us"], ["funder_initial_approval", "تصویب مبلغ وام", 3, "us"],
  ["approved_contract_pending_signature", "امضای قرارداد جایگزین", 3, "customer"],
  ["physical_documents_submission", "ارسال مدارک فیزیکی", 4, "us"], ["physical_documents_review", "بررسی مدارک فیزیکی", 4, "us"],
  ["wallet_charge_pending", "تأیید شارژ", 5, "us"], ["admin_approval", "تأیید نهایی", 5, "us"],
  ["final_invoice_pending_signature", "امضای صورت‌حساب نهایی", 5, "customer"], ["completed", "تکمیل‌شده", 5, "us"],
] as const).map(([key, label, phase, turn]) => ({ key, label, phase, turn, enabled: true, optional: false, docs: [] as string[] }));
/** §6-11: «قرارداد لازم نیست» never touches the final invoice; it has its own switch. */
export const CONTRACT_STAGES = ["draft", "primary_contract_pending_signature", "approved_contract_pending_signature"];
export const GUARANTOR_STAGES = ["guarantor_registration", "guarantor_documents_upload", "guarantor_documents_review"];
export const COLLATERAL_STAGES = ["collateral_upload", "collateral_review"];

function seedTeams(): TeamsDoc {
  const teams: Team[] = []; const experts: Expert[] = [];
  let rows: { team_id: number; salesperson_id: number | null; is_lead: number | null }[] = [];
  try {
    rows = queryRows(`SELECT t.id team_id, m.salesperson_id, m.is_lead FROM sales_teams t
      LEFT JOIN sales_team_members m ON m.team_id=t.id WHERE t.enabled=1 ORDER BY t.id, m.sort_order`);
  } catch { rows = []; }
  const seen = new Set<number>();
  for (const r of rows) {
    const tid = `t${r.team_id}`;
    if (!teams.some((t) => t.id === tid)) teams.push({ id: tid, name: `تیم ${fa(teams.length + 1)}`, leadExpertId: null });
    if (r.salesperson_id == null || seen.has(Number(r.salesperson_id))) continue;
    const sp = Number(r.salesperson_id); seen.add(sp);
    const u = queryRow<{ id: number | null; name: string | null }>(
      `SELECT u.id, s.name FROM salespersons s LEFT JOIN users u ON u.salesperson_id=s.id AND u.active=1 AND u.id<>${SMC_NEVER_USER}
        WHERE s.id=? ORDER BY CASE u.role WHEN 'salesperson' THEN 0 ELSE 1 END, u.id LIMIT 1`, [sp]);
    const teamIdx = teams.findIndex((t) => t.id === tid);
    // §6-18: team 2 extensions stay empty until Mohammad gives new ones; team 1 keeps its live extension (read-only copy).
    const ext = teamIdx === 0 && u?.id ? (queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [u.id])?.extension ?? null) : null;
    const id = `e${sp}`;
    experts.push({
      id, displayName: SURNAME_ONLY[sp] ?? TEAM1_TITLES[sp] ?? String(u?.name ?? `کارشناس ${fa(sp)}`).trim(),
      extension: ext ? (toLatin(ext).replace(/\D/g, "") || null) : null, role: Number(r.is_lead) === 1 ? "lead" : "expert",
      status: "active", leaveUntil: null, userId: u?.id ? Number(u.id) : null, salespersonId: sp, teamId: tid,
    });
    if (Number(r.is_lead) === 1) teams[teamIdx]!.leadExpertId = id;
  }
  return { teams, experts };
}
const seedDaily = (): DailyDoc => ({ blocks: { global: null, team: {}, expert: {} } });
function seedAccess(t: TeamsDoc): AccessDoc {
  // §3.2 + §6-17: team lead «تیمش», everyone else «فقط خودش».
  const policies: AccessDoc["policies"] = {};
  for (const e of t.experts) { const l: Level = e.role === "lead" ? "team" : "own"; policies[e.id] = { customers: l, loan_files: l }; }
  return { policies };
}
const seedValid = (): ValidDoc => ({ identity: { mode: "forever", hours: 0 }, credit: { mode: "hours", hours: 24 }, appliedAt: { identity: null, credit: null } });
export const DEFAULT_WEIGHTS = { priority: 8, idleDays: 6, creditRank: 5, leadAge: 7, amount: 3, fileStage: 4 };
function seedModels(): ModelDoc {
  // §6-12: two ready models, assigned to nobody; everyone stays on «پیش‌فرض فعلی سیستم».
  const w = DEFAULT_WEIGHTS;
  return { models: [
    { id: "m-followup", name: "پیگیری‌محور", capacity: 25, mix: { followup: 40, lead: 30, actual: 20, cold: 10 }, weights: { ...w }, retryHours: 3, useTeamBlocks: true, assign: [],
      rules: [
        { id: "r1", subject: "potential", op: "idle_days", value: 7, outcome: "include", outcomeValue: "high" },
        { id: "r2", subject: "reminder", op: "overdue", value: null, outcome: "block_start", outcomeValue: "next" },
        { id: "r3", subject: "file", op: "waiting_days_gt", value: 2, outcome: "include" },
        { id: "r4", subject: "new_lead", op: "age_hours_lt", value: 2, outcome: "block_start", outcomeValue: "same_day" },
        { id: "r5", subject: "no_answer", op: "streak", value: 3, outcome: "retry_days", outcomeValue: { days: 3, coldAfter: 5 } },
        { id: "r6", subject: "credit_rank", op: "in", value: ["A", "B"], outcome: "score", outcomeValue: 2 },
      ] },
    { id: "m-lead", name: "لیدمحور", capacity: 30, mix: { followup: 25, lead: 50, actual: 15, cold: 10 }, weights: { ...w, leadAge: 9 }, retryHours: 3, useTeamBlocks: true, assign: [],
      rules: [
        { id: "r1", subject: "new_lead", op: "age_hours_lt", value: 2, outcome: "block_start", outcomeValue: "same_day" },
        { id: "r2", subject: "reminder", op: "overdue", value: null, outcome: "block_start", outcomeValue: "next" },
      ] },
  ] };
}
function seedDist(t: TeamsDoc): DistDoc {
  const live = t.teams.filter((x) => !x.deleted);
  let shares: { team_id: number; percent: number }[] = [];
  try { shares = queryRows("SELECT team_id, percent FROM sales_intake_shares WHERE source='new_customers' ORDER BY team_id"); } catch { shares = []; }
  const pct = live.map((x) => ({ id: x.id, weight: Number(shares.find((s) => `t${s.team_id}` === x.id)?.percent ?? 0) }));
  const even = (n: number, i: number) => Math.floor(100 / Math.max(1, n)) + (i === 0 ? 100 % Math.max(1, n) : 0);
  const targets = pct.reduce((a, b) => a + b.weight, 0) === 100 ? pct : live.map((x, i) => ({ id: x.id, weight: even(live.length, i) }));
  const member: DistDoc["member"] = {}; const caps: DistDoc["caps"] = {};
  for (const x of live) {
    member[x.id] = { rules: [], fallback: { method: "capacity", targets: [] } };
    const ms = t.experts.filter((e) => e.teamId === x.id);
    ms.forEach((e, i) => { caps[e.id] = { percent: even(ms.length, i), dailyCap: 12 }; });
  }
  return { team: { rules: [], fallback: { method: live.length ? "percent" : "round_robin", targets } }, member, caps };
}
const seedSteps = (): StepsDoc => ({ plans: { default: null } });

/* ---------------- load / save ---------------- */
export type Meta = { version: number; updatedBy: number | null; updatedAt: string | null; updatedByName: string | null };
const SEED: { [K in Section]: () => Docs[K] } = {
  teams: seedTeams, daily: seedDaily, access: () => seedAccess(loadDoc("teams")), valid: seedValid, model: seedModels,
  dist: () => seedDist(loadDoc("teams")), steps: seedSteps,
};
export function loadDoc<K extends Section>(s: K): Docs[K] {
  ensureSmcSchema();
  const r = queryRow<{ payload_json: string }>("SELECT payload_json FROM smc_settings WHERE section=?", [s]);
  if (r) { try { return JSON.parse(r.payload_json) as Docs[K]; } catch { /* fall through to the seed */ } }
  const seeded = SEED[s]() as Docs[K];
  execute("INSERT OR IGNORE INTO smc_settings(section,payload_json,version,updated_by,updated_at) VALUES(?,?,0,NULL,?)", [s, JSON.stringify(seeded), new Date().toISOString()]);
  return seeded;
}
export function roleName(userId: number): string {
  const u = queryRow<{ role: string }>("SELECT role FROM users WHERE id=?", [userId]);
  return u?.role === "sales_manager" ? "مدیر فروش" : "ادمین";
}
export function metaOf(s: Section): Meta {
  loadDoc(s);
  const r = queryRow<{ version: number; updated_by: number | null; updated_at: string }>("SELECT version, updated_by, updated_at FROM smc_settings WHERE section=?", [s]);
  const v = Number(r?.version ?? 0);
  return { version: v, updatedBy: r?.updated_by ?? null, updatedAt: v > 0 ? r!.updated_at : null, updatedByName: v > 0 && r?.updated_by ? roleName(Number(r.updated_by)) : null };
}
function saveDoc(s: Section, doc: unknown, userId: number, at: string): number {
  const v = metaOf(s).version + 1;
  execute("UPDATE smc_settings SET payload_json=?, version=?, updated_by=?, updated_at=? WHERE section=?", [JSON.stringify(doc), v, userId, at, s]);
  return v;
}

/* ---------------- people ---------------- */
export const liveTeams = (t: TeamsDoc) => t.teams.filter((x) => !x.deleted);
export const expertName = (t: TeamsDoc, id: string | null | undefined) => t.experts.find((e) => e.id === id)?.displayName ?? "کارشناس";
export const teamName = (t: TeamsDoc, id: string | null | undefined) => t.teams.find((x) => x.id === id)?.name ?? "تیم";
export function customerCounts(): Map<number, { customers: number; openFiles: number }> {
  const out = new Map<number, { customers: number; openFiles: number }>();
  for (const r of queryRows<{ sp: number; n: number }>("SELECT salesperson_id sp, COUNT(*) n FROM customers WHERE merged_into_customer_id IS NULL AND salesperson_id IS NOT NULL GROUP BY salesperson_id"))
    out.set(Number(r.sp), { customers: Number(r.n), openFiles: 0 });
  try {
    for (const r of queryRows<{ sp: number; n: number }>(`SELECT c.salesperson_id sp, COUNT(*) n FROM loan_applications a JOIN customers c ON c.id=a.customer_id
        WHERE a.deleted_at IS NULL AND a.status<>'rejected' AND a.stage<>'completed' AND c.salesperson_id IS NOT NULL GROUP BY c.salesperson_id`)) {
      const o = out.get(Number(r.sp)) ?? { customers: 0, openFiles: 0 }; o.openFiles = Number(r.n); out.set(Number(r.sp), o);
    }
  } catch { /* bare DB without loan_applications */ }
  return out;
}
/** «انتخاب از کاربران»: existing active staff accounts only. No password, no account creation (§4.1). */
export function userPicker(): { id: number; name: string; role: string; salespersonId: number | null }[] {
  return queryRows<{ id: number; full_name: string | null; username: string; role: string; salesperson_id: number | null }>(
    `SELECT id, full_name, username, role, salesperson_id FROM users WHERE active=1 AND id<>${SMC_NEVER_USER} AND role='salesperson' ORDER BY id`,
  ).map((u) => ({ id: Number(u.id), name: fa(String(u.full_name || u.username)), role: u.role, salespersonId: u.salesperson_id == null ? null : Number(u.salesperson_id) }));
}
export const expertOfUser = (t: TeamsDoc, userId: number) => t.experts.find((e) => e.userId === userId) ?? null;

/* ---------------- validation ---------------- */
export type VErr = { section: Section; field: string; message: string };
const LEVELS: Level[] = ["locked", "own", "team", "all"];
export function validateTeams(d: TeamsDoc): VErr[] {
  const e: VErr[] = []; const add = (field: string, message: string) => e.push({ section: "teams", field, message });
  if (!d || !Array.isArray(d.teams) || !Array.isArray(d.experts)) return [{ section: "teams", field: "doc", message: "داده‌ی تیم‌ها کامل نیست." }];
  const ids = new Set<string>();
  for (const t of d.teams) {
    if (!t.id || ids.has(t.id)) add("teams", "شناسه‌ی تیم تکراری است."); ids.add(t.id);
    const nm = String(t.name ?? "").trim();
    if (!nm) add(`team:${t.id}`, "نام تیم را بنویسید.");
    if (nm.length > 40) add(`team:${t.id}`, "نام تیم بلند است.");
    const n = d.experts.filter((x) => x.teamId === t.id).length;
    if (t.deleted && n) add(`team:${t.id}`, `${nm} ${fa(n)} عضو دارد؛ اول اعضا را منتقل کنید.`);
    if (t.leadExpertId && !d.experts.some((x) => x.id === t.leadExpertId && x.teamId === t.id)) add(`team:${t.id}`, "سرپرست باید عضو همین تیم باشد.");
  }
  const exts = new Map<string, string>(); const eids = new Set<string>(); const users = new Set<number>();
  for (const x of d.experts) {
    if (!x.id || eids.has(x.id)) add("experts", "شناسه‌ی کارشناس تکراری است."); eids.add(x.id);
    if (!String(x.displayName ?? "").trim()) add(`expert:${x.id}`, "نام و نام خانوادگی لازم است.");
    if (String(x.displayName ?? "").length > 60) add(`expert:${x.id}`, "نام بلند است.");
    if (x.teamId && !d.teams.some((t) => t.id === x.teamId && !t.deleted)) add(`expert:${x.id}`, "تیم این کارشناس پیدا نشد.");
    if (x.extension != null && x.extension !== "") {
      const ext = toLatin(x.extension);
      if (!/^\d{2,5}$/.test(ext)) add(`expert:${x.id}`, "داخلی فقط عدد است.");
      const owner = exts.get(ext);
      if (owner) add(`expert:${x.id}`, `داخلی ${fa(ext)} مال ${owner} است.`); else exts.set(ext, x.displayName);
    }
    if (!["expert", "lead"].includes(x.role)) add(`expert:${x.id}`, "نقش معتبر نیست.");
    if (!["active", "leave", "inactive"].includes(x.status)) add(`expert:${x.id}`, "وضعیت معتبر نیست.");
    if (x.status === "leave" && !isYmd(x.leaveUntil)) add(`expert:${x.id}`, "تاریخ پایان مرخصی را بگذارید.");
    if (x.userId != null) {
      if (Number(x.userId) === SMC_NEVER_USER || !queryRow("SELECT 1 x FROM users WHERE id=? AND active=1", [x.userId])) add(`expert:${x.id}`, "حساب کاربری انتخاب‌شده فعال نیست.");
      if (users.has(Number(x.userId))) add(`expert:${x.id}`, "این حساب به کارشناس دیگری وصل است."); users.add(Number(x.userId));
    }
  }
  for (const m of d.moves ?? []) if (!d.experts.some((x) => x.id === m.expertId)) add("moves", "کارشناسِ انتقال پیدا نشد.");
  return e;
}
function validBlocks(list: Block[] | null | undefined, field: string, out: VErr[]) {
  if (list == null) return;
  if (!Array.isArray(list) || !list.length) { out.push({ section: "daily", field, message: "حداقل یک بازه لازم است." }); return; }
  const s = [...list].sort((a, b) => a.from - b.from);
  for (let i = 0; i < s.length; i++) {
    const b = s[i]!;
    if (!Number.isInteger(b.from) || !Number.isInteger(b.to) || b.from % 30 || b.to % 30 || b.from < 6 * 60 || b.to > 22 * 60 || b.to <= b.from)
      out.push({ section: "daily", field, message: "هر بازه «از / تا» با گام ۳۰ دقیقه است." });
    if (!["actual", "potential", "any"].includes(b.k)) out.push({ section: "daily", field, message: "نوع بازه معتبر نیست." });
    const p = s[i - 1];
    if (p && b.from < p.to) out.push({ section: "daily", field, message: `این بازه با بازه‌ی ${hmFa(p.from)} تا ${hmFa(p.to)} هم‌پوشانی دارد.` });
  }
}
export function validateDaily(d: DailyDoc): VErr[] {
  const e: VErr[] = [];
  if (!d?.blocks) return [{ section: "daily", field: "doc", message: "داده‌ی لیست روزانه کامل نیست." }];
  validBlocks(d.blocks.global, "global", e);
  for (const [k, v] of Object.entries(d.blocks.team ?? {})) validBlocks(v, `team:${k}`, e);
  for (const [k, v] of Object.entries(d.blocks.expert ?? {})) validBlocks(v, `expert:${k}`, e);
  for (const op of d.ops ?? []) {
    if (!["add", "remove", "move", "restore"].includes(op.op) || !isYmd(op.date) || !Number.isInteger(op.customerId) || !op.expertId)
      e.push({ section: "daily", field: "ops", message: "یک تغییر لیست روزانه معتبر نیست." });
    if (op.toDate != null && !isYmd(op.toDate)) e.push({ section: "daily", field: "ops", message: "روز مقصد معتبر نیست." });
    if (op.atTime != null && !/^\d{2}:\d{2}$/.test(op.atTime)) e.push({ section: "daily", field: "ops", message: "ساعت معتبر نیست." });
    if (op.customerId && !queryRow("SELECT 1 x FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [op.customerId])) e.push({ section: "daily", field: "ops", message: "مشتری پیدا نشد." });
  }
  return e;
}
export function validateAccess(d: AccessDoc): VErr[] {
  if (!d?.policies) return [{ section: "access", field: "doc", message: "داده‌ی دسترسی کامل نیست." }];
  const e: VErr[] = [];
  for (const [k, v] of Object.entries(d.policies))
    if (!LEVELS.includes(v?.customers) || !LEVELS.includes(v?.loan_files)) e.push({ section: "access", field: k, message: "سطح دسترسی معتبر نیست." });
  return e;
}
export function validateValid(d: ValidDoc): VErr[] {
  const e: VErr[] = [];
  for (const k of ["identity", "credit"] as const) {
    const v = d?.[k];
    if (!v || !["forever", "hours"].includes(v.mode)) { e.push({ section: "valid", field: k, message: "مدت اعتبار معتبر نیست." }); continue; }
    if (v.mode === "hours" && (!Number.isInteger(v.hours) || v.hours < 1 || v.hours > 365 * 24)) e.push({ section: "valid", field: k, message: "مدت دلخواه از ۱ ساعت تا ۳۶۵ روز است." });
  }
  return e;
}
export function validateModels(d: ModelDoc, t: TeamsDoc): VErr[] {
  const e: VErr[] = []; const add = (field: string, message: string) => e.push({ section: "model", field, message });
  if (!d || !Array.isArray(d.models)) return [{ section: "model", field: "doc", message: "داده‌ی مدل کامل نیست." }];
  const owner = new Map<string, string>();
  for (const m of d.models) {
    if (!String(m.name ?? "").trim()) add(`model:${m.id}`, "نام مدل را بنویسید.");
    if (!Number.isInteger(m.capacity) || m.capacity < 5 || m.capacity > 60) add(`model:${m.id}`, "ظرفیت روزانه از ۵ تا ۶۰ کار است.");
    const mix = m.mix ?? ({} as Model["mix"]);
    const vals = [mix.followup, mix.lead, mix.actual, mix.cold];
    if (vals.some((v) => !Number.isInteger(v) || v < 0 || v % 5)) add(`model:${m.id}`, "درصدهای ترکیب گام ۵ درصدی دارند.");
    const sum = vals.reduce((a, b) => a + (Number(b) || 0), 0);
    if (sum !== 100) add(`model:${m.id}`, `جمع ${fa(sum)}٪؛ ${fa(Math.abs(100 - sum))}٪ ${sum < 100 ? "مانده" : "اضافه"}`);
    for (const w of Object.values(m.weights ?? {})) if (!Number.isInteger(w) || w < 0 || w > 10) add(`model:${m.id}`, "وزن‌ها از ۰ تا ۱۰ هستند.");
    if (!Number.isInteger(m.retryHours) || m.retryHours < 1 || m.retryHours > 72) add(`model:${m.id}`, "فاصله‌ی تلاش دوباره از ۱ تا ۷۲ ساعت است.");
    for (const a of m.assign ?? []) {
      if (a.scope === "expert" && !t.experts.some((x) => x.id === a.id)) add(`model:${m.id}`, "کارشناس این مدل پیدا نشد.");
      if (a.scope === "team" && !liveTeams(t).some((x) => x.id === a.id)) add(`model:${m.id}`, "تیم این مدل پیدا نشد.");
      const k = `${a.scope}:${a.id}`; const prev = owner.get(k);
      if (prev && prev !== m.id) add(`model:${m.id}`, `${a.scope === "expert" ? expertName(t, a.id) : teamName(t, a.id)} مدل دیگری دارد؛ هر کارشناس دقیقاً یک مدل دارد.`);
      owner.set(k, m.id);
    }
  }
  return e;
}
function validMethod(m: Method, field: string, out: VErr[], level: "team" | "member") {
  if (!m || !["direct", "ratio", "percent", "round_robin", "capacity"].includes(m.method)) { out.push({ section: "dist", field, message: "روش تقسیم معتبر نیست." }); return; }
  if (!Array.isArray(m.targets)) { out.push({ section: "dist", field, message: "مقصد قانون معتبر نیست." }); return; }
  if (m.method === "direct" && m.targets.length !== 1) out.push({ section: "dist", field, message: `برای «مستقیم» یک ${level === "team" ? "تیم" : "کارشناس"} انتخاب کنید.` });
  if (m.method === "percent") {
    const sum = m.targets.reduce((a, b) => a + (Number(b.weight) || 0), 0);
    if (sum !== 100) out.push({ section: "dist", field, message: `جمع درصدها ${fa(sum)}٪ است؛ باید ۱۰۰٪ باشد.` });
  }
  if (m.method === "ratio" && (!m.targets.length || m.targets.some((x) => !Number.isInteger(x.weight) || Number(x.weight) < 1)))
    out.push({ section: "dist", field, message: "نسبت هر مقصد حداقل ۱ است." });
}
export function validateDist(d: DistDoc): VErr[] {
  const e: VErr[] = [];
  if (!d?.team || !d.member || !d.caps) return [{ section: "dist", field: "doc", message: "داده‌ی تقسیم کامل نیست." }];
  d.team.rules.forEach((r, i) => { validMethod(r, `team:${i}`, e, "team"); if (!r.conds?.length) e.push({ section: "dist", field: `team:${i}`, message: "هر قانون حداقل یک شرط دارد." }); });
  validMethod(d.team.fallback, "team:fallback", e, "team");
  for (const [tid, m] of Object.entries(d.member)) {
    m.rules.forEach((r, i) => { validMethod(r, `member:${tid}:${i}`, e, "member"); if (!r.conds?.length) e.push({ section: "dist", field: `member:${tid}:${i}`, message: "هر قانون حداقل یک شرط دارد." }); });
    validMethod(m.fallback, `member:${tid}:fallback`, e, "member");
  }
  for (const [k, c] of Object.entries(d.caps)) {
    if (!Number.isInteger(c.percent) || c.percent < 0 || c.percent > 100) e.push({ section: "dist", field: `cap:${k}`, message: "سهم درصدی از ۰ تا ۱۰۰ است." });
    if (!Number.isInteger(c.dailyCap) || c.dailyCap < 0 || c.dailyCap > 200) e.push({ section: "dist", field: `cap:${k}`, message: "سقف لید روزانه از ۰ تا ۲۰۰ است." });
  }
  return e;
}
export function validateSteps(d: StepsDoc): VErr[] {
  const e: VErr[] = [];
  if (!d?.plans) return [{ section: "steps", field: "doc", message: "داده‌ی مراحل کامل نیست." }];
  for (const [k, list] of Object.entries(d.plans)) {
    if (list == null) continue;
    if (k !== "default" && !/^p\d+$/.test(k)) e.push({ section: "steps", field: k, message: "طرح معتبر نیست." });
    if (!Array.isArray(list)) { e.push({ section: "steps", field: k, message: "فهرست مراحل معتبر نیست." }); continue; }
    const last = list[list.length - 1];
    if (!last || last.key !== "completed" || !last.enabled) e.push({ section: "steps", field: k, message: "«تکمیل‌شده» همیشه آخر است و حذف نمی‌شود." });
    if (!list.some((s) => s.enabled && s.turn === "us" && s.key !== "completed")) e.push({ section: "steps", field: k, message: "حداقل یک مرحله‌ی «ما» قبل از تکمیل لازم است." });
    const keys = new Set<string>();
    for (const s of list) {
      if (!s.key || keys.has(s.key)) e.push({ section: "steps", field: k, message: "مرحله‌ی تکراری." }); keys.add(s.key);
      if (!String(s.label ?? "").trim()) e.push({ section: "steps", field: k, message: "نام مرحله لازم است." });
      if (!s.custom && !SYSTEM_STAGES.some((x) => x.key === s.key)) e.push({ section: "steps", field: k, message: "مرحله‌ی ناشناخته." });
      if (s.custom && !/^custom_[a-z0-9_]{1,40}$/.test(s.key)) e.push({ section: "steps", field: k, message: "کلید مرحله‌ی سفارشی معتبر نیست." });
      if (![1, 2, 3, 4, 5].includes(Number(s.phase))) e.push({ section: "steps", field: k, message: "فاز مرحله از ۱ تا ۵ است." });
      if (!["us", "customer"].includes(s.turn)) e.push({ section: "steps", field: k, message: "نوبت مرحله معتبر نیست." });
    }
  }
  return e;
}
export function validate(section: Section, doc: any): VErr[] {
  switch (section) {
    case "teams": return validateTeams(doc);
    case "daily": return validateDaily(doc);
    case "access": return validateAccess(doc);
    case "valid": return validateValid(doc);
    case "model": return validateModels(doc, loadDoc("teams"));
    case "dist": return validateDist(doc);
    case "steps": return validateSteps(doc);
  }
}

/* ---------------- stages ---------------- */
export function planStages(steps: StepsDoc, planKey: string): Stage[] {
  const own = steps.plans[planKey];
  if (own) return own;
  return steps.plans.default ?? SYSTEM_STAGES.map((s) => ({ ...s, docs: [...s.docs] }));
}
/** New-file hook (§6-10): enabled stage keys for a plan (own → default → system). Open files keep their own snapshot. Flag OFF = system list. */
export function smcStagesForNewFile(planId: number | null): string[] {
  if (!smcFlagOn()) return SYSTEM_STAGES.map((s) => s.key);
  return planStages(loadDoc("steps"), planId == null ? "default" : `p${planId}`).filter((s) => s.enabled).map((s) => s.key);
}
export function planName(id: number): string {
  const r = queryRow<{ name: string }>("SELECT name FROM loan_plans WHERE id=?", [id]);
  return fa(String(r?.name ?? id).replace(/^طرح\s+/, "").trim());
}
/** Plan chips: active loan_plans only, read-only; same-name plans get their number so they can be told apart. */
export function planChips(): { key: string; name: string }[] {
  let rows: { id: number; name: string }[] = [];
  try { rows = queryRows("SELECT id, name FROM loan_plans WHERE COALESCE(active,1)=1 ORDER BY id"); } catch { rows = []; }
  const names = rows.map((r) => String(r.name).replace(/^طرح\s+/, "").trim());
  return rows.map((r, i) => ({ key: `p${r.id}`, name: fa(names.filter((n) => n === names[i]).length > 1 ? `${names[i]} (${names.slice(0, i + 1).filter((n) => n === names[i]).length})` : names[i]!) }));
}

/* ---------------- summaries (full Persian sentences for the history) ---------------- */
export const LEVEL_FA: Record<Level, string> = { locked: "قفل", own: "فقط خودش", team: "تیمش", all: "همه" };
export const validFa = (v: Validity) => v.mode === "forever" ? "همیشه معتبر"
  : v.hours === 24 * 7 ? "یک هفته" : v.hours === 24 * 30 ? "یک ماه" : v.hours === 24 * 365 ? "یک سال"
  : v.hours % 24 === 0 && v.hours > 24 ? `${fa(v.hours / 24)} روز` : `${fa(v.hours)} ساعت`;
const statusFa = (x: Expert) => x.status === "active" ? "فعال" : x.status === "inactive" ? "غیرفعال" : `مرخصی تا ${x.leaveUntil ? jDate(noon(x.leaveUntil)) : ""}`;
export function summarize(section: Section, before: any, after: any): string[] {
  const out: string[] = [];
  const t: TeamsDoc = section === "teams" ? after : loadDoc("teams");
  if (section === "teams") {
    const b = before as TeamsDoc, a = after as TeamsDoc;
    for (const x of a.teams) {
      const p = b.teams.find((y) => y.id === x.id);
      if (!p) { if (!x.deleted) out.push(`${x.name} ساخته شد`); continue; }
      if (x.deleted && !p.deleted) out.push(`${p.name} حذف شد`);
      else if (!x.deleted && p.deleted) out.push(`${x.name} برگشت`);
      if (p.name !== x.name) out.push(`نام ${p.name} به ${x.name} تغییر کرد`);
      if (!x.deleted && p.leadExpertId !== x.leadExpertId) out.push(`سرپرست ${x.name}: ${x.leadExpertId ? expertName(a, x.leadExpertId) : "بدون سرپرست"}`);
    }
    for (const x of a.experts) {
      const p = b.experts.find((y) => y.id === x.id);
      if (!p) { out.push(`${x.displayName} به ${teamName(a, x.teamId)} اضافه شد`); continue; }
      if (p.teamId !== x.teamId) {
        const mv = (a.moves ?? []).find((m) => m.expertId === x.id);
        out.push(`${x.displayName} از ${teamName(b, p.teamId)} به ${teamName(a, x.teamId)} رفت${mv && mv.keepCustomers === false ? "؛ مشتریانش در تیم قبلی دوباره تقسیم شدند" : "؛ مشتریانش با خودش ماندند"}`);
      }
      if (p.displayName !== x.displayName) out.push(`نام ${p.displayName} به ${x.displayName} تغییر کرد`);
      if ((p.extension ?? "") !== (x.extension ?? "")) out.push(`داخلی ${x.displayName}: ${x.extension ? fa(x.extension) : "بدون داخلی"}`);
      if (p.status !== x.status || p.leaveUntil !== x.leaveUntil) out.push(`${x.displayName}: ${statusFa(x)}`);
      if (p.role !== x.role) out.push(`نقش ${x.displayName}: ${x.role === "lead" ? "سرپرست" : "کارشناس فروش"}`);
      if (p.userId !== x.userId) out.push(`حساب کاربری ${x.displayName} ${x.userId ? "وصل شد" : "جدا شد"}`);
    }
  } else if (section === "access") {
    const b = before as AccessDoc, a = after as AccessDoc;
    for (const [id, v] of Object.entries(a.policies)) {
      const p = b.policies[id];
      if (!p || p.customers !== v.customers) out.push(`${expertName(t, id)}، لیست مشتریان: ${LEVEL_FA[v.customers]}`);
      if (!p || p.loan_files !== v.loan_files) out.push(`${expertName(t, id)}، پرونده‌ها: ${LEVEL_FA[v.loan_files]}`);
    }
  } else if (section === "valid") {
    const b = before as ValidDoc, a = after as ValidDoc;
    if (JSON.stringify(b.identity) !== JSON.stringify(a.identity)) out.push(`احراز هویت: از ${validFa(b.identity)} به ${validFa(a.identity)}`);
    if (JSON.stringify(b.credit) !== JSON.stringify(a.credit)) out.push(`اعتبارسنجی: از ${validFa(b.credit)} به ${validFa(a.credit)}`);
  } else if (section === "model") {
    const b = before as ModelDoc, a = after as ModelDoc;
    for (const m of a.models) {
      const p = b.models.find((x) => x.id === m.id);
      if (!p) { out.push(`مدل «${m.name}» ساخته شد`); continue; }
      if (p.name !== m.name) out.push(`نام مدل «${p.name}» به «${m.name}» تغییر کرد`);
      if (p.capacity !== m.capacity) out.push(`مدل «${m.name}»: ظرفیت روزانه از ${fa(p.capacity)} به ${fa(m.capacity)} کار`);
      if (JSON.stringify(p.mix) !== JSON.stringify(m.mix)) out.push(`مدل «${m.name}»: ترکیب لیست عوض شد`);
      if (JSON.stringify(p.rules) !== JSON.stringify(m.rules)) out.push(`مدل «${m.name}»: قانون‌ها عوض شد`);
      if (JSON.stringify(p.weights) !== JSON.stringify(m.weights)) out.push(`مدل «${m.name}»: وزن‌ها عوض شد`);
      if (p.retryHours !== m.retryHours || p.useTeamBlocks !== m.useTeamBlocks) out.push(`مدل «${m.name}»: بازه‌ها و تلاش دوباره عوض شد`);
      if (JSON.stringify(p.assign) !== JSON.stringify(m.assign))
        out.push(`مدل «${m.name}» برای: ${m.assign.map((x) => x.scope === "expert" ? expertName(t, x.id) : `کل ${teamName(t, x.id)}`).join("، ") || "هیچ‌کس"}`);
    }
    for (const p of b.models) if (!a.models.some((x) => x.id === p.id)) out.push(`مدل «${p.name}» حذف شد`);
  } else if (section === "dist") {
    const b = before as DistDoc, a = after as DistDoc;
    if (JSON.stringify(b.team) !== JSON.stringify(a.team)) out.push(`قانون‌های بین تیم‌ها عوض شد (${fa(a.team.rules.length)} قانون)`);
    for (const [tid, m] of Object.entries(a.member)) if (JSON.stringify(b.member[tid]) !== JSON.stringify(m)) out.push(`قانون‌های داخل ${teamName(t, tid)} عوض شد (${fa(m.rules.length)} قانون)`);
    for (const [id, c] of Object.entries(a.caps)) {
      const p = b.caps[id];
      if (!p || p.percent !== c.percent || p.dailyCap !== c.dailyCap) out.push(`${expertName(t, id)}: سهم ${fa(c.percent)}٪، سقف ${fa(c.dailyCap)} لید تازه در روز`);
    }
  } else if (section === "steps") {
    const b = before as StepsDoc, a = after as StepsDoc;
    for (const [k, list] of Object.entries(a.plans)) {
      if (JSON.stringify(b.plans[k] ?? null) === JSON.stringify(list ?? null)) continue;
      const nm = k === "default" ? "پیش‌فرض سیستم" : `طرح ${planName(Number(k.slice(1)))}`;
      if (list == null) { out.push(`${nm}: بازگشت به پیش‌فرض`); continue; }
      const prev = planStages(b, k);
      const on = list.filter((s) => s.enabled && prev.find((x) => x.key === s.key)?.enabled !== true).map((s) => s.label);
      const off = list.filter((s) => !s.enabled && prev.find((x) => x.key === s.key)?.enabled !== false).map((s) => s.label);
      if (off.length) out.push(`${nm}: ${off.join("، ")} خاموش شد`);
      if (on.length) out.push(`${nm}: ${on.join("، ")} روشن شد`);
      if (!on.length && !off.length) out.push(`${nm}: ترتیب، نام یا مدارک مراحل عوض شد`);
    }
  } else if (section === "daily") {
    const b = before as DailyDoc, a = after as DailyDoc;
    const scopeFa = (k: string) => k === "global" ? "همه‌ی تیم‌ها" : k.startsWith("team:") ? `کل ${teamName(t, k.slice(5))}` : expertName(t, k.slice(7));
    const keys = new Set<string>(["global", ...Object.keys(a.blocks.team).map((k) => `team:${k}`), ...Object.keys(b.blocks.team).map((k) => `team:${k}`),
      ...Object.keys(a.blocks.expert).map((k) => `expert:${k}`), ...Object.keys(b.blocks.expert).map((k) => `expert:${k}`)]);
    const get = (d: DailyDoc, k: string) => k === "global" ? d.blocks.global : k.startsWith("team:") ? d.blocks.team[k.slice(5)] : d.blocks.expert[k.slice(7)];
    for (const k of keys) {
      const x = get(a, k) ?? null, y = get(b, k) ?? null;
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
      out.push(x == null ? `بازه‌های ${scopeFa(k)} به پیش‌فرض برگشت` : `بازه‌های کاری ${scopeFa(k)}: ${x.map((bl) => `${hmFa(bl.from)} تا ${hmFa(bl.to)}`).join("، ")}`);
    }
  }
  return out;
}
function opsSummary(ops: DailyOp[], t: TeamsDoc): string[] {
  return ops.map((o) => {
    const c = queryRow<{ name: string }>("SELECT name FROM customers WHERE id=?", [o.customerId])?.name ?? "مشتری";
    const who = expertName(t, o.expertId); const day = jDay(noon(o.date));
    if (o.op === "add") return `${c} به لیست ${day} ${who} اضافه شد`;
    if (o.op === "remove") return o.toDate ? `${c} از لیست ${day} ${who} به ${jDay(noon(o.toDate))} رفت` : `${c} از لیست ${day} ${who} حذف شد`;
    if (o.op === "restore") return `${c} به لیست ${day} ${who} برگشت`;
    return o.atTime ? `${c} در لیست ${day} ${who} به ساعت ${fa(o.atTime)} رفت` : `${c} در لیست ${day} ${who} جابه‌جا شد`;
  });
}

/* ---------------- drafts ---------------- */
export type DraftRow = { doc: any; baseVersion: number; changes: number; updatedAt: string };
export function getDrafts(userId: number): Record<string, DraftRow> {
  ensureSmcSchema();
  const out: Record<string, DraftRow> = {};
  for (const r of queryRows<{ section: string; payload_json: string; base_version: number; changes: number; updated_at: string }>("SELECT * FROM smc_draft WHERE user_id=?", [userId])) {
    try { out[r.section] = { doc: JSON.parse(r.payload_json), baseVersion: Number(r.base_version), changes: Number(r.changes), updatedAt: r.updated_at }; } catch { /* skip a broken row */ }
  }
  return out;
}
export function putDraft(userId: number, section: Section, doc: unknown, baseVersion: number | null, changes: number, now = new Date()) {
  ensureSmcSchema();
  const base = baseVersion ?? metaOf(section).version;
  execute(`INSERT INTO smc_draft(user_id,section,payload_json,base_version,changes,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,section) DO UPDATE SET payload_json=excluded.payload_json, changes=excluded.changes, updated_at=excluded.updated_at`,
    [userId, section, JSON.stringify(doc), base, Math.max(1, Math.min(999, Math.round(changes) || 1)), now.toISOString()]);
}
export function dropDraft(userId: number, section: Section | null): number {
  ensureSmcSchema();
  return section ? executeChanges("DELETE FROM smc_draft WHERE user_id=? AND section=?", [userId, section]) : executeChanges("DELETE FROM smc_draft WHERE user_id=?", [userId]);
}

/** Confirm-dialog preview (§3 «ذخیره و اعمال»): the same Persian lines the history will get, plus validation errors. Nothing is written. */
export function draftSummary(userId: number, sections: Section[]): { section: Section; lines: string[]; errors: VErr[] }[] {
  const drafts = getDrafts(userId);
  return sections.filter((s) => drafts[s]).map((s) => {
    const before = loadDoc(s); const doc = drafts[s]!.doc;
    const lines = s === "daily" ? [...summarize("daily", before, doc), ...opsSummary(doc.ops ?? [], loadDoc("teams"))] : summarize(s, before, doc);
    return { section: s, lines: lines.map((l) => fa(l)), errors: validate(s, doc) };
  });
}

/* ---------------- apply / audit / revert ---------------- */
export type ApplyResult =
  | { ok: true; applied: { section: Section; auditId: number; version: number; summary: string }[] }
  | { ok: false; status: number; error: string; message: string; errors?: VErr[]; conflict?: { section: Section; by: string | null; at: string | null; atFa: string | null } };

function writeSection(section: Section, before: any, after: any, user: AuthUser, at: string, effects: Record<string, unknown>): void {
  if (section === "daily") { saveDoc("daily", { blocks: (after as DailyDoc).blocks }, user.id, at); return; }
  if (section === "valid") {
    const a = after as ValidDoc, b = before as ValidDoc;
    const appliedAt = { identity: b.appliedAt?.identity ?? null, credit: b.appliedAt?.credit ?? null };
    if (JSON.stringify(a.identity) !== JSON.stringify(b.identity)) appliedAt.identity = at;
    if (JSON.stringify(a.credit) !== JSON.stringify(b.credit)) appliedAt.credit = at;
    saveDoc("valid", { identity: a.identity, credit: a.credit, appliedAt }, user.id, at);
    return;
  }
  if (section === "teams") {
    const a = after as TeamsDoc;
    saveDoc("teams", { teams: a.teams, experts: a.experts }, user.id, at);
    const moved: { id: number; from: number; to: number }[] = [];
    for (const mv of a.moves ?? []) if (mv.keepCustomers === false) moved.push(...redistributeCustomers(before as TeamsDoc, mv.expertId, mv.from, at));
    effects.customersMoved = moved;
    return;
  }
  saveDoc(section, after, user.id, at);
}
function writeOps(ops: DailyOp[], user: AuthUser, at: string, auditId: number): number[] {
  const ids: number[] = [];
  for (const o of ops) {
    if (o.op === "restore") {
      const ref = Number(o.ref);
      if (Number.isInteger(ref) && ref > 0) executeChanges("UPDATE smc_daily_override SET undone_at=? WHERE id=? AND undone_at IS NULL", [at, ref]);
      else executeChanges("UPDATE smc_daily_override SET undone_at=? WHERE expert_id=? AND day=? AND customer_id=? AND action='remove' AND undone_at IS NULL", [at, o.expertId, o.date, o.customerId]);
      continue;
    }
    const ins = (day: string, action: string, blockIdx: number | null, sort: number | null, atTime: string | null) =>
      ids.push(execute(`INSERT INTO smc_daily_override(expert_id,day,customer_id,action,block_idx,sort,at_time,by_user_id,created_at,audit_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [o.expertId, day, o.customerId, action, blockIdx, sort, atTime, user.id, at, auditId]));
    if (o.op === "remove" && o.toDate) { ins(o.date, "remove", null, null, null); ins(o.toDate, "add", o.blockIdx ?? 0, null, o.atTime ?? null); continue; }
    ins(o.date, o.op, o.blockIdx ?? null, o.sort ?? null, o.atTime ?? null);
  }
  return ids;
}
/** §3.1: urgent rows (incoming, payment order, file action) can be neither moved nor removed. */
function urgentOpError(ops: DailyOp[], now: Date): VErr | null {
  const seen = new Map<string, ReturnType<typeof arrangeQueue>>();
  for (const o of ops) {
    if (o.op !== "remove" && o.op !== "move") continue;
    const k = `${o.expertId}|${o.date}`;
    if (!seen.has(k)) seen.set(k, arrangeQueue(o.expertId, o.date, { now }));
    const row = seen.get(k)!.rows.find((r) => r.customerId === o.customerId && r.locked);
    if (row) return { section: "daily", field: "ops", message: `${row.name} فوری است؛ جابه‌جا یا حذف نمی‌شود.` };
  }
  return null;
}

export function apply(user: AuthUser, sections: Section[], opts: { docs?: Partial<Record<Section, any>>; force?: boolean; now?: Date } = {}): ApplyResult {
  ensureSmcSchema();
  const now = opts.now ?? new Date(); const at = now.toISOString();
  const drafts = getDrafts(user.id);
  const todo: { section: Section; doc: any; base: number }[] = [];
  for (const s of [...new Set(sections)]) {
    const doc = opts.docs?.[s] ?? drafts[s]?.doc;
    if (doc == null) continue;
    todo.push({ section: s, doc, base: drafts[s]?.baseVersion ?? metaOf(s).version });
  }
  if (!todo.length) return { ok: false, status: 400, error: "nothing_to_apply", message: "تغییر ذخیره‌نشده‌ای نیست." };
  const errors = todo.flatMap((x) => validate(x.section, x.doc));
  const daily = todo.find((x) => x.section === "daily");
  if (!errors.length && daily) { const u = urgentOpError(daily.doc.ops ?? [], now); if (u) return { ok: false, status: 409, error: "urgent_locked", message: u.message, errors: [u] }; }
  if (errors.length) return { ok: false, status: 422, error: "invalid", message: errors[0]!.message, errors };
  if (!opts.force) {
    for (const x of todo) {
      const m = metaOf(x.section);
      if (m.version !== x.base && m.updatedBy !== user.id)
        return { ok: false, status: 409, error: "changed_since_open", conflict: { section: x.section, by: m.updatedByName, at: m.updatedAt, atFa: m.updatedAt ? fa(jTime(new Date(m.updatedAt))) : null },
          message: `این بخش از ${m.updatedAt ? fa(jTime(new Date(m.updatedAt))) : ""} توسط ${m.updatedByName ?? "مدیر دیگر"} عوض شده. اول تغییرهای او را ببینید.` };
    }
  }
  const applied: { section: Section; auditId: number; version: number; summary: string }[] = [];
  runImmediateTransaction(() => {
    for (const x of todo) {
      const before = loadDoc(x.section);
      const lines = x.section === "daily" ? [...summarize("daily", before, x.doc), ...opsSummary(x.doc.ops ?? [], loadDoc("teams"))] : summarize(x.section, before, x.doc);
      const summary = (lines.length ? lines.join("؛ ") : "بدون تغییر محتوا ذخیره شد").slice(0, 2000);
      const auditId = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
        [at, user.id, x.section, summary, JSON.stringify(before), JSON.stringify(x.doc)]);
      const effects: Record<string, unknown> = {};
      writeSection(x.section, before, x.doc, user, at, effects);
      if (x.section === "daily") effects.overrideIds = writeOps(x.doc.ops ?? [], user, at, auditId);
      execute("UPDATE smc_audit SET effects_json=? WHERE id=?", [JSON.stringify(effects), auditId]);
      executeChanges("DELETE FROM smc_draft WHERE user_id=? AND section=?", [user.id, x.section]);
      applied.push({ section: x.section, auditId, version: metaOf(x.section).version, summary });
    }
  });
  return { ok: true, applied };
}

/** «برگرداندن» (§3.7): a new change with its own history row that puts the section back to that row's «before» and undoes its side effects. */
export function revert(user: AuthUser, auditId: number, now = new Date()): ApplyResult {
  ensureSmcSchema();
  const row = queryRow<{ id: number; section: string; summary_fa: string; before_json: string; effects_json: string | null }>("SELECT * FROM smc_audit WHERE id=?", [auditId]);
  if (!row || !isSection(row.section)) return { ok: false, status: 404, error: "not_found", message: "این تغییر پیدا نشد." };
  const section = row.section; const at = now.toISOString();
  const before = JSON.parse(row.before_json); const effects = row.effects_json ? JSON.parse(row.effects_json) : {};
  const errors = section === "daily" ? [] : validate(section, before);
  if (errors.length) return { ok: false, status: 409, error: "revert_invalid", message: `برگرداندن ممکن نیست: ${errors[0]!.message}`, errors };
  let newId = 0; const summary = `برگرداندن: ${row.summary_fa}`.slice(0, 2000);
  runImmediateTransaction(() => {
    const cur = loadDoc(section);
    newId = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json,revert_of) VALUES(?,?,?,?,?,?,?)",
      [at, user.id, section, summary, JSON.stringify(cur), JSON.stringify(before), auditId]);
    const eff: Record<string, unknown> = {};
    if (section === "daily") {
      saveDoc("daily", { blocks: (before as DailyDoc).blocks }, user.id, at);
      eff.undoneOverrides = executeChanges("UPDATE smc_daily_override SET undone_at=? WHERE audit_id=? AND undone_at IS NULL", [at, auditId]);
    } else if (section === "teams") {
      saveDoc("teams", { teams: before.teams, experts: before.experts }, user.id, at);
    } else saveDoc(section, before, user.id, at);
    if (Array.isArray(effects.customersMoved) && effects.customersMoved.length) {
      let back = 0;
      for (const m of effects.customersMoved as { id: number; from: number; to: number }[])
        back += executeChanges("UPDATE customers SET salesperson_id=? WHERE id=? AND salesperson_id=?", [m.from, m.id, m.to]);
      eff.customersBack = back;
    }
    execute("UPDATE smc_audit SET effects_json=? WHERE id=?", [JSON.stringify(eff), newId]);
  });
  return { ok: true, applied: [{ section, auditId: newId, version: metaOf(section).version, summary }] };
}
export function auditList(section: string | null, limit = 200, now = new Date()) {
  ensureSmcSchema();
  const rows = queryRows<{ id: number; at: string; user_id: number; section: string; summary_fa: string; revert_of: number | null }>(
    `SELECT id, at, user_id, section, summary_fa, revert_of FROM smc_audit ${section ? "WHERE section=?" : ""} ORDER BY id DESC LIMIT ?`,
    section ? [section, limit] : [limit]);
  return rows.map((r) => ({ id: Number(r.id), at: r.at, atFa: fa(relWhen(r.at, now)), who: roleName(Number(r.user_id)), section: r.section,
    sectionFa: SECTION_FA[r.section as Section] ?? r.section, summary: fa(r.summary_fa), revertOf: r.revert_of }));
}

/* ---------------- distribution engine (§3.5) ---------------- */
export type Lead = Partial<Record<"priority" | "status" | "credit_rank" | "amount" | "job" | "docs" | "bounced_check" | "need_time" | "city" | "source" | "plan" | "retired_intro", string>>;
export const DIST_FIELDS = ["priority", "status", "credit_rank", "amount", "job", "docs", "retired_intro", "bounced_check", "need_time", "city", "source", "plan"] as const;
function condHit(c: Cond, lead: Lead): boolean {
  const v = lead[c.field as keyof Lead];
  if (v == null || v === "") return false;
  if (c.field === "amount") {
    const n = Number(toLatin(v)); const op = c.values[0]; const lim = Number(toLatin(c.values[1]));
    return Number.isFinite(n) && Number.isFinite(lim) && (op === "gt" ? n > lim : op === "lt" ? n < lim : n === lim);
  }
  return c.values.map(String).includes(String(v));
}
const ruleHit = (r: DistRule, lead: Lead) => Array.isArray(r.conds) && r.conds.length > 0 && r.conds.every((c) => condHit(c, lead));
const counter = (key: string) => Number(queryRow<{ n: number }>("SELECT n FROM smc_dist_counter WHERE rule_key=?", [key])?.n ?? 0);
function bump(key: string, at: string) { execute("INSERT INTO smc_dist_counter(rule_key,n,updated_at) VALUES(?,1,?) ON CONFLICT(rule_key) DO UPDATE SET n=n+1, updated_at=excluded.updated_at", [key, at]); }
function dayRange(day: string): [string, string] { return [new Date(`${day}T00:00:00+03:30`).toISOString(), new Date(`${addDays(day, 1)}T00:00:00+03:30`).toISOString()]; }
const leadsToday = (expertId: string, day: string) => Number(queryRow<{ n: number }>("SELECT COUNT(*) n FROM smc_dist_log WHERE expert_id=? AND kind='lead' AND at>=? AND at<?", [expertId, ...dayRange(day)])?.n ?? 0);
/** Who may get a lead: in that team, has an account (§6-19), active or leave already over, under the daily cap. */
function eligible(t: TeamsDoc, d: DistDoc, teamId: string, day: string, exclude?: string): Expert[] {
  return t.experts.filter((e) => e.teamId === teamId && e.id !== exclude && e.userId != null
    && (e.status === "active" || (e.status === "leave" && e.leaveUntil != null && e.leaveUntil < day))
    && leadsToday(e.id, day) < (d.caps[e.id]?.dailyCap ?? 12));
}
function pickOne(m: Method, key: string, pool: string[], commit: boolean, at: string, freeOf: (id: string) => number): { id: string | null; how: string } {
  const base = (m.method === "round_robin" || m.method === "capacity") && !m.targets.length ? pool.map((id) => ({ id, weight: 1 })) : m.targets;
  const targets = base.filter((x) => pool.includes(x.id));
  if (!targets.length) return { id: null, how: "" };
  const n = counter(key);
  let id: string | null = null; let how = "";
  if (m.method === "direct") { id = targets[0]!.id; how = "مستقیم"; }
  else if (m.method === "round_robin") { id = targets[n % targets.length]!.id; how = "نوبتی"; }
  else if (m.method === "ratio" || m.method === "percent") {
    const total = targets.reduce((a, b) => a + (Number(b.weight) || 0), 0);
    if (total <= 0) return { id: null, how: "" };
    let slot = n % total;
    for (const x of targets) { const w = Number(x.weight) || 0; if (slot < w) { id = x.id; break; } slot -= w; }
    id = id ?? targets[0]!.id;
    how = m.method === "ratio" ? `نوبت ${fa(n % total + 1)} از ${fa(total)} در نسبت ${targets.map((x) => fa(Number(x.weight) || 0)).join(" به ")}` : "درصدی";
  } else { id = [...targets].sort((a, b) => freeOf(b.id) - freeOf(a.id))[0]!.id; how = "بر اساس ظرفیت"; }
  if (commit && (m.method === "round_robin" || m.method === "ratio" || m.method === "percent")) bump(key, at);
  return { id, how };
}
export type RouteResult = { teamId: string | null; expertId: string | null; teamRule: number | null; memberRule: number | null; path: { level: 1 | 2 | 3; text: string }[]; unassigned: boolean };
/** commit=false («آزمایش با یک لید نمونه»): nothing is written, no counter moves (§5-6). */
export function routeLead(lead: Lead, opts: { commit: boolean; customerId?: number; now?: Date; teams?: TeamsDoc; dist?: DistDoc; excludeExpert?: string; onlyTeam?: string }): RouteResult {
  ensureSmcSchema();
  const now = opts.now ?? new Date(); const at = now.toISOString(); const day = ymdTehran(now);
  const t = opts.teams ?? loadDoc("teams"); const d = opts.dist ?? loadDoc("dist");
  const path: RouteResult["path"] = [];
  const liveIds = liveTeams(t).map((x) => x.id);
  const teamFree = (tid: string) => eligible(t, d, tid, day).reduce((a, e) => a + Math.max(0, (d.caps[e.id]?.dailyCap ?? 12) - leadsToday(e.id, day)), 0);
  let teamId: string | null = opts.onlyTeam ?? null; let teamRule: number | null = null;
  if (!teamId) {
    const i = d.team.rules.findIndex((r) => ruleHit(r, lead));
    if (i >= 0) {
      const p = pickOne(d.team.rules[i]!, `team:${d.team.rules[i]!.id}`, liveIds, opts.commit, at, teamFree);
      if (p.id) { teamId = p.id; teamRule = i + 1; path.push({ level: 1, text: `قانون ${fa(i + 1)} بین تیم‌ها، ${p.how}: ${teamName(t, teamId)}` }); }
    }
    if (!teamId) {
      const p = pickOne(d.team.fallback, "team:fallback", liveIds, opts.commit, at, teamFree);
      teamId = p.id; if (teamId) path.push({ level: 1, text: `بقیه، ${p.how}: ${teamName(t, teamId)}` });
    }
  }
  let expertId: string | null = null; let memberRule: number | null = null;
  if (teamId) {
    const ids = eligible(t, d, teamId, day, opts.excludeExpert).map((e) => e.id);
    const free = (id: string) => (d.caps[id]?.dailyCap ?? 12) - leadsToday(id, day);
    const m = d.member[teamId] ?? { rules: [], fallback: { method: "capacity" as const, targets: [] } };
    const i = m.rules.findIndex((r) => ruleHit(r, lead));
    if (i >= 0) {
      const r = m.rules[i]!;
      const p = pickOne(r, `member:${teamId}:${r.id}`, ids, opts.commit, at, free);
      if (p.id) { expertId = p.id; memberRule = i + 1; path.push({ level: 2, text: `قانون ${fa(i + 1)} داخل ${teamName(t, teamId)}، ${p.how}` }); }
      else path.push({ level: 2, text: `قانون ${fa(i + 1)} داخل ${teamName(t, teamId)} خورد ولی کارشناسش اینجا نیست، مرخصی یا پر است؛ به «بقیه» رفت` });
    }
    if (!expertId) {
      const p = pickOne(m.fallback, `member:${teamId}:fallback`, ids, opts.commit, at, free);
      if (p.id) { expertId = p.id; path.push({ level: 2, text: `بقیه داخل ${teamName(t, teamId)}، ${p.how}` }); }
    }
  }
  const e = t.experts.find((x) => x.id === expertId);
  path.push({ level: 3, text: e ? `به ${e.displayName} می‌رسد${e.extension ? `، داخلی ${fa(e.extension)}` : ""}` : "همه پر یا مرخصی‌اند؛ به صف «بی‌کارشناس» مدیر فروش می‌رود" });
  if (opts.commit && opts.customerId != null)
    execute("INSERT INTO smc_dist_log(at,customer_id,team_id,expert_id,team_rule,member_rule,reason_fa,kind) VALUES(?,?,?,?,?,?,?,?)",
      [at, opts.customerId, teamId, expertId, teamRule, memberRule, path.map((p) => p.text).join("، "), opts.onlyTeam ? "move" : "lead"]);
  return { teamId, expertId, teamRule, memberRule, path, unassigned: !e };
}
/** keep_customers=false (§4.1, §6-14): the moved expert's customers are re-split with the OLD team's level-2 rules; logged and revertable. */
function redistributeCustomers(before: TeamsDoc, expertId: string, fromTeam: string | null, at: string): { id: number; from: number; to: number }[] {
  const e = before.experts.find((x) => x.id === expertId);
  if (!e?.salespersonId || !fromTeam) return [];
  const rows = queryRows<{ id: number; priority: number | null; credit_rank: string | null; status: string | null }>(
    "SELECT id, priority, credit_rank, status FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL ORDER BY id", [e.salespersonId]);
  const out: { id: number; from: number; to: number }[] = [];
  for (const c of rows) {
    const r = routeLead({ priority: c.priority == null ? "none" : String(c.priority), credit_rank: String(c.credit_rank ?? ""), status: String(c.status ?? "") },
      { commit: true, customerId: c.id, now: new Date(at), teams: before, excludeExpert: expertId, onlyTeam: fromTeam });
    const to = before.experts.find((x) => x.id === r.expertId)?.salespersonId;
    if (!to || to === e.salespersonId) continue;
    if (executeChanges("UPDATE customers SET salesperson_id=? WHERE id=? AND salesperson_id=?", [to, c.id, e.salespersonId])) out.push({ id: c.id, from: e.salespersonId, to });
  }
  return out;
}
export function distLog(day: string) {
  ensureSmcSchema();
  const t = loadDoc("teams");
  return queryRows<{ at: string; team_id: string | null; expert_id: string | null; team_rule: number | null; member_rule: number | null; name: string | null }>(
    "SELECT l.at, l.team_id, l.expert_id, l.team_rule, l.member_rule, c.name FROM smc_dist_log l LEFT JOIN customers c ON c.id=l.customer_id WHERE l.at>=? AND l.at<? ORDER BY l.id DESC LIMIT 200",
    dayRange(day),
  ).map((r) => ({ at: fa(jTime(new Date(r.at))), customer: r.name ?? "مشتری", team: r.team_id ? teamName(t, r.team_id) : "—", expert: r.expert_id ? expertName(t, r.expert_id) : "بی‌کارشناس",
    reason: [r.team_rule ? `قانون ${fa(r.team_rule)} تیم` : "بقیه", r.member_rule ? `قانون ${fa(r.member_rule)} داخل تیم` : null].filter(Boolean).join("، ") }));
}
/** §6-15: a rule naming an expert who left that team (or a deleted team) is not edited; it is flagged and its leads go to «بقیه». */
export function staleRules(t: TeamsDoc, d: DistDoc): { level: "team" | "member"; teamId: string | null; index: number; text: string }[] {
  const out: { level: "team" | "member"; teamId: string | null; index: number; text: string }[] = [];
  d.team.rules.forEach((r, i) => { for (const x of r.targets) if (!liveTeams(t).some((y) => y.id === x.id)) out.push({ level: "team", teamId: null, index: i, text: `${teamName(t, x.id)} حذف شده` }); });
  for (const [tid, m] of Object.entries(d.member)) m.rules.forEach((r, i) => {
    for (const x of r.targets) {
      const e = t.experts.find((y) => y.id === x.id);
      if (!e || e.teamId !== tid) out.push({ level: "member", teamId: tid, index: i, text: `${e?.displayName ?? "کارشناس"} به ${teamName(t, e?.teamId)} می‌رود` });
      else if (e.status === "inactive") out.push({ level: "member", teamId: tid, index: i, text: `${e.displayName} غیرفعال است` });
    }
  });
  return out;
}
export function rulesNaming(d: DistDoc, expertId: string, teamId: string | null): number {
  if (!teamId) return 0;
  return (d.member[teamId]?.rules ?? []).filter((r) => r.targets.some((x) => x.id === expertId)).length;
}

/* ---------------- daily queue: manager view over the live «کارهای امروز» engine (read-only) ---------------- */
export const KIND_KEY: Record<DqKind, string> = { incoming_call: "in", new_lead: "lead", follow_up: "fu", reminder: "rem", file_action: "file", payment_order: "pay", outgoing_call: "out" };
export function blocksFor(expertId: string, t: TeamsDoc, daily: DailyDoc): { blocks: Block[]; scope: "expert" | "team" | "global" | "system" } {
  const e = t.experts.find((x) => x.id === expertId);
  if (daily.blocks.expert[expertId]) return { blocks: daily.blocks.expert[expertId]!, scope: "expert" };
  if (e?.teamId && daily.blocks.team[e.teamId]) return { blocks: daily.blocks.team[e.teamId]!, scope: "team" };
  if (daily.blocks.global) return { blocks: daily.blocks.global, scope: "global" };
  return { blocks: dqBlocks().map((b) => ({ from: b.from, to: b.to, k: b.k })), scope: "system" };
}
export type QRow = {
  key: string; customerId: number | null; name: string; type: string; why: string; source: "urgent" | "system" | "manual" | "moved" | "removed";
  blockIdx: number; locked: boolean; overrideId: number | null; overCapacity?: boolean; score?: number; draft?: boolean;
};
function whyOf(it: DqItem): string {
  const t = it.due_at ? fa(jTime(new Date(it.due_at))) : "";
  switch (it.kind) {
    case "incoming_call": return "تماس ورودی";
    case "payment_order": return "دستور پرداخت، منتظر تأیید فروش";
    case "file_action": return it.fileTask?.stageLabel ?? "اقدام پرونده";
    case "reminder": return it.remText ? `${fa(String(it.remText).slice(0, 60))}${t ? `، ساعت ${t}` : ""}` : `یادآور${t ? `، ساعت ${t}` : ""}`;
    case "new_lead": return "لید تازه";
    case "outgoing_call": return "تماس خروجی";
    default: return it.timed && t ? `پیگیری، ساعت ${t}` : "پیگیری";
  }
}
/** Today = now; another day = that day's 08:30 Tehran (before the first block) so the engine lays it out from the start. */
export const dayNow = (date: string, now = new Date()) => (ymdTehran(now) === date ? now : new Date(`${date}T08:30:00+03:30`));
export function modelFor(expertId: string, t: TeamsDoc, md: ModelDoc): Model | null {
  const byExpert = md.models.find((m) => m.assign.some((a) => a.scope === "expert" && a.id === expertId));
  if (byExpert) return byExpert;
  const e = t.experts.find((x) => x.id === expertId);
  return e?.teamId ? md.models.find((m) => m.assign.some((a) => a.scope === "team" && a.id === e.teamId)) ?? null : null;
}
const RANK: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, E: 1 };
type CustFacts = { priority: number | null; credit_rank: string | null; created_at: string | null; last_call: string | null };
function facts(id: number, cache: Map<number, CustFacts>): CustFacts {
  let c = cache.get(id);
  if (!c) {
    c = queryRow<CustFacts>("SELECT c.priority, c.credit_rank, c.created_at, (SELECT MAX(l.created_at) FROM call_logs l WHERE l.customer_id=c.id) last_call FROM customers c WHERE c.id=?", [id])
      ?? { priority: null, credit_rank: null, created_at: null, last_call: null };
    cache.set(id, c);
  }
  return c;
}
function scoreRow(r: QRow, m: Model, cache: Map<number, CustFacts>, now: Date): number {
  if (r.customerId == null) return 0;
  const c = facts(r.customerId, cache); const w = m.weights ?? {};
  const pr = c.priority == null ? 0 : (4 - Number(c.priority)) / 3;
  const idle = c.last_call ? Math.min(1, (now.getTime() - Date.parse(c.last_call)) / (14 * 86_400_000)) : 1;
  const rank = (RANK[String(c.credit_rank ?? "").toUpperCase()] ?? 0) / 5;
  const age = c.created_at ? Math.max(0, 1 - (now.getTime() - Date.parse(c.created_at)) / (7 * 86_400_000)) : 0;
  let s = (w.priority ?? 0) * pr + (w.idleDays ?? 0) * idle + (w.creditRank ?? 0) * rank + (w.leadAge ?? 0) * (r.type === "lead" ? age : 0) + (w.fileStage ?? 0) * (r.type === "file" ? 1 : 0);
  for (const rule of m.rules)
    if (rule.subject === "credit_rank" && rule.outcome === "score" && Array.isArray(rule.value) && (rule.value as string[]).includes(String(c.credit_rank ?? "").toUpperCase())) s += Number(rule.outcomeValue) || 0;
  return Math.round(s * 10) / 10;
}
/** Model rules that bring customers in (§3.4 «به لیست بیاید»): «مشتری بالقوه N روز تماس نگرفته» and «پرونده بیش از N روز منتظر». */
function ruleCandidates(m: Model, e: Expert, date: string, have: Set<number>, blocks: Block[]): QRow[] {
  if (!e.salespersonId) return [];
  const out: QRow[] = []; const dayStart = new Date(`${date}T00:00:00+03:30`).getTime();
  const pot = Math.max(0, blocks.findIndex((b) => b.k === "potential")); const act = Math.max(0, blocks.findIndex((b) => b.k === "actual"));
  const room = Math.max(0, m.capacity);
  for (const r of m.rules) {
    if (r.outcome !== "include") continue;
    if (r.subject === "potential" && r.op === "idle_days") {
      const days = Math.max(1, Number(r.value) || 7);
      const rows = queryRows<{ id: number; name: string; last: string | null }>(
        `SELECT c.id, c.name, (SELECT MAX(l.created_at) FROM call_logs l WHERE l.customer_id=c.id) last FROM customers c
          WHERE c.salesperson_id=? AND c.merged_into_customer_id IS NULL AND c.status='in_progress'
            AND NOT EXISTS (SELECT 1 FROM loan_applications a WHERE a.customer_id=c.id AND a.deleted_at IS NULL AND a.status<>'rejected' AND a.stage<>'completed')
          ORDER BY last ASC LIMIT ?`, [e.salespersonId, room]);
      for (const c of rows) {
        if (have.has(c.id)) continue;
        const idle = c.last ? Math.floor((dayStart - Date.parse(c.last)) / 86_400_000) : null;
        if (idle != null && idle < days) continue;
        have.add(c.id);
        out.push({ key: `rule-${r.id}-${c.id}`, customerId: c.id, name: c.name, type: idle != null && idle >= 14 ? "cold" : "fu",
          why: idle == null ? "هنوز تماسی ندارد" : `${fa(idle)} روز بدون تماس`, source: "system", blockIdx: pot, locked: false, overrideId: null });
      }
    }
    if (r.subject === "file" && r.op === "waiting_days_gt") {
      const days = Math.max(1, Number(r.value) || 2);
      let rows: { id: number; name: string; updated_at: string }[] = [];
      try {
        rows = queryRows(`SELECT c.id, c.name, a.updated_at FROM loan_applications a JOIN customers c ON c.id=a.customer_id
          WHERE c.salesperson_id=? AND a.deleted_at IS NULL AND a.status<>'rejected' AND a.stage<>'completed' AND julianday(?) - julianday(a.updated_at) > ? LIMIT ?`,
          [e.salespersonId, new Date(dayStart).toISOString(), days, room]);
      } catch { rows = []; }
      for (const c of rows) {
        if (have.has(c.id)) continue; have.add(c.id);
        out.push({ key: `rule-${r.id}-${c.id}`, customerId: c.id, name: c.name, type: "file", why: `${fa(Math.floor((dayStart - Date.parse(c.updated_at)) / 86_400_000))} روز منتظر اقدام`,
          source: "system", blockIdx: act, locked: false, overrideId: null });
      }
    }
  }
  return out;
}
export function arrangeQueue(expertId: string, date: string, opts: { now?: Date; model?: Model | null; extraOps?: DailyOp[]; withRules?: boolean; daily?: DailyDoc } = {}) {
  ensureSmcSchema();
  const now = opts.now ?? new Date();
  const t = loadDoc("teams"); const daily = opts.daily && validateDaily({ blocks: opts.daily.blocks }).length === 0 ? opts.daily : loadDoc("daily"); const md = loadDoc("model");
  const e = t.experts.find((x) => x.id === expertId);
  const { blocks, scope } = blocksFor(expertId, t, daily);
  const model = opts.model !== undefined ? opts.model : modelFor(expertId, t, md);
  const rows: QRow[] = [];
  const u = e?.userId && e.userId !== SMC_NEVER_USER ? getAuthUserById(e.userId) : undefined;
  if (u) {
    let q: ReturnType<typeof dqQueue> | null = null;
    try { q = dqQueue(u, dayNow(date, now)); } catch { q = null; }
    if (q && q.date === date) for (const it of q.items) {
      if (it.done) continue;
      const startMin = it.due_at ? Math.round((Date.parse(it.due_at) - Date.parse(`${date}T00:00:00+03:30`)) / 60000) : null;
      let bi = startMin != null && it.timed ? blocks.findIndex((b) => startMin < b.to) : -1;
      if (bi < 0) bi = Math.max(0, blocks.findIndex((b) => b.k === it.block || b.k === "any"));
      rows.push({ key: it.id, customerId: it.customer_id, name: it.name, type: KIND_KEY[it.kind], why: whyOf(it), source: it.urgent ? "urgent" : "system", blockIdx: bi, locked: it.urgent, overrideId: null });
    }
  }
  if (model && e && opts.withRules !== false) rows.push(...ruleCandidates(model, e, date, new Set(rows.map((r) => r.customerId).filter((x): x is number => x != null)), blocks));
  type Ov = { id: number | null; customerId: number; action: string; blockIdx: number | null; sort: number | null; atTime: string | null; draft: boolean };
  const sortOf = new Map<QRow, number>();
  const applyOv = (o: Ov) => {
    const ex = rows.find((r) => r.customerId === o.customerId && r.source !== "removed");
    if (ex?.locked) return; // §3.1: urgent rows never move or leave
    if (o.action === "remove") { if (ex) { ex.source = "removed"; ex.overrideId = o.id; ex.draft = o.draft; } return; }
    if (o.action === "add") {
      if (ex) return;
      const c = queryRow<{ name: string }>("SELECT name FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [o.customerId]);
      if (!c) return;
      const row: QRow = { key: `smc-${o.id ?? `d${o.customerId}`}`, customerId: o.customerId, name: c.name, type: "fu", why: o.atTime ? `افزوده‌ی مدیر فروش، ساعت ${fa(o.atTime)}` : "افزوده‌ی مدیر فروش",
        source: "manual", blockIdx: Math.min(Math.max(0, o.blockIdx ?? 0), blocks.length - 1), locked: false, overrideId: o.id, draft: o.draft };
      rows.push(row); if (o.sort != null) sortOf.set(row, o.sort);
      return;
    }
    if (o.action === "move" && ex) {
      if (o.blockIdx != null) ex.blockIdx = Math.min(Math.max(0, o.blockIdx), blocks.length - 1);
      if (ex.source !== "manual") ex.source = "moved";
      ex.overrideId = o.id; ex.draft = o.draft;
      if (o.atTime) ex.why = `${ex.why.replace(/، ساعت .*$/, "")}، ساعت ${fa(o.atTime)}`;
      if (o.sort != null) sortOf.set(ex, o.sort);
    }
  };
  for (const o of queryRows<{ id: number; customer_id: number; action: string; block_idx: number | null; sort: number | null; at_time: string | null }>(
    "SELECT * FROM smc_daily_override WHERE expert_id=? AND day=? AND undone_at IS NULL ORDER BY id", [expertId, date]))
    applyOv({ id: o.id, customerId: o.customer_id, action: o.action, blockIdx: o.block_idx, sort: o.sort, atTime: o.at_time, draft: false });
  for (const o of opts.extraOps ?? []) {
    if (o.expertId !== expertId) continue;
    if (o.op === "restore" && o.date === date) { const r = rows.find((x) => x.customerId === o.customerId && x.source === "removed"); if (r) { r.source = r.key.startsWith("smc-") ? "manual" : "system"; r.draft = true; } continue; }
    if (o.date === date && o.op !== "restore") applyOv({ id: null, customerId: o.customerId, action: o.op, blockIdx: o.blockIdx ?? null, sort: o.sort ?? null, atTime: o.atTime ?? null, draft: true });
    if (o.op === "remove" && o.toDate === date) applyOv({ id: null, customerId: o.customerId, action: "add", blockIdx: o.blockIdx ?? 0, sort: null, atTime: o.atTime ?? null, draft: true });
  }
  const cache = new Map<number, CustFacts>();
  if (model) for (const r of rows) r.score = scoreRow(r, model, cache, now);
  const ordered: QRow[] = [];
  for (let b = 0; b < blocks.length; b++) {
    const inB = rows.filter((r) => r.blockIdx === b);
    const urg = inB.filter((r) => r.locked);
    const rest = inB.filter((r) => !r.locked).map((r, i) => ({ r, i }));
    // manual / moved rows keep the explicit place the manager gave them (§6-2); the rest follow the model score or the engine order
    const base = [...rest].sort((x, y) => (model && x.r.source === "system" && y.r.source === "system" ? (y.r.score ?? 0) - (x.r.score ?? 0) : 0) || x.i - y.i);
    const fixed = base.filter((x) => sortOf.has(x.r)).sort((x, y) => sortOf.get(x.r)! - sortOf.get(y.r)!);
    const free = base.filter((x) => !sortOf.has(x.r)).map((x) => x.r);
    for (const f of fixed) free.splice(Math.min(free.length, Math.max(0, Math.floor(sortOf.get(f.r)!))), 0, f.r);
    ordered.push(...urg, ...free);
  }
  if (model) { let n = 0; for (const r of ordered) { if (r.locked || r.source === "removed") continue; n++; if (n > model.capacity && r.source === "system") r.overCapacity = true; } }
  const live = ordered.filter((r) => r.source !== "removed");
  return {
    expertId, date, dateFa: jDay(noon(date)),
    blocks: blocks.map((b) => ({ ...b, label: `${hmFa(b.from)} تا ${hmFa(b.to)}`, kindFa: b.k === "actual" ? "بالفعل" : b.k === "potential" ? "بالقوه" : "همه" })),
    blockScope: scope, model: model ? { id: model.id, name: model.name, capacity: model.capacity } : null, rows: ordered,
    count: live.filter((r) => !r.overCapacity).length, manual: ordered.filter((r) => r.source === "manual" || r.source === "moved").length,
    removed: ordered.filter((r) => r.source === "removed").length, noAccount: !u,
  };
}
/** «پیش‌نمایش» (§3.4): the same day with a draft model vs. the current arrangement. Real data, nothing saved. */
export function previewModel(model: Model, expertId: string, date: string, now?: Date) {
  const cur = arrangeQueue(expertId, date, { now });
  const next = arrangeQueue(expertId, date, { now, model });
  const live = (q: ReturnType<typeof arrangeQueue>) => q.rows.filter((r) => r.source !== "removed" && !r.overCapacity);
  const a = live(cur), b = live(next);
  const ak = new Map(a.map((r, i) => [r.key, i])); const bk = new Set(b.map((r) => r.key));
  const counts = { fu: 0, lead: 0, file: 0, cold: 0 };
  for (const r of b) { if (r.type === "lead") counts.lead++; else if (r.type === "file" || r.type === "pay") counts.file++; else if (r.type === "cold") counts.cold++; else counts.fu++; }
  return {
    expert: expertName(loadDoc("teams"), expertId), date, dateFa: next.dateFa, counts,
    diff: { added: b.filter((r) => !ak.has(r.key)).length, out: a.filter((r) => !bk.has(r.key)).length, moved: b.filter((r, i) => ak.has(r.key) && ak.get(r.key) !== i).length, manualKept: next.manual },
    top: b.slice(0, 7).map((r) => ({ type: r.type, name: r.name, why: r.why })), more: Math.max(0, b.length - 7), total: b.length,
  };
}

/* ---------------- enforcement (only while the flag is ON; managers/admins untouched) ---------------- */
export function accessLevel(u: AuthUser, resource: "customers" | "loan_files"): Level | null {
  if (smcCanManage(u)) return null;
  const e = expertOfUser(loadDoc("teams"), u.id);
  if (!e) return null; // not an expert of the console → existing behaviour only
  return loadDoc("access").policies[e.id]?.[resource] ?? "own"; // §3.2: a new expert starts on «فقط خودش»
}
/** null = no extra narrowing («همه» keeps the existing server rules; this console never widens them). */
export function allowedSalespersons(u: AuthUser, level: Level): Set<number> | null {
  if (level === "all") return null;
  const t = loadDoc("teams"); const e = expertOfUser(t, u.id);
  const ids = new Set<number>(u.salespersonId != null ? [Number(u.salespersonId)] : []);
  if (level === "team" && e?.teamId) for (const x of t.experts) if (x.teamId === e.teamId && x.salespersonId) ids.add(x.salespersonId);
  return ids;
}
/** §3.3 / §6-5: only checks completed after the policy was saved count; until then the old behaviour stays. */
export function creditValidUntil(customerId: number, now = new Date()): { valid: boolean; validUntil: string | null; validUntilFa: string | null } {
  const v = loadDoc("valid");
  const none = { valid: false, validUntil: null, validUntilFa: null };
  if (!v.appliedAt?.credit) return none;
  let row: { completed_at: string | null } | undefined;
  try { row = queryRow("SELECT completed_at FROM customer_credit_checks WHERE customer_id=? AND status='report_generated' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1", [customerId]); } catch { row = undefined; }
  if (!row?.completed_at || row.completed_at < v.appliedAt.credit) return none;
  if (v.credit.mode === "forever") return { valid: true, validUntil: "forever", validUntilFa: "همیشه معتبر" };
  const until = new Date(Date.parse(row.completed_at) + v.credit.hours * 3_600_000);
  if (until.getTime() <= now.getTime()) return none;
  return { valid: true, validUntil: until.toISOString(), validUntilFa: `معتبر تا ${jDate(until)}، ${fa(jTime(until))}` };
}
/**
 * The expert's own «کارهای امروز» (GET /daily-customer-inline/queue) after the manager's applied rows for today (§3.1, §6-4):
 * removed rows leave, moved rows change slot, added rows come in with `smc_manual` (small gold dot; «از طرف مدیر فروش» only in details).
 * Urgent rows are never touched. A model assigned before today re-orders the non-urgent rows inside each slot («از لیست فردا»).
 */
export function overlayExpertQueue(u: AuthUser, body: any, now = new Date()): any {
  if (!body || !Array.isArray(body.items) || typeof body.date !== "string") return body;
  const t = loadDoc("teams"); const e = expertOfUser(t, u.id);
  if (!e) return body;
  const ov = queryRows<{ id: number; customer_id: number; action: string; block_idx: number | null; sort: number | null; at_time: string | null }>(
    "SELECT * FROM smc_daily_override WHERE expert_id=? AND day=? AND undone_at IS NULL ORDER BY id", [e.id, body.date]);
  const md = loadDoc("model"); const mMeta = metaOf("model");
  const model = mMeta.updatedAt && mMeta.updatedAt < new Date(`${body.date}T00:00:00+03:30`).toISOString() ? modelFor(e.id, t, md) : null;
  if (!ov.length && !model) return body;
  const nBlocks = Array.isArray(body.blocks) ? body.blocks.length : 4;
  let items: any[] = [...body.items];
  for (const o of ov) {
    const idx = items.findIndex((x) => x.customer_id === o.customer_id && !x.done);
    const it = idx >= 0 ? items[idx] : null;
    if (it?.urgent) continue;
    if (o.action === "remove" && it) { items.splice(idx, 1); continue; }
    if (o.action === "move" && it) { if (o.block_idx != null) it.blockIdx = Math.min(Math.max(0, o.block_idx), nBlocks - 1); it.smc_manual = true; continue; }
    if (o.action === "add" && !it) {
      const c = queryRow<{ name: string }>("SELECT name FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [o.customer_id]);
      if (!c) continue;
      items.push({ id: `smc-${o.id}`, kind: "follow_up", kinds: ["follow_up"], block: "potential", blockIdx: Math.min(Math.max(0, o.block_idx ?? 0), nBlocks - 1), urgent: false, done: false, due: false,
        due_at: null, timed: false, done_at: null, done_early: false, customer_id: o.customer_id, name: c.name, tm: "", overdue: false, current: false, next: false, turn: 0, due_ref: null,
        itemId: null, dpStatus: null, reminderId: null, remText: null, call_id: null, live: false, direction: null, detected: "customer", payment_order_id: null, loan_file_id: null,
        pay: null, fileAct: null, fileTask: null, phone: null, phone_masked: null, phone_full: false, attempts: 0, smc_manual: true, smc_note: "از طرف مدیر فروش" });
    }
  }
  const cache = new Map<number, CustFacts>();
  const sorted: any[] = [];
  for (let b = 0; b < nBlocks; b++) {
    const inB = items.filter((x) => x.blockIdx === b);
    const fixed = inB.filter((x) => x.done || x.urgent || x.current);
    let rest = inB.filter((x) => !x.done && !x.urgent && !x.current);
    if (model) rest = rest.map((x, i) => ({ x, i, s: x.smc_manual ? Infinity : scoreRow({ customerId: x.customer_id, type: KIND_KEY[x.kind as DqKind] ?? "fu" } as QRow, model, cache, now) }))
      .sort((p, q) => q.s - p.s || p.i - q.i).map((p) => p.x);
    sorted.push(...fixed, ...rest);
  }
  sorted.push(...items.filter((x) => x.blockIdx == null || x.blockIdx >= nBlocks));
  items = sorted;
  items.forEach((x, i) => { x.turn = i + 1; });
  const counts: Record<string, number> = { ...(body.counts ?? {}) };
  for (const k of Object.keys(counts)) counts[k] = 0;
  for (const x of items) if (!x.done) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
  return { ...body, items, counts, openCount: items.filter((x) => !x.done).length, smc: { manual: ov.length, model: model?.name ?? null } };
}
