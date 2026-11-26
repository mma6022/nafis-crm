/**
 * «دسترسی این صفحه» v1 API (t942u, Armita v1.1). flag.page_access_v1 OFF → /page-access/me answers {enabled:false},
 * every other route 404s, nothing is created or read. ON → admin / sales manager only (user 29 never) for the admin routes.
 */
import { Router, type Request, type Response } from "express";
import { queryRow, queryRows, execute } from "../lib/crm-db";
import { requireAuth, type AuthUser } from "../lib/auth";
import { permissionsForRole } from "../lib/access-control";
import { elLocked } from "../lib/expert-lockdown";
import { PA_BY_KEY, PA_PAGES, paGrantable, paPhase1, type PaPage } from "../lib/page-access-registry";
import {
  ensurePaSchema, paActiveRows, paEffective, paFlagOn, paIsAdminLike, paIsTrainee, paLog, paRevert, paRevertable, paVersion, paWrite,
  PA_NEVER_USER_IDS, type PaChange, type PaLevel,
} from "../lib/page-access";
import { expertOfUser, getDrafts, loadDoc, metaOf, smcFlagOn, summarize, type AccessDoc, type Level } from "../lib/sales-manager-console";

const router = Router();
const ADMIN_ROLES = ["admin", "sales_manager"];
type URow = { id: number; full_name: string | null; username: string; role: string; salesperson_id: number | null; active: number };
const nameOf = (u: Pick<URow, "full_name" | "username"> | undefined | null) => String(u?.full_name || u?.username || "کاربر");
const userRow = (id: number) => queryRow<URow>("SELECT id,full_name,username,role,salesperson_id,active FROM users WHERE id=?", [id]);
const roleNames = () => new Map(queryRows<{ slug: string; name: string }>("SELECT slug,name FROM app_roles").map((r) => [r.slug, r.name]));

function admin(req: Request, res: Response): AuthUser | null {
  if (!paFlagOn()) { res.status(404).json({ error: "not_found" }); return null; }
  const u = res.locals.authUser as AuthUser | undefined;
  if (!u || !paIsAdminLike(u) || PA_NEVER_USER_IDS.includes(Number(u.id)) || (u as { pageAccessElevated?: string }).pageAccessElevated) {
    res.status(403).json({ error: "forbidden", message: "فقط ادمین و مدیر فروش." }); return null;
  }
  try { ensurePaSchema(); } catch { res.status(503).json({ error: "page_access_unavailable", message: "لیست را نتوانستیم بیاوریم." }); return null; }
  return u;
}
function pageOf(req: Request, res: Response): PaPage | null {
  const p = PA_BY_KEY.get(String(req.params.key ?? ""));
  if (!p || !paPhase1(p)) { res.status(404).json({ error: "unknown_page" }); return null; }
  return p;
}
const levelFa = (l: PaLevel) => (l === "manage" ? "دیدن و کار کردن" : "فقط دیدن");

/** Role default (today's role permissions). Admin-only pages have no role default. */
function roleDefault(p: PaPage, slug: string): PaLevel | null {
  if (p.kind !== "permission" || !p.view.length) return null;
  const perms = new Set(queryRows<{ permission: string }>("SELECT permission FROM role_permissions WHERE role_slug=?", [slug]).map((r) => r.permission));
  if (!p.view.every((x) => perms.has(x))) return null;
  return p.manage.length && p.manage.every((x) => perms.has(x)) ? "manage" : "view";
}

