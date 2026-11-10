/**
 * Team-builder routes (flag.multi_team_v1).
 * OFF → fall through (404 as before). ON: admin + sales_manager manage; experts read their own team;
 * only the true admin can disable / re-enable.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import {
  addMember,
  createTeam,
  disableTeam,
  enableTeam,
  isManager,
  isTrueAdmin,
  listState,
  loseLines,
  pickerPeople,
  presentIntake,
  presentTeam,
  putIntake,
  type MemberInput,
} from "../lib/sales-teams-admin";
import { loadTeam, migrateMultiTeam, mtFlagOn, teamOfSalesperson } from "../lib/multi-team";

const me = (res: Response) => res.locals.authUser as AuthUser;
const idParam = (req: Request) => {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : 0;
};
function parseMembers(raw: unknown): MemberInput[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((m, i) => ({
    salespersonId: Number((m as MemberInput).salespersonId),
    isLead: Boolean((m as MemberInput).isLead),
    ownsNone: Boolean((m as MemberInput).ownsNone),
    ownsP1: Boolean((m as MemberInput).ownsP1),
    ownsP2: Boolean((m as MemberInput).ownsP2),
    ownsP3: Boolean((m as MemberInput).ownsP3),
    sortOrder: Number.isInteger((m as MemberInput).sortOrder) ? Number((m as MemberInput).sortOrder) : i,
  }));
}
function parseMember(raw: unknown): MemberInput | null {
  if (!raw || typeof raw !== "object") return null;
  const list = parseMembers([raw]);
  return list && list[0] ? list[0] : null;
}

const router: IRouter = Router();

function gate(req: Request, res: Response, next: NextFunction) {
  if (!mtFlagOn()) return next("router");
  res.setHeader("Cache-Control", "private, no-store");
  if (req.path === "/sales-teams/me") return next();
  if (!me(res)) return void res.status(401).json({ error: "unauthenticated" });
  next();
}

const scoped: IRouter = Router();
scoped.use((req, res, next) => (req.path === "/sales-teams" || req.path.startsWith("/sales-teams/") ? gate(req, res, next) : next("router")));

scoped.get("/sales-teams/me", (req, res) => {
  const u = me(res);
  const manage = isManager(u);
  const admin = isTrueAdmin(u);
  const team = u?.salespersonId != null ? teamOfSalesperson(Number(u.salespersonId)) : null;
  res.json({
    enabled: true,
    canManage: manage,
    canDisable: admin,
    canEnable: admin,
    canView: manage || Boolean(team),
    readonly: !manage,
    userId: u?.id ?? null,
    salespersonId: u?.salespersonId ?? null,
    teamId: team?.id ?? null,
    displayName: u?.fullName || u?.username || "",
    roleLabel: admin ? "مدیر سامانه" : (u && (u as AuthUser).salesManager || u?.baseRole === "sales_manager") ? "مدیر فروش" : "کارشناس فروش",
  });
});

scoped.get("/sales-teams/picker", (req, res) => {
  const u = me(res);
  if (!isManager(u)) return void res.status(403).json({ error: "no_access", message: "انتخاب کارشناس فقط برای مدیر سامانه و مدیر فروش است." });
  try {
    migrateMultiTeam();
    res.json({ people: pickerPeople() });
  } catch (e) {
    res.status(500).json({ error: "load_failed", message: "فهرست کارشناسان باز نشد." });
  }
});

scoped.get("/sales-teams/intake", (req, res) => {
  const u = me(res);
  if (!isManager(u)) return void res.status(403).json({ error: "no_access", message: "تقسیم مشتری جدید فقط برای مدیر سامانه و مدیر فروش است." });
  try {
    migrateMultiTeam();
    res.json({ intake: presentIntake() });
  } catch {
    res.status(500).json({ error: "load_failed", message: "تنظیم تقسیم باز نشد." });
  }
});

scoped.put("/sales-teams/intake", (req, res) => {
  const u = me(res);
  if (!isManager(u)) return void res.status(403).json({ error: "no_access", message: "تقسیم مشتری جدید فقط برای مدیر سامانه و مدیر فروش است." });
  const result = putIntake(req.body ?? {});
  if (!result.ok) return void res.status(result.status).json({ error: result.error, message: result.message });
  res.json({ intake: result.intake });
});

scoped.get("/sales-teams", (req, res) => {
  const u = me(res);
  try {
    const state = listState();
    if (isManager(u)) return void res.json({ ...state, canManage: true, canDisable: isTrueAdmin(u) });
    const team = u?.salespersonId != null ? state.teams.find((t) => t.members.some((m) => m.salespersonId === Number(u.salespersonId))) : null;
    if (!team) return void res.json({ teams: [], intake: [], todayLabel: state.todayLabel, canManage: false, canDisable: false, readonly: true });
    res.json({ teams: [team], intake: [], todayLabel: state.todayLabel, canManage: false, canDisable: false, readonly: true });
  } catch {
    res.status(500).json({ error: "load_failed", message: "فهرست تیم‌ها الآن نیامد" });
  }
});

scoped.get("/sales-teams/:id", (req, res) => {
  const n = idParam(req);
  if (!n) return void res.status(400).json({ error: "bad_id", message: "شناسه تیم معتبر نیست." });
  const u = me(res);
  const team = loadTeam(n);
  if (!team) return void res.status(404).json({ error: "not_found", message: "تیم پیدا نشد." });
  if (!isManager(u)) {
    const mine = team.members.some((m) => m.salespersonId === Number(u.salespersonId));
    if (!mine) return void res.status(403).json({ error: "no_access", message: "فقط تیم خودتان را می‌بینید." });
  }
  const presented = presentTeam(team);
  res.json({ team: presented });
});

scoped.post("/sales-teams", (req, res) => {
  if (!isManager(me(res))) return void res.status(403).json({ error: "no_access", message: "ساخت تیم فقط برای مدیر سامانه و مدیر فروش است." });
  const members = parseMembers(req.body?.members);
  if (!members) return void res.status(400).json({ error: "invalid_members", message: "اعضای تیم را انتخاب کنید." });
  const result = createTeam(String(req.body?.name ?? ""), members);
  if (!result.ok) return void res.status(result.status).json({ error: result.error, message: result.message, errors: result.errors });
  res.status(201).json({ team: result.team });
});

scoped.patch("/sales-teams/:id", (req, res) => {
  if (!isManager(me(res))) return void res.status(403).json({ error: "no_access", message: "ویرایش تیم فقط برای مدیر سامانه و مدیر فروش است." });
  const n = idParam(req);
  if (!n) return void res.status(400).json({ error: "bad_id", message: "شناسه تیم معتبر نیست." });
  const members = req.body?.members != null ? parseMembers(req.body.members) : undefined;
  if (req.body?.members != null && !members) return void res.status(400).json({ error: "invalid_members", message: "اعضای تیم را انتخاب کنید." });
  const result = updateTeam(n, { name: req.body?.name, members: members ?? undefined });
  if (!result.ok) return void res.status(result.status).json({ error: result.error, message: result.message, errors: result.errors });
  res.json({ team: result.team });
});

scoped.post("/sales-teams/:id/members", (req, res) => {
  if (!isManager(me(res))) return void res.status(403).json({ error: "no_access", message: "افزودن عضو فقط برای مدیر سامانه و مدیر فروش است." });
  const n = idParam(req);
  if (!n) return void res.status(400).json({ error: "bad_id", message: "شناسه تیم معتبر نیست." });
  const member = parseMember(req.body?.member ?? req.body);
  if (!member) return void res.status(400).json({ error: "invalid_members", message: "کارشناس را انتخاب کنید." });
  const existing = loadTeam(n);
  const preview = existing ? loseLines(existing, member) : [];
  if (req.body?.preview === true) {
    return void res.json({ lose: preview });
  }
  const result = addMember(n, member);
  if (!result.ok) return void res.status(result.status).json({ error: result.error, message: result.message, errors: result.errors });
  res.status(201).json({ team: result.team, lose: preview });
});

scoped.post("/sales-teams/:id/disable", (req, res) => {
  if (!isTrueAdmin(me(res))) return void res.status(403).json({ error: "no_access", message: "غیرفعال کردن تیم فقط برای مدیر سامانه است." });
  const n = idParam(req);
  if (!n) return void res.status(400).json({ error: "bad_id", message: "شناسه تیم معتبر نیست." });
  const result = disableTeam(n);
  if (!result.ok) {
    // Scene 13 copy when the team is still an intake destination.
    const message = result.error === "intake_destination"
      ? (result.sources && result.sources.length
          ? `این تیم مقصد ${result.sources.map((s) => s === "site_leads" ? "لید فرم سایت" : "تقسیم مشتری جدید").join(" و ")} است. تا وقتی مقصد عوض نشود، تیم غیرفعال نمی‌شود.`
          : result.message)
      : result.message;
    return void res.status(result.status).json({ error: result.error, message, sources: result.sources });
  }
  res.json({ team: result.team });
});

scoped.post("/sales-teams/:id/enable", (req, res) => {
  if (!isTrueAdmin(me(res))) return void res.status(403).json({ error: "no_access", message: "فعال کردن تیم فقط برای مدیر سامانه است." });
  const n = idParam(req);
  if (!n) return void res.status(400).json({ error: "bad_id", message: "شناسه تیم معتبر نیست." });
  const members = req.body?.members != null ? parseMembers(req.body.members) : undefined;
  if (req.body?.members != null && !members) return void res.status(400).json({ error: "invalid_members", message: "اعضای تیم را انتخاب کنید." });
  const result = enableTeam(n, members ?? undefined);
  if (!result.ok) return void res.status(result.status).json({ error: result.error, message: result.message, errors: result.errors });
  res.json({ team: result.team });
});

router.use(scoped);
export default router;
