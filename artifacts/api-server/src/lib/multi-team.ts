/**
 * Multi-team sales model (flag.multi_team_v1, default OFF).
 *
 * Flag OFF: every helper here is a no-op pass-through to the legacy single-team
 * config (notification_settings.team_sales_config / team_sales_closer_cursor).
 * No writes to those keys happen in this module.
 *
 * Flag ON: teams come from sales_teams / sales_team_members.
 *  - 2–4 members, each salesperson in exactly one team, exactly one lead.
 *  - No fixed roles. The manager ticks priorities freely.
 *  - Every priority (none / 1 / 2 / 3) has an owner.
 *  - P1 may have one or two owners (rotation uses the per-team p1_cursor).
 *  - none / P2 / P3 have exactly one owner each.
 *  - Lead-split quotas (new customers + site leads) are per team.
 *  - Team-commission config is per team (team 2 is seeded at zero).
 *  - Future membership changes do not move existing customers.
 */
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import { mergeTeamSalesConfig, type TeamSalesConfig } from "./team-sales-rules";

export const MT_FLAG = "flag.multi_team_v1";
export const LEGACY_TEAM_SALES_CONFIG_KEY = "team_sales_config";
export const LEGACY_TEAM_SALES_CURSOR_KEY = "team_sales_closer_cursor";

export type CallPriority = 1 | 2 | 3 | null;
export type TeamMemberRow = {
  teamId: number;
  salespersonId: number;
  isLead: boolean;
  ownsNone: boolean;
  ownsP1: boolean;
  ownsP2: boolean;
  ownsP3: boolean;
  sortOrder: number;
};
export type SalesTeam = {
  id: number;
  name: string;
  enabled: boolean;
  leadSplitQuota: number;
  p1Cursor: number;
  commissionJson: string;
  members: TeamMemberRow[];
};

export type MultiTeamValidationError = { field: string; message: string };

export function mtFlagOn(): boolean {
  try {
    return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [MT_FLAG])?.value === "1";
  } catch { return false; }
}

export function readLegacyTeamSalesConfig(): TeamSalesConfig {
  const row = queryRow<{ value: string }>("SELECT value FROM notification_settings WHERE key=?", [LEGACY_TEAM_SALES_CONFIG_KEY]);
  if (!row) return mergeTeamSalesConfig(null);
  try { return mergeTeamSalesConfig(JSON.parse(row.value)); } catch { return mergeTeamSalesConfig(null); }
}

export function readLegacyCloserCursor(): number {
  const raw = queryRow<{ value: string }>("SELECT value FROM notification_settings WHERE key=?", [LEGACY_TEAM_SALES_CURSOR_KEY]);
  return Math.max(0, Number.parseInt(raw?.value ?? "0", 10) || 0);
}

/* ---------------- schema + idempotent seed ---------------- */