/* ---------------- smc scope bridge («کدام مشتری‌ها؟») ---------------- */
type Scope = "own" | "team" | "all";
function scopeInfo(p: PaPage, userId: number): { expertId: string; level: Scope } | null {
  if (!p.scope || !smcFlagOn()) return null;
  try {
    const e = expertOfUser(loadDoc("teams"), userId); if (!e) return null;
    const lv = loadDoc("access").policies?.[e.id]?.[p.scope] as Level | undefined;
    return { expertId: e.id, level: lv === "team" || lv === "all" ? lv : "own" };
  } catch { return null; }
}
/** Writes the access section the same way «مدیریت فروش» does (version+1 + its own history row). Called inside our transaction. */
function writeScopes(actor: AuthUser, resource: "customers" | "loan_files", sets: { expertId: string; level: Scope | string | null }[], at: string): void {
  if (!sets.length) return;
  const before = loadDoc("access"); const after: AccessDoc = JSON.parse(JSON.stringify(before));
  for (const s of sets) {
    const cur = after.policies[s.expertId] ?? { customers: "own", loan_files: "own" };
    after.policies[s.expertId] = { ...cur, [resource]: (s.level ?? "own") as Level };
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const lines = summarize("access", before, after);
  execute("INSERT INTO smc_audit(at,user_id,section,summary_fa,before_json,after_json,effects_json) VALUES(?,?,?,?,?,?,?)",
    [at, actor.id, "access", (lines.length ? lines.join("؛ ") : "دسترسی تغییر کرد").slice(0, 2000) + " (از «دسترسی این صفحه»)", JSON.stringify(before), JSON.stringify(after), "{}"]);
  execute("UPDATE smc_settings SET payload_json=?, version=?, updated_by=?, updated_at=? WHERE section='access'", [JSON.stringify(after), metaOf("access").version + 1, actor.id, at]);
}

/* ---------------- status ---------------- */
function status(p: PaPage) {
  const g = paGrantable(p); const names = roleNames();
  const rows = g === "never" ? [] : paActiveRows(p.key);
  const users = queryRows<URow>("SELECT id,full_name,username,role,salesperson_id,active FROM users WHERE active=1");
  const members = (slug: string) => users.filter((u) => u.role === slug && !PA_NEVER_USER_IDS.includes(Number(u.id))).length;
  const roles = queryRows<{ slug: string; name: string }>("SELECT slug,name FROM app_roles ORDER BY is_system DESC, created_at, slug")
    .filter((r) => !ADMIN_ROLES.includes(r.slug))
    .map((r) => {
      const grant = rows.find((x) => x.subject_kind === "role" && x.subject_id === r.slug && x.effect === "allow");
      const def = roleDefault(p, r.slug);
      return { slug: r.slug, name: r.name, members: members(r.slug), default: def, grant: grant ? { id: grant.id, level: grant.level } : null };
    })
    .filter((r) => r.default || r.grant);
  const always = users.filter((u) => ADMIN_ROLES.includes(u.role) && !PA_NEVER_USER_IDS.includes(Number(u.id)))
    .map((u) => ({ id: Number(u.id), name: nameOf(u), role: u.role, roleName: names.get(u.role) ?? u.role, kind: "always" as const }));
  const direct = rows.filter((x) => x.subject_kind === "user").map((x) => {
    const u = userRow(Number(x.subject_id)); const by = userRow(Number(x.created_by));
    return { id: Number(x.subject_id), name: nameOf(u), role: u?.role ?? "", roleName: names.get(u?.role ?? "") ?? "", active: Boolean(u?.active),
      kind: x.effect === "deny" ? ("blocked" as const) : ("granted" as const), rowId: x.id, level: x.level, by: nameOf(by), at: x.updated_at ?? x.created_at,
      scope: x.effect === "allow" ? scopeInfo(p, Number(x.subject_id))?.level ?? null : null };
  }).filter((x) => x.active);
  const blockedIds = new Set(direct.filter((x) => x.kind === "blocked").map((x) => x.id));
  // Chip (Mohammad): everyone who can open it, admins + sales manager included; role-only members are not listed twice; blocked users don't count.
  const roleUserIds = new Set<number>();
  for (const r of roles) for (const u of users) if (u.role === r.slug && !PA_NEVER_USER_IDS.includes(Number(u.id))) {
    if (!r.default && paIsTrainee({ id: Number(u.id), role: u.role, salespersonId: u.salesperson_id })) continue;
    roleUserIds.add(Number(u.id));
  }
  const people = new Set<number>([...always.map((x) => x.id), ...direct.filter((x) => x.kind === "granted").map((x) => x.id), ...roleUserIds]);
  for (const id of blockedIds) people.delete(id);
  return {
    key: p.key, label: p.label, grantable: g, viewOnly: g === "view", scope: p.scope ?? null, scopeEnabled: Boolean(p.scope && smcFlagOn()),
    version: g === "never" ? 0 : paVersion(p.key), counts: { people: people.size, roles: roles.length },
    roles, always, users: direct.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "granted" ? -1 : 1)),
  };
}

