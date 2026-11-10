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
 *  - Incoming leads start 100% at team 1 (0% team 2) until a manager changes intake.
 *  - Intake is per source (new_customers / site_leads): integer percents per team that sum to 100.
 *  - Assignment is a persisted deficit-counter (smooth weighted round-robin), not random.
 *  - A team with more than 0% on any source cannot be disabled until that share is set to 0.
 *  - A disabled team cannot have more than 0%.
 *  - Team-commission config is per team (team 2 is seeded at zero).
 *  - Future membership changes do not move existing customers.
 *  - Team UI display names are labels only (no users-table writes). Kheradkar: «حسین خردکار».
 */
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import { mergeTeamSalesConfig, type TeamSalesConfig } from "./team-sales-rules";

export const MT_FLAG = "flag.multi_team_v1";
export const LEGACY_TEAM_SALES_CONFIG_KEY = "team_sales_config";
export const LEGACY_TEAM_SALES_CURSOR_KEY = "team_sales_closer_cursor";

export const TEAM_SEED_NAMES: Readonly<Record<number, string>> = { 1: "تیم فروش ۱", 2: "تیم فروش ۲" };
const LEGACY_TEAM_SEED_NAMES: readonly string[] = [
  "تیم ۱ — کاظمی، حسنی، قاسمی",
  "تیم ۲ — خردکار، اصلانیان",
];

/** Team-UI-only labels. Never written to users / salespersons. */
export const TEAM_UI_DISPLAY_NAMES: Readonly<Record<number, string>> = {
  3: "خانم حسنی",
  4: "خانم قاسمی",
  5: "آرش اصلانیان",
  6: "آقای کاظمی",
  19: "خانم یونسی",
  20: "حسین خردکار",
};
export function teamUiDisplayName(salespersonId: number, fallback?: string | null): string {
  const over = TEAM_UI_DISPLAY_NAMES[Number(salespersonId)];
  if (over) return over;
  const fa = (v: string) => v.replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
  const fb = (fallback ?? "").trim();
  return fa(fb || `کارشناس ${salespersonId}`);
}

export const INTAKE_SOURCES = ["new_customers", "site_leads"] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];
export type IntakeShare = { teamId: number; percent: number; deficit: number };
export type IntakeSplitRow = { source: IntakeSource; shares: IntakeShare[]; teamIds: number[]; updatedAt: string };

export function isIntakeSource(v: unknown): v is IntakeSource {
  return v === "new_customers" || v === "site_leads";
}

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
    CREATE TABLE IF NOT EXISTS sales_intake_split (
      source TEXT PRIMARY KEY CHECK (source IN ('new_customers','site_leads')),
      team_ids_json TEXT NOT NULL,
      cursor_index INTEGER NOT NULL DEFAULT 0,
      cursor_used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_intake_shares (
      source TEXT NOT NULL CHECK (source IN ('new_customers','site_leads')),
      team_id INTEGER NOT NULL,
      percent INTEGER NOT NULL CHECK (percent >= 0 AND percent <= 100),
      deficit INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source, team_id)
    );
  `);
  schemaReady = true;
  seedIntakeSplitIfNeeded();
  renameLegacyTeamNames();
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
      [TEAM_SEED_NAMES[1], cursor, at, at],
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
      [TEAM_SEED_NAMES[2], 1, at, at],
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
  const intake = seedIntakeSplitIfNeeded(now);
  seeded.push(...intake);
  if (renameLegacyTeamNames()) seeded.push("team_names");
  return { seeded };
}

/** Official names (t965s4040). Idempotent rename of the earlier long seed titles. */
export function renameLegacyTeamNames(): boolean {
  let changed = false;
  for (const [id, name] of Object.entries(TEAM_SEED_NAMES)) {
    const row = queryRow<{ name: string }>("SELECT name FROM sales_teams WHERE id=?", [Number(id)]);
    if (row && LEGACY_TEAM_SEED_NAMES.includes(row.name) && row.name !== name) {
      execute("UPDATE sales_teams SET name=?, updated_at=? WHERE id=?", [name, new Date().toISOString(), Number(id)]);
      changed = true;
    }
  }
  return changed;
}

function parseTeamIdsJson(raw: string | null | undefined): number[] {
  try {
    const v = JSON.parse(raw || "[]");
    if (!Array.isArray(v)) return [1];
    const ids = v.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    return ids.length ? [...new Set(ids)] : [1];
  } catch { return [1]; }
}

function intakeError(message: string, error = "invalid_intake", status = 422, field = "percent"): Error {
  return Object.assign(new Error(message), { error, status, field });
}

function knownTeamIds(): number[] {
  try {
    return queryRows<{ id: number }>("SELECT id FROM sales_teams ORDER BY id").map((r) => Number(r.id));
  } catch { return []; }
}

function ensureIntakeSharesTable(): void {
  try {
    crmDb.exec(`CREATE TABLE IF NOT EXISTS sales_intake_shares (
      source TEXT NOT NULL CHECK (source IN ('new_customers','site_leads')),
      team_id INTEGER NOT NULL,
      percent INTEGER NOT NULL CHECK (percent >= 0 AND percent <= 100),
      deficit INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source, team_id)
    )`);
    crmDb.exec(`CREATE TABLE IF NOT EXISTS sales_intake_split (
      source TEXT PRIMARY KEY CHECK (source IN ('new_customers','site_leads')),
      team_ids_json TEXT NOT NULL,
      cursor_index INTEGER NOT NULL DEFAULT 0,
      cursor_used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);
  } catch { /* already exists or no db */ }
}

