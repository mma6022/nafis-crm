/**
 * «مدیریت تیم فروش» v1.1 routes (flag.sales_manager_console_v1, global, default OFF → every /sales-admin path falls through = 404).
 * ON: only the sales manager and admin (403 for everyone else, enforced here, not only hidden in the UI).
 * `smcEnforceGuard` applies the saved access / validity / daily-list settings to experts; it does nothing while the flag is OFF.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { queryRow, queryRows } from "../lib/crm-db";
import {
  accessLevel, addDays, allowedSalespersons, apply, arrangeQueue, auditList, COLLATERAL_STAGES, CONTRACT_STAGES, creditValidUntil, customerCounts,
  DEFAULT_WEIGHTS, distLog, draftSummary, dropDraft, ensureSmcSchema, expertName, fa, GUARANTOR_STAGES, getDrafts, isSection, isYmd, jFull, liveTeams, loadDoc,
  metaOf, modelFor, overlayExpertQueue, planChips, planStages, previewModel, putDraft, revert, routeLead, rulesNaming, SECTIONS, smcCanManage,
  smcFlagOn, SMC_NEVER_USER, staleRules, SYSTEM_STAGES, teamName, userPicker, validFa, LEVEL_FA, ymdTehran, type Lead, type Model, type Section,
  samMerged, samAccessRoles,
} from "../lib/sales-manager-console";
import { isFoldKey, samCanWriteFolded, samImport, samRevertTeam, samSaveFolded, samUndoFolded, samView, samWriteTeam } from "../lib/sales-admin-merge";
import { isSabSection, sabCanWrite, sabConnectBot, sabOn, sabRequestTranscripts, sabVoiceView, sabSaveKey, sabSaveQuick, sabSetAi, sabSetMode, sabSetView, sabSetVoiceMode, sabState, sabUndo, startSabVoiceFeeder } from "../lib/sales-admin-bale";
import { smcBotDisconnect, smcBotEditOn, smcBotEditSave, smcBotEditUndo, smcBotsView, smcBotTestSaved, smcBotTestToken } from "../lib/smc-bot-edit";

const me = (res: Response) => res.locals.authUser as AuthUser | undefined;
const router: IRouter = Router();
const isSmcPath = (p: string) => p === "/sales-admin" || p.startsWith("/sales-admin/");

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isSmcPath(req.path)) return next("router");
  if (!smcFlagOn()) return next("router");
  res.setHeader("Cache-Control", "private, no-store");
  const u = me(res);
  if (!u) return void res.status(401).json({ error: "unauthenticated" });
  if (!smcCanManage(u)) return void res.status(403).json({ error: "smc_forbidden", message: "این صفحه فقط برای مدیر فروش و ادمین است." });
  try { ensureSmcSchema(); } catch { return void res.status(500).json({ error: "schema_failed", message: "صفحه باز نشد." }); }
  next();
});

const today = () => ymdTehran(new Date());
const nowFa = () => jFull(new Date());

function sectionSummaries(userId: number) {
  const t = loadDoc("teams"); const access = loadDoc("access"); const valid = loadDoc("valid"); const md = loadDoc("model"); const dist = loadDoc("dist"); const steps = loadDoc("steps");
  const teamsLine = liveTeams(t).map((x) => `${x.name}: ${t.experts.filter((e) => e.teamId === x.id).map((e) => e.displayName.replace(/^(خانم|آقای) /, "")).join("، ") || "خالی"}`).join("؛ ");
  const lvlCount = (lvl: string) => Object.values(access.policies).filter((p) => p.customers === lvl).length;
  const modelLine = md.models.length
    ? `${fa(md.models.length + 1)} مدل: ${md.models.filter((m) => m.assign.length).map((m) => `${m.name} برای ${m.assign.map((a) => a.scope === "expert" ? expertName(t, a.id) : `کل ${teamName(t, a.id)}`).join("، ")}`).join("، ") || "به کسی داده نشده"}، بقیه پیش‌فرض سیستم`
    : "همه با پیش‌فرض سیستم";
  const memberRules = Object.values(dist.member).reduce((a, m) => a + m.rules.length, 0);
  const custom = Object.entries(steps.plans).filter(([k, v]) => k !== "default" && v).length;
  const last = auditList(null, 1)[0];
  const tq = arrangeQueueSafe(t.experts[0]?.id ?? null);
  return {
    teams: teamsLine || "هنوز تیمی نیست",
    daily: tq ? `${tq.who}، ${tq.dayFa}: ${fa(tq.count)} کار${tq.manual ? `، ${fa(tq.manual)} تغییر دستی` : ""}${tq.removed ? ` و ${fa(tq.removed)} حذف` : ""}` : "کارشناسی تعریف نشده",
    access: `فقط خودش: ${fa(lvlCount("own"))}، تیمش: ${fa(lvlCount("team"))}، همه: ${fa(lvlCount("all"))}، قفل: ${fa(lvlCount("locked"))}`,
    valid: `احراز هویت: ${validFa(valid.identity)}، اعتبارسنجی: ${validFa(valid.credit)}`,
    model: modelLine,
    dist: `${fa(liveTeams(t).length)} تیم، ${fa(dist.team.rules.length)} قانون بین تیم‌ها، ${fa(memberRules)} قانون داخل تیم‌ها`,
    steps: custom ? `پیش‌فرض سیستم برای همه، به‌جز ${fa(custom)} طرح سفارشی` : "پیش‌فرض سیستم برای همه‌ی طرح‌ها",
    audit: last ? `آخرین تغییر: ${last.summary.split("؛ ")[0]}، ${last.atFa}` : "هنوز تغییری ثبت نشده",
  };
  function arrangeQueueSafe(expertId: string | null) {
    if (!expertId) return null;
    try { const d = addDays(today(), 1); const q = arrangeQueue(expertId, d); return { who: expertName(t, expertId), dayFa: "فردا", count: q.count, manual: q.manual, removed: q.removed }; } catch { return null; }
  }
}

router.get("/sales-admin/me", (_req, res) => {
  const u = me(res)!;
  const roleLabel = u.role === "admin" && !u.salesManager && u.baseRole !== "sales_manager" ? "ادمین" : "مدیر فروش";
  const be = smcBotEditOn() ? { botEdit: true } : {};
  // v1.2 fields only while flag.sales_admin_merge_v12 is ON, so the v1.1 response stays byte-identical when it is OFF.
  if (!samMerged()) return void res.json({ enabled: true, canManage: true, roleLabel, ...be });
  res.json({ enabled: true, canManage: true, roleLabel, merged: true, path: "/sales-admin", accessRoles: samAccessRoles(), ...(sabOn() ? { bale: true } : {}), ...be });
});

/* ---------------- admin bot edit in SMC (flag.smc_bot_edit_v1 + console flag; OFF -> 404) ---------------- */
const botEditOff = (res: Response) => { if (smcBotEditOn()) return false; res.status(404).json({ error: "not_found" }); return true; };
router.get("/sales-admin/bots", (_req, res) => {
  if (botEditOff(res)) return;
  res.json(smcBotsView());
});
router.post("/sales-admin/bots/test", async (req, res) => {
  if (botEditOff(res)) return;
  try { sabSend(res, await smcBotTestToken(me(res)!, req.body ?? {})); }
  catch { res.status(500).json({ ok: false, error: "unknown", message: "آزمایش توکن انجام نشد؛ دوباره تلاش کنید." }); }
});
router.post("/sales-admin/bots/:userId/test", async (req, res) => {
  if (botEditOff(res)) return;
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) return void res.status(400).json({ ok: false, error: "bad_id" });
  try { sabSend(res, await smcBotTestSaved(me(res)!, userId)); }
  catch { res.status(500).json({ ok: false, error: "unknown", message: "آزمایش اتصال انجام نشد؛ دوباره تلاش کنید." }); }
});
router.put("/sales-admin/bots/:userId", async (req, res) => {
  if (botEditOff(res)) return;
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) return void res.status(400).json({ ok: false, error: "bad_id" });
  try { sabSend(res, await smcBotEditSave(me(res)!, userId, req.body ?? {})); }
  catch { res.status(500).json({ ok: false, error: "unknown", message: "تغییرات ربات ذخیره نشد؛ دوباره تلاش کنید." }); }
});
router.post("/sales-admin/bots/:userId/disconnect", (req, res) => {
  if (botEditOff(res)) return;
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) return void res.status(400).json({ ok: false, error: "bad_id" });
  sabSend(res, smcBotDisconnect(me(res)!, userId));
});

