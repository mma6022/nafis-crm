/**
 * VOIP-CALL — «تماس از تلفن ویپ» (Simotel parts 1–2, design simotel v1.0.2 scenes 01–17).
 * Only for a user with flag.voip_call (global) or flag.voip_call.user.<id> = 1 AND a voip_extensions row; else 404 voip_call_off.
 * The phone is read from the customer row on the server; the browser never sends or receives it.
 */
import { Router, type IRouter, type Response } from "express";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { getSimotelAudio, SimotelError } from "../lib/simotel";
import { vcCustomerAllowed, vcDismiss, vcHistory, vcMe, vcOn, vcRecordingFile, vcStart } from "../lib/voip-call";
import { runImmediateTransaction, runTransaction } from "../lib/crm-db";
import { s132CloseBar, s132Fix, s132IsFirstCall, s132Note, s132On, s132SetStatus } from "../lib/simotel132";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const off = (res: Response) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (vcOn(me(res) as any)) return false;
  res.status(404).json({ error: "voip_call_off", message: "تماس از تلفن ویپ برای شما فعال نیست.", enabled: false }); return true;
};
const send = (res: Response, r: { status: number; body?: any; error?: string; message?: string }) => {
  if ("body" in r && r.body !== undefined) return void res.status(r.status).json(r.body);
  const { status, ...rest } = r; res.status(status).json(rest);
};

router.get("/voip-call/me", requirePermission("calls.view"), (_req, res) => {
  if (off(res)) return;
  res.json(runTransaction(() => vcMe(me(res) as any)));
});
router.post("/voip-call/start", requirePermission("calls.create"), async (req, res) => {
  if (off(res)) return;
  try { send(res, await vcStart(me(res) as any, req.body)); }
  catch { res.status(500).json({ error: "start_failed", message: "شروع تماس ناموفق بود." }); }
});
router.post("/voip-call/:id/dismiss", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return void res.status(400).json({ error: "bad_id", message: "شناسه معتبر نیست." });
  send(res, vcDismiss(me(res) as any, id));
});
// SIMOTEL-132 (flag.simotel132[.user.<id>]): status pick when the CDR is late, «اشتباهه؟», note edit, bar close. Own calls only; 404 when off.
const s132Route = (path: string, f: (u: any, id: number, body: any) => { status: number; body: any }) =>
  router.post(`/voip-call/:id/${path}`, requirePermission("calls.create"), (req, res) => {
    if (off(res)) return;
    if (!s132On(me(res) as any)) return void res.status(404).json({ error: "simotel132_off", message: "این امکان برای شما فعال نیست." });
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return void res.status(400).json({ error: "bad_id", message: "شناسه معتبر نیست." });
    try { send(res, runImmediateTransaction(() => f(me(res) as any, id, req.body ?? {}))); }
    catch { res.status(500).json({ error: "save_failed", message: "ثبت ناموفق بود؛ دوباره امتحان کن." }); }
  });
s132Route("status", (u, id, b) => s132SetStatus(u, id, b));
s132Route("fix", (u, id, b) => s132Fix(u, id, b));
s132Route("note", (u, id, b) => s132Note(u, id, b));
s132Route("close-bar", (u, id) => s132CloseBar(u, id));
// SIMOTEL-132: «تماس اول» chip before the call (read-only; 404 when off).
router.get("/voip-call/customers/:id/s132", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return;
  if (!s132On(me(res) as any)) return void res.status(404).json({ error: "simotel132_off", message: "این امکان برای شما فعال نیست." });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || !vcCustomerAllowed(me(res) as any, id)) return void res.status(404).json({ error: "not_found", message: "این مشتری در دسترس شما نیست." });
  res.json({ firstCall: s132IsFirstCall(me(res) as any, id) });
});
router.get("/voip-call/customers/:id/history", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || !vcCustomerAllowed(me(res) as any, id)) return void res.status(404).json({ error: "not_found", message: "این مشتری در دسترس شما نیست." });
  res.json(runTransaction(() => vcHistory(me(res) as any, id)));
});
router.get("/voip-call/calls/:eventId/audio", requirePermission("calls.view"), async (req, res) => {
  if (off(res)) return;
  res.setHeader("X-Content-Type-Options", "nosniff");
  const id = Number(req.params.eventId);
  const file = Number.isSafeInteger(id) && id > 0 ? vcRecordingFile(me(res) as any, id) : null;
  if (!file) return void res.status(404).json({ error: "recording_missing", message: "صدای این تماس در دسترس شما نیست." });
  try {
    const response = await getSimotelAudio(file);
    res.setHeader("Content-Type", response.headers.get("content-type") ?? "audio/mpeg");
    res.setHeader("Content-Disposition", `inline; filename="call-${id}.${file.split(".").pop()!.toLowerCase()}"`);
    const source = Readable.fromWeb(response.body as any);
    const abort = () => source.destroy();
    res.on("close", abort);
    let bytes = 0;
    const guard = new Transform({ transform(chunk, _e, cb) { bytes += chunk.length; cb(bytes > 100 * 1024 * 1024 ? new Error("audio_size_limit") : null, chunk); } });
    try { await pipeline(source, guard, res); } finally { res.off("close", abort); }
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    const k = e instanceof SimotelError ? e : new SimotelError("audio_failed", 502, "دریافت فایل صوتی ناموفق بود.");
    res.status(k.status).json({ error: k.code, message: k.message });
  }
});
export default router;