let schemaReady = false;
export function ensureMultiTeamSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS sales_teams (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      lead_split_quota INTEGER NOT NULL DEFAULT 0,
      p1_cursor INTEGER NOT NULL DEFAULT 0,
      commission_json TEXT NOT NULL DEFAULT '{"mode":"zero"}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_team_members (
      team_id INTEGER NOT NULL REFERENCES sales_teams(id) ON DELETE CASCADE,
      salesperson_id INTEGER NOT NULL,
      is_lead INTEGER NOT NULL DEFAULT 0,
      owns_none INTEGER NOT NULL DEFAULT 0,
      owns_p1 INTEGER NOT NULL DEFAULT 0,
      owns_p2 INTEGER NOT NULL DEFAULT 0,
      owns_p3 INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (team_id, salesperson_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_team_members_salesperson
      ON sales_team_members(salesperson_id);
    CREATE TABLE IF NOT EXISTS sales_lead_split_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cursor_index INTEGER NOT NULL DEFAULT 0,
      cursor_used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  schemaReady = true;
}

/** Idempotent seed of team 1 (from legacy config + cursor) and team 2. Never writes notification_settings. */
export function seedMultiTeamIfNeeded(now = new Date()): { seeded: string[] } {
  ensureMultiTeamSchema();
  const at = now.toISOString();
  const seeded: string[] = [];
  const legacy = readLegacyTeamSalesConfig();
  const cursor = readLegacyCloserCursor();
  const qualifier = Number(legacy.qualifierSalespersonId) || 6;
  const closers = (legacy.closerSalespersonIds || [3, 4]).map(Number);

  if (!queryRow("SELECT 1 x FROM sales_teams WHERE id=1")) {
    execute(
      `INSERT INTO sales_teams(id,name,enabled,lead_split_quota,p1_cursor,commission_json,created_at,updated_at)
       VALUES(1,?,1,1,?,'{"mode":"inherit"}',?,?)`,
      ["تیم ۱ — کاظمی، حسنی، قاسمی", cursor, at, at],
    );
    execute(
      `INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order)
       VALUES(1,?,1,1,0,1,1,0)`,
      [qualifier],
    );
    closers.forEach((sp, i) => {
      execute(
        `INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order)
         VALUES(1,?,0,0,1,0,0,?)`,
        [sp, i + 1],
      );
    });
    seeded.push("team1");
  }

  if (!queryRow("SELECT 1 x FROM sales_teams WHERE id=2")) {
    execute(
      `INSERT INTO sales_teams(id,name,enabled,lead_split_quota,p1_cursor,commission_json,created_at,updated_at)
       VALUES(2,?,?,0,0,'{"mode":"zero"}',?,?)`,
      ["تیم ۲ — خردکار، اصلانیان", 1, at, at],
    );
    // خردکار (sp 20) lead + none/P2/P3; اصلانیان (sp 5) P1 only.
    execute(`INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order)
             VALUES(2,20,1,1,0,1,1,0)`);
    execute(`INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order)
             VALUES(2,5,0,0,1,0,0,1)`);
    seeded.push("team2");
  }

  if (!queryRow("SELECT 1 x FROM sales_lead_split_state WHERE id=1")) {
    execute("INSERT INTO sales_lead_split_state(id,cursor_index,cursor_used,updated_at) VALUES(1,0,0,?)", [at]);
    seeded.push("lead_split_state");
  }
  return { seeded };
}

export function migrateMultiTeam(now = new Date()) {
  ensureMultiTeamSchema();
  const seeded = seedMultiTeamIfNeeded(now);
  installAssistantBellGuard(crmDb);
  return seeded;
}

/* ---------------- load / validate ---------------- */

function rowToMember(r: {
  team_id: number; salesperson_id: number; is_lead: number;
  owns_none: number; owns_p1: number; owns_p2: number; owns_p3: number; sort_order: number;
}): TeamMemberRow {
  return {
    teamId: Number(r.team_id),
    salespersonId: Number(r.salesperson_id),
    isLead: Number(r.is_lead) === 1,
    ownsNone: Number(r.owns_none) === 1,
    ownsP1: Number(r.owns_p1) === 1,
    ownsP2: Number(r.owns_p2) === 1,
    ownsP3: Number(r.owns_p3) === 1,
    sortOrder: Number(r.sort_order),
  };
}

function loadMembers(teamId: number): TeamMemberRow[] {
  return queryRows<{
    team_id: number; salesperson_id: number; is_lead: number;
    owns_none: number; owns_p1: number; owns_p2: number; owns_p3: number; sort_order: number;
  }>(
    `SELECT team_id, salesperson_id, is_lead, owns_none, owns_p1, owns_p2, owns_p3, sort_order
     FROM sales_team_members WHERE team_id=? ORDER BY sort_order, salesperson_id`,
    [teamId],
  ).map(rowToMember);
}

export function loadTeam(id: number): SalesTeam | null {
  ensureMultiTeamSchema();
  const t = queryRow<{
    id: number; name: string; enabled: number; lead_split_quota: number; p1_cursor: number; commission_json: string;
  }>("SELECT id,name,enabled,lead_split_quota,p1_cursor,commission_json FROM sales_teams WHERE id=?", [id]);
  if (!t) return null;
  return {
    id: Number(t.id),
    name: t.name,
    enabled: Number(t.enabled) === 1,
    leadSplitQuota: Number(t.lead_split_quota),
    p1Cursor: Number(t.p1_cursor) || 0,
    commissionJson: t.commission_json || '{"mode":"zero"}',
    members: loadMembers(Number(t.id)),
  };
}

export function loadAllTeams(): SalesTeam[] {
  ensureMultiTeamSchema();
  return queryRows<{ id: number }>("SELECT id FROM sales_teams ORDER BY id").map((r) => loadTeam(Number(r.id))!);
}

export function validateTeamMembers(members: TeamMemberRow[], opts: { otherTeamSalespersonIds?: Set<number> } = {}): MultiTeamValidationError[] {
  const errors: MultiTeamValidationError[] = [];
  if (members.length < 2 || members.length > 4) {
    errors.push({ field: "members", message: "هر تیم باید ۲ تا ۴ عضو داشته باشد." });
  }
  const leads = members.filter((m) => m.isLead);
  if (leads.length !== 1) errors.push({ field: "is_lead", message: "هر تیم باید دقیقاً یک سرپرست داشته باشد." });
  const seen = new Set<number>();
  for (const m of members) {
    if (seen.has(m.salespersonId)) errors.push({ field: "salesperson_id", message: `کارشناس ${m.salespersonId} دوبار در تیم آمده است.` });
    seen.add(m.salespersonId);
    if (opts.otherTeamSalespersonIds?.has(m.salespersonId)) {
      errors.push({ field: "salesperson_id", message: `کارشناس ${m.salespersonId} در تیم دیگری عضو است.` });
    }
  }
  const owners = {
    none: members.filter((m) => m.ownsNone),
    1: members.filter((m) => m.ownsP1),
    2: members.filter((m) => m.ownsP2),
    3: members.filter((m) => m.ownsP3),
  };
  if (owners.none.length !== 1) errors.push({ field: "owns_none", message: "اولویت «بدون اولویت» باید دقیقاً یک صاحب داشته باشد." });
  if (owners[2].length !== 1) errors.push({ field: "owns_p2", message: "اولویت ۲ باید دقیقاً یک صاحب داشته باشد." });
  if (owners[3].length !== 1) errors.push({ field: "owns_p3", message: "اولویت ۳ باید دقیقاً یک صاحب داشته باشد." });
  if (owners[1].length < 1 || owners[1].length > 2) {
    errors.push({ field: "owns_p1", message: "اولویت ۱ باید یک یا دو صاحب داشته باشد." });
  }
  return errors;
}

export function validateStoredTeam(team: SalesTeam): MultiTeamValidationError[] {
  const others = new Set(
    queryRows<{ salesperson_id: number }>(
      "SELECT salesperson_id FROM sales_team_members WHERE team_id<>?",
      [team.id],
    ).map((r) => Number(r.salesperson_id)),
  );
  return validateTeamMembers(team.members, { otherTeamSalespersonIds: others });
}

/* ---------------- resolver ---------------- */

export function teamOfSalesperson(salespersonId: number | null | undefined): SalesTeam | null {
  if (salespersonId == null || !Number.isInteger(Number(salespersonId))) return null;
  ensureMultiTeamSchema();
  const row = queryRow<{ team_id: number }>(
    "SELECT team_id FROM sales_team_members WHERE salesperson_id=?",
    [Number(salespersonId)],
  );
  return row ? loadTeam(Number(row.team_id)) : null;
}

export function teamOfCustomer(customerId: number): SalesTeam | null {
  const c = queryRow<{ salesperson_id: number | null }>(
    "SELECT salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL",
    [customerId],
  );
  if (!c || c.salesperson_id == null) return null;
  return teamOfSalesperson(Number(c.salesperson_id));
}

export function ownerForPriority(team: SalesTeam, priority: CallPriority): number | null {
  const pred =
    priority == null ? ((m: TeamMemberRow) => m.ownsNone) :
    priority === 1 ? ((m: TeamMemberRow) => m.ownsP1) :
    priority === 2 ? ((m: TeamMemberRow) => m.ownsP2) :
    ((m: TeamMemberRow) => m.ownsP3);
  const owners = team.members.filter(pred).sort((a, b) => a.sortOrder - b.sortOrder || a.salespersonId - b.salespersonId);
  if (!owners.length) return null;
  if (priority === 1 && owners.length === 2) {
    const active = activeInOrder(owners.map((m) => m.salespersonId));
    if (!active.length) return null;
    return active[team.p1Cursor % active.length];
  }
  return owners[0].salespersonId;
}

function activeInOrder(ids: number[]): number[] {
  if (!ids.length) return [];
  const active = new Set(queryRows<{ id: number }>(
    `SELECT id FROM salespersons WHERE active=1 AND id IN (${ids.map(() => "?").join(",")})`,
    ids,
  ).map((r) => Number(r.id)));
  return ids.filter((id) => active.has(id));
}

/** Advance the per-team P1 cursor. Must run inside a write transaction. Does not touch notification_settings. */
export function nextP1Owner(team: SalesTeam): number {
  const owners = team.members.filter((m) => m.ownsP1).sort((a, b) => a.sortOrder - b.sortOrder || a.salespersonId - b.salespersonId);
  const order = activeInOrder(owners.map((m) => m.salespersonId));
  if (!order.length) throw new Error("هیچ کارشناس اولویت ۱ فعالی در این تیم تعریف نشده است.");
  const fresh = queryRow<{ p1_cursor: number }>("SELECT p1_cursor FROM sales_teams WHERE id=?", [team.id]);
  const counter = Math.max(0, Number(fresh?.p1_cursor ?? team.p1Cursor) || 0);
  const chosen = order[counter % order.length];
  execute("UPDATE sales_teams SET p1_cursor=?, updated_at=? WHERE id=?", [counter + 1, new Date().toISOString(), team.id]);
  return chosen;
}

export function peekP1Owner(team: SalesTeam): { salespersonId: number; name: string } | null {
  const owners = team.members.filter((m) => m.ownsP1).sort((a, b) => a.sortOrder - b.sortOrder || a.salespersonId - b.salespersonId);
  const order = activeInOrder(owners.map((m) => m.salespersonId));
  if (!order.length) return null;
  const fresh = queryRow<{ p1_cursor: number }>("SELECT p1_cursor FROM sales_teams WHERE id=?", [team.id]);
  const counter = Math.max(0, Number(fresh?.p1_cursor ?? team.p1Cursor) || 0);
  const id = order[counter % order.length];
  return { salespersonId: id, name: queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [id])?.name ?? "" };
}