/* ---------------- v1.3 Bale + voice (flag.sales_admin_bale_v13 + both console flags; OFF → 404) ---------------- */
const baleOff = (res: Response) => { if (sabOn()) return false; res.status(404).json({ error: "not_found" }); return true; };
type SabR = { ok: boolean; status?: number };
const sabSend = (res: Response, r: SabR) => { if (!r.ok) return void res.status((r as { status: number }).status).json(r); res.json(r); };
router.get("/sales-admin/bale/state", (_req, res) => {
  if (baleOff(res)) return;
  res.json({ ...sabState(), canWrite: sabCanWrite(me(res)) });
});
router.put("/sales-admin/bale/ai", (req, res) => { if (baleOff(res)) return; sabSend(res, sabSetAi(me(res)!, req.body ?? {})); });
router.put("/sales-admin/bale/mode", (req, res) => { if (baleOff(res)) return; sabSend(res, sabSetMode(me(res)!, req.body ?? {})); });
router.put("/sales-admin/bale/view", (req, res) => { if (baleOff(res)) return; sabSend(res, sabSetView(me(res)!, req.body ?? {})); });
router.put("/sales-admin/bale/quick", (req, res) => { if (baleOff(res)) return; sabSend(res, sabSaveQuick(me(res)!, req.body ?? {})); });
router.get("/sales-admin/bale/voice", (req, res) => { if (baleOff(res)) return; res.json(sabVoiceView(req.query.page)); });
router.put("/sales-admin/bale/voice/mode", (req, res) => { if (baleOff(res)) return; sabSend(res, sabSetVoiceMode(me(res)!, req.body ?? {})); });
router.post("/sales-admin/bale/voice/transcribe", (req, res) => { if (baleOff(res)) return; sabSend(res, sabRequestTranscripts(me(res)!, req.body ?? {})); });
router.post("/sales-admin/bale/bots/connect", async (req, res) => {
  if (baleOff(res)) return;
  try { sabSend(res, await sabConnectBot(me(res)!, req.body ?? {})); }
  catch { res.status(500).json({ ok: false, error: "unknown", message: "ربات وصل نشد؛ دوباره تلاش کنید." }); } // never echoes the token
});
router.post("/sales-admin/bale/key", (req, res) => {
  if (baleOff(res)) return;
  try { sabSend(res, sabSaveKey(me(res)!, req.body ?? {})); }
  catch { res.status(500).json({ ok: false, error: "unknown", message: "کلید ذخیره نشد؛ دوباره تلاش کنید." }); } // never echoes the key
});
startSabVoiceFeeder();

