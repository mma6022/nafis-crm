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
import { cqSettings, cqDisciplineSettings, cqManager, CQ_DEFAULTS, CQ_DS_DEFAULTS, saveCqSettings, saveDiscipline, validateCqSettings, validateDiscipline } from "./call-queue";
import { dpAdminCapacity, dpCapacity, dpSaveSettings, dpSettings, dpValidateSettings, ensureDailyPlanSchema, DP_DEFAULTS } from "./daily-plan";
import {
  getSalesAssistSettings, getP1Settings, saveP1Settings, saveSalesAssistSettings, validateP1Settings, validateSettings as validateAssistSettings,
  P1_SETTING_KEYS, SALES_ASSIST_SIGNALS, SALES_ASSIST_DEFAULTS, P1_DEFAULTS,
} from "./sales-assist";
import {
  getDefaultOwnerConfig, intakeDistHookInstalled, legacyDefaultOwnerDecision, saveDefaultOwnerConfig, setIntakeDistHook, validateDefaultOwnerConfig,
  REGISTRATION_SOURCES, type OwnerDecision, type RegistrationSource,
} from "./default-owner-rule";
import { defaultSourceBySeller, saveIntakeSetting, validateDefaultSourceBySeller, LEAD_SOURCES } from "./lead-intake";
import { disableBlockedByIntakeMessage } from "./multi-team";
import { disableTeam, enableTeam, type MemberInput } from "./sales-teams-admin";
import {
  ensureSmcSchema, fa, loadDoc, metaOf, relWhen, routeLead, samMerged, SMC_NEVER_USER, type DistDoc, type DistRule, type TeamsDoc,
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

/* ---------------- live writes: sales_teams (+ members on deactivate, old behavior) ---------------- */
type MemberRow = { salesperson_id: number; is_lead: number; owns_none: number; owns_p1: number; owns_p2: number; owns_p3: number; sort_order: number };
const memberRows = (teamId: number): MemberInput[] => queryRows<MemberRow>(
  "SELECT salesperson_id, is_lead, owns_none, owns_p1, owns_p2, owns_p3, sort_order FROM sales_team_members WHERE team_id=? ORDER BY sort_order, salesperson_id", [teamId])
  .map((m) => ({ salespersonId: Number(m.salesperson_id), isLead: m.is_lead === 1, ownsNone: m.owns_none === 1, ownsP1: m.owns_p1 === 1, ownsP2: m.owns_p2 === 1, ownsP3: m.owns_p3 === 1, sortOrder: Number(m.sort_order) }));
function lastRemovedMembers(teamId: number): MemberInput[] {
  for (const r of queryRows<{ before_json: string; after_json: string }>("SELECT before_json, after_json FROM smc_audit WHERE section='teams_live' ORDER BY id DESC LIMIT 200")) {
    try {
      const b = JSON.parse(r.before_json); const a = JSON.parse(r.after_json);
      if (Number(b.id) === teamId && b.enabled === true && a.enabled === false) return Array.isArray(b.members) ? b.members : [];
    } catch { /* skip */ }
  }
  return [];
}
export type TeamWritePatch = { name?: unknown; enabled?: unknown; preview?: unknown; members?: MemberInput[] };
export type TeamWriteResult =
  | { ok: true; team: LiveTeam; auditId: number; preview?: false; removed?: string[] }
  | { ok: true; preview: true; teamId: number; name: string; removed: string[]; blocked: string | null; returning: string[] }
  | { ok: false; status: number; error: string; message: string };
/**
 * Rename: sales_teams.name/updated_at. Deactivate (t358s1318 §3 = the old disableTeam): sales_team_members rows of that team are
 * DELETED, sales_teams.enabled=0, sales_team_membership_history closed (syncTeamMembershipHistory 'disable'); the removed members are
 * kept in smc_audit.before_json so «برگرداندن» puts them back. Reactivate: sales_teams.enabled=1 (+ members only when undoing).
 * preview:true → nothing is written; returns who would leave the team (the confirm step).
 */
export function samWriteTeam(u: AuthUser, teamId: number, patch: TeamWritePatch, now = new Date()): TeamWriteResult {
  if (!samMerged()) return { ok: false, status: 404, error: "merge_off", message: "ادغام «مدیریت فروش» روشن نیست." };
  const row = queryRow<{ id: number; name: string; enabled: number }>("SELECT id, name, enabled FROM sales_teams WHERE id=?", [teamId]);
  if (!row) return { ok: false, status: 404, error: "not_found", message: "تیم پیدا نشد." };
  const wasEnabled = Number(row.enabled) === 1;
  let name = row.name; let enabled = wasEnabled;
  if (patch.name !== undefined) {
    name = String(patch.name ?? "").trim();
    if (!name) return { ok: false, status: 400, error: "invalid_name", message: "نام تیم را بنویسید." };
    if (name.length > 40) return { ok: false, status: 400, error: "invalid_name", message: "نام تیم بلند است." };
    if (queryRow("SELECT 1 x FROM sales_teams WHERE name=? AND id<>?", [name, teamId])) return { ok: false, status: 409, error: "duplicate_name", message: "تیمی با همین نام هست." };
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return { ok: false, status: 400, error: "invalid_enabled", message: "وضعیت تیم معتبر نیست." };
    enabled = patch.enabled;
  }
  const members0 = memberRows(teamId);
  const removedNames = members0.map((m) => spName(m.salespersonId));
  if (patch.preview === true) {
    return { ok: true, preview: true, teamId, name: row.name, removed: wasEnabled && !enabled ? removedNames : [], blocked: wasEnabled && !enabled ? disableBlockedByIntakeMessage(teamId) : null,
      returning: !wasEnabled && enabled ? (patch.members ?? lastRemovedMembers(teamId)).map((m) => spName(m.salespersonId)) : [] };
  }
  if (name === row.name && enabled === wasEnabled) return { ok: true, team: samLiveValues().teams.find((t) => t.id === teamId)!, auditId: 0 };
  const at = now.toISOString();
  const parts: string[] = [];
  if (name !== row.name) parts.push(`نام «${row.name}» → «${name}»`);
  if (name !== row.name) execute("UPDATE sales_teams SET name=?, updated_at=? WHERE id=?", [name, at, teamId]);
  let after: LiveMember[] | MemberInput[] = members0;
  if (wasEnabled && !enabled) {
    const r = disableTeam(teamId, now);
    if (!r.ok) {
      if (name !== row.name) execute("UPDATE sales_teams SET name=?, updated_at=? WHERE id=?", [row.name, at, teamId]);
      return { ok: false, status: r.status, error: r.error, message: r.message };
    }
    parts.push(removedNames.length ? `غیرفعال شد؛ ${removedNames.join("، ")} از تیم بیرون آمدند` : "غیرفعال شد");
    after = [];
  } else if (!wasEnabled && enabled) {
    // No members given: bring back the members the last deactivation removed (the old validator needs 2–4 members per team).
    const members = patch.members ?? lastRemovedMembers(teamId);
    // enableTeam also switches on the team-1 panel flags (call_queue_settings flag.*.user.<id>) for the members' users. They are coming
    // back to the state they had, so those per-user keys are put back exactly as they were before (no feature turns on as a side effect).
    const uids = members.length ? queryRows<{ id: number }>(`SELECT id FROM users WHERE salesperson_id IN (${members.map(() => "?").join(",")})`, members.map((m) => m.salespersonId)).map((x) => Number(x.id)) : [];
    const flagRows = () => uids.length ? queryRows<{ key: string; value: string; updated_by: number | null; updated_at: string }>(
      `SELECT key, value, updated_by, updated_at FROM call_queue_settings WHERE key LIKE 'flag.%' AND (${uids.map(() => "key LIKE ?").join(" OR ")})`, uids.map((id) => `flag.%.user.${id}`)) : [];
    const flags0 = flagRows();
    const r = enableTeam(teamId, members, now);
    if (r.ok) {
      const flags1 = flagRows();
      for (const f of flags1) {
        const o = flags0.find((x) => x.key === f.key);
        if (!o) execute("DELETE FROM call_queue_settings WHERE key=?", [f.key]);
        else if (o.value !== f.value || o.updated_at !== f.updated_at) execute("UPDATE call_queue_settings SET value=?, updated_by=?, updated_at=? WHERE key=?", [o.value, o.updated_by, o.updated_at, f.key]);
      }
    }
    if (!r.ok) {
      if (name !== row.name) execute("UPDATE sales_teams SET name=?, updated_at=? WHERE id=?", [row.name, at, teamId]);
      return { ok: false, status: r.status, error: r.error, message: r.message };
    }
    parts.push(members.length ? `فعال شد؛ ${members.map((m) => spName(m.salespersonId)).join("، ")} برگشتند` : "فعال شد");
    after = members;
  }
  const auditId = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
    [at, u.id, "teams_live", `${row.name}: ${parts.join("، ")}`,
      JSON.stringify({ id: teamId, name: row.name, enabled: wasEnabled, members: members0 }), JSON.stringify({ id: teamId, name, enabled, members: after })]);
  return { ok: true, team: samLiveValues().teams.find((t) => t.id === teamId)!, auditId, removed: wasEnabled && !enabled ? removedNames : [] };
}
/** «برگرداندن» of a teams_live row: name/enabled back; undoing a deactivation puts the removed members back (a new audited change). */
export function samRevertTeam(u: AuthUser, auditId: number, now = new Date()) {
  const r = queryRow<{ before_json: string; after_json: string; section: string }>("SELECT before_json, after_json, section FROM smc_audit WHERE id=?", [auditId]);
  if (!r || r.section !== "teams_live") return { ok: false as const, status: 404, error: "not_found", message: "این تغییر پیدا نشد." };
  const b = JSON.parse(r.before_json) as { id: number; name: string; enabled: boolean; members?: MemberInput[] };
  const a = JSON.parse(r.after_json) as { enabled: boolean };
  const res = samWriteTeam(u, b.id, { name: b.name, enabled: b.enabled, ...(b.enabled && !a.enabled ? { members: b.members ?? [] } : {}) }, now);
  if (res.ok && !res.preview && res.auditId) execute("UPDATE smc_audit SET revert_of=? WHERE id=?", [auditId, res.auditId]);
  return res;
}

