/**
 * «پیشنهاد دستیار فروش» API. Read + event logging only; no SMS / notification / owner / priority / money change.
 * Experts (Kazemi, Hasani, Ghasemi) always get their OWN list; trainees (5/19/20), user 29 and others get eligible:false.
 * Admin may preview an expert's list with ?salespersonId= (no impressions logged) and edit the levels.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { queryRows } from "../lib/crm-db";
import {
  NOT_NOW_REASONS, SALES_ASSIST_DEFAULTS, SALES_ASSIST_EXCLUDED_USERS, SALES_ASSIST_SIGNALS, SNOOZE_OPTIONS, snoozeUntil, snoozeLabel, customerInScope, eligibleUser, getSalesAssistSettings, recordEvent,
  recordImpressions, saveSalesAssistSettings, getP1Settings, validateP1Settings, saveP1Settings, P1_DEFAULTS, P1_LIMITS, salesAssistScope, salesAssistSettingsMeta, scoreForSalesperson, suggestionsFor, todayCounts, validateSettings, weightsFrom,
  type NotNowReason,
} from "../lib/sales-assist";

const router: IRouter = Router();
const isAdmin = (u: AuthUser) => u.role === "admin" && !SALES_ASSIST_EXCLUDED_USERS.includes(Number(u.id));
const reasons = () => (Object.entries(NOT_NOW_REASONS) as [NotNowReason, string][]).map(([key, label]) => ({ key, label, needsText: key === "other" }));
function previewable() {
  return queryRows<{ id: number; name: string }>("SELECT id, name FROM salespersons WHERE active=1 ORDER BY id")
    .filter((s) => salesAssistScope(Number(s.id)) != null).map((s) => ({ id: Number(s.id), name: s.name, scope: salesAssistScope(Number(s.id)) }));
}
/** Own salesperson for an eligible expert; for admin an optional preview target. */
function target(req: Request, res: Response): { sp: number; preview: boolean } | null {
  const u = res.locals.authUser as AuthUser;
  if (SALES_ASSIST_EXCLUDED_USERS.includes(Number(u.id))) return null;
  const q = Number(req.query.salespersonId ?? (req.body as { salespersonId?: unknown } | undefined)?.salespersonId);
  if (isAdmin(u) && Number.isInteger(q) && q > 0 && salesAssistScope(q)) return { sp: q, preview: q !== Number(u.salespersonId) || !eligibleUser(u) };
  if (eligibleUser(u)) return { sp: Number(u.salespersonId), preview: false };
  return null;
}
const custId = (raw: unknown) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

router.get("/sales-assist/suggestions", requirePermission("customers.view"), (req, res) => {
  const u = res.locals.authUser as AuthUser;
  const t = target(req, res);
  const base = { reasons: reasons(), previewable: isAdmin(u) ? previewable() : [] };
  if (!t) { res.json({ eligible: false, items: [], ...base }); return; }
  const now = new Date();
  const s = getSalesAssistSettings();
  const r = suggestionsFor(t.sp, now, 3);
  if (!t.preview) recordImpressions(u.id, t.sp, r.items, now);
  res.json({ eligible: true, preview: t.preview, salespersonId: t.sp, scope: salesAssistScope(t.sp), now: now.toISOString(), snoozeHours: s.snoozeHours, snoozeLabel: snoozeLabel(s.snoozeHours),
    items: r.items, pool: r.pool, snoozed: r.snoozed, p1Quota: r.p1Quota, today: todayCounts(t.sp, now), ...base });
});