/* ---------------- v1.2 merge (flag.sales_admin_merge_v12; OFF → 404 like an unknown path) ---------------- */
const mergeOff = (res: Response) => { if (samMerged()) return false; res.status(404).json({ error: "not_found" }); return true; };
router.get("/sales-admin/merge/state", (_req, res) => {
  if (mergeOff(res)) return;
  const imp = samImport(me(res)!.id); // idempotent: first open after the flag is turned on carries the values over; later opens write nothing unless live changed
  if (!imp.ok) return void res.status(imp.status).json(imp);
  res.json({ ...samView(), canWriteFolded: samCanWriteFolded(me(res)) });
});
router.put("/sales-admin/merge/teams/:id", (req, res) => {
  if (mergeOff(res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "bad_id" });
  const r = samWriteTeam(me(res)!, id, { name: req.body?.name, enabled: req.body?.enabled, preview: req.body?.preview === true });
  if (!r.ok) return void res.status(r.status).json(r);
  res.json(r);
});
/** The four folded sections (t358s1318 §2): same validators/savers/tables as the old pages + smc_audit for «برگرداندن». */
router.put("/sales-admin/merge/section/:key", (req, res) => {
  if (mergeOff(res)) return;
  const key = req.params.key;
  if (!isFoldKey(key)) return void res.status(404).json({ error: "unknown_section" });
  const r = samSaveFolded(me(res)!, key, req.body ?? {});
  if (!r.ok) return void res.status(r.status).json(r);
  res.json(r);
});

