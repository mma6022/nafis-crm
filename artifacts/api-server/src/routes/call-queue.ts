/**
 * crm-call-queue R1 API. Every endpoint answers {enabled:false} / 404-style refusals while its flag is OFF, except the read-only
 * config and the admin settings/flags pages. No SMS, Bale or customer message is ever sent from here.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { queryRows } from "../lib/crm-db";
import {
  CQ_DEFAULTS, CQ_FLAGS, CQ_FLAG_LABELS, CQ_LIMITS, CQ_VOID_REASONS, CQ_SNOOZE_MIN, cqAcceptSuggestion, cqAfterSave, cqDue, cqPreCall, cqEditDate, cqEligible, cqEvents,
  cqFlags, cqManager, cqMarkSeen, cqQueue, cqRejectSuggestion, cqSettings, cqSettingsLog, cqSnooze, cqVoid, ensureCallQueueSchema, saveCqFlag, saveCqSettings,
  validateCqSettings, type CqFlag,
} from "../lib/call-queue";
import { customerInScope, salesAssistScope, suggestionsFor } from "../lib/sales-assist";
import { CQ_DS_DEFAULTS, CQ_DS_RANGES, CQ_MANUAL_TYPES, cqDisciplineSettings, cqLockOn, saveDiscipline, validateDiscipline } from "../lib/call-queue";
import { cqMarkReturned, cqMyDiscipline, cqPendingView, cqRestriction, cqSignals, cqStartCall, cqTeamDiscipline } from "../lib/call-queue-r2";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const idOf = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const off = (res: Response) => res.status(404).json({ error: "این بخش فعال نیست.", enabled: false });

router.get("/call-queue/config", requirePermission("customers.view"), (_req, res) => {
  ensureCallQueueSchema();
  const u = me(res); const s = cqSettings();
  res.json({ flags: cqFlags(), eligible: cqEligible(u), manager: cqManager(u), userId: u.id, salespersonId: u.salespersonId ?? null,
    settings: { order: s.order, newRedHours: s.newRedHours, p1StaleDays: s.p1StaleDays, naTemplate: s.naTemplate },
    limits: CQ_LIMITS, voidReasons: Object.entries(CQ_VOID_REASONS).map(([key, label]) => ({ key, label })), snoozeMinutes: CQ_SNOOZE_MIN,
    // R2
    lockOn: cqLockOn(u), manualTypes: Object.entries(CQ_MANUAL_TYPES).map(([key, label]) => ({ key, label })),
    restriction: cqEligible(u) && cqFlags().restrict_panel ? (({ overdueCustomerIds, ...r }) => ({ ...r, customerIds: overdueCustomerIds }))(cqRestriction(u)) : null,
    discipline: (({ onTimeMin, onTimeCapMin, restrictOverdue }) => ({ onTimeMin, onTimeCapMin, restrictOverdue }))(cqDisciplineSettings()) });
});

router.get("/call-queue/after-save", requirePermission("calls.create"), (req, res) => {
  const u = me(res); const f = cqFlags();
  if (!cqEligible(u) || !(f.result || f.autoclose || f.assistant_reminders)) { res.json({ found: false }); return; }
  const cid = idOf(req.query.callId); if (!cid) { res.status(400).json({ error: "callId" }); return; }
  res.json(cqAfterSave(u, cid));
});

router.get("/call-queue/pre-call", requirePermission("calls.create"), (req, res) => {
  const u = me(res); const f = cqFlags();
  if (!cqEligible(u) || !(f.result || f.autoclose)) { res.json({ due: [], naAttemptIfNoAnswer: 1, p1: false }); return; }
  const cid = idOf(req.query.customerId); if (!cid) { res.status(400).json({ error: "customerId" }); return; }
  if (!customerInScope(Number(u.salespersonId), cid) && !queryRows("SELECT 1 FROM customers WHERE id=? AND salesperson_id=?", [cid, Number(u.salespersonId)]).length) { res.json({ due: [], naAttemptIfNoAnswer: 1, p1: false }); return; }
  res.json(cqPreCall(u, cid));
});

router.get("/call-queue", requirePermission("customers.view"), (_req, res) => {
  const u = me(res);
  if (!cqFlags().queue) return void off(res);
  if (!cqEligible(u)) { res.json({ eligible: false, cards: [], counts: { due: 0, new: 0, p1: 0, assist: 0 }, total: 0 }); return; }
  const sp = Number(u.salespersonId);
  let sug: { customerId: number; rank: number; reason?: string }[] = [];
  try {
    if (salesAssistScope(sp)) { sug = suggestionsFor(sp, new Date(), 3).items.map((x) => ({ customerId: Number(x.customerId), rank: Number(x.rank), reason: x.reason?.text || undefined })); }
  } catch { sug = []; }
  const q = cqQueue(u, sug);
  // R2 «پنل محدود» (server side): above the threshold only group A (overdue reminders) is open.
  if (cqFlags().restrict_panel) {
    const r = cqRestriction(u);
    if (r.restricted) { const cards = q.cards.filter(c => c.reminder); res.json({ eligible: true, ...q, cards, total: cards.length, restricted: { overdue: r.overdue, threshold: r.threshold, leftToUnlock: r.leftToUnlock } }); return; }
  }
  res.json({ eligible: true, ...q });
});

router.get("/call-queue/due", requirePermission("customers.view"), (_req, res) => {
  const u = me(res);
  const f = cqFlags();
  // The modal only clears through a saved call, so it needs «نتیجه‌ی تماس» and «بستن خودکار» on as well.
  if (!(f.modal && f.result && f.autoclose) || !cqEligible(u)) { res.json({ enabled: false, items: [], snoozed: [], total: 0 }); return; }
  res.json({ enabled: true, ...cqDue(u) });
});

const mutable = (res: Response, flag: CqFlag | CqFlag[]) => {
  const u = me(res); const f = cqFlags(); const fl = Array.isArray(flag) ? flag : [flag];
  if (!fl.some(x => f[x])) { off(res); return null; }
  if (!cqEligible(u)) { res.status(403).json({ error: "این بخش برای شما فعال نیست." }); return null; }
  return u;
};
router.post("/call-queue/reminders/:id/snooze", requirePermission("customers.view"), (req, res) => {
  const u = mutable(res, "modal"); if (!u) return; const id = idOf(req.params.id); if (!id) { res.status(400).json({ error: "id" }); return; }
  const r = cqSnooze(u, id); res.status(r.status).json(r.error ? { error: r.error } : { ok: true, until: r.until });
});
router.post("/call-queue/reminders/:id/void", requirePermission("customers.view"), (req, res) => {
  const u = mutable(res, ["assistant_reminders"]); if (!u) return; const id = idOf(req.params.id); if (!id) { res.status(400).json({ error: "id" }); return; }
  const r = cqVoid(u, id, req.body?.reason, req.body?.note); res.status(r.status).json(r.error ? { error: r.error } : { ok: true });
});
router.patch("/call-queue/reminders/:id/date", requirePermission("reminders.manage"), (req, res) => {
  const u = mutable(res, ["queue", "assistant_reminders"]); if (!u) return; const id = idOf(req.params.id); if (!id) { res.status(400).json({ error: "id" }); return; }
  const r = cqEditDate(u, id, req.body?.remindAt); res.status(r.status).json(r.error ? { error: r.error } : { ok: true, remindAt: r.remindAt, shifted: r.shifted });
});
router.post("/call-queue/suggestions/:callId/accept", requirePermission("reminders.manage"), (req, res) => {
  const u = mutable(res, "assistant_reminders"); if (!u) return; const id = idOf(req.params.callId); if (!id) { res.status(400).json({ error: "id" }); return; }
  const r = cqAcceptSuggestion(u, id, req.body?.remindAt); res.status(r.status).json(r.error ? { error: r.error } : { ok: true, reminderId: r.reminderId, remindAt: r.remindAt });
});
router.post("/call-queue/suggestions/:callId/reject", requirePermission("customers.view"), (req, res) => {
  const u = mutable(res, "assistant_reminders"); if (!u) return; const id = idOf(req.params.callId); if (!id) { res.status(400).json({ error: "id" }); return; }
  const r = cqRejectSuggestion(u, id); res.status(r.status).json(r.error ? { error: r.error } : { ok: true });
});

/* -------- R2: call lock -------- */
router.post("/call-queue/calls/start", requirePermission("calls.create"), (req, res) => {
  const u = me(res); const cid = idOf(req.body?.customerId); if (!cid) { res.status(400).json({ error: "customerId" }); return; }
  const r = cqStartCall(u, cid, String(req.body?.via ?? "crm").replace(/[^a-z_-]/gi, "") || "crm");
  if (r.status !== 200) { res.status(r.status).json({ error: r.error, pending: r.pending ?? null, restricted: r.restricted ?? false }); return; }
  res.json({ ok: true, callId: r.callId, tel: r.tel, reused: r.reused ?? false });
});
router.post("/call-queue/calls/:id/returned", requirePermission("calls.create"), (req, res) => {
  const u = me(res); const id = idOf(req.params.id); if (!id) { res.status(400).json({ error: "id" }); return; }
  res.json({ ok: cqMarkReturned(u, id) });
});
router.get("/call-queue/pending", requirePermission("customers.view"), (_req, res) => { res.json(cqPendingView(me(res))); });
/* -------- R2: discipline (display only) -------- */
router.get("/call-queue/discipline/me", requirePermission("customers.view"), (_req, res) => { res.json(cqMyDiscipline(me(res))); });