/* ---------------- routes ---------------- */
router.get("/page-access/me", requireAuth, (_req, res): void => {
  if (!paFlagOn()) { res.json({ enabled: false }); return; }
  const u = res.locals.authUser as AuthUser;
  const adminLike = paIsAdminLike(u);
  const pa = adminLike ? null : (u as { pageAccess?: ReturnType<typeof paEffective> }).pageAccess ?? paEffective(u);
  res.json({
    enabled: true, canManage: adminLike && !PA_NEVER_USER_IDS.includes(Number(u.id)), error: Boolean(pa?.error),
    pages: PA_PAGES.filter(paPhase1).map((p) => ({ key: p.key, label: p.label, routes: p.routes, kind: p.kind, grantable: paGrantable(p) })),
    granted: pa?.grants ?? {}, blocked: pa?.blocked ?? [], locked: Boolean(pa?.locked),
    // Role permissions before the overlay: the client opens a permission page only by its own grant, not by a sibling page's grant.
    basePermissions: adminLike ? null : permissionsForRole(u.role),
  });
});

router.get("/page-access/pages/:key", requireAuth, (req, res): void => {
  if (!admin(req, res)) return; const p = pageOf(req, res); if (!p) return;
  res.json(status(p));
});

router.get("/page-access/pages/:key/subjects", requireAuth, (req, res): void => {
  if (!admin(req, res)) return; const p = pageOf(req, res); if (!p) return;
  if (paGrantable(p) === "never") { res.status(409).json({ error: "never_grantable" }); return; }
  const names = roleNames(); const rows = paActiveRows(p.key);
  const roles = queryRows<{ slug: string; name: string }>("SELECT slug,name FROM app_roles ORDER BY is_system DESC, created_at, slug").filter((r) => !ADMIN_ROLES.includes(r.slug))
    .map((r) => {
      const grant = rows.find((x) => x.subject_kind === "role" && x.subject_id === r.slug && x.effect === "allow");
      const def = roleDefault(p, r.slug);
      return { slug: r.slug, name: r.name, members: queryRow<{ n: number }>("SELECT COUNT(*) n FROM users WHERE active=1 AND role=? AND id NOT IN (29)", [r.slug])?.n ?? 0,
        has: Boolean(def || grant), default: def, grant: grant ? { id: grant.id, level: grant.level } : null };
    });
  const users = queryRows<URow>("SELECT id,full_name,username,role,salesperson_id,active FROM users WHERE active=1 ORDER BY full_name, id")
    .filter((u) => !ADMIN_ROLES.includes(u.role) && !PA_NEVER_USER_IDS.includes(Number(u.id)))
    .map((u) => {
      const id = Number(u.id); const trainee = paIsTrainee({ id, role: u.role, salespersonId: u.salesperson_id });
      const direct = rows.find((x) => x.subject_kind === "user" && x.subject_id === String(id));
      const viaRole = rows.find((x) => x.subject_kind === "role" && x.subject_id === u.role && x.effect === "allow");
      const def = roleDefault(p, u.role);
      let locked = false; try { locked = elLocked({ id, role: u.role, salespersonId: u.salesperson_id }); } catch { locked = false; }
      const sc = scopeInfo(p, id);
      return { id, name: nameOf(u), role: u.role, roleName: names.get(u.role) ?? u.role, trainee, locked,
        has: direct?.effect === "allow" ? direct.level : null, blocked: direct?.effect === "deny" ? direct.id : null,
        fromRole: !direct && (def ? true : viaRole && !trainee ? true : false), grantId: direct?.effect === "allow" ? direct.id : null,
        scope: sc?.level ?? null, scopeAvailable: Boolean(sc) };
    });
  res.json({ version: paVersion(p.key), roles, users });
});