export function noneOwnerId(team: SalesTeam): number | null {
  return ownerForPriority(team, null);
}

export function p1OwnerIds(team: SalesTeam): number[] {
  return team.members.filter((m) => m.ownsP1).sort((a, b) => a.sortOrder - b.sortOrder || a.salespersonId - b.salespersonId).map((m) => m.salespersonId);
}

/** Present a team as the legacy TeamSalesConfig shape (qualifier = none-owner, closers = P1 owners). */
export function configFromTeam(team: SalesTeam, legacy: TeamSalesConfig = readLegacyTeamSalesConfig()): TeamSalesConfig {
  const qualifier = noneOwnerId(team) ?? legacy.qualifierSalespersonId;
  const closers = p1OwnerIds(team);
  return {
    ...legacy,
    enabled: team.enabled && legacy.enabled,
    qualifierSalespersonId: qualifier,
    closerSalespersonIds: closers.length ? closers : legacy.closerSalespersonIds,
  };
}

export type ResolveHint = { salespersonId?: number | null; customerId?: number | null };

/**
 * Flag OFF → legacy getTeamSalesConfig equivalent.
 * Flag ON → the customer's team, else the salesperson's team, else team 1 (so global reads stay team-1-shaped).
 */
export function resolveTeam(hint: ResolveHint = {}): SalesTeam | null {
  if (!mtFlagOn()) return null;
  migrateMultiTeam();
  if (hint.customerId != null) {
    const t = teamOfCustomer(Number(hint.customerId));
    if (t) return t;
  }
  if (hint.salespersonId != null) {
    const t = teamOfSalesperson(Number(hint.salespersonId));
    if (t) return t;
  }
  return loadTeam(1);
}