router.get("/sales-admin/overview", (_req, res) => {
  const u = me(res)!; const drafts = getDrafts(u.id);
  const sum = sectionSummaries(u.id);
  res.json({
    dateFa: nowFa(), sections: [...SECTIONS, "audit"].map((s) => ({ id: s, summary: (sum as any)[s], draftChanges: drafts[s]?.changes ?? 0, version: s === "audit" ? null : metaOf(s as Section).version })),
  });
});

router.get("/sales-admin/state", (_req, res) => {
  const u = me(res)!;
  const t = loadDoc("teams"); const counts = customerCounts(); const dist = loadDoc("dist");
  const people = t.experts.map((e) => ({
    ...e, customers: e.salespersonId ? counts.get(e.salespersonId)?.customers ?? 0 : 0, openFiles: e.salespersonId ? counts.get(e.salespersonId)?.openFiles ?? 0 : 0,
    rulesNaming: rulesNaming(dist, e.id, e.teamId), hasModel: modelFor(e.id, t, loadDoc("model"))?.name ?? null,
  }));
  const meta: Record<string, unknown> = {}; for (const s of SECTIONS) meta[s] = metaOf(s);
  res.json({
    dateFa: nowFa(), today: today(), sums: sectionSummaries(u.id), meta, drafts: getDrafts(u.id),
    docs: { teams: t, daily: loadDoc("daily"), access: loadDoc("access"), valid: loadDoc("valid"), model: loadDoc("model"), dist, steps: loadDoc("steps") },
    people, users: userPicker(), plans: planChips(), systemStages: SYSTEM_STAGES, stageGroups: { contract: CONTRACT_STAGES, guarantor: GUARANTOR_STAGES, collateral: COLLATERAL_STAGES },
    stale: staleRules(t, dist), defaultWeights: DEFAULT_WEIGHTS, levelsFa: LEVEL_FA,
  });
});

router.put("/sales-admin/drafts/:section", (req, res) => {
  const u = me(res)!; const s = req.params.section;
  if (!isSection(s)) return void res.status(404).json({ error: "unknown_section" });
  const doc = req.body?.doc;
  if (doc == null || typeof doc !== "object") return void res.status(400).json({ error: "invalid_draft", message: "پیش‌نویس خالی است." });
  if (JSON.stringify(doc).length > 400_000) return void res.status(413).json({ error: "too_large", message: "پیش‌نویس بزرگ است." });
  const base = Number.isInteger(req.body?.baseVersion) ? Number(req.body.baseVersion) : null;
  putDraft(u.id, s, doc, base, Number(req.body?.changes) || 1);
  res.json({ ok: true, section: s, drafts: getDrafts(u.id) });
});
router.delete("/sales-admin/drafts/:section", (req, res) => {
  const u = me(res)!; const s = req.params.section;
  if (s !== "all" && !isSection(s)) return void res.status(404).json({ error: "unknown_section" });
  res.json({ ok: true, dropped: dropDraft(u.id, s === "all" ? null : s) });
});