function guard(req: Request, res: Response): { u: AuthUser; sp: number; id: number } | null {
  const u = res.locals.authUser as AuthUser;
  if (!eligibleUser(u)) { res.status(403).json({ error: "این بخش برای شما فعال نیست." }); return null; }
  const id = custId(req.params.customerId);
  const sp = Number(u.salespersonId);
  if (!id || !customerInScope(sp, id)) { res.status(404).json({ error: "Customer not found" }); return null; }
  return { u, sp, id };
}
router.post("/sales-assist/suggestions/:customerId/call", requirePermission("customers.view"), (req, res) => {
  const g = guard(req, res); if (!g) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const eventId = recordEvent({ kind: "call", userId: g.u.id, salespersonId: g.sp, customerId: g.id, rank: num(b.rank), tier: num(b.tier), score: num(b.score) });
  res.json({ ok: true, eventId });
});
router.post("/sales-assist/suggestions/:customerId/not-now", requirePermission("customers.view"), (req, res) => {
  const g = guard(req, res); if (!g) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const reason = String(b.reason ?? "") as NotNowReason;
  if (!(reason in NOT_NOW_REASONS)) { res.status(400).json({ error: "یک دلیل انتخاب کنید." }); return; }
  let text: string | null = null;
  if (b.text != null && String(b.text).trim()) {
    if (reason !== "other") { res.status(400).json({ error: "توضیح فقط برای «سایر» است." }); return; }
    text = String(b.text).trim().replace(/\s+/g, " ");
    if ([...text].length > 120) { res.status(400).json({ error: "توضیح حداکثر ۱۲۰ نویسه است." }); return; }
  }
  const now = new Date();
  const until = snoozeUntil(now, getSalesAssistSettings().snoozeHours).toISOString();
  const eventId = recordEvent({ kind: "not_now", userId: g.u.id, salespersonId: g.sp, customerId: g.id, rank: num(b.rank), tier: num(b.tier), score: num(b.score),
    reasonKey: reason, reasonText: text, snoozeUntil: until }, now);
  res.json({ ok: true, eventId, snoozedUntil: until });
});
router.post("/sales-assist/suggestions/:customerId/restore", requirePermission("customers.view"), (req, res) => {
  const g = guard(req, res); if (!g) return;
  const eventId = recordEvent({ kind: "restore", userId: g.u.id, salespersonId: g.sp, customerId: g.id });
  res.json({ ok: true, eventId });
});

function adminOnly(res: Response): boolean {
  if (!isAdmin(res.locals.authUser as AuthUser)) { res.status(403).json({ error: "فقط مدیر" }); return false; }
  return true;
}
const signals = () => Object.entries(SALES_ASSIST_SIGNALS).map(([key, s]) => ({ key, label: s.label, help: s.help, default: SALES_ASSIST_DEFAULTS.levels[key as keyof typeof SALES_ASSIST_DEFAULTS.levels] }));
router.get("/sales-assist/weights", requirePermission("customers.view"), (_req, res) => {
  if (!adminOnly(res)) return;
  res.json({ settings: getSalesAssistSettings(), defaults: SALES_ASSIST_DEFAULTS, signals: signals(), snoozeOptions: SNOOZE_OPTIONS, meta: salesAssistSettingsMeta(), previewable: previewable(),
    p1: getP1Settings(), p1Defaults: P1_DEFAULTS, p1Limits: P1_LIMITS });
});
router.put("/sales-assist/weights", requirePermission("customers.view"), (req, res) => {
  if (!adminOnly(res)) return;
  const { p1, ...rest } = (req.body ?? {}) as { p1?: unknown } & Record<string, unknown>;
  const p = p1 == null ? null : validateP1Settings(p1);
  if (p && !p.ok) { res.status(400).json({ error: p.error }); return; }
  const v = validateSettings(rest);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  saveSalesAssistSettings(v.settings, (res.locals.authUser as AuthUser).id);
  if (p && p.ok && p.values.length) saveP1Settings(p.values, (res.locals.authUser as AuthUser).id);
  res.json({ settings: getSalesAssistSettings(), meta: salesAssistSettingsMeta(), p1: getP1Settings() });
});
/** Live order preview for unsaved levels: top 6 of one expert under the proposed levels, with the rank under the saved ones. */
router.post("/sales-assist/weights/preview", requirePermission("customers.view"), (req, res) => {
  if (!adminOnly(res)) return;
  const b = (req.body ?? {}) as { salespersonId?: unknown; levels?: unknown };
  const sp = Number(b.salespersonId);
  if (!salesAssistScope(sp)) { res.status(400).json({ error: "کارشناس نامعتبر است." }); return; }
  const v = validateSettings({ levels: b.levels ?? {} });
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const now = new Date();
  const before = scoreForSalesperson(sp, now).map((x) => x.customerId);
  const after = scoreForSalesperson(sp, now, weightsFrom(v.settings)).slice(0, 6);
  res.json({ items: after.map((x, i) => ({ rank: i + 1, customerId: x.customerId, displayName: x.displayName, priority: x.priority, tier: x.tier, points: x.points,
    signals: x.signals.slice(0, 4), was: before.indexOf(x.customerId) + 1 })) });
});

export default router;
