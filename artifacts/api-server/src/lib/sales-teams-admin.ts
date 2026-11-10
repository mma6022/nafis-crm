/**
 * Team-builder API helpers (flag.multi_team_v1). Presentation, writes, intake, disable,
 * and applying the team-1 panel to new members. No users-table name writes.
 */
import type { AuthUser } from "./auth";
import { crmDb, execute, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { isSalesManagerUser } from "./sales-manager";
import {
  disableBlockedByIntakeMessage,
  installAssistantBellGuard,
  INTAKE_SOURCES,
  isIntakeSource,
  isTraineeSalesperson,
  loadAllIntakeSplits,
  loadAllTeams,
  loadIntakeSplit,
  loadTeam,
  migrateMultiTeam,
  mtFlagOn,
  normalizeIncomingShares,
  saveIntakeShares,
  seedIntakeSplitIfNeeded,
  TEAM_SEED_NAMES,
  teamIsIntakeDestination,
  teamOfSalesperson,
  teamUiDisplayName,
  type IntakeSource,
  type MultiTeamValidationError,
  type SalesTeam,
  type TeamMemberRow,
  validateTeamMembers,
} from "./multi-team";
import { syncTeamMembershipHistory } from "./sales-performance";

export const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
export function faDigits(v: string | number): string {
  return String(v).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}
export function extensionLabel(ext: string | null | undefined): string {
  const e = (ext ?? "").trim();
  return e ? `داخلی ${faDigits(e)}` : "داخلی ندارد";
}
export function avatarLetter(name: string): string {
  const t = (name || "").trim();
  return t ? t[0]! : "؟";
}

export function isManager(u: AuthUser | null | undefined): boolean {
  if (!u) return false;
  return u.role === "admin" || isSalesManagerUser(u) || u.baseRole === "admin" || u.baseRole === "sales_manager";
}
/** Only the real admin role — sales_manager is excluded. */
export function isTrueAdmin(u: AuthUser | null | undefined): boolean {
  if (!u) return false;
  if (isSalesManagerUser(u)) return false;
  return (u.baseRole ?? u.role) === "admin";
}

export type MemberInput = {
  salespersonId: number;
  isLead?: boolean;
  ownsNone?: boolean;
  ownsP1?: boolean;
  ownsP2?: boolean;
  ownsP3?: boolean;
  sortOrder?: number;
};

export type PresentedMember = {
  salespersonId: number;
  userId: number | null;
  displayName: string;
  avatarLetter: string;
  extension: string | null;
  extensionLabel: string;
  isLead: boolean;
  ownsNone: boolean;
  ownsP1: boolean;
  ownsP2: boolean;
  ownsP3: boolean;
  sortOrder: number;
  priorities: string[];
};

export type PresentedTeam = {
  id: number;
  name: string;
  enabled: boolean;
  leadSalespersonId: number | null;
  leadName: string | null;
  members: PresentedMember[];
  intakeSources: IntakeSource[];
};

export type PickerPerson = {
  salespersonId: number;
  userId: number | null;
  displayName: string;
  avatarLetter: string;
  extension: string | null;
  extensionLabel: string;
  available: boolean;
  teamId: number | null;
  teamName: string | null;
  reason: string | null;
  isTrainee: boolean;
};

function personRow(sp: number): { name: string | null; userId: number | null; extension: string | null; active: number } | null {
  return queryRow(
    `SELECT s.name AS name, s.active AS active,
            (SELECT u.id FROM users u WHERE u.salesperson_id=s.id AND u.active=1 ORDER BY CASE u.role WHEN 'salesperson' THEN 0 ELSE 1 END, u.id LIMIT 1) AS userId,
            (SELECT e.extension FROM users u LEFT JOIN voip_extensions e ON e.user_id=u.id
              WHERE u.salesperson_id=s.id AND u.active=1
              ORDER BY CASE u.role WHEN 'salesperson' THEN 0 ELSE 1 END, u.id LIMIT 1) AS extension
       FROM salespersons s WHERE s.id=?`,
    [sp],
  ) as { name: string | null; userId: number | null; extension: string | null; active: number } | null;
}

export function priorityLabels(m: { ownsNone: boolean; ownsP1: boolean; ownsP2: boolean; ownsP3: boolean }, p1Rotating = false): string[] {
  const out: string[] = [];
  if (m.ownsNone) out.push("بدون اولویت");
  if (m.ownsP1) out.push(p1Rotating ? "۱" : "۱");
  if (m.ownsP2) out.push("۲");
  if (m.ownsP3) out.push("۳");
  return out;
}

export function presentMember(m: TeamMemberRow, p1Rotating = false): PresentedMember {
  const row = personRow(m.salespersonId);
  const displayName = teamUiDisplayName(m.salespersonId, row?.name);
  const ext = (row?.extension ?? "").trim() || null;
  return {
    salespersonId: m.salespersonId,
    userId: row?.userId ?? null,
    displayName,
    avatarLetter: avatarLetter(displayName),
    extension: ext,
    extensionLabel: extensionLabel(ext),
    isLead: m.isLead,
    ownsNone: m.ownsNone,
    ownsP1: m.ownsP1,
    ownsP2: m.ownsP2,
    ownsP3: m.ownsP3,
    sortOrder: m.sortOrder,
    priorities: priorityLabels(m, p1Rotating),
  };
}

export function presentTeam(team: SalesTeam): PresentedTeam {
  const p1Count = team.members.filter((m) => m.ownsP1).length;
  const members = [...team.members]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.salespersonId - b.salespersonId)
    .map((m) => presentMember(m, p1Count === 2 && m.ownsP1));
  const lead = members.find((m) => m.isLead) ?? null;
  const intakeSources = loadAllIntakeSplits().filter((r) => r.teamIds.includes(team.id)).map((r) => r.source);
  return {
    id: team.id,
    name: team.name,
    enabled: team.enabled,
    leadSalespersonId: lead?.salespersonId ?? null,
    leadName: lead?.displayName ?? null,
    members,
    intakeSources,
  };
}