router.post("/sales-admin/apply/preview", (req, res) => {
  const u = me(res)!;
  const sections = (Array.isArray(req.body?.sections) ? req.body.sections : []).filter(isSection) as Section[];
  res.json({ rows: draftSummary(u.id, sections) });
});
router.post("/sales-admin/apply", (req, res) => {
  const u = me(res)!;
  const sections = (Array.isArray(req.body?.sections) ? req.body.sections : []).filter(isSection) as Section[];
  if (!sections.length) return void res.status(400).json({ error: "no_sections", message: "بخشی برای اعمال انتخاب نشده." });
  const docs = req.body?.docs && typeof req.body.docs === "object" ? req.body.docs : undefined;
  const r = apply(u, sections, { docs, force: req.body?.force === true });
  if (!r.ok) return void res.status(r.status).json(r);
  res.json(r);
});

router.get("/sales-admin/queue", (req, res) => {
  const t = loadDoc("teams");
  const expert = String(req.query.expert ?? "");
  const date = String(req.query.date ?? today());
  if (!t.experts.some((e) => e.id === expert)) return void res.status(404).json({ error: "unknown_expert", message: "کارشناس پیدا نشد." });
  if (!isYmd(date)) return void res.status(400).json({ error: "bad_date" });
  if (date < today() || date > addDays(today(), 14)) return void res.status(422).json({ error: "date_range", message: "فقط امروز تا ۱۴ روز بعد." });
  const draft = getDrafts(me(res)!.id).daily?.doc?.ops;
  res.json(arrangeQueue(expert, date, { extraOps: Array.isArray(draft) ? draft : [] }));
});

/** The page's own view: the unsaved daily draft (blocks + ops) comes in the body, so the list never races the draft save. */
router.post("/sales-admin/queue", (req, res) => {
  const t = loadDoc("teams");
  const expert = String(req.body?.expert ?? ""); const date = String(req.body?.date ?? today());
  if (!t.experts.some((e) => e.id === expert)) return void res.status(404).json({ error: "unknown_expert", message: "کارشناس پیدا نشد." });
  if (!isYmd(date)) return void res.status(400).json({ error: "bad_date" });
  if (date < today() || date > addDays(today(), 14)) return void res.status(422).json({ error: "date_range", message: "فقط امروز تا ۱۴ روز بعد." });
  const draft = req.body?.daily && typeof req.body.daily === "object" ? req.body.daily : undefined;
  const ops = Array.isArray(draft?.ops) ? draft.ops.slice(0, 500) : [];
  res.json(arrangeQueue(expert, date, { extraOps: ops, daily: draft?.blocks ? { blocks: draft.blocks } : undefined }));
});
router.post("/sales-admin/models/preview", (req, res) => {
  const t = loadDoc("teams");
  const model = req.body?.model as Model | undefined; const expert = String(req.body?.expert ?? ""); const date = String(req.body?.date ?? addDays(today(), 1));
  if (!model || typeof model !== "object") return void res.status(400).json({ error: "no_model" });
  if (!t.experts.some((e) => e.id === expert)) return void res.status(404).json({ error: "unknown_expert" });
  if (!isYmd(date)) return void res.status(400).json({ error: "bad_date" });
  res.json(previewModel(model, expert, date));
});

router.post("/sales-admin/distribution/test", (req, res) => {
  const raw = (req.body?.lead ?? {}) as Record<string, unknown>;
  const lead: Lead = {};
  for (const [k, v] of Object.entries(raw)) if (v != null && String(v).length <= 60) (lead as Record<string, string>)[k] = String(v);
  const dist = req.body?.dist && typeof req.body.dist === "object" ? req.body.dist : undefined;
  res.json(routeLead(lead, { commit: false, dist }));
});
router.get("/sales-admin/distribution/log", (req, res) => {
  const d = String(req.query.date ?? today());
  if (!isYmd(d)) return void res.status(400).json({ error: "bad_date" });
  res.json({ date: d, rows: distLog(d) });
});

