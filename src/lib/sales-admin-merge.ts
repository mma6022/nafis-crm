/**
 * «مدیریت فروش» v1.2 merge (design: nafis-design/mockups/sales-manager-console/merge-v1.2.md; Mohammad t355s1298, t356s1307).
 * flag.sales_admin_merge_v12 (global, default OFF) on top of flag.sales_manager_console_v1. Both OFF/either OFF = v1.1 and the old pages exactly.
 *
 * Reads (exact, through the same functions the old pages' GET endpoints use):
 *   sales_teams + sales_team_members (/sales-teams), sales_intake_shares + sales_intake_split (/sales-teams/intake),
 *   default_owner_rule_settings (/admin/default-owner-rule), lead_intake_settings (/lead-intake/admin/settings),
 *   call_queue_settings queue keys (/call-queue/settings), dp.* (/admin/settings/daily-plan), ds.* (/call-queue/discipline/settings),
 *   sales_assist_settings + P1 keys (/sales-assist/weights).
 * Writes:
 *   - samImport(): smc_settings(section='merge_import') + smc_settings('teams') team names only when they differ from live + smc_audit. Idempotent.
 *   - samWriteTeam(): sales_teams.name / sales_teams.enabled / sales_teams.updated_at for ONE row + smc_audit. Nothing else live.
 *   - samApplyConversion(): NOT exposed over HTTP. Needs both flags + an explicit approval id. Writes smc_settings('dist') + smc_audit,
 *     and default_owner_rule_settings('config').enabled=false + one default_owner_rule_settings_log row. Never run on live without Mohammad.
 * Never written: team_sales_config / notification_settings, sales_team_members, sales_intake_shares/split, call_queue_settings, sales_assist_settings,
 * lead_intake_settings, dp_capacity_log, users, loan_plans, contract templates. User 29 is never listed.
 */
import crypto from "node:crypto";
import { crmDb, execute, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import type { AuthUser } from "./auth";
import { cqSettings, cqDisciplineSettings, CQ_DEFAULTS, CQ_DS_DEFAULTS } from "./call-queue";
import { dpSettings, DP_DEFAULTS } from "./daily-plan";
import { getSalesAssistSettings, getP1Settings, SALES_ASSIST_SIGNALS, SALES_ASSIST_DEFAULTS, P1_DEFAULTS } from "./sales-assist";
import { getDefaultOwnerConfig, saveDefaultOwnerConfig, REGISTRATION_SOURCES } from "./default-owner-rule";
import { defaultSourceBySeller, LEAD_SOURCES } from "./lead-intake";
import { disableBlockedByIntakeMessage } from "./multi-team";
import {
  ensureSmcSchema, fa, loadDoc, metaOf, relWhen, samMerged, SMC_NEVER_USER, type DistDoc, type DistRule, type TeamsDoc,
} from "./sales-manager-console";

export type LiveMember = { salespersonId: number; name: string; isLead: boolean; ownsNone: boolean; ownsP1: boolean; ownsP2: boolean; ownsP3: boolean; sortOrder: number };
export type LiveTeam = { id: number; name: string; enabled: boolean; leadSplitQuota: number; members: LiveMember[] };
export type LiveValues = {
  teams: LiveTeam[];
  intake: { source: string; teamId: number; percent: number }[];
  intakeSplit: { source: string; teamIds: number[] }[];
  defaultOwner: { enabled: boolean; ownerSalespersonId: number | null; registrarMode: string; registrarUserIds: number[]; sourceMode: string; sources: string[] };
  defaultSourceBySeller: Record<string, string>;
  queue: { order: string[]; newRedHours: number; p1StaleDays: number; naTemplate: string };
  daily: { guardPct: number; waitMin: number; firstDayCapacity: number | null };
  discipline: Record<string, unknown>;
  assist: { settings: unknown; p1: unknown };
};

const spName = (sp: number) => String(queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [sp])?.name ?? `کارشناس ${fa(sp)}`).trim();