function checkVersion(req: Request, res: Response, key: string): boolean {
  const base = Number((req.body as { baseVersion?: unknown })?.baseVersion);
  if (!Number.isFinite(base) || base !== paVersion(key)) { res.status(409).json({ error: "changed", message: "این لیست تغییر کرده، دوباره بارگذاری شد." }); return false; }
  return true;
}
function subjectUsers(ids: unknown): URow[] | null {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50) return null;
  const out: URow[] = [];
  for (const raw of ids) {
    const id = Number(raw); if (!Number.isInteger(id) || id <= 0) return null;
    const u = userRow(id); if (!u || !u.active || ADMIN_ROLES.includes(u.role) || PA_NEVER_USER_IDS.includes(id)) return null;
    if (!out.some((x) => x.id === id)) out.push(u);
  }
  return out;
}
const bad = (res: Response, error: string) => { res.status(422).json({ error, message: "دسترسی ذخیره نشد. چیزی تغییر نکرد." }); };
const failed = (res: Response, e: unknown) => { console.error("[page-access] write failed", e instanceof Error ? e.message : e); res.status(500).json({ error: "save_failed", message: "دسترسی ذخیره نشد. چیزی تغییر نکرد." }); };

router.post("/page-access/pages/:key/grants", requireAuth, (req, res): void => {
  const actor = admin(req, res); if (!actor) return; const p = pageOf(req, res); if (!p) return;
  const g = paGrantable(p); if (g === "never") { res.status(409).json({ error: "never_grantable" }); return; }
  const body = (req.body ?? {}) as { subjectKind?: string; roleSlug?: string; userIds?: unknown; level?: string; scope?: string };
  const level = body.level === "manage" ? "manage" : body.level === "view" ? "view" : null;
  if (!level || (level === "manage" && g !== "both")) { bad(res, "invalid_level"); return; }
  if (!checkVersion(req, res, p.key)) return;
  const at = new Date();
  try {
    if (body.subjectKind === "role") {
      const slug = String(body.roleSlug ?? "");
      if (!slug || ADMIN_ROLES.includes(slug) || !queryRow("SELECT 1 x FROM app_roles WHERE slug=?", [slug])) { bad(res, "invalid_subject"); return; }
      const batch = paWrite(p.key, actor.id, "grant", [{ kind: "role", id: slug, to: { effect: "allow", level } }], at);
      res.json({ ok: true, batch, status: status(p) }); return;
    }
    if (body.subjectKind !== "user") { bad(res, "invalid_subject"); return; }
    const us = subjectUsers(body.userIds); if (!us) { bad(res, "invalid_subject"); return; }
    const scope = body.scope === "own" || body.scope === "team" || body.scope === "all" ? body.scope : null;
    const scopeSets: { expertId: string; level: Scope }[] = [];
    const changes: PaChange[] = us.map((u) => {
      const c: PaChange = { kind: "user", id: String(u.id), to: { effect: "allow", level } };
      const sc = p.scope && scope ? scopeInfo(p, Number(u.id)) : null;
      if (sc && p.scope) { c.scope = { resource: p.scope, before: sc.level, after: scope! }; if (sc.level !== scope) scopeSets.push({ expertId: sc.expertId, level: scope! }); }
      return c;
    });
    if (scopeSets.length && getDrafts(actor.id).access) { res.status(409).json({ error: "smc_draft", message: "در «مدیریت فروش» تغییر ذخیره‌نشده‌ای در دسترسی‌ها داری؛ اول آن را اعمال یا رها کن." }); return; }
    const batch = paWrite(p.key, actor.id, "grant", changes, at, () => writeScopes(actor, p.scope!, scopeSets, at.toISOString()));
    res.json({ ok: true, batch, status: status(p) });
  } catch (e) { failed(res, e); }
});

router.post("/page-access/pages/:key/blocks", requireAuth, (req, res): void => {
  const actor = admin(req, res); if (!actor) return; const p = pageOf(req, res); if (!p) return;
  if (paGrantable(p) === "never") { res.status(409).json({ error: "never_grantable" }); return; }
  const us = subjectUsers([(req.body as { userId?: unknown })?.userId]); if (!us) { bad(res, "invalid_subject"); return; }
  if (!checkVersion(req, res, p.key)) return;
  try {
    const batch = paWrite(p.key, actor.id, "block", [{ kind: "user", id: String(us[0]!.id), to: { effect: "deny", level: "view" } }]);
    res.json({ ok: true, batch, status: status(p) });
  } catch (e) { failed(res, e); }
});