function sharesFromLegacyIds(ids: number[], teamIds: number[]): { teamId: number; percent: number }[] {
  const dest = ids.length ? ids : [1];
  const all = [...new Set([...teamIds, ...dest])].sort((a, b) => a - b);
  const out = new Map<number, number>();
  for (const id of all) out.set(id, 0);
  if (dest.length === 1) {
    out.set(dest[0]!, 100);
  } else {
    const base = Math.floor(100 / dest.length);
    let rem = 100 - base * dest.length;
    for (const id of dest) {
      out.set(id, base + (rem > 0 ? 1 : 0));
      if (rem > 0) rem -= 1;
    }
  }
  return [...out.entries()].map(([teamId, percent]) => ({ teamId, percent }));
}

function upsertShare(source: IntakeSource, teamId: number, percent: number, deficit: number, at: string): void {
  execute(
    `INSERT INTO sales_intake_shares(source,team_id,percent,deficit) VALUES(?,?,?,?)
     ON CONFLICT(source,team_id) DO UPDATE SET percent=excluded.percent, deficit=excluded.deficit`,
    [source, teamId, percent, deficit],
  );
  const positive = queryRows<{ team_id: number }>(
    "SELECT team_id FROM sales_intake_shares WHERE source=? AND percent>0 ORDER BY team_id",
    [source],
  ).map((r) => Number(r.team_id));
  const idsJson = JSON.stringify(positive.length ? positive : [1]);
  execute(
    `INSERT INTO sales_intake_split(source,team_ids_json,cursor_index,cursor_used,updated_at) VALUES(?,?,0,0,?)
     ON CONFLICT(source) DO UPDATE SET team_ids_json=excluded.team_ids_json, updated_at=excluded.updated_at`,
    [source, idsJson, at],
  );
}