/* ---------------- intake follows the distribution rules (t358s1318 §1) ---------------- */
function readDoc<T>(section: string): T | null {
  try { const r = queryRow<{ payload_json: string }>("SELECT payload_json FROM smc_settings WHERE section=?", [section]); return r ? JSON.parse(r.payload_json) as T : null; }
  catch { return null; }
}
/**
 * The owner decision from the console's explicit distribution rules (level 1 AND level 2 rule hit). null = no explicit rule
 * matched (or a flag is OFF) → the old «قانون ثبت مشتری» decides. Pure read: commit=false, no counters, no smc_dist_log.
 * Lead fields at intake: registrar (users.id) and reg_source (registration source) — the converted rule's fields.
 */
export function samDistDecision(source: RegistrationSource | string, registrarUserId: number | null | undefined, docs?: { teams: TeamsDoc; dist: DistDoc }): (OwnerDecision & { apply: true }) | null {
  if (!docs && !samMerged()) return null;
  const teams = docs?.teams ?? readDoc<TeamsDoc>("teams"); const dist = docs?.dist ?? readDoc<DistDoc>("dist");
  if (!teams || !dist || !Array.isArray(dist.team?.rules) || !dist.team.rules.length) return null;
  const r = routeLead({ registrar: registrarUserId == null ? "" : String(registrarUserId), reg_source: String(source) }, { commit: false, teams, dist });
  if (r.teamRule == null || r.memberRule == null || !r.expertId) return null;
  const sp = teams.experts.find((e) => e.id === r.expertId)?.salespersonId;
  if (sp == null) return null;
  const act = queryRow<{ active: number }>("SELECT active FROM salespersons WHERE id=?", [sp]);
  if (!act || Number(act.active) !== 1) return null;
  return { apply: true, ownerSalespersonId: Number(sp), via: "dist", ruleId: dist.team.rules[r.teamRule - 1]?.id };
}
setIntakeDistHook((source, registrar) => samDistDecision(source, registrar));
export function samIntakeFollowsDist(): { active: boolean; merged: boolean; hook: boolean } {
  const merged = samMerged(); const hook = intakeDistHookInstalled();
  return { active: merged && hook, merged, hook };
}
/** Every registration source × every registrar (+ none): the owner after the conversion must equal today's «قانون ثبت» owner. */
export function samConversionParity(teams: TeamsDoc, nextDist: DistDoc): { ok: boolean; cases: number; mismatches: string[] } {
  const cfg = getDefaultOwnerConfig(); const off = { ...cfg, enabled: false };
  const regs: (number | null)[] = [null, ...queryRows<{ id: number }>(`SELECT id FROM users WHERE id<>${SMC_NEVER_USER} ORDER BY id`).map((x) => Number(x.id))];
  const mismatches: string[] = []; let cases = 0;
  for (const src of Object.keys(REGISTRATION_SOURCES) as RegistrationSource[]) for (const reg of regs) {
    cases++;
    const today = legacyDefaultOwnerDecision(src, reg, cfg);
    const d = samDistDecision(src, reg, { teams, dist: nextDist });
    const after = d ?? legacyDefaultOwnerDecision(src, reg, off);
    const a = today.apply ? today.ownerSalespersonId : null; const b = after.apply ? after.ownerSalespersonId : null;
    if (a !== b) mismatches.push(`${src}/${reg ?? "-"}: ${a ?? "-"}→${b ?? "-"}`);
  }
  return { ok: mismatches.length === 0, cases, mismatches };
}