/** «برداشتن دسترسی» (allow row) / «باز کردن» (deny row). */
router.post("/page-access/pages/:key/rows/:id/remove", requireAuth, (req, res): void => {
  const actor = admin(req, res); if (!actor) return; const p = pageOf(req, res); if (!p) return;
  const row = paActiveRows(p.key).find((x) => x.id === Number(req.params.id));
  if (!row) { res.status(409).json({ error: "changed", message: "این لیست تغییر کرده، دوباره بارگذاری شد." }); return; }
  if (!checkVersion(req, res, p.key)) return;
  try {
    const batch = paWrite(p.key, actor.id, row.effect === "deny" ? "unblock" : "revoke", [{ kind: row.subject_kind, id: row.subject_id, to: null }]);
    res.json({ ok: true, batch, status: status(p) });
  } catch (e) { failed(res, e); }
});

router.get("/page-access/pages/:key/history", requireAuth, (req, res): void => {
  if (!admin(req, res)) return; const p = pageOf(req, res); if (!p) return;
  if (paGrantable(p) === "never") { res.json({ items: [], revertBatch: null }); return; }
  const names = roleNames(); const rev = paRevertable(p.key);
  const snap = (x: { row?: { effect?: string; level?: PaLevel } | null; scope?: { level?: string | null } | null } | null) => {
    const row = x?.row ?? null;
    return { effect: (row?.effect === "allow" || row?.effect === "deny") ? row.effect : null, level: row?.effect === "allow" ? (row.level ?? null) : null, scope: x?.scope?.level ?? null };
  };
  const items = paLog(p.key).map((r) => {
    const after = JSON.parse(r.after_json || "{}") as { row: { effect: string; level: PaLevel } | null; scope: { level: string | null } | null };
    const before = JSON.parse(r.before_json || "{}") as { row: { effect: string; level: PaLevel } | null; scope: { level: string | null } | null };
    const subj = r.subject_kind === "role" ? { name: names.get(r.subject_id) ?? r.subject_id, id: null } : { name: nameOf(userRow(Number(r.subject_id))), id: Number(r.subject_id) };
    const lvl = after.row?.effect === "allow" ? after.row.level : before.row?.effect === "allow" ? before.row.level : null;
    return { id: r.id, batch: r.batch, at: r.at, actor: nameOf(userRow(r.actor_user_id)), action: r.action, subjectKind: r.subject_kind, subjectName: subj.name, subjectId: subj.id,
      level: lvl, levelFa: lvl ? levelFa(lvl) : null, scope: after.scope?.level ?? null, reverted: Boolean(r.reverted_by), revertOf: r.revert_of,
      prior: snap(before), result: snap(after) };
  });
  res.json({ items, revertBatch: rev ? rev[0]!.batch : null, version: paVersion(p.key) });
});

router.post("/page-access/pages/:key/revert", requireAuth, (req, res): void => {
  const actor = admin(req, res); if (!actor) return; const p = pageOf(req, res); if (!p) return;
  const batch = String((req.body as { batch?: unknown })?.batch ?? "");
  const rows = paRevertable(p.key);
  if (!rows || rows[0]!.batch !== batch) { res.status(409).json({ error: "changed", message: "این لیست تغییر کرده، دوباره بارگذاری شد." }); return; }
  const needsScope = rows.some((r) => { try { const b = JSON.parse(r.before_json), a = JSON.parse(r.after_json); return b.scope && b.scope.level !== a.scope?.level; } catch { return false; } });
  if (needsScope && getDrafts(actor.id).access) { res.status(409).json({ error: "smc_draft", message: "در «مدیریت فروش» تغییر ذخیره‌نشده‌ای در دسترسی‌ها داری؛ اول آن را اعمال یا رها کن." }); return; }
  try {
    const at = new Date();
    const nb = paRevert(p.key, batch, actor.id, at, (scopes) => {
      if (!p.scope) return;
      const sets = scopes.map((s) => ({ expertId: scopeInfo(p, s.userId)?.expertId ?? "", level: s.level })).filter((s) => s.expertId);
      writeScopes(actor, p.scope, sets, at.toISOString());
    });
    if (!nb) { res.status(409).json({ error: "changed", message: "این لیست تغییر کرده، دوباره بارگذاری شد." }); return; }
    res.json({ ok: true, batch: nb, status: status(p) });
  } catch (e) { failed(res, e); }
});

export default router;