export function resolveTeamSalesConfig(hint: ResolveHint = {}): TeamSalesConfig {
  if (!mtFlagOn()) return readLegacyTeamSalesConfig();
  const team = resolveTeam(hint);
  if (!team) return readLegacyTeamSalesConfig();
  return configFromTeam(team);
}

export function teamCommissionMode(team: SalesTeam | null): "inherit" | "zero" {
  if (!team) return "inherit";
  try {
    const j = JSON.parse(team.commissionJson) as { mode?: string };
    return j.mode === "inherit" ? "inherit" : "zero";
  } catch { return "zero"; }
}

/* ---------------- lead split (new customers + site leads) ---------------- */

export function nextLeadSplitTeam(now = new Date()): SalesTeam {
  migrateMultiTeam();
  const teams = loadAllTeams().filter((t) => t.enabled && t.leadSplitQuota > 0);
  if (!teams.length) {
    const fallback = loadTeam(1);
    if (!fallback) throw new Error("هیچ تیمی برای تخصیص سرنخ تعریف نشده است.");
    return fallback;
  }
  const state = queryRow<{ cursor_index: number; cursor_used: number }>(
    "SELECT cursor_index, cursor_used FROM sales_lead_split_state WHERE id=1",
  ) ?? { cursor_index: 0, cursor_used: 0 };
  let index = Math.max(0, Number(state.cursor_index) || 0) % teams.length;
  let used = Math.max(0, Number(state.cursor_used) || 0);
  const quota = Math.max(1, teams[index].leadSplitQuota);
  if (used >= quota) {
    index = (index + 1) % teams.length;
    used = 0;
  }
  const chosen = teams[index];
  execute(
    `INSERT INTO sales_lead_split_state(id,cursor_index,cursor_used,updated_at) VALUES(1,?,?,?)
     ON CONFLICT(id) DO UPDATE SET cursor_index=excluded.cursor_index, cursor_used=excluded.cursor_used, updated_at=excluded.updated_at`,
    [index, used + 1, now.toISOString()],
  );
  return chosen;
}

