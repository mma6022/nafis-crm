/**
 * G5 (2026-10-27): read-only general-ledger reports. Everything is behind gl.reports (OFF by default; changed only by a
 * release). No write endpoint here: retry of the posting queue, Excel export and the setup wizard come later.
 */
import { Router, type RequestHandler } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import { tehranDateOf } from "../lib/gl-posting";
import { accountLedger, accountList, commissionTotals, glFlagOn, journal, ledgerStatus, postingQueue, reconcile, trialBalance, type TbLevel } from "../lib/gl-reports";

const router = Router();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const actor = (res: import("express").Response) => res.locals.authUser as AuthUser | undefined;
/** Finance roles only (admin / accounting / G6c gl_accountant, gl_voucher_approver) on top of accounting.view; a trainee or salesperson never sees the ledger. */
const FINANCE_ROLES = new Set(["admin", "accounting", "gl_accountant", "gl_voucher_approver"]);
const financeOnly: RequestHandler = (_req, res, next) => {
  const u = actor(res);
  if (!u || !FINANCE_ROLES.has(u.role)) { res.status(403).json({ error: "Forbidden" }); return; }
  next();
};
/** N2: per-seller commission totals — admin or gl.commission_totals.view (gl_accountant). The old accounting role keeps decision 5 (status only, no amounts). */
const commissionTotalsAllowed: RequestHandler = (_req, res, next) => {
  const u = actor(res);
  if (!u || (u.role !== "admin" && !u.permissions.includes("gl.commission_totals.view"))) { res.status(403).json({ error: "Forbidden" }); return; }
  next();
};
const enabled: RequestHandler = (_req, res, next) => {
  if (!glFlagOn(crmDb, "gl.reports")) { res.status(404).json({ error: "gl_reports_off" }); return; }
  next();
};
const wrap = (fn: RequestHandler): RequestHandler => (req, res, next) => {
  try { return fn(req, res, next); } catch (err) {
    req.log?.error?.({ code: String((err as Error)?.message ?? "").slice(0, 120) }, "gl report failed");
    return res.status(500).json({ error: "gl_report_failed" });
  }
};
const today = () => tehranDateOf(new Date());
function range(q: Record<string, unknown>) {
  const t = today();
  const to = typeof q.to === "string" && DATE.test(q.to) ? q.to : t;
  let from = typeof q.from === "string" && DATE.test(q.from) ? q.from : "";
  if (!from) {
    const fy = crmDb.prepare("SELECT start_date FROM gl_fiscal_years WHERE ? BETWEEN start_date AND end_date").get(to) as { start_date: string } | undefined;
    from = fy?.start_date ?? `${to.slice(0, 4)}-01-01`;
  }
  return from > to ? null : { from, to };
}
const page = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n < 100000 ? n : 1; };

router.use("/gl/reports", (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); }, requirePermission("accounting.view"), financeOnly);
router.get("/gl/reports/status", wrap((_req, res) => {
  if (!glFlagOn(crmDb, "gl.reports")) return res.json({ enabled: false });
  return res.json({ enabled: true, ...ledgerStatus(crmDb, today()) });
}));
router.get("/gl/reports/trial-balance", enabled, wrap((req, res) => {
  const r = range(req.query); if (!r) return res.status(400).json({ error: "gl_bad_range" });
  const level = (["kol", "moein", "tafsili"].includes(String(req.query.level)) ? req.query.level : "moein") as TbLevel;
  return res.json(trialBalance(crmDb, { ...r, level }));
}));
router.get("/gl/reports/journal", enabled, wrap((req, res) => {
  const r = range(req.query); if (!r) return res.status(400).json({ error: "gl_bad_range" });
  return res.json(journal(crmDb, { ...r, page: page(req.query.page), limit: 30 }));
}));
router.get("/gl/reports/accounts", enabled, wrap((_req, res) => res.json(accountList(crmDb))));
router.get("/gl/reports/ledger", enabled, wrap((req, res) => {
  const r = range(req.query); if (!r) return res.status(400).json({ error: "gl_bad_range" });
  const code = String(req.query.code ?? "");
  if (!/^\d{2}(\d{2})?$/.test(code)) return res.status(400).json({ error: "gl_unknown_account" });
  const tf = req.query.tafsiliId === undefined || req.query.tafsiliId === "" ? null : Number(req.query.tafsiliId);
  if (tf !== null && !(Number.isSafeInteger(tf) && tf > 0)) return res.status(400).json({ error: "gl_bad_tafsili" });
  const out = accountLedger(crmDb, { code, tafsiliId: tf, ...r, page: page(req.query.page), limit: 50 });
  return out ? res.json(out) : res.status(404).json({ error: "gl_unknown_account" });
}));
router.get("/gl/reports/commission-totals", enabled, commissionTotalsAllowed, wrap((req, res) => {
  const t = today(); const asOf = typeof req.query.to === "string" && DATE.test(req.query.to) ? req.query.to : t;
  return res.json(commissionTotals(crmDb, asOf));
}));
router.get("/gl/reports/queue", enabled, wrap((_req, res) => res.json(postingQueue(crmDb))));
router.get("/gl/reports/reconciliation", enabled, wrap((_req, res) => {
  const last = crmDb.prepare("SELECT run_date,status,mismatch_count,started_at,finished_at FROM gl_reconciliation_runs ORDER BY run_date DESC LIMIT 1").get() as any;
  return res.json({ live: reconcile(crmDb, today()),
    lastRun: last ? { runDate: last.run_date, status: last.status, mismatchCount: last.mismatch_count, startedAt: last.started_at, finishedAt: last.finished_at } : null,
    nightlyEnabled: glFlagOn(crmDb, "gl.nightly_compare") });
}));

export default router;