export function todayJalaliLabel(now = new Date()): string {
  try {
    const fmt = (opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", ...opts }).format(now);
    return `${fmt({ weekday: "long" })} ${fmt({ day: "numeric" })} ${fmt({ month: "long" })} ${fmt({ year: "numeric" })}`;
  } catch { return ""; }
}

export function intakeSentence(source: IntakeSource, shares: { teamId: number; percent: number }[]): string {
  const subject = source === "site_leads" ? "لید فرم سایت" : "مشتری جدید";
  const nameOf = (id: number) => loadTeam(id)?.name || TEAM_SEED_NAMES[id] || `تیم ${faDigits(id)}`;
  const parts = [...shares].sort((a, b) => a.teamId - b.teamId).map((s) => {
    const name = nameOf(s.teamId);
    return s.percent === 0
      ? `${name} ${faDigits(0)}٪، بدون سهم ورودی`
      : `${name} ${faDigits(s.percent)}٪`;
  });
  if (!parts.length) return `${subject}: ${nameOf(1)} ${faDigits(100)}٪.`;
  return `${subject}: ${parts.join("؛ ")}.`;
}

export function presentIntake() {
  seedIntakeSplitIfNeeded();
  return INTAKE_SOURCES.map((source) => {
    const row = loadIntakeSplit(source);
    return {
      source,
      label: source === "site_leads" ? "لید فرم سایت" : "مشتری جدید",
      teamIds: row.teamIds,
      teams: row.shares.map((s) => ({
        teamId: s.teamId,
        name: loadTeam(s.teamId)?.name || TEAM_SEED_NAMES[s.teamId] || `تیم ${faDigits(s.teamId)}`,
        percent: s.percent,
        enabled: loadTeam(s.teamId)?.enabled ?? false,
      })),
      sentence: intakeSentence(source, row.shares),
    };
  });
}

export function listState() {
  migrateMultiTeam();
  seedIntakeSplitIfNeeded();
  const teams = loadAllTeams().map(presentTeam);
  return { teams, intake: presentIntake(), todayLabel: todayJalaliLabel() };
}

export function enabledMemberIds(): Set<number> {
  return new Set(queryRows<{ salesperson_id: number }>(
    `SELECT m.salesperson_id FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1`,
  ).map((r) => Number(r.salesperson_id)));
}

/** Active salespersons; those on an enabled team are greyed with «عضو تیم …». */
export function pickerPeople(opts: { excludeTeamId?: number } = {}): PickerPerson[] {
  migrateMultiTeam();
  const rows = queryRows<{ id: number; name: string | null; active: number }>(
    "SELECT id, name, active FROM salespersons WHERE active=1 ORDER BY id",
  );
  const out: PickerPerson[] = [];
  for (const r of rows) {
    const sp = Number(r.id);
    const team = teamOfSalesperson(sp);
    const onEnabled = Boolean(team && team.enabled && team.id !== opts.excludeTeamId);
    const info = personRow(sp);
    const displayName = teamUiDisplayName(sp, info?.name ?? r.name);
    const ext = (info?.extension ?? "").trim() || null;
    const isTrainee = !onEnabled && !(team && team.enabled);
    out.push({
      salespersonId: sp,
      userId: info?.userId ?? null,
      displayName,
      avatarLetter: avatarLetter(displayName),
      extension: ext,
      extensionLabel: extensionLabel(ext),
      available: !onEnabled,
      teamId: onEnabled ? team!.id : null,
      teamName: onEnabled ? team!.name : null,
      reason: onEnabled ? `عضو ${team!.name}` : null,
      isTrainee: isTraineeSalesperson(sp),
    });
  }
  out.sort((a, b) => Number(b.available) - Number(a.available) || a.salespersonId - b.salespersonId);
  return out;
}

function toRow(teamId: number, m: MemberInput, i: number): TeamMemberRow {
  return {
    teamId,
    salespersonId: Number(m.salespersonId),
    isLead: Boolean(m.isLead),
    ownsNone: Boolean(m.ownsNone),
    ownsP1: Boolean(m.ownsP1),
    ownsP2: Boolean(m.ownsP2),
    ownsP3: Boolean(m.ownsP3),
    sortOrder: Number.isInteger(m.sortOrder) ? Number(m.sortOrder) : i,
  };
}

function otherIds(exceptTeamId?: number): Set<number> {
  const sql = exceptTeamId != null
    ? "SELECT m.salesperson_id AS salesperson_id FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1 WHERE m.team_id<>?"
    : "SELECT m.salesperson_id AS salesperson_id FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1";
  return new Set(queryRows<{ salesperson_id: number }>(sql, exceptTeamId != null ? [exceptTeamId] : []).map((r) => Number(r.salesperson_id)));
}

export function assertMembers(members: TeamMemberRow[], exceptTeamId?: number): MultiTeamValidationError[] {
  return validateTeamMembers(members, { otherTeamSalespersonIds: otherIds(exceptTeamId) });
}

function writeMembers(teamId: number, members: TeamMemberRow[]): void {
  execute("DELETE FROM sales_team_members WHERE team_id=?", [teamId]);
  for (const m of members) {
    execute(
      `INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order)
       VALUES(?,?,?,?,?,?,?,?)`,
      [teamId, m.salespersonId, m.isLead ? 1 : 0, m.ownsNone ? 1 : 0, m.ownsP1 ? 1 : 0, m.ownsP2 ? 1 : 0, m.ownsP3 ? 1 : 0, m.sortOrder],
    );
  }
  try { syncTeamMembershipHistory(crmDb); } catch { /* history is additive and must not block a team write */ }
}

/**
 * Copy the intersection of per-user panel flags that every current team-1 member has
 * onto a newly added member (spec §5.2 / decision 13). Never touches users.full_name.
 */
export function applyTeam1PanelFlags(userId: number, now = new Date()): string[] {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return [];
  const team1Users = queryRows<{ id: number }>(
    `SELECT u.id AS id FROM users u
      JOIN sales_team_members m ON m.salesperson_id=u.salesperson_id
      WHERE m.team_id=1 AND u.active=1`,
  ).map((r) => Number(r.id)).filter((n) => n > 0 && n !== uid);
  const ids = team1Users.length ? team1Users : [8, 2, 3];
  const counts = new Map<string, { n: number; value: string }>();
  for (const id of ids) {
    const rows = queryRows<{ key: string; value: string }>(
      "SELECT key, value FROM call_queue_settings WHERE key LIKE ?",
      [`flag.%.user.${id}`],
    );
    for (const r of rows) {
      const suffix = `.user.${id}`;
      if (!r.key.endsWith(suffix)) continue;
      const base = r.key.slice(0, -suffix.length); // flag.foo
      const cur = counts.get(base);
      if (!cur) counts.set(base, { n: 1, value: r.value });
      else if (cur.value === r.value) cur.n += 1;
      else cur.n = -999; // disagreement — skip
    }
  }
  const written: string[] = [];
  const at = now.toISOString();
  for (const [base, rec] of counts) {
    if (rec.n !== ids.length) continue;
    const key = `${base}.user.${uid}`;
    const old = queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value;
    if (old === rec.value) continue;
    execute(
      `INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [key, rec.value, at],
    );
    written.push(key);
  }
  return written;
}

export function applyTeam1PanelToSalesperson(salespersonId: number, now = new Date()): string[] {
  const users = queryRows<{ id: number }>(
    "SELECT id FROM users WHERE salesperson_id=? AND active=1",
    [salespersonId],
  );
  const out: string[] = [];
  for (const u of users) out.push(...applyTeam1PanelFlags(Number(u.id), now));
  return out;
}

function nextTeamId(): number {
  return (queryRow<{ m: number }>("SELECT COALESCE(MAX(id),0) AS m FROM sales_teams")?.m ?? 0) + 1;
}

export type WriteResult =
  | { ok: true; team: PresentedTeam; flags?: string[] }
  | { ok: false; status: number; error: string; message: string; errors?: MultiTeamValidationError[] };

export function createTeam(name: string, membersIn: MemberInput[], now = new Date()): WriteResult {
  migrateMultiTeam();
  const trimmed = (name || "").trim();
  if (!trimmed) return { ok: false, status: 400, error: "invalid_name", message: "نام تیم را بنویسید." };
  const id = nextTeamId();
  const members = membersIn.map((m, i) => toRow(id, m, i));
  const errors = assertMembers(members);
  if (errors.length) return { ok: false, status: 400, error: "invalid_members", message: errors[0]!.message, errors };
  const at = now.toISOString();
  const flags: string[] = [];
  runImmediateTransaction(() => {
    execute(
      `INSERT INTO sales_teams(id,name,enabled,lead_split_quota,p1_cursor,commission_json,created_at,updated_at)
       VALUES(?,?,1,0,0,'{"mode":"inherit"}',?,?)`,
      [id, trimmed, at, at],
    );
    writeMembers(id, members);
    for (const m of members) flags.push(...applyTeam1PanelToSalesperson(m.salespersonId, now));
    installAssistantBellGuard(crmDb);
  });
  const team = loadTeam(id);
  if (!team) return { ok: false, status: 500, error: "create_failed", message: "تیم ثبت نشد." };
  return { ok: true, team: presentTeam(team), flags };
}

export function updateTeam(id: number, patch: { name?: string; members?: MemberInput[]; enabled?: boolean }, now = new Date()): WriteResult {
  migrateMultiTeam();
  const existing = loadTeam(id);
  if (!existing) return { ok: false, status: 404, error: "not_found", message: "تیم پیدا نشد." };
  const trimmed = patch.name != null ? patch.name.trim() : existing.name;
  if (!trimmed) return { ok: false, status: 400, error: "invalid_name", message: "نام تیم را بنویسید." };
  let members = existing.members;
  if (patch.members) members = patch.members.map((m, i) => toRow(id, m, i));
  const errors = assertMembers(members, id);
  if (errors.length) return { ok: false, status: 400, error: "invalid_members", message: errors[0]!.message, errors };
  const at = now.toISOString();
  const prev = new Set(existing.members.map((m) => m.salespersonId));
  const flags: string[] = [];
  runImmediateTransaction(() => {
    execute("UPDATE sales_teams SET name=?, updated_at=? WHERE id=?", [trimmed, at, id]);
    writeMembers(id, members);
    for (const m of members) {
      if (!prev.has(m.salespersonId)) flags.push(...applyTeam1PanelToSalesperson(m.salespersonId, now));
    }
    installAssistantBellGuard(crmDb);
  });
  return { ok: true, team: presentTeam(loadTeam(id)!), flags };
}

export function addMember(id: number, member: MemberInput, now = new Date()): WriteResult {
  migrateMultiTeam();
  const existing = loadTeam(id);
  if (!existing) return { ok: false, status: 404, error: "not_found", message: "تیم پیدا نشد." };
  if (!existing.enabled) return { ok: false, status: 409, error: "team_disabled", message: "اول تیم را فعال کنید، بعد عضو اضافه کنید." };
  const incoming = toRow(id, member, existing.members.length);
  // If the new member takes a exclusive priority, drop it from the previous owner (review line).
  const next = existing.members.map((m) => {
    const copy = { ...m };
    if (incoming.ownsNone) copy.ownsNone = false;
    if (incoming.ownsP2) copy.ownsP2 = false;
    if (incoming.ownsP3) copy.ownsP3 = false;
    if (incoming.isLead) copy.isLead = false;
    return copy;
  });
  next.push(incoming);
  const errors = assertMembers(next, id);
  if (errors.length) return { ok: false, status: 400, error: "invalid_members", message: errors[0]!.message, errors };
  return updateTeam(id, { members: next }, now);
}

/** Who loses a exclusive priority if this member is added — for the review step. */
export function loseLines(team: SalesTeam, member: MemberInput): string[] {
  const nameOf = (sp: number) => presentMember(team.members.find((m) => m.salespersonId === sp) ?? {
    teamId: team.id, salespersonId: sp, isLead: false, ownsNone: false, ownsP1: false, ownsP2: false, ownsP3: false, sortOrder: 0,
  }).displayName;
  const lines: string[] = [];
  const check = (take: boolean, pred: (m: TeamMemberRow) => boolean, label: string) => {
    if (!take) return;
    const prev = team.members.find(pred);
    if (prev) lines.push(`${label} از ${nameOf(prev.salespersonId)} گرفته می‌شود.`);
  };
  check(Boolean(member.ownsNone), (m) => m.ownsNone, "بدون اولویت");
  check(Boolean(member.ownsP2), (m) => m.ownsP2, "اولویت ۲");
  check(Boolean(member.ownsP3), (m) => m.ownsP3, "اولویت ۳");
  return lines;
}

export type DisableResult =
  | { ok: true; team: PresentedTeam }
  | { ok: false; status: number; error: string; message: string; sources?: IntakeSource[] };

export function disableTeam(id: number, now = new Date()): DisableResult {
  migrateMultiTeam();
  const existing = loadTeam(id);
  if (!existing) return { ok: false, status: 404, error: "not_found", message: "تیم پیدا نشد." };
  if (!existing.enabled) return { ok: true, team: presentTeam(existing) };
  const blocked = disableBlockedByIntakeMessage(id);
  if (blocked) {
    const sources = loadAllIntakeSplits().filter((r) => r.teamIds.includes(id)).map((r) => r.source);
    return { ok: false, status: 409, error: "intake_destination", message: blocked, sources };
  }
  const at = now.toISOString();
  runImmediateTransaction(() => {
    execute("DELETE FROM sales_team_members WHERE team_id=?", [id]);
    execute("UPDATE sales_teams SET enabled=0, updated_at=? WHERE id=?", [at, id]);
    try { syncTeamMembershipHistory(crmDb, now, "disable"); } catch { /* history is additive and must not block disable */ }
    installAssistantBellGuard(crmDb);
  });
  return { ok: true, team: presentTeam(loadTeam(id)!) };
}

export function enableTeam(id: number, membersIn: MemberInput[] | undefined, now = new Date()): WriteResult {
  migrateMultiTeam();
  const existing = loadTeam(id);
  if (!existing) return { ok: false, status: 404, error: "not_found", message: "تیم پیدا نشد." };
  const members = (membersIn ?? existing.members).map((m, i) => toRow(id, m, i));
  const errors = assertMembers(members, id);
  if (errors.length) return { ok: false, status: 400, error: "invalid_members", message: errors[0]!.message, errors };
  const at = now.toISOString();
  const flags: string[] = [];
  runImmediateTransaction(() => {
    execute("UPDATE sales_teams SET enabled=1, updated_at=? WHERE id=?", [at, id]);
    writeMembers(id, members);
    for (const m of members) flags.push(...applyTeam1PanelToSalesperson(m.salespersonId, now));
    installAssistantBellGuard(crmDb);
  });
  return { ok: true, team: presentTeam(loadTeam(id)!), flags };
}

function parsePutShares(item: {
  teams?: { teamId?: number; percent?: number }[];
  shares?: { teamId?: number; percent?: number }[];
  percents?: Record<string, number>;
}): { teamId: number; percent: number }[] {
  if (Array.isArray(item.teams) || Array.isArray(item.shares)) {
    return (item.teams || item.shares || []).map((t) => ({ teamId: Number(t.teamId), percent: Number(t.percent) }));
  }
  if (item.percents && typeof item.percents === "object") {
    return Object.entries(item.percents).map(([id, percent]) => ({ teamId: Number(id), percent: Number(percent) }));
  }
  throw Object.assign(new Error("درصد هر تیم را برای این منبع بفرستید."), { status: 422, error: "invalid_intake" });
}

export function putIntake(body: { sources?: { source: string; teams?: { teamId: number; percent: number }[]; shares?: { teamId: number; percent: number }[]; percents?: Record<string, number> }[] }, now = new Date()) {
  migrateMultiTeam();
  const items = Array.isArray(body?.sources) ? body.sources : [];
  const prepared: { source: IntakeSource; shares: { teamId: number; percent: number }[] }[] = [];
  for (const item of items) {
    if (!isIntakeSource(item.source)) {
      return { ok: false as const, status: 400, error: "invalid_source", message: "منبع تقسیم معتبر نیست." };
    }
    try {
      prepared.push({ source: item.source, shares: normalizeIncomingShares(item.source, parsePutShares(item)) });
    } catch (e) {
      const err = e as Error & { field?: string; status?: number; error?: string; source?: string; sum?: number };
      return { ok: false as const, status: err.status || 422, error: err.error || "invalid_intake", message: err.message, source: err.source, sum: err.sum };
    }
  }
  for (const item of prepared) saveIntakeShares(item.source, item.shares, now);
  return { ok: true as const, intake: presentIntake() };
}

export { teamIsIntakeDestination, isIntakeSource };