/** Runtime counters (p1_cursor, cursor_index/used, deficit) are not settings and are left out of the parity check on purpose. */
export function samLiveValues(): LiveValues {
  const teams = queryRows<{ id: number; name: string; enabled: number; lead_split_quota: number }>("SELECT id, name, enabled, lead_split_quota FROM sales_teams ORDER BY id")
    .map((t) => ({
      id: Number(t.id), name: t.name, enabled: Number(t.enabled) === 1, leadSplitQuota: Number(t.lead_split_quota),
      members: queryRows<any>("SELECT salesperson_id, is_lead, owns_none, owns_p1, owns_p2, owns_p3, sort_order FROM sales_team_members WHERE team_id=? ORDER BY sort_order, salesperson_id", [t.id])
        .map((m) => ({ salespersonId: Number(m.salesperson_id), name: spName(Number(m.salesperson_id)), isLead: !!m.is_lead, ownsNone: !!m.owns_none, ownsP1: !!m.owns_p1, ownsP2: !!m.owns_p2, ownsP3: !!m.owns_p3, sortOrder: Number(m.sort_order) })),
    }));
  let intake: LiveValues["intake"] = []; let intakeSplit: LiveValues["intakeSplit"] = [];
  try { intake = queryRows<any>("SELECT source, team_id, percent FROM sales_intake_shares ORDER BY source, team_id").map((r) => ({ source: r.source, teamId: Number(r.team_id), percent: Number(r.percent) })); } catch { intake = []; }
  try { intakeSplit = queryRows<any>("SELECT source, team_ids_json FROM sales_intake_split ORDER BY source").map((r) => ({ source: r.source, teamIds: (() => { try { return JSON.parse(r.team_ids_json).map(Number); } catch { return []; } })() })); } catch { intakeSplit = []; }
  const d = getDefaultOwnerConfig();
  return {
    teams, intake, intakeSplit,
    defaultOwner: { enabled: d.enabled, ownerSalespersonId: d.ownerSalespersonId ?? null, registrarMode: d.registrarMode, registrarUserIds: [...d.registrarUserIds], sourceMode: d.sourceMode, sources: [...d.sources] },
    defaultSourceBySeller: { ...defaultSourceBySeller(crmDb) },
    queue: { ...cqSettings() }, daily: { ...dpSettings() }, discipline: { ...cqDisciplineSettings() },
    assist: { settings: getSalesAssistSettings(), p1: getP1Settings() },
  };
}
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const samHash = (v: unknown) => crypto.createHash("sha256").update(stable(v)).digest("hex");

