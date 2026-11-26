/**
 * «دسترسی این صفحه» v1 (t942u, Armita v1.1) — grants per page to a ROLE or a USER, behind flag.page_access_v1.
 *
 * Flag absent / not '1' → every function here is a no-op: no table is created, no row is read, session users and
 * permissions are exactly today's. Only '1' is ON (call_queue_settings, same rule as every other flag).
 *
 * Precedence (first match wins), evaluated per page key:
 *   1. admin / sales_manager (effective role 'admin'): always full access; rows about them are rejected and ignored.
 *   2. never-rules: user 29; never-grantable pages; phase-2 pages; unknown keys → no extra access.
 *   3. user deny («بستن») → page closed for that user (wins over the role and over any role grant).
 *   4. user allow → level (view | manage).
 *   5. role allow → level — skipped for trainees (they get a page only by an explicit user grant).
 *   6. default → today's role permissions.
 * Fail-closed: any read error → no extra access, and blockable endpoints answer 503 page_access_unavailable to non-admins.
 * expert_lockdown, trainee locks, registrar guard, smc scope and lead_annotator run exactly as before (the lockdown guard
 * sits before this one). v1: while a user is in expert_lockdown their grants are ignored entirely (PA_LOCKDOWN_OVERRIDE = false).
 */
import { crmDb, execute, queryRow, queryRows, runTransaction } from "./crm-db";
import { isTraineeUser } from "./multi-team";
import { elLocked } from "./expert-lockdown";
import { PA_BY_KEY, PA_PAGES, paGrantable, paMatch, paPermissionsFor, paPhase1, type PaPage } from "./page-access-registry";
import type { NextFunction, Request, Response } from "express";

export const PA_FLAG = "flag.page_access_v1";
/** Mohammad may later let a per-user grant open one page inside «محدودیت کارشناس»; v1 keeps the lockdown whole. */
export const PA_LOCKDOWN_OVERRIDE = false;
export const PA_NEVER_USER_IDS: readonly number[] = [29];
/** Trainee users named by Mohammad (t942u) in addition to the system trainee rule (multi-team / base lists). */
export const PA_TRAINEE_USER_IDS: readonly number[] = [27, 31];
export type PaLevel = "view" | "manage";
type PaUser = { id: number; role: string; salespersonId?: number | null; baseRole?: string; salesManager?: boolean; permissions?: string[]; active?: boolean };
export type PaEffective = { grants: Record<string, PaLevel>; blocked: string[]; error?: boolean; locked?: boolean };

export function paFlagOn(): boolean {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [PA_FLAG])?.value === "1"; }
  catch { return false; }
}
export const paIsAdminLike = (u: PaUser | null | undefined): boolean => Boolean(u && (u.role === "admin" || u.role === "sales_manager" || u.baseRole === "sales_manager"));