router.get("/sales-admin/experts/:id/move-info", (req, res) => {
  const t = loadDoc("teams"); const e = t.experts.find((x) => x.id === req.params.id);
  if (!e) return void res.status(404).json({ error: "unknown_expert" });
  const c = e.salespersonId ? customerCounts().get(e.salespersonId) : undefined;
  const dist = loadDoc("dist"); const n = rulesNaming(dist, e.id, e.teamId);
  res.json({ expert: e.displayName, from: e.teamId, fromName: teamName(t, e.teamId), customers: c?.customers ?? 0, openFiles: c?.openFiles ?? 0, rulesNaming: n,
    model: modelFor(e.id, t, loadDoc("model"))?.name ?? null });
});

router.get("/sales-admin/customers/search", (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 40);
  if (q.length < 2) return void res.json({ rows: [] });
  const t = loadDoc("teams");
  const digits = q.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\D/g, "");
  const rows = queryRows<{ id: number; name: string; salesperson_id: number | null }>(
    `SELECT id, name, salesperson_id FROM customers WHERE merged_into_customer_id IS NULL AND (name LIKE ? ${digits.length >= 4 ? "OR phone LIKE ?" : ""}) ORDER BY id DESC LIMIT 12`,
    digits.length >= 4 ? [`%${q}%`, `%${digits}%`] : [`%${q}%`]);
  res.json({ rows: rows.map((r) => ({ id: r.id, name: r.name, owner: t.experts.find((e) => e.salespersonId === r.salesperson_id)?.displayName ?? "بدون کارشناس" })) });
});

router.get("/sales-admin/audit", (req, res) => {
  const s = req.query.section ? String(req.query.section) : null;
  if (s && !isSection(s)) return void res.status(400).json({ error: "unknown_section" });
  res.json({ rows: auditList(s) });
});
router.post("/sales-admin/audit/:id/revert", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "bad_id" });
  if (samMerged() && queryRow<{ section: string }>("SELECT section FROM smc_audit WHERE id=?", [id])?.section === "teams_live") {
    const t = samRevertTeam(me(res)!, id);
    if (!t.ok) return void res.status(t.status).json(t);
    return void res.json({ ok: true, applied: [{ section: "teams_live", auditId: "auditId" in t ? t.auditId : 0 }] });
  }
  if (smcBotEditOn()) {
    const be = smcBotEditUndo(me(res)!, id);
    if (be !== null) {
      if (!be.ok) return void res.status(be.status).json(be);
      return void res.json({ ok: true, applied: [{ section: "bale_bots", auditId: be.auditId }] });
    }
  }
  const sec = samMerged() ? queryRow<{ section: string }>("SELECT section FROM smc_audit WHERE id=?", [id])?.section : undefined;
  if (sec && isSabSection(sec) && sabOn()) {
    const b = sabUndo(me(res)!, id);
    if (!b.ok) return void res.status(b.status).json(b);
    return void res.json({ ok: true, applied: [{ section: sec, auditId: b.auditId }] });
  }
  if (sec && sec.startsWith("merge_") && isFoldKey(sec.slice(6))) {
    const f = samUndoFolded(me(res)!, id);
    if (!f.ok) return void res.status(f.status).json(f);
    return void res.json({ ok: true, applied: [{ section: sec, auditId: f.auditId }] });
  }
  const r = revert(me(res)!, id);
  if (!r.ok) return void res.status(r.status).json(r);
  res.json(r);
});
router.get("/sales-admin/plan-stages/:plan", (req, res) => {
  const k = req.params.plan === "default" ? "default" : `p${Number(req.params.plan)}`;
  res.json({ plan: k, stages: planStages(loadDoc("steps"), k) });
});

export default router;