/** Owner of a new lead for a given priority, advancing P1 rotation when needed. */
export function assignLeadOwner(priority: CallPriority, now = new Date()): { team: SalesTeam; salespersonId: number } {
  const team = nextLeadSplitTeam(now);
  const owner = priority === 1 && p1OwnerIds(team).length ? nextP1Owner(team) : ownerForPriority(team, priority);
  if (owner == null) {
    const fallback = noneOwnerId(team) ?? team.members[0]?.salespersonId;
    if (fallback == null) throw new Error("تیم انتخاب‌شده عضوی ندارد.");
    return { team, salespersonId: fallback };
  }
  return { team, salespersonId: owner };
}

/* ---------------- trainees / EL map ---------------- */

/** Hard-coded trainee salesperson ids (Younesi stays even when the flag is on). */
export const BASE_TRAINEE_SALESPERSON_IDS: readonly number[] = [5, 19, 20];
export const BASE_TRAINEE_USER_IDS: readonly number[] = [6, 27, 28];

/**
 * With the flag ON, team members (currently 5 and 20) are no longer treated as trainees.
 * Younesi (19 / user 27) remains a trainee.
 */
export function isTraineeSalesperson(salespersonId: number | null | undefined): boolean {
  if (salespersonId == null) return false;
  const sp = Number(salespersonId);
  if (!BASE_TRAINEE_SALESPERSON_IDS.includes(sp)) return false;
  if (mtFlagOn() && teamOfSalesperson(sp)) return false;
  return true;
}

export function isTraineeUser(userId: number | null | undefined, salespersonId?: number | null): boolean {
  if (userId == null) return false;
  const uid = Number(userId);
  if (!BASE_TRAINEE_USER_IDS.includes(uid)) return false;
  if (mtFlagOn()) {
    const sp = salespersonId != null ? Number(salespersonId) : queryRow<{ salesperson_id: number | null }>(
      "SELECT salesperson_id FROM users WHERE id=?", [uid],
    )?.salesperson_id;
    if (sp != null && teamOfSalesperson(Number(sp))) return false;
  }
  return true;
}

/** userId → salespersonId for every member of enabled teams (plus the legacy three). */
export function teamExpertUserMap(base: Readonly<Record<number, number>> = { 8: 6, 2: 3, 3: 4 }): Record<number, number> {
  if (!mtFlagOn()) return { ...base };
  migrateMultiTeam();
  const out: Record<number, number> = { ...base };
  const members = queryRows<{ salesperson_id: number }>("SELECT salesperson_id FROM sales_team_members");
  for (const m of members) {
    const sp = Number(m.salesperson_id);
    const u = queryRow<{ id: number }>(
      "SELECT id FROM users WHERE salesperson_id=? AND role='salesperson' AND active=1 ORDER BY id LIMIT 1",
      [sp],
    );
    if (u) out[Number(u.id)] = sp;
  }
  return out;
}