/** Default both sources to 100% team 1 / 0% team 2 until a manager changes it. Idempotent. */
export function seedIntakeSplitIfNeeded(now = new Date()): string[] {
  const at = now.toISOString();
  const seeded: string[] = [];
  ensureIntakeSharesTable();
  const teamIds = knownTeamIds();
  for (const source of INTAKE_SOURCES) {
    const existing = queryRows<{ team_id: number; percent: number }>(
      "SELECT team_id, percent FROM sales_intake_shares WHERE source=?",
      [source],
    );
    if (!existing.length) {
      let initial: { teamId: number; percent: number }[] = [];
      const legacy = queryRow<{ team_ids_json: string }>("SELECT team_ids_json FROM sales_intake_split WHERE source=?", [source]);
      if (legacy?.team_ids_json) {
        initial = sharesFromLegacyIds(parseTeamIdsJson(legacy.team_ids_json), teamIds);
      } else {
        const ids = teamIds.length ? teamIds : [1];
        initial = ids.map((id) => ({ teamId: id, percent: id === 1 ? 100 : 0 }));
        if (!initial.some((s) => s.teamId === 1)) initial.unshift({ teamId: 1, percent: 100 });
      }
      for (const s of initial) upsertShare(source, s.teamId, s.percent, 0, at);
      seeded.push(`intake:${source}`);
    } else {
      for (const id of teamIds) {
        if (!existing.some((r) => Number(r.team_id) === id)) upsertShare(source, id, 0, 0, at);
      }
    }
  }
  return seeded;
}

function readShares(source: IntakeSource): IntakeShare[] {
  const rows = queryRows<{ team_id: number; percent: number; deficit: number }>(
    "SELECT team_id, percent, deficit FROM sales_intake_shares WHERE source=? ORDER BY team_id",
    [source],
  );
  return rows.map((r) => ({
    teamId: Number(r.team_id),
    percent: Math.max(0, Number(r.percent) || 0),
    deficit: Number(r.deficit) || 0,
  }));
}

export function loadIntakeSplit(source: IntakeSource): IntakeSplitRow {
  ensureMultiTeamSchema();
  seedIntakeSplitIfNeeded();
  const shares = readShares(source);
  const meta = queryRow<{ updated_at: string }>("SELECT updated_at FROM sales_intake_split WHERE source=?", [source]);
  return {
    source,
    shares,
    teamIds: shares.filter((s) => s.percent > 0).map((s) => s.teamId),
    updatedAt: meta?.updated_at ?? "",
  };
}

export function loadAllIntakeSplits(): IntakeSplitRow[] {
  return INTAKE_SOURCES.map((s) => loadIntakeSplit(s));
}

/** Team ids that currently have more than 0% on at least one intake source. */
export function intakeDestinationTeamIds(): number[] {
  const ids = new Set<number>();
  for (const row of loadAllIntakeSplits()) {
    for (const s of row.shares) if (s.percent > 0) ids.add(s.teamId);
  }
  return [...ids];
}

export function teamIsIntakeDestination(teamId: number): boolean {
  return intakeDestinationTeamIds().includes(Number(teamId));
}

export function disableBlockedByIntakeMessage(teamId: number): string | null {
  if (!teamIsIntakeDestination(teamId)) return null;
  const sources = loadAllIntakeSplits()
    .filter((r) => r.shares.some((s) => s.teamId === Number(teamId) && s.percent > 0))
    .map((r) => r.source === "new_customers" ? "مشتری جدید" : "لید فرم سایت");
  const which = sources.length ? sources.join(" و ") : "تقسیم ورودی";
  return `این تیم مقصد ${which} است. اول مقصد تقسیم را عوض کنید، بعد غیرفعال کنید.`;
}

function normalizeIncomingShares(raw: { teamId: number; percent: number }[]): { teamId: number; percent: number }[] {
  const byId = new Map<number, number>();
  for (const item of raw || []) {
    const teamId = Number(item.teamId);
    const percent = Number(item.percent);
    if (!Number.isInteger(teamId) || teamId <= 0) throw intakeError("تیم انتخاب‌شده پیدا نشد.", "invalid_intake", 422, "teamId");
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw intakeError("درصد باید عدد صحیح بین ۰ و ۱۰۰ باشد.");
    }
    if (byId.has(teamId)) throw intakeError("درصد هر تیم در هر منبع فقط یک‌بار نوشته می‌شود.");
    byId.set(teamId, percent);
  }
  for (const id of knownTeamIds()) if (!byId.has(id)) byId.set(id, 0);
  const shares = [...byId.entries()].map(([teamId, percent]) => ({ teamId, percent })).sort((a, b) => a.teamId - b.teamId);
  const sum = shares.reduce((n, s) => n + s.percent, 0);
  if (sum !== 100) throw intakeError("جمع درصدهای هر منبع باید دقیقاً ۱۰۰ باشد.");
  for (const s of shares) {
    const t = loadTeam(s.teamId);
    if (!t) throw intakeError("تیم انتخاب‌شده پیدا نشد.", "invalid_intake", 422, "teamId");
    if (!t.enabled && s.percent > 0) {
      throw intakeError("تیم غیرفعال نمی‌تواند درصدی بیشتر از صفر داشته باشد.");
    }
  }
  return shares;
}