let schemaReady = false;
/** Lazy, idempotent, additive. Called only while the flag is ON (or by the admin API, which itself 404s while OFF). */
export function ensurePaSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS page_access_grants(
      id INTEGER PRIMARY KEY AUTOINCREMENT, page_key TEXT NOT NULL,
      subject_kind TEXT NOT NULL CHECK(subject_kind IN ('role','user')), subject_id TEXT NOT NULL,
      effect TEXT NOT NULL CHECK(effect IN ('allow','deny')), level TEXT NOT NULL CHECK(level IN ('view','manage')),
      created_by INTEGER NOT NULL, created_at TEXT NOT NULL, updated_by INTEGER, updated_at TEXT, revoked_at TEXT, revoked_by INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_page_access_active ON page_access_grants(page_key, subject_kind, subject_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_page_access_subject ON page_access_grants(subject_kind, subject_id) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS page_access_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_user_id INTEGER NOT NULL, batch TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('grant','update','revoke','block','unblock','revert')), page_key TEXT NOT NULL,
      subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, before_json TEXT, after_json TEXT, revert_of TEXT, reverted_by TEXT);
    CREATE INDEX IF NOT EXISTS idx_page_access_log_page ON page_access_log(page_key, id);`);
  schemaReady = true;
}
export function resetPaSchemaCache(): void { schemaReady = false; }

export function paIsTrainee(u: { id: number; role: string; salespersonId?: number | null }): boolean {
  if (u.role !== "salesperson") return false;
  if (PA_TRAINEE_USER_IDS.includes(Number(u.id))) return true;
  try { return isTraineeUser(Number(u.id), u.salespersonId ?? null); } catch { return true; } // unknown → treat as trainee (no role grants)
}

type Row = { id: number; page_key: string; subject_kind: "role" | "user"; subject_id: string; effect: "allow" | "deny"; level: PaLevel };
/** Effective page grants for one non-admin user. null = flag OFF or admin-like (callers keep today's behaviour). */
export function paEffective(u: PaUser | null | undefined): PaEffective | null {
  if (!u || paIsAdminLike(u) || !paFlagOn()) return null;
  if (PA_NEVER_USER_IDS.includes(Number(u.id))) return { grants: {}, blocked: [] };
  try {
    ensurePaSchema();
    const rows = queryRows<Row>(
      `SELECT id,page_key,subject_kind,subject_id,effect,level FROM page_access_grants
       WHERE revoked_at IS NULL AND ((subject_kind='user' AND subject_id=?) OR (subject_kind='role' AND subject_id=?))`,
      [String(Number(u.id)), String(u.role)],
    );
    const trainee = paIsTrainee({ id: u.id, role: u.role, salespersonId: u.salespersonId });
    // v1 (conservative, t942u): a grant never overrides «محدودیت کارشناس» — while the user is locked, grants are ignored; «بستن» still applies.
    let locked = false; try { locked = elLocked({ id: Number(u.id), role: u.role, salespersonId: u.salespersonId ?? null }); } catch { locked = true; }
    const grants: Record<string, PaLevel> = {}; const blocked: string[] = [];
    const byPage = new Map<string, Row[]>();
    for (const r of rows) { const p = PA_BY_KEY.get(r.page_key); if (!p || !paPhase1(p) || paGrantable(p) === "never") continue; byPage.set(r.page_key, [...(byPage.get(r.page_key) ?? []), r]); }
    for (const [key, list] of byPage) {
      const p = PA_BY_KEY.get(key)!;
      const cap = (l: PaLevel): PaLevel => (paGrantable(p) === "view" ? "view" : l);
      const ud = list.find((r) => r.subject_kind === "user" && r.effect === "deny");
      if (ud) { blocked.push(key); continue; }
      if (locked && !PA_LOCKDOWN_OVERRIDE) continue;
      const ua = list.find((r) => r.subject_kind === "user" && r.effect === "allow");
      if (ua) { grants[key] = cap(ua.level); continue; }
      if (trainee) continue;
      const ra = list.find((r) => r.subject_kind === "role" && r.effect === "allow");
      if (ra) grants[key] = cap(ra.level);
    }
    return locked ? { grants, blocked, locked: true } : { grants, blocked };
  } catch {
    return { grants: {}, blocked: [], error: true };
  }
}

/** Session overlay: role permissions ∪ permissions of granted pages. Never removes a permission (a «بستن» is enforced per page). */
export function paOverlayPermissions(u: PaUser, base: string[]): { permissions: string[]; pa: PaEffective | null } {
  const pa = paEffective(u);
  if (!pa || pa.error) return { permissions: base, pa };
  const set = new Set(base);
  for (const [key, level] of Object.entries(pa.grants)) { const p = PA_BY_KEY.get(key); if (p) for (const perm of paPermissionsFor(p, level)) set.add(perm); }
  return { permissions: set.size === base.length ? base : [...set], pa };
}

/**
 * API guard (app.ts, after the existing guards): (a) «بستن» → 403 page_access_blocked on that page's own endpoints;
 * (b) admin-only pages → the exact endpoints listed in the registry are served as if the granted user were an admin.
 * Flag OFF / admin / no grant → next() untouched.
 */
export function pageAccessGuard(req: Request, res: Response, next: NextFunction): void {
  const u = res.locals.authUser as (PaUser & { pageAccess?: PaEffective | null }) | undefined;
  if (!u || paIsAdminLike(u)) { next(); return; }
  const pa = (u as { pageAccess?: PaEffective | null }).pageAccess !== undefined ? u.pageAccess! : paEffective(u);
  if (!pa) { next(); return; }
  const method = req.method === "HEAD" ? "GET" : req.method, path = req.path;
  for (const p of PA_PAGES) {
    if (!paPhase1(p) || !p.block?.length || !paMatch(p.block, method, path)) continue;
    if (pa.error) { res.status(503).json({ error: "page_access_unavailable" }); return; }
    if (pa.blocked.includes(p.key)) { res.status(403).json({ error: "page_access_blocked", page: p.key }); return; }
  }
  if (pa.error) { next(); return; }
  for (const [key, level] of Object.entries(pa.grants)) {
    const p = PA_BY_KEY.get(key);
    if (!p || p.kind !== "admin") continue;
    const ok = paMatch(p.elevateView, method, path) || (level === "manage" && paGrantable(p) === "both" && paMatch(p.elevateManage, method, path));
    if (!ok) continue;
    const elevated = { ...u, role: "admin", customerScope: "all", pageAccessElevated: key };
    res.locals.authUser = elevated;
    res.locals.pageAccessElevated = elevated; // requireAuth re-runs inside a few routers; it keeps this user (lib/auth.ts)
    break;
  }
  next();
}

/* ---------------- admin side: status, subjects, writes, history ---------------- */
export type PaGrantRow = Row & { created_by: number; created_at: string; updated_at: string | null };
export const paVersion = (key: string): number => Number(queryRow<{ v: number | null }>("SELECT MAX(id) v FROM page_access_log WHERE page_key=?", [key])?.v ?? 0);
export function paActiveRows(key: string): PaGrantRow[] {
  return queryRows<PaGrantRow>("SELECT id,page_key,subject_kind,subject_id,effect,level,created_by,created_at,updated_at FROM page_access_grants WHERE page_key=? AND revoked_at IS NULL ORDER BY id", [key]);
}
type Snapshot = { effect: "allow" | "deny"; level: PaLevel; scope?: string | null } | null;
const snap = (r: Row | undefined | null, scope?: string | null): Snapshot => (r ? { effect: r.effect, level: r.level, ...(scope !== undefined ? { scope } : {}) } : null);

function activeRow(key: string, kind: string, id: string): Row | undefined {
  return queryRow<Row>("SELECT id,page_key,subject_kind,subject_id,effect,level FROM page_access_grants WHERE page_key=? AND subject_kind=? AND subject_id=? AND revoked_at IS NULL", [key, kind, id]);
}
function setRow(key: string, kind: string, id: string, to: Snapshot, actor: number, at: string): void {
  const cur = activeRow(key, kind, id);
  if (cur && to && cur.effect === to.effect) { execute("UPDATE page_access_grants SET level=?, updated_by=?, updated_at=? WHERE id=?", [to.level, actor, at, cur.id]); return; }
  if (cur) execute("UPDATE page_access_grants SET revoked_at=?, revoked_by=? WHERE id=?", [at, actor, cur.id]);
  if (to) execute("INSERT INTO page_access_grants(page_key,subject_kind,subject_id,effect,level,created_by,created_at) VALUES(?,?,?,?,?,?,?)", [key, kind, id, to.effect, to.level, actor, at]);
}
export type PaChange = { kind: "role" | "user"; id: string; to: Snapshot; scope?: { resource: string; before: string | null; after: string | null } };
/** Applies a batch of subject changes for one page in one transaction and writes one log row per subject (same batch id). */
export function paWrite(key: string, actor: number, action: "grant" | "revoke" | "block" | "unblock", changes: PaChange[], now = new Date(), extraTx?: () => void): string {
  const at = now.toISOString(); const batch = `${at}#${actor}#${Math.random().toString(36).slice(2, 8)}`;
  runTransaction(() => {
    for (const c of changes) {
      const before = activeRow(key, c.kind, c.id);
      const act = action === "grant" && before && before.effect === "allow" ? "update" : action;
      setRow(key, c.kind, c.id, c.to, actor, at);
      execute("INSERT INTO page_access_log(at,actor_user_id,batch,action,page_key,subject_kind,subject_id,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?)",
        [at, actor, batch, act, key, c.kind, c.id, JSON.stringify({ row: snap(before), scope: c.scope ? { resource: c.scope.resource, level: c.scope.before } : null }),
          JSON.stringify({ row: c.to, scope: c.scope ? { resource: c.scope.resource, level: c.scope.after } : null })]);
    }
    extraTx?.();
  });
  return batch;
}
type LogRow = { id: number; at: string; actor_user_id: number; batch: string; action: string; page_key: string; subject_kind: string; subject_id: string; before_json: string; after_json: string; revert_of: string | null; reverted_by: string | null };
export const paLog = (key: string, limit = 100): LogRow[] => queryRows<LogRow>("SELECT * FROM page_access_log WHERE page_key=? ORDER BY id DESC LIMIT ?", [key, limit]);
/** Only the newest batch of a page may be reverted, including a revert (undo of that revert restores the previous state). A batch already marked reverted_by is not offered again. */
export function paRevertable(key: string): LogRow[] | null {
  const last = queryRow<LogRow>("SELECT * FROM page_access_log WHERE page_key=? ORDER BY id DESC LIMIT 1", [key]);
  if (!last || last.reverted_by) return null;
  return queryRows<LogRow>("SELECT * FROM page_access_log WHERE page_key=? AND batch=? ORDER BY id", [key, last.batch]);
}
/** Reverts the newest batch: every subject goes back to its «before» row; scope changes are returned for the caller to restore. */
export function paRevert(key: string, batch: string, actor: number, now = new Date(), extraTx?: (scopes: { userId: number; resource: string; level: string | null }[]) => void): string | null {
  const rows = paRevertable(key);
  if (!rows || rows[0]!.batch !== batch) return null;
  const at = now.toISOString(); const nb = `${at}#${actor}#r${Math.random().toString(36).slice(2, 8)}`;
  const scopes: { userId: number; resource: string; level: string | null }[] = [];
  runTransaction(() => {
    for (const r of [...rows].reverse()) {
      const before = JSON.parse(r.before_json) as { row: Snapshot; scope: { resource: string; level: string | null } | null };
      const after = JSON.parse(r.after_json) as { row: Snapshot; scope: { resource: string; level: string | null } | null };
      const cur = activeRow(key, r.subject_kind, r.subject_id);
      setRow(key, r.subject_kind, r.subject_id, before.row, actor, at);
      if (before.scope && before.scope.level !== after.scope?.level) scopes.push({ userId: Number(r.subject_id), resource: before.scope.resource, level: before.scope.level });
      execute("INSERT INTO page_access_log(at,actor_user_id,batch,action,page_key,subject_kind,subject_id,before_json,after_json,revert_of) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [at, actor, nb, "revert", key, r.subject_kind, r.subject_id, JSON.stringify({ row: snap(cur), scope: after.scope }), JSON.stringify({ row: before.row, scope: before.scope }), batch]);
    }
    execute("UPDATE page_access_log SET reverted_by=? WHERE page_key=? AND batch=?", [nb, key, batch]);
    extraTx?.(scopes);
  });
  return nb;
}