/** Minimal handle so db-injected modules (assistants, intro, GL, …) never have to import crm-db. */
export type TraineeQueryDb = {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown; all?: (...params: unknown[]) => unknown[] };
  exec?: (sql: string) => void;
};

function tableExistsOn(db: TraineeQueryDb, name: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}
export function mtFlagOnDb(db: TraineeQueryDb): boolean {
  try {
    if (!tableExistsOn(db, "call_queue_settings")) return false;
    return ((db.prepare("SELECT value FROM call_queue_settings WHERE key=?").get(MT_FLAG) as { value?: string } | undefined)?.value === "1");
  } catch { return false; }
}
function isTeamMemberOn(db: TraineeQueryDb, salespersonId: number): boolean {
  try {
    if (!tableExistsOn(db, "sales_team_members")) return false;
    return Boolean(db.prepare("SELECT 1 x FROM sales_team_members WHERE salesperson_id=?").get(salespersonId));
  } catch { return false; }
}

/**
 * db-injected form of isTraineeSalesperson. Flag OFF (or no team row) = the base list.
 * Flag ON + team membership = not a trainee. Younesi (19) is never a team member, so always a trainee.
 */
export function isTraineeSalespersonOn(db: TraineeQueryDb, salespersonId: number | null | undefined): boolean {
  if (salespersonId == null) return false;
  const sp = Number(salespersonId);
  if (!BASE_TRAINEE_SALESPERSON_IDS.includes(sp)) return false;
  if (mtFlagOnDb(db) && isTeamMemberOn(db, sp)) return false;
  return true;
}
export function isTraineeUserOn(db: TraineeQueryDb, userId: number | null | undefined, salespersonId?: number | null): boolean {
  if (userId == null) return false;
  const uid = Number(userId);
  if (!BASE_TRAINEE_USER_IDS.includes(uid)) return false;
  if (mtFlagOnDb(db)) {
    const sp = salespersonId != null ? Number(salespersonId) : (db.prepare("SELECT salesperson_id FROM users WHERE id=?").get(uid) as { salesperson_id: number | null } | undefined)?.salesperson_id;
    if (sp != null && isTeamMemberOn(db, Number(sp))) return false;
  }
  return true;
}
/** Current trainee salesperson ids for SQL IN-lists and admin payloads. Flag OFF → [5,19,20]; flag ON after seed → [19]. */
export function traineeSalespersonIdsOn(db: TraineeQueryDb): number[] {
  return BASE_TRAINEE_SALESPERSON_IDS.filter((sp) => isTraineeSalespersonOn(db, sp));
}
export function traineeUserIdsOn(db: TraineeQueryDb): number[] {
  return BASE_TRAINEE_USER_IDS.filter((id) => isTraineeUserOn(db, id));
}
export function traineeSalespersonIds(): number[] { return traineeSalespersonIdsOn(crmDb); }

/** AR30 assistant-bell trigger, rebuilt from the current trainee list so flag ON no longer blocks team-2 experts. */
export function assistantBellGuardTriggerSql(db: TraineeQueryDb, excludedUserIds: readonly number[] = [29]): string {
  const trainees = traineeSalespersonIdsOn(db);
  const inList = trainees.length ? trainees.join(",") : "NULL";
  const ex = excludedUserIds.length ? excludedUserIds.join(",") : "NULL";
  return `CREATE TRIGGER IF NOT EXISTS trg_assistant_bell_recipient_guard BEFORE INSERT ON site_notification_events
  WHEN NEW.actor_key LIKE 'assistant:%' AND NEW.recipient_user_id IS NOT NULL AND (NEW.recipient_user_id IN (${ex})
    OR EXISTS(SELECT 1 FROM users WHERE id=NEW.recipient_user_id AND (role='trainee' OR salesperson_id IN (${inList}))))
  BEGIN SELECT RAISE(IGNORE); END`;
}
export function installAssistantBellGuard(db: TraineeQueryDb): void {
  if (typeof db.exec !== "function") return;
  try {
    if (!tableExistsOn(db, "site_notification_events") || !tableExistsOn(db, "users")) return;
    db.exec("DROP TRIGGER IF EXISTS trg_assistant_bell_recipient_guard");
    db.exec(assistantBellGuardTriggerSql(db));
  } catch { /* leave whatever trigger is already there */ }
}

export function resetMultiTeamSchemaCache(): void { schemaReady = false; }