/* ---------------- §6-22: «قانون ثبت مشتری» → distribution rules (designed; gated; never run on live without Mohammad) ---------------- */
export const CONVERSION_RULE_ID = "conv-default-owner";
export type ConversionWrite = { table: string; key: string; before: unknown; after: unknown; note: string };
export function samConversionPlan(): { applicable: boolean; reason: string; teamRule: DistRule | null; memberRule: { teamId: string; rule: DistRule } | null; writes: ConversionWrite[]; blockers: string[]; untouched: string[];
  intakeFollowsDist?: boolean; parity?: { ok: boolean; cases: number; mismatches: string[] } } {
  ensureSmcSchema();
  const cfg = getDefaultOwnerConfig(); const dist = loadDoc("dist"); const teams = loadDoc("teams");
  const untouched = ["notification_settings (team_sales_config)", "sales_team_members", "sales_intake_shares", "sales_intake_split", "lead_intake_settings (منبع پیش‌فرض فرم)", "call_queue_settings", "sales_assist_settings", "customers"];
  if (!cfg.enabled) return { applicable: false, reason: "قانون ثبت خاموش است؛ چیزی برای تبدیل نیست.", teamRule: null, memberRule: null, writes: [], blockers: [], untouched, intakeFollowsDist: samIntakeFollowsDist().active };
  const sp = Number(cfg.ownerSalespersonId);
  const expert = teams.experts.find((e) => e.salespersonId === sp) ?? null;
  const liveTeam = queryRow<{ team_id: number }>("SELECT m.team_id FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1 WHERE m.salesperson_id=? LIMIT 1", [sp]);
  const teamId = expert?.teamId ?? (liveTeam ? `t${liveTeam.team_id}` : null);
  const conds = [
    { field: "registrar", values: cfg.registrarMode === "all" ? ["*"] : cfg.registrarUserIds.filter((id) => id !== SMC_NEVER_USER).map(String) },
    { field: "reg_source", values: cfg.sourceMode === "all" ? ["*"] : cfg.sources.map(String) },
  ];
  const follows = samIntakeFollowsDist();
  const blockers: string[] = [];
  if (!follows.active) blockers.push("ثبت مشتری هنوز از قانون‌های تقسیم پیروی نمی‌کند (هر دو پرچم باید روشن باشد). تا آن موقع تبدیل اجرا نمی‌شود، چون خاموش شدن قانون ثبت مشتری‌های تازه را از کارشناس مقصد جدا می‌کند.");
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
  const parity = teamRule && memberRule ? samConversionParity(teams, nextDist) : { ok: false, cases: 0, mismatches: [] as string[] };
  if (teamRule && memberRule && !parity.ok) blockers.push(`بعد از تبدیل، ${fa(parity.mismatches.length)} حالت از ${fa(parity.cases)} حالت ثبت به کارشناس دیگری می‌رسد (${parity.mismatches.slice(0, 3).join("، ")})؛ تبدیل اجرا نمی‌شود.`);
  const { updatedAt: _a, updatedByUserId: _b, ...cfgPlain } = cfg as any;
  const writes: ConversionWrite[] = [
    { table: "smc_settings", key: "section='dist' (payload_json, version+1, updated_by, updated_at)", before: { teamRules: dist.team.rules.length, memberRules: memberRule ? (dist.member[memberRule.teamId]?.rules.length ?? 0) : 0 }, after: { teamRules: nextDist.team.rules.length, memberRules: memberRule ? nextDist.member[memberRule.teamId]!.rules.length : 0 }, note: "قانون ۱ بین تیم‌ها و قانون ۱ داخل تیم مقصد: «ثبت‌کننده و منبع مثل قانون ثبت → مستقیم به کارشناس مقصد»" },
    { table: "smc_audit", key: "1 new row, section='dist'", before: null, after: "تبدیل قانون ثبت به قانون تقسیم", note: "با «برگرداندن» قابل برگشت" },
    { table: "default_owner_rule_settings", key: "key='config' (value, updated_at, updated_by_user_id)", before: cfgPlain, after: { ...cfgPlain, enabled: false }, note: "فقط enabled عوض می‌شود؛ مقصد و ثبت‌کننده و منبع برای برگشت می‌مانند" },
    { table: "default_owner_rule_settings_log", key: "1 new row (old_value, new_value, actor_user_id, via='smc_merge_conversion', created_at)", before: null, after: "log", note: "" },
  ];
  return { applicable: Boolean(teamRule && memberRule), reason: already ? "قانون تبدیل‌شده از قبل در قانون‌های تقسیم هست." : "", teamRule, memberRule, writes, blockers, untouched,
    intakeFollowsDist: follows.active, parity };
}
/** Library only (no route). approvedBy must be Mohammad's own card id; refused while either flag is OFF. Idempotent. */
export function samApplyConversion(u: AuthUser, approval: { approvedBy: string }, now = new Date()) {
  // Order (t358s1318): the conversion runs only AFTER intake follows the distribution rules (both flags ON + this build's hook).
  if (!samIntakeFollowsDist().active) return { ok: false as const, error: "intake_not_following_dist" };
  if (!approval?.approvedBy || !/^t\d+[us]/.test(approval.approvedBy)) return { ok: false as const, error: "approval_required" };
  const d0 = loadDoc("dist");
  if (d0.team.rules.some((r) => r.id === CONVERSION_RULE_ID) && !getDefaultOwnerConfig().enabled) return { ok: true as const, changed: false };
  const plan = samConversionPlan();
  if (!plan.applicable) return { ok: false as const, error: "not_applicable", reason: plan.reason || plan.blockers.join(" ") };
  if (plan.blockers.length) return { ok: false as const, error: "blocked", reason: plan.blockers.join(" ") };
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

/* ---------------- the four folded sections become editable (t358s1318 §2) ----------------
 * Each save goes through the SAME validator + saver the old page's PUT uses (same tables, same log rows), plus one smc_audit row
 * (section merge_<key>, before/after = the raw rows) so «برگرداندن» can put the raw rows back exactly. Who: the old pages' check
 * (role admin incl. sales manager, never user 29) AND the merged page's access. None of them writes notification_settings / team_sales_config.
 */
export const SAM_FOLD_KEYS = ["daily", "capacity", "model", "discipline", "owner"] as const;
export type SamFoldKey = typeof SAM_FOLD_KEYS[number];
export const isFoldKey = (k: unknown): k is SamFoldKey => typeof k === "string" && (SAM_FOLD_KEYS as readonly string[]).includes(k);
const DS_ROW_KEYS = ["on_time_min", "on_time_cap_min", "new_customer_pct", "new_customer_max_overdue", "restrict_overdue", "alert_days", "w_report", "w_overdue", "w_nocall", "drop_pct", "transfer_mode", "excluded_receivers"].map((k) => `ds.${k}`);
type RawRef = { table: string; keyCol: string; key: string | number; cols: string[] };
const cqs = (key: string): RawRef => ({ table: "call_queue_settings", keyCol: "key", key, cols: ["value", "updated_by", "updated_at"] });
const RAW: Record<Exclude<SamFoldKey, "capacity">, RawRef[]> = {
  daily: ["dp.guardPct", "dp.waitMin", "dp.firstDayCapacity"].map(cqs),
  model: [...["order", "new_red_hours", "p1_stale_days", "na_template"].map(cqs),
    { table: "sales_assist_settings", keyCol: "id", key: 1, cols: ["settings_json", "updated_at", "updated_by_user_id"] },
    ...Object.values(P1_SETTING_KEYS).map((key) => ({ table: "assistant_settings", keyCol: "key", key, cols: ["value", "updated_at", "updated_by_user_id"] }))],
  discipline: DS_ROW_KEYS.map(cqs),
  owner: [{ table: "default_owner_rule_settings", keyCol: "key", key: "config", cols: ["value", "updated_at", "updated_by_user_id"] },
    { table: "lead_intake_settings", keyCol: "key", key: "default_source_by_seller", cols: ["value", "updated_at", "updated_by_user_id"] }],
};
/** Exactly what each section writes — shown on the page and in the report. */
export const SAM_FOLD_WRITES: Record<SamFoldKey, { table: string; keys: string }[]> = {
  daily: [{ table: "call_queue_settings", keys: "dp.guardPct, dp.waitMin, dp.firstDayCapacity" }, { table: "call_queue_settings_log", keys: "۱ ردیف برای هر کلید عوض‌شده" }],
  capacity: [{ table: "dp_capacity_log", keys: "۱ ردیف (kind=admin)" }, { table: "assistant_events", keys: "daily_plan.capacity_override برای دستیار کارشناس؛ اگر خارج از حد بود برای دستیار مدیرها هم" },
    { table: "site_notification_events", keys: "فقط اگر خارج از حد بود: زنگوله‌ی daily_plan_capacity_override برای مدیرها (نه کاربر ۲۹)" }],
  model: [{ table: "call_queue_settings", keys: "order, new_red_hours, p1_stale_days, na_template" }, { table: "call_queue_settings_log", keys: "۱ ردیف برای هر کلید عوض‌شده" },
    { table: "sales_assist_settings", keys: "id=1 (settings_json: levels, snoozeHours)" }, { table: "assistant_settings", keys: "sales_assist_p1_quota, sales_assist_p1_red_days" }],
  discipline: [{ table: "call_queue_settings", keys: DS_ROW_KEYS.join(", ") }, { table: "call_queue_settings_log", keys: "۱ ردیف برای هر کلید عوض‌شده" }],
  owner: [{ table: "default_owner_rule_settings", keys: "key=config" }, { table: "default_owner_rule_settings_log", keys: "۱ ردیف (via=sales_admin_page)" },
    { table: "lead_intake_settings", keys: "key=default_source_by_seller" }, { table: "lead_intake_settings_log", keys: "۱ ردیف (via=sales_admin_page)" }],
};
const tableExists = (t: string) => Boolean(queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [t]));
function rawSnap(refs: RawRef[]): Record<string, Record<string, unknown> | null> {
  const out: Record<string, Record<string, unknown> | null> = {};
  for (const r of refs) {
    const row = tableExists(r.table) ? queryRow<Record<string, unknown>>(`SELECT ${r.cols.join(",")} FROM ${r.table} WHERE ${r.keyCol}=?`, [r.key]) : undefined;
    out[`${r.table}:${r.key}`] = row ? JSON.parse(JSON.stringify(row)) : null;
  }
  return out;
}
export const samCanWriteFolded = (u: AuthUser | null | undefined) => Boolean(u && samMerged() && cqManager(u as any) && Number(u.id) !== SMC_NEVER_USER);
type FoldResult = { ok: true; changed: boolean; auditId: number; values: LiveValues; preview?: unknown } | { ok: false; status: number; error: string; message: string };
const bad = (message: string, status = 422, error = "invalid"): FoldResult => ({ ok: false, status, error, message });
/** Validate everything first, then save with the old savers. */
function foldSave(key: Exclude<SamFoldKey, "capacity">, body: any, userId: number): FoldResult | true {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("مقدارها نامعتبر است.");
  if (key === "daily") {
    ensureDailyPlanSchema(); const v = dpValidateSettings(body); if (!v.ok) return bad(v.error);
    dpSaveSettings(v.value, userId); return true;
  }
  if (key === "discipline") {
    const v = validateDiscipline(body); if (!v.ok) return bad(v.error);
    saveDiscipline(v.value, userId); return true;
  }
  if (key === "model") {
    const q = body.queue != null ? validateCqSettings(body.queue) : null; if (q && !q.ok) return bad(q.error);
    const a = body.assist != null ? validateAssistSettings(body.assist) : null; if (a && !a.ok) return bad(a.error);
    const p = body.p1 != null ? validateP1Settings(body.p1) : null; if (p && !p.ok) return bad(p.error);
    if (!q && !a && !p) return bad("چیزی برای ذخیره نیست.");
    runImmediateTransaction(() => {
      if (q && q.ok) saveCqSettings(q.value, userId);
      if (a && a.ok) saveSalesAssistSettings(a.settings, userId);
      if (p && p.ok && p.values.length) saveP1Settings(p.values, userId);
    });
    return true;
  }
  const c = body.config != null ? validateDefaultOwnerConfig(body.config) : null; if (c && !c.ok) return bad(c.error);
  const d = body.defaultSourceBySeller != null ? validateDefaultSourceBySeller(crmDb, body.defaultSourceBySeller) : null; if (d && !d.ok) return bad(d.error);
  if (!c && !d) return bad("چیزی برای ذخیره نیست.");
  runImmediateTransaction(() => {
    if (c && c.ok) saveDefaultOwnerConfig(c.config, userId, "sales_admin_page");
    if (d && d.ok) saveIntakeSetting(crmDb, "default_source_by_seller", JSON.stringify(d.value), userId, "sales_admin_page");
  });
  return true;
}
const FOLD_FA: Record<SamFoldKey, string> = { daily: "لیست روزانه", capacity: "ظرفیت کارشناس", model: "مدل لیست و صف تماس", discipline: "نظم پیگیری و تحویل", owner: "مالک پیش‌فرض مشتری" };
export function samSaveFolded(u: AuthUser, key: SamFoldKey, body: any, now = new Date()): FoldResult {
  if (!samMerged()) return bad("ادغام «مدیریت فروش» روشن نیست.", 404, "merge_off");
  if (!samCanWriteFolded(u)) return bad("ذخیره‌ی این بخش فقط برای مدیر فروش و ادمین است.", 403, "no_access");
  const at = now.toISOString();
  if (key === "capacity") {
    ensureDailyPlanSchema();
    const sp = Number(body?.salespersonId); if (!Number.isInteger(sp) || sp <= 0) return bad("کارشناس را انتخاب کنید.", 400, "bad_type");
    const date = String(body?.date ?? "");
    const prev = dpCapacity(sp, date).capacity;
    const r: any = dpAdminCapacity(u as any, sp, date, { capacity: body?.capacity, reason: body?.reason, confirm: body?.confirm === true }, now);
    if (r && r.ok === false || r?.error) return bad(r.message ?? "ذخیره نشد.", r.status ?? 422, r.error ?? "invalid");
    if (r.preview) return { ok: true, changed: false, auditId: 0, values: samLiveValues(), preview: r };
    const auditId = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
      [at, u.id, "merge_capacity", `ظرفیت ${spName(sp)} برای ${fa(r.date)}: ${fa(String(prev ?? "—"))} → ${fa(String(r.capacity))}`,
        JSON.stringify({ salespersonId: sp, date: r.date, capacity: prev }), JSON.stringify({ salespersonId: sp, date: r.date, capacity: r.capacity, capLogId: r.id })]);
    return { ok: true, changed: true, auditId, values: samLiveValues(), preview: r };
  }
  const before = rawSnap(RAW[key]);
  const s = foldSave(key, body, Number(u.id));
  if (s !== true) return s;
  const after = rawSnap(RAW[key]);
  const changedKeys = Object.keys(after).filter((k) => JSON.stringify(after[k]?.[RAW[key].find((r) => `${r.table}:${r.key}` === k)!.cols[0]!] ?? null) !== JSON.stringify(before[k]?.[RAW[key].find((r) => `${r.table}:${r.key}` === k)!.cols[0]!] ?? null));
  if (!changedKeys.length) return { ok: true, changed: false, auditId: 0, values: samLiveValues() };
  const auditId = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json) VALUES(?,?,?,?,?,?)",
    [at, u.id, `merge_${key}`, `${FOLD_FA[key]}: ${fa(changedKeys.length)} مقدار عوض شد`, JSON.stringify(before), JSON.stringify(after)]);
  return { ok: true, changed: true, auditId, values: samLiveValues() };
}
/** «برگرداندن»: the raw rows go back exactly (absent before → deleted), with the same log tables the old pages write. */
export function samUndoFolded(u: AuthUser, auditId: number, now = new Date()): FoldResult {
  if (!samCanWriteFolded(u)) return bad("برگرداندن این بخش فقط برای مدیر فروش و ادمین است.", 403, "no_access");
  const a = queryRow<{ section: string; before_json: string; after_json: string }>("SELECT section, before_json, after_json FROM smc_audit WHERE id=?", [auditId]);
  if (!a || !a.section.startsWith("merge_") || !isFoldKey(a.section.slice(6))) return bad("این تغییر پیدا نشد.", 404, "not_found");
  const key = a.section.slice(6) as SamFoldKey; const at = now.toISOString(); const uid = Number(u.id);
  if (key === "capacity") {
    const b = JSON.parse(a.before_json) as { salespersonId: number; date: string; capacity: number | null };
    if (b.capacity == null) return bad("ظرفیت قبلی تنظیم نشده بود؛ برگرداندن به «بدون ظرفیت» از اینجا ممکن نیست.", 409, "no_previous");
    const r = samSaveFolded(u, "capacity", { salespersonId: b.salespersonId, date: b.date, capacity: b.capacity, reason: "برگرداندن از «مدیریت فروش»", confirm: true }, now);
    if (r.ok && r.auditId) execute("UPDATE smc_audit SET revert_of=? WHERE id=?", [auditId, r.auditId]);
    return r;
  }
  const before = JSON.parse(a.before_json) as Record<string, Record<string, unknown> | null>;
  const refs = RAW[key]; const cur = rawSnap(refs);
  let n = 0;
  runImmediateTransaction(() => {
    for (const r of refs) {
      const k = `${r.table}:${r.key}`; const b = before[k] ?? null; const c = cur[k] ?? null; const vc = r.cols[0]!;
      const bv = b ? (b[vc] as string | null) : null; const cv = c ? (c[vc] as string | null) : null;
      if (bv === cv) continue;
      n++;
      if (b == null) execute(`DELETE FROM ${r.table} WHERE ${r.keyCol}=?`, [r.key]);
      else if (r.table === "call_queue_settings") execute("INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at", [r.key, bv, uid, at]);
      else execute(`INSERT INTO ${r.table}(${r.keyCol},${vc},updated_at,updated_by_user_id) VALUES(?,?,?,?) ON CONFLICT(${r.keyCol}) DO UPDATE SET ${vc}=excluded.${vc}, updated_at=excluded.updated_at, updated_by_user_id=excluded.updated_by_user_id`, [r.key, bv, at, uid]);
      if (r.table === "call_queue_settings") execute("INSERT INTO call_queue_settings_log(key,old_value,new_value,user_id,at) VALUES(?,?,?,?,?)", [r.key, cv, bv, uid, at]);
      if (r.table === "default_owner_rule_settings") execute("INSERT INTO default_owner_rule_settings_log(old_value,new_value,actor_user_id,via,created_at) VALUES(?,?,?,?,?)", [cv, bv, uid, "sales_admin_undo", at]);
      if (r.table === "lead_intake_settings") execute("INSERT INTO lead_intake_settings_log(key,old_value,new_value,actor_user_id,via,created_at) VALUES(?,?,?,?,?,?)", [r.key, cv, bv, uid, "sales_admin_undo", at]);
    }
  });
  if (!n) return { ok: true, changed: false, auditId: 0, values: samLiveValues() };
  const id = execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json,revert_of) VALUES(?,?,?,?,?,?,?)",
    [at, uid, a.section, `${FOLD_FA[key]}: برگرداندن (${fa(n)} مقدار)`, JSON.stringify(cur), JSON.stringify(rawSnap(refs)), auditId]);
  return { ok: true, changed: true, auditId: id, values: samLiveValues() };
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
    conversion: { applicable: conv.applicable, reason: conv.reason, teamRule: conv.teamRule, memberRule: conv.memberRule, blockers: conv.blockers, writes: conv.writes.map((w) => ({ table: w.table, key: w.key, note: w.note })),
      intakeFollowsDist: conv.intakeFollowsDist ?? false, parity: conv.parity ?? null },
    writable: { teamName: true, teamEnabled: true, folded: true },
    foldWrites: SAM_FOLD_WRITES,
    intakeFollowsDist: samIntakeFollowsDist().active,
  };
}