/* ---------------- enforcement guard (flag ON only; managers/admins untouched) ---------------- */
function idsOfBody(body: any, field: "id" | "customerId"): { list: any[] | null; set: (l: any[]) => any } {
  if (Array.isArray(body)) return { list: body, set: (l) => l };
  for (const k of ["items", "customers", "rows", "data"]) if (body && Array.isArray(body[k])) return { list: body[k], set: (l) => ({ ...body, [k]: l }) };
  return { list: null, set: () => body };
}
function narrow(res: Response, allowed: Set<number>, kind: "customers" | "loan_files") {
  const orig = res.json.bind(res);
  res.json = ((body: any) => {
    if (res.statusCode >= 400) return orig(body);
    const { list, set } = idsOfBody(body, kind === "customers" ? "id" : "customerId");
    if (!list) return orig(body);
    const cid = (x: any) => Number(kind === "customers" ? x?.id : (x?.customerId ?? x?.customer_id));
    const ids = [...new Set(list.map(cid).filter((n) => Number.isInteger(n) && n > 0))];
    const owner = new Map<number, number | null>();
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      for (const r of queryRows<{ id: number; sp: number | null }>(`SELECT id, salesperson_id sp FROM customers WHERE id IN (${part.map(() => "?").join(",")})`, part)) owner.set(Number(r.id), r.sp == null ? null : Number(r.sp));
    }
    const kept = list.filter((x) => { const sp = owner.get(cid(x)); return sp != null && allowed.has(sp); });
    const out = set(kept);
    if (out && typeof out === "object" && !Array.isArray(out) && "total" in out) (out as any).total = kept.length;
    return orig(out);
  }) as Response["json"];
}
export function smcEnforceGuard(req: Request, res: Response, next: NextFunction): void {
  let on = false; try { on = smcFlagOn(); } catch { on = false; }
  if (!on) return next();
  const u = me(res);
  if (!u || smcCanManage(u) || Number(u.id) === SMC_NEVER_USER) return next();
  try {
    ensureSmcSchema();
    const path = req.path.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && (path === "/customers" || path === "/loan-applications")) {
      const kind = path === "/customers" ? "customers" : "loan_files";
      const level = accessLevel(u, kind);
      if (!level || level === "all") return next();
      const searching = kind === "customers" && Boolean(String(req.query.search ?? req.query.q ?? "").trim());
      if (level === "locked" && !searching)
        return void res.status(403).json({ error: "smc_access_locked", message: kind === "customers" ? "لیست مشتریان برای شما بسته است؛ کارهای صف خودتان باز می‌شوند." : "لیست پرونده‌ها برای شما بسته است؛ پرونده‌ای که از صف باز می‌شود باز است." });
      // §6-6: «قفل» + quick search finds own customers only; «فقط خودش» / «تیمش» narrow the list on the server.
      narrow(res, allowedSalespersons(u, level === "locked" ? "own" : level) ?? new Set(), kind);
      return next();
    }
    const credit = req.method === "POST" && (/^\/customers\/(\d+)\/credit-checks$/.exec(path) ?? /^\/instant-credit-check\/customers\/(\d+)\/checks$/.exec(path));
    if (credit) {
      const v = creditValidUntil(Number(credit[1]));
      if (v.valid) return void res.status(409).json({ error: "smc_credit_still_valid", validUntil: v.validUntil, message: `نتیجه‌ی اعتبارسنجی هنوز معتبر است (${v.validUntilFa}).` });
      return next();
    }
    if (req.method === "GET" && path === "/daily-customer-inline/queue") {
      const orig = res.json.bind(res);
      res.json = ((body: any) => {
        if (res.statusCode >= 400) return orig(body);
        try { return orig(overlayExpertQueue(u, body)); } catch { return orig(body); }
      }) as Response["json"];
      return next();
    }
  } catch { /* the guard must never break a page: on any error the old behaviour stays */ }
  next();
}
/** Read for the file page: «معتبر تا …» under the inquiry button (any signed-in staff, flag ON). */
export const smcValidityRouter: IRouter = Router();
smcValidityRouter.get("/sales-console/validity/customer/:id", (req, res, next) => {
  if (!smcFlagOn()) return next("router");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "bad_id" });
  if (!queryRow("SELECT 1 x FROM customers WHERE id=?", [id])) return void res.status(404).json({ error: "not_found" });
  res.json({ credit: creditValidUntil(id), identity: { mode: loadDoc("valid").identity.mode } });
});