/** Persist integer percents for one source and reset that source's deficit counters. */
export function saveIntakeShares(source: IntakeSource, shares: { teamId: number; percent: number }[], now = new Date()): IntakeSplitRow {
  ensureMultiTeamSchema();
  const next = normalizeIncomingShares(shares);
  const at = now.toISOString();
  for (const s of next) upsertShare(source, s.teamId, s.percent, 0, at);
  return loadIntakeSplit(source);
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
  if (leads.length !== 1) errors.push({ field: "is_lead", message: "هر تیم باید دقیقاً یک سرپرست تیم داشته باشد." });
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
  if (owners.none.length === 0) errors.push({ field: "owns_none", message: "بدون اولویت هنوز مسئول ندارد." });
  else if (owners.none.length > 1) errors.push({ field: "owns_none", message: "بدون اولویت فقط برای یک نفر است." });
  if (owners[2].length === 0) errors.push({ field: "owns_p2", message: "اولویت ۲ هنوز مسئول ندارد." });
  else if (owners[2].length > 1) errors.push({ field: "owns_p2", message: "اولویت ۲ فقط برای یک نفر است." });
  if (owners[3].length === 0) errors.push({ field: "owns_p3", message: "اولویت ۳ هنوز مسئول ندارد." });
  else if (owners[3].length > 1) errors.push({ field: "owns_p3", message: "اولویت ۳ فقط برای یک نفر است." });
  if (owners[1].length === 0) errors.push({ field: "owns_p1", message: "اولویت ۱ هنوز مسئول ندارد." });
  else if (owners[1].length > 2) errors.push({ field: "owns_p1", message: "اولویت ۱ حداکثر برای دو نفر است." });
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

export function nextLeadSplitTeam(now = new Date(), source: IntakeSource = "new_customers"): SalesTeam {
  migrateMultiTeam();
  const row = loadIntakeSplit(source);
  // Deficit / smooth weighted round-robin: add each team's percent, pick the
  // highest deficit, subtract 100. Ties break to the lowest team id. Persisted
  // per source and team so a 70/30 split yields exactly 70 and 30 over 100 leads.
  const eligible = row.shares
    .map((s) => ({ share: s, team: loadTeam(s.teamId) }))
    .filter((x): x is { share: IntakeShare; team: SalesTeam } => Boolean(x.team && x.team.enabled && x.share.percent > 0));
  const fallback = loadTeam(1);
  if (!eligible.length) {
    if (!fallback) throw new Error("هیچ تیمی برای تخصیص سرنخ تعریف نشده است.");
    return fallback;
  }
  const deficits = new Map(row.shares.map((s) => [s.teamId, s.deficit]));
  for (const { share } of eligible) deficits.set(share.teamId, (deficits.get(share.teamId) || 0) + share.percent);
  let chosen = eligible[0]!;
  for (const item of eligible) {
    const d = deficits.get(item.share.teamId) || 0;
    const best = deficits.get(chosen.share.teamId) || 0;
    if (d > best || (d === best && item.share.teamId < chosen.share.teamId)) chosen = item;
  }
  deficits.set(chosen.share.teamId, (deficits.get(chosen.share.teamId) || 0) - 100);
  const at = now.toISOString();
  for (const s of row.shares) {
    const next = deficits.has(s.teamId) ? (deficits.get(s.teamId) || 0) : s.deficit;
    execute("UPDATE sales_intake_shares SET deficit=? WHERE source=? AND team_id=?", [next, source, s.teamId]);
  }
  execute("UPDATE sales_intake_split SET updated_at=? WHERE source=?", [at, source]);
  return chosen.team;
}

/** Owner of a new lead for a given priority, advancing P1 rotation when needed. */
export function assignLeadOwner(priority: CallPriority, now = new Date(), source: IntakeSource = "new_customers"): { team: SalesTeam; salespersonId: number } {
  const team = nextLeadSplitTeam(now, source);
  const owner = priority === 1 && p1OwnerIds(team).length ? nextP1Owner(team) : ownerForPriority(team, priority);
  if (owner == null) {
    const fallback = noneOwnerId(team) ?? team.members[0]?.salespersonId;
    if (fallback == null) throw new Error("تیم انتخاب‌شده عضوی ندارد.");
    return { team, salespersonId: fallback };
  }
  return { team, salespersonId: owner };
}

/* ---------------- trainees / EL map ---------------- */

/** Legacy trainee list (flag OFF only). */
export const BASE_TRAINEE_SALESPERSON_IDS: readonly number[] = [5, 19, 20];
export const BASE_TRAINEE_USER_IDS: readonly number[] = [6, 27, 28];

function isEnabledTeamMember(salespersonId: number): boolean {
  try {
    return Boolean(queryRow(
      `SELECT 1 x FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1
        WHERE m.salesperson_id=?`,
      [salespersonId],
    ));
  } catch { return false; }
}

/**
 * Flag OFF: the legacy list [5, 19, 20].
 * Flag ON: anyone who is not a member of an enabled team is a trainee; a member is not.
 * Younesi (19) is not on a team, so he stays a trainee until he is added.
 */
export function isTraineeSalesperson(salespersonId: number | null | undefined): boolean {
  if (salespersonId == null) return false;
  const sp = Number(salespersonId);
  if (!Number.isInteger(sp) || sp <= 0) return false;
  if (mtFlagOn()) return !isEnabledTeamMember(sp);
  return BASE_TRAINEE_SALESPERSON_IDS.includes(sp);
}

export function isTraineeUser(userId: number | null | undefined, salespersonId?: number | null): boolean {
  if (userId == null) return false;
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return false;
  const sp = salespersonId != null ? Number(salespersonId) : queryRow<{ salesperson_id: number | null }>(
    "SELECT salesperson_id FROM users WHERE id=?", [uid],
  )?.salesperson_id ?? null;
  if (mtFlagOn()) {
    if (sp == null) return false;
    return isTraineeSalesperson(Number(sp));
  }
  if (sp != null && BASE_TRAINEE_SALESPERSON_IDS.includes(Number(sp))) return true;
  return BASE_TRAINEE_USER_IDS.includes(uid);
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
function isEnabledTeamMemberOn(db: TraineeQueryDb, salespersonId: number): boolean {
  try {
    if (!tableExistsOn(db, "sales_team_members") || !tableExistsOn(db, "sales_teams")) return false;
    return Boolean(db.prepare(
      `SELECT 1 x FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1 WHERE m.salesperson_id=?`,
    ).get(salespersonId));
  } catch { return false; }
}

/**
 * db-injected form of isTraineeSalesperson.
 * Flag OFF = the legacy list. Flag ON = not a member of an enabled team.
 */
export function isTraineeSalespersonOn(db: TraineeQueryDb, salespersonId: number | null | undefined): boolean {
  if (salespersonId == null) return false;
  const sp = Number(salespersonId);
  if (!Number.isInteger(sp) || sp <= 0) return false;
  if (mtFlagOnDb(db)) return !isEnabledTeamMemberOn(db, sp);
  return BASE_TRAINEE_SALESPERSON_IDS.includes(sp);
}
export function isTraineeUserOn(db: TraineeQueryDb, userId: number | null | undefined, salespersonId?: number | null): boolean {
  if (userId == null) return false;
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return false;
  let sp = salespersonId != null ? Number(salespersonId) : null;
  if (sp == null) {
    try { sp = (db.prepare("SELECT salesperson_id FROM users WHERE id=?").get(uid) as { salesperson_id: number | null } | undefined)?.salesperson_id ?? null; }
    catch { sp = null; }
  }
  if (mtFlagOnDb(db)) {
    if (sp == null) return false;
    return isTraineeSalespersonOn(db, Number(sp));
  }
  if (sp != null && BASE_TRAINEE_SALESPERSON_IDS.includes(Number(sp))) return true;
  return BASE_TRAINEE_USER_IDS.includes(uid);
}
/** Flag OFF → [5,19,20]. Flag ON → every salesperson who is not on an enabled team. */
export function traineeSalespersonIdsOn(db: TraineeQueryDb): number[] {
  if (!mtFlagOnDb(db)) return BASE_TRAINEE_SALESPERSON_IDS.slice();
  try {
    const rows = (db.prepare(
      `SELECT s.id AS id FROM salespersons s
        WHERE s.active=1 AND NOT EXISTS (
          SELECT 1 FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1
          WHERE m.salesperson_id=s.id
        )`,
    ).all ? db.prepare(
      `SELECT s.id AS id FROM salespersons s
        WHERE s.active=1 AND NOT EXISTS (
          SELECT 1 FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1
          WHERE m.salesperson_id=s.id
        )`,
    ).all() : []) as { id: number }[];
    return rows.map((r) => Number(r.id)).filter((n) => n > 0);
  } catch {
    return [];
  }
}
export function traineeUserIdsOn(db: TraineeQueryDb): number[] {
  if (!mtFlagOnDb(db)) return BASE_TRAINEE_USER_IDS.slice();
  try {
    const rows = (db.prepare(
      `SELECT u.id AS id FROM users u
        WHERE u.salesperson_id IS NOT NULL AND u.active=1 AND NOT EXISTS (
          SELECT 1 FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1
          WHERE m.salesperson_id=u.salesperson_id
        )`,
    ).all ? db.prepare(
      `SELECT u.id AS id FROM users u
        WHERE u.salesperson_id IS NOT NULL AND u.active=1 AND NOT EXISTS (
          SELECT 1 FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1
          WHERE m.salesperson_id=u.salesperson_id
        )`,
    ).all() : []) as { id: number }[];
    return rows.map((r) => Number(r.id)).filter((n) => n > 0);
  } catch {
    return BASE_TRAINEE_USER_IDS.filter((id) => isTraineeUserOn(db, id));
  }
}
export function traineeSalespersonIds(): number[] { return traineeSalespersonIdsOn(crmDb); }

/** AR30 assistant-bell trigger. Flag ON uses membership-of-enabled-team, not a fixed list. */
export function assistantBellGuardTriggerSql(db: TraineeQueryDb, excludedUserIds: readonly number[] = [29]): string {
  const ex = excludedUserIds.length ? excludedUserIds.join(",") : "NULL";
  if (mtFlagOnDb(db) && tableExistsOn(db, "sales_team_members") && tableExistsOn(db, "sales_teams")) {
    return `CREATE TRIGGER IF NOT EXISTS trg_assistant_bell_recipient_guard BEFORE INSERT ON site_notification_events
  WHEN NEW.actor_key LIKE 'assistant:%' AND NEW.recipient_user_id IS NOT NULL AND (NEW.recipient_user_id IN (${ex})
    OR EXISTS(SELECT 1 FROM users u WHERE u.id=NEW.recipient_user_id AND (u.role='trainee' OR (
      u.salesperson_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1
        WHERE m.salesperson_id=u.salesperson_id
      )
    ))))
  BEGIN SELECT RAISE(IGNORE); END`;
  }
  const trainees = traineeSalespersonIdsOn(db);
  const inList = trainees.length ? trainees.join(",") : "NULL";
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