/* -------- admin (managers: role admin, never user 29) -------- */
const admin = (res: Response) => { const u = me(res); if (!cqManager(u)) { res.status(403).json({ error: "فقط مدیر." }); return null; } return u; };
router.get("/call-queue/settings", (_req: Request, res) => {
  if (!admin(res)) return;
  res.json({ settings: cqSettings(), defaults: CQ_DEFAULTS, limits: CQ_LIMITS, flags: cqFlags(), flagLabels: CQ_FLAG_LABELS, log: cqSettingsLog() });
});
router.put("/call-queue/settings", (req, res) => {
  const u = admin(res); if (!u) return;
  const v = validateCqSettings(req.body?.reset === true ? CQ_DEFAULTS : req.body);
  if (!v.ok) { res.status(422).json({ error: v.error }); return; }
  const changed = saveCqSettings(v.value, u.id);
  res.json({ ok: true, changed, settings: cqSettings(), log: cqSettingsLog() });
});
router.put("/call-queue/flags/:flag", (req, res) => {
  const u = admin(res); if (!u) return;
  const f = String(req.params.flag) as CqFlag; if (!CQ_FLAGS.includes(f)) { res.status(404).json({ error: "flag" }); return; }
  if (typeof req.body?.on !== "boolean") { res.status(400).json({ error: "on" }); return; }
  saveCqFlag(f, req.body.on, u.id);
  res.json({ ok: true, flags: cqFlags() });
});
router.get("/call-queue/discipline/team", (_req, res) => { if (!admin(res)) return; res.json(cqTeamDiscipline()); });
router.get("/call-queue/discipline/settings", (_req, res) => {
  if (!admin(res)) return;
  res.json({ settings: cqDisciplineSettings(), defaults: CQ_DS_DEFAULTS, ranges: CQ_DS_RANGES, log: cqSettingsLog().filter((l: any) => String(l.key).startsWith("ds.")) });
});
router.put("/call-queue/discipline/settings", (req, res) => {
  const u = admin(res); if (!u) return;
  const v = validateDiscipline(req.body?.reset === true ? CQ_DS_DEFAULTS : req.body);
  if (!v.ok) { res.status(422).json({ error: v.error }); return; }
  const changed = saveDiscipline(v.value, u.id);
  res.json({ ok: true, changed, settings: cqDisciplineSettings(), log: cqSettingsLog().filter((l: any) => String(l.key).startsWith("ds.")) });
});
/** §8-33 daily digest signals — managers and admins only. */
router.get("/reports/discipline-signals", (req, res) => { if (!admin(res)) return; res.json(cqSignals(req.query.date)); });
router.get("/call-queue/events", (req, res) => {
  if (!admin(res)) return;
  const sps = queryRows<{ id: number; name: string }>("SELECT id,name FROM salespersons WHERE active=1 AND id NOT IN (5,19,20) ORDER BY id");
  res.json({ ...cqEvents({ kind: typeof req.query.kind === "string" ? req.query.kind : undefined, salespersonId: idOf(req.query.salespersonId),
    day: typeof req.query.day === "string" ? req.query.day : null }), salespersons: sps });
});
router.post("/call-queue/events/:id/seen", (req, res) => {
  const u = admin(res); if (!u) return; const id = idOf(req.params.id); if (!id) { res.status(400).json({ error: "id" }); return; }
  res.json({ ok: cqMarkSeen(id, u.id) });
});

export default router;