/** Leaf-by-leaf diff (paths) between two value trees. */
export function samDiff(a: unknown, b: unknown, p = ""): string[] {
  if (stable(a) === stable(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
    return keys.flatMap((k) => samDiff((a as any)[k], (b as any)[k], p ? `${p}.${k}` : k));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.flatMap((x, i) => samDiff(x, b[i], `${p}[${i}]`));
  return [p || "(root)"];
}

type ImportRow = { importedAt: string; importedBy: number | null; hash: string; values: LiveValues };
export function samImported(): ImportRow | null {
  ensureSmcSchema();
  const r = queryRow<{ payload_json: string }>("SELECT payload_json FROM smc_settings WHERE section='merge_import'");
  try { return r ? (JSON.parse(r.payload_json) as ImportRow) : null; } catch { return null; }
}

/**
 * Import routine (§6 «انتقال داده»). Only while both flags are ON. Idempotent: same live values → no write, same row.
 * Writes only smc_* (merge_import snapshot, console team names synced to the live names, one smc_audit row per real change).
 */
export function samImport(userId: number | null, now = new Date()): { ok: true; changed: boolean; hash: string; namesSynced: string[] } | { ok: false; status: number; error: string; message: string } {
  if (!samMerged()) return { ok: false, status: 404, error: "merge_off", message: "ادغام «مدیریت فروش» روشن نیست." };
  ensureSmcSchema();
  const values = samLiveValues(); const hash = samHash(values); const at = now.toISOString();
  const prev = samImported();
  const t = loadDoc("teams");
  const synced: string[] = [];
  const nextTeams: TeamsDoc = { ...t, teams: t.teams.map((x) => {
    const live = values.teams.find((lt) => `t${lt.id}` === x.id);
    if (live && live.name !== x.name) { synced.push(`${x.name} → ${live.name}`); return { ...x, name: live.name }; }
    return x;
  }) };
  if (prev?.hash === hash && !synced.length) return { ok: true, changed: false, hash, namesSynced: [] };
  runImmediateTransaction(() => {
    const row: ImportRow = { importedAt: at, importedBy: userId, hash, values };
    execute(`INSERT INTO smc_settings(section,payload_json,version,updated_by,updated_at) VALUES('merge_import',?,1,?,?)
      ON CONFLICT(section) DO UPDATE SET payload_json=excluded.payload_json, version=smc_settings.version+1, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [JSON.stringify(row), userId, at]);
    if (synced.length) {
      const v = metaOf("teams").version + 1;
      execute("UPDATE smc_settings SET payload_json=?, version=?, updated_by=?, updated_at=? WHERE section='teams'", [JSON.stringify(nextTeams), v, userId, at]);
    }
    const summary = prev ? "مقدارهای صفحه‌های قدیم دوباره خوانده شد" : "مقدارهای صفحه‌های قدیم به «مدیریت فروش» منتقل شد";
    execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
      [at, userId ?? 0, "merge", `${summary}${synced.length ? `؛ نام تیم از جدول زنده: ${synced.join("، ")}` : ""}`, JSON.stringify(prev?.values ?? null), JSON.stringify(values)]);
  });
  return { ok: true, changed: true, hash, namesSynced: synced };
}

/** Parity: the imported snapshot vs what the old pages read right now. ok=true means every carried-over value is identical. */
export function samParity(): { imported: boolean; ok: boolean; diffs: string[]; importedAt: string | null } {
  const imp = samImported();
  if (!imp) return { imported: false, ok: false, diffs: ["(not imported)"], importedAt: null };
  const diffs = samDiff(imp.values, samLiveValues());
  return { imported: true, ok: diffs.length === 0, diffs, importedAt: imp.importedAt };
}

/* ---------------- the only live write: sales_teams ---------------- */
export function samWriteTeam(u: AuthUser, teamId: number, patch: { name?: unknown; enabled?: unknown }, now = new Date()):
  { ok: true; team: LiveTeam; auditId: number } | { ok: false; status: number; error: string; message: string } {
  if (!samMerged()) return { ok: false, status: 404, error: "merge_off", message: "ادغام «مدیریت فروش» روشن نیست." };
  const row = queryRow<{ id: number; name: string; enabled: number }>("SELECT id, name, enabled FROM sales_teams WHERE id=?", [teamId]);
  if (!row) return { ok: false, status: 404, error: "not_found", message: "تیم پیدا نشد." };
  let name = row.name; let enabled = Number(row.enabled) === 1;
  if (patch.name !== undefined) {
    name = String(patch.name ?? "").trim();
    if (!name) return { ok: false, status: 400, error: "invalid_name", message: "نام تیم را بنویسید." };
    if (name.length > 40) return { ok: false, status: 400, error: "invalid_name", message: "نام تیم بلند است." };
    if (queryRow("SELECT 1 x FROM sales_teams WHERE name=? AND id<>?", [name, teamId])) return { ok: false, status: 409, error: "duplicate_name", message: "تیمی با همین نام هست." };
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return { ok: false, status: 400, error: "invalid_enabled", message: "وضعیت تیم معتبر نیست." };
    if (enabled && !patch.enabled) { const blocked = disableBlockedByIntakeMessage(teamId); if (blocked) return { ok: false, status: 409, error: "intake_destination", message: blocked }; }
    if (!enabled && patch.enabled) {
      // A kept member who joined another enabled team meanwhile would end up in two teams.
      const clash = queryRow<{ sp: number }>(`SELECT m.salesperson_id sp FROM sales_team_members m JOIN sales_team_members o ON o.salesperson_id=m.salesperson_id AND o.team_id<>m.team_id
        JOIN sales_teams t ON t.id=o.team_id AND t.enabled=1 WHERE m.team_id=? LIMIT 1`, [teamId]);
      if (clash) return { ok: false, status: 409, error: "member_in_other_team", message: `${spName(Number(clash.sp))} الان عضو تیم دیگری است؛ اول از آن تیم بیرونش بیاورید.` };
    }
    enabled = patch.enabled;
  }
  if (name === row.name && enabled === (Number(row.enabled) === 1)) return { ok: true, team: samLiveValues().teams.find((t) => t.id === teamId)!, auditId: 0 };
  const at = now.toISOString(); let auditId = 0;
  const parts: string[] = [];
  if (name !== row.name) parts.push(`نام «${row.name}» → «${name}»`);
  if (enabled !== (Number(row.enabled) === 1)) parts.push(enabled ? "فعال شد" : "غیرفعال شد");
  runImmediateTransaction(() => {
    execute("UPDATE sales_teams SET name=?, enabled=?, updated_at=? WHERE id=?", [name, enabled ? 1 : 0, at, teamId]);
    auditId = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
      [at, u.id, "teams_live", `${row.name}: ${parts.join("، ")}`, JSON.stringify({ id: teamId, name: row.name, enabled: Number(row.enabled) === 1 }), JSON.stringify({ id: teamId, name, enabled })]);
  });
  return { ok: true, team: samLiveValues().teams.find((t) => t.id === teamId)!, auditId };
}
/** «برگرداندن» of a teams_live row: puts that sales_teams row's name/enabled back (a new audited change). */
export function samRevertTeam(u: AuthUser, auditId: number, now = new Date()) {
  const r = queryRow<{ before_json: string; section: string }>("SELECT before_json, section FROM smc_audit WHERE id=?", [auditId]);
  if (!r || r.section !== "teams_live") return { ok: false as const, status: 404, error: "not_found", message: "این تغییر پیدا نشد." };
  const b = JSON.parse(r.before_json) as { id: number; name: string; enabled: boolean };
  return samWriteTeam(u, b.id, { name: b.name, enabled: b.enabled }, now);
}

/* ---------------- §6-22: «قانون ثبت مشتری» → distribution rules (designed; gated; never run on live without Mohammad) ---------------- */
export const CONVERSION_RULE_ID = "conv-default-owner";
export type ConversionWrite = { table: string; key: string; before: unknown; after: unknown; note: string };
export function samConversionPlan(): { applicable: boolean; reason: string; teamRule: DistRule | null; memberRule: { teamId: string; rule: DistRule } | null; writes: ConversionWrite[]; blockers: string[]; untouched: string[] } {
  ensureSmcSchema();
  const cfg = getDefaultOwnerConfig(); const dist = loadDoc("dist"); const teams = loadDoc("teams");
  const untouched = ["notification_settings (team_sales_config)", "sales_team_members", "sales_intake_shares", "sales_intake_split", "lead_intake_settings (منبع پیش‌فرض فرم)", "call_queue_settings", "sales_assist_settings", "customers"];
  if (!cfg.enabled) return { applicable: false, reason: "قانون ثبت خاموش است؛ چیزی برای تبدیل نیست.", teamRule: null, memberRule: null, writes: [], blockers: [], untouched };
  const sp = Number(cfg.ownerSalespersonId);
  const expert = teams.experts.find((e) => e.salespersonId === sp) ?? null;
  const liveTeam = queryRow<{ team_id: number }>("SELECT m.team_id FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1 WHERE m.salesperson_id=? LIMIT 1", [sp]);
  const teamId = expert?.teamId ?? (liveTeam ? `t${liveTeam.team_id}` : null);
  const conds = [
    { field: "registrar", values: cfg.registrarMode === "all" ? ["*"] : cfg.registrarUserIds.filter((id) => id !== SMC_NEVER_USER).map(String) },
    { field: "reg_source", values: cfg.sourceMode === "all" ? ["*"] : cfg.sources.map(String) },
  ];
  const blockers: string[] = [
    "مسیر ثبت مشتری زنده هنوز قانون‌های تقسیم کنسول را نمی‌خواند (فقط «امتحان با یک مشتری نمونه» و انتقال کارشناس از routeLead استفاده می‌کنند). اگر قانون ثبت خاموش شود و ثبت زنده به قانون تقسیم وصل نشده باشد، مشتری‌های تازه دیگر به کارشناس مقصد نمی‌رسند و طبق درصد تیم‌ها تقسیم می‌شوند.",
  ];
  if (!teamId || !expert) blockers.push("کارشناس مقصد قانون ثبت در تیم‌های کنسول پیدا نشد.");
  const teamRule: DistRule | null = teamId ? { id: CONVERSION_RULE_ID, conds, method: "direct", targets: [{ id: teamId }] } : null;
  const memberRule = teamId && expert ? { teamId, rule: { id: CONVERSION_RULE_ID, conds, method: "direct" as const, targets: [{ id: expert.id }] } } : null;
  const already = dist.team.rules.some((r) => r.id === CONVERSION_RULE_ID);
  const nextDist: DistDoc = JSON.parse(JSON.stringify(dist));
  if (teamRule && !already) nextDist.team.rules.unshift(teamRule);
  if (memberRule && !(nextDist.member[memberRule.teamId]?.rules ?? []).some((r) => r.id === CONVERSION_RULE_ID)) {
    nextDist.member[memberRule.teamId] ??= { rules: [], fallback: { method: "capacity", targets: [] } };
    nextDist.member[memberRule.teamId]!.rules.unshift(memberRule.rule);
  }
  const { updatedAt: _a, updatedByUserId: _b, ...cfgPlain } = cfg as any;
  const writes: ConversionWrite[] = [
    { table: "smc_settings", key: "section='dist' (payload_json, version+1, updated_by, updated_at)", before: { teamRules: dist.team.rules.length, memberRules: memberRule ? (dist.member[memberRule.teamId]?.rules.length ?? 0) : 0 }, after: { teamRules: nextDist.team.rules.length, memberRules: memberRule ? nextDist.member[memberRule.teamId]!.rules.length : 0 }, note: "قانون ۱ بین تیم‌ها و قانون ۱ داخل تیم مقصد: «ثبت‌کننده و منبع مثل قانون ثبت → مستقیم به کارشناس مقصد»" },
    { table: "smc_audit", key: "1 new row, section='dist'", before: null, after: "تبدیل قانون ثبت به قانون تقسیم", note: "با «برگرداندن» قابل برگشت" },
    { table: "default_owner_rule_settings", key: "key='config' (value, updated_at, updated_by_user_id)", before: cfgPlain, after: { ...cfgPlain, enabled: false }, note: "فقط enabled عوض می‌شود؛ مقصد و ثبت‌کننده و منبع برای برگشت می‌مانند" },
    { table: "default_owner_rule_settings_log", key: "1 new row (old_value, new_value, actor_user_id, via='smc_merge_conversion', created_at)", before: null, after: "log", note: "" },
  ];
  return { applicable: Boolean(teamRule && memberRule), reason: already ? "قانون تبدیل‌شده از قبل در قانون‌های تقسیم هست." : "", teamRule, memberRule, writes, blockers, untouched };
}
/** Library only (no route). approvedBy must be Mohammad's own card id; refused while either flag is OFF. Idempotent. */
export function samApplyConversion(u: AuthUser, approval: { approvedBy: string }, now = new Date()) {
  if (!samMerged()) return { ok: false as const, error: "merge_off" };
  if (!approval?.approvedBy || !/^t\d+[us]/.test(approval.approvedBy)) return { ok: false as const, error: "approval_required" };
  const d0 = loadDoc("dist");
  if (d0.team.rules.some((r) => r.id === CONVERSION_RULE_ID) && !getDefaultOwnerConfig().enabled) return { ok: true as const, changed: false };
  const plan = samConversionPlan();
  if (!plan.applicable) return { ok: false as const, error: "not_applicable", reason: plan.reason || plan.blockers.join(" ") };
  const at = now.toISOString(); const dist = loadDoc("dist");
  const next: DistDoc = JSON.parse(JSON.stringify(dist));
  let changed = false;
  if (!next.team.rules.some((r) => r.id === CONVERSION_RULE_ID)) { next.team.rules.unshift(plan.teamRule!); changed = true; }
  const m = plan.memberRule!; next.member[m.teamId] ??= { rules: [], fallback: { method: "capacity", targets: [] } };
  if (!next.member[m.teamId]!.rules.some((r) => r.id === CONVERSION_RULE_ID)) { next.member[m.teamId]!.rules.unshift(m.rule); changed = true; }
  const cfg = getDefaultOwnerConfig();
  runImmediateTransaction(() => {
    if (changed) {
      const v = metaOf("dist").version + 1;
      execute("UPDATE smc_settings SET payload_json=?, version=?, updated_by=?, updated_at=? WHERE section='dist'", [JSON.stringify(next), v, u.id, at]);
      execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
        [at, u.id, "dist", `تبدیل «قانون ثبت مشتری» به قانون تقسیم (${approval.approvedBy})`, JSON.stringify(dist), JSON.stringify(next)]);
    }
    if (cfg.enabled) { const { updatedAt: _a, updatedByUserId: _b, ...plain } = cfg as any; saveDefaultOwnerConfig({ ...plain, enabled: false }, u.id, "smc_merge_conversion"); }
  });
  return { ok: true as const, changed: changed || cfg.enabled };
}

/* ---------------- read model for the merged page ---------------- */
const QUEUE_GROUP_FA: Record<string, string> = { due: "یادآور سررسیده", new: "شماره‌ی جدید", p1: "اولویت ۱", assist: "پیشنهاد دستیار" };
export function samView(now = new Date()) {
  const imp = samImported(); const values = samLiveValues(); const parity = samParity();
  const users = new Map(queryRows<{ id: number; name: string }>(`SELECT id, COALESCE(NULLIF(full_name,''), username) name FROM users WHERE id<>${SMC_NEVER_USER}`).map((u) => [Number(u.id), String(u.name)]));
  const conv = samConversionPlan();
  return {
    importedAt: imp?.importedAt ?? null, importedAtFa: imp ? fa(relWhen(imp.importedAt, now)) : null, parity,
    values: { ...values, defaultOwner: { ...values.defaultOwner, registrarNames: values.defaultOwner.registrarUserIds.filter((id) => id !== SMC_NEVER_USER).map((id) => users.get(id) ?? `کاربر ${fa(id)}`) } },
    labels: {
      queueGroups: QUEUE_GROUP_FA, regSources: REGISTRATION_SOURCES, leadSources: LEAD_SOURCES,
      signals: Object.fromEntries(Object.entries(SALES_ASSIST_SIGNALS).map(([k, s]) => [k, s.label])),
      sellers: Object.fromEntries(queryRows<{ id: number; name: string }>("SELECT id, name FROM salespersons").map((s) => [String(s.id), s.name])),
      receivers: Object.fromEntries(queryRows<{ id: number; name: string }>("SELECT id, name FROM salespersons").map((s) => [String(s.id), s.name])),
    },
    defaults: { queue: CQ_DEFAULTS, daily: DP_DEFAULTS, discipline: CQ_DS_DEFAULTS, assist: SALES_ASSIST_DEFAULTS, p1: P1_DEFAULTS },
    conversion: { applicable: conv.applicable, reason: conv.reason, teamRule: conv.teamRule, memberRule: conv.memberRule, blockers: conv.blockers, writes: conv.writes.map((w) => ({ table: w.table, key: w.key, note: w.note })) },
    writable: { teamName: true, teamEnabled: true, other: false },
  };
}
