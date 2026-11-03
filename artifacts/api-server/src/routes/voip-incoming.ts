/**
 * SIMOTEL-456 — incoming popup (part 4), today's missed calls (part 5), experts report + live state (part 6). Design simotel v1.2.
 * Flags (all OFF → 404): flag.voip_incoming[.user.<id>], flag.voip_missed[.user.<id>], flag.voip_report. The popup is never shown to the admin role.
 * Numbers are decided server-side (another expert's customer → no number); the browser never sends a phone.
 */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { runTransaction } from "../lib/crm-db";
import { tehranRange } from "../lib/call-transcripts";
import { viAct, viFlag, viIncomingFor, viLive, viMe, viMissed, viNewCustomer, viRedial, viReport, viReportAccess, viReportOn, viTransfer } from "../lib/voip-incoming";
import { viExtension } from "../lib/voip-incoming-flags";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const nostore = (res: Response) => res.setHeader("Cache-Control", "private, no-store");
const send = (res: Response, r: { status: number; body: any }) => void res.status(r.status).json(r.body);
const offIncoming = (res: Response) => { nostore(res); if (viIncomingFor(me(res))) return false;
  res.status(404).json({ error: "voip_incoming_off", message: "پنجره‌ی تماس ورودی برای شما فعال نیست.", enabled: false }); return true; };
const offMissed = (res: Response) => { nostore(res); const u = me(res); if (viFlag("missed", u.id) && u.role !== "admin" && (viExtension(u.id) != null || u.salespersonId != null)) return false;
  res.status(404).json({ error: "voip_missed_off", message: "تماس‌های بی‌پاسخ برای شما فعال نیست.", enabled: false }); return true; };
const idOf = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };

router.get("/voip-incoming/me", requirePermission("calls.view"), (_req, res) => {
  if (offIncoming(res)) return;
  res.json(runTransaction(() => viMe(me(res))));
});
for (const action of ["close", "later", "log", "transfer"] as const) {
  router.post(`/voip-incoming/:eventId/${action}`, requirePermission("calls.view"), (req, res) => {
    if (offIncoming(res)) return;
    const id = idOf(req.params.eventId); if (!id) return void res.status(400).json({ error: "bad_id", message: "شناسه معتبر نیست." });
    send(res, runTransaction(() => action === "transfer" ? viTransfer(me(res), id) : viAct(me(res), id, action === "close" ? "closed" : action)));
  });
}
router.post("/voip-incoming/new-customer", requirePermission("customers.create"), (req, res) => {
  const u = me(res); nostore(res);
  const on = req.body?.source === "missed" ? viFlag("missed", u.id) && u.role !== "admin" : viIncomingFor(u);
  if (!on) return void res.status(404).json({ error: "voip_incoming_off", message: "این امکان برای شما فعال نیست.", enabled: false });
  send(res, viNewCustomer(u, req.body));
});
router.get("/voip-incoming/missed", requirePermission("calls.view"), (_req, res) => {
  if (offMissed(res)) return;
  res.json(viMissed(me(res))); // read-only: fcDeck is only consulted when today's carousel row already exists
});
router.post("/voip-incoming/missed/:eventId/call", requirePermission("calls.create"), async (req, res) => {
  if (offMissed(res)) return;
  const id = idOf(req.params.eventId); if (!id) return void res.status(400).json({ error: "bad_id", message: "شناسه معتبر نیست." });
  try { send(res, await viRedial(me(res), id)); }
  catch { res.status(500).json({ error: "start_failed", message: "شروع تماس ناموفق بود." }); }
});
const reportGate = (res: Response) => { nostore(res);
  if (!viReportOn()) { res.status(404).json({ error: "voip_report_off", message: "گزارش کارشناسان فعال نیست.", enabled: false }); return true; }
  if (!viReportAccess(me(res))) { res.status(403).json({ error: "forbidden", message: "این گزارش فقط برای مدیر فروش است." }); return true; }
  return false; };
router.get("/voip-incoming/report", requirePermission("calls.view"), (req, res) => {
  if (reportGate(res)) return;
  const r = tehranRange(req.query.from, req.query.to, 93);
  if (!r) return void res.status(400).json({ error: "bad_range", message: "بازه‌ی تاریخ معتبر نیست." });
  res.json({ from: r.from, to: r.to, rows: viReport(r.fromIso, r.toIso), live: viLive() });
});
router.get("/voip-incoming/live", requirePermission("calls.view"), (_req, res) => {
  if (reportGate(res)) return;
  res.json({ live: viLive() });
});
export default router;
