/**
 * Attendance routes (t869). flag.attendance_v1 absent/≠'1' → /me returns enabled:false, other routes 404.
 * Settings, test, map, pull, board, report: admin only. Comm key never returned or logged.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { requireAuth, requireAdmin, type AuthUser } from "../lib/auth";
import {
  ATTENDANCE_FLAG, attendanceOn, attendanceTick, ensureAttendanceSchema, getSettings,
  listMap, listStaff, monthlyReport, pullLogs, saveMap, saveSettings, testConnection, todayBoard,
  jalaliParts,
} from "../lib/attendance";

const router: IRouter = Router();

function fail(res: Response, status: number, error: string, message?: string) {
  res.status(status).json({ error, ...(message ? { message } : {}) });
}

function guarded(req: Request, res: Response, next: NextFunction): void {
  if (!attendanceOn()) { fail(res, 404, "not_found"); return; }
  ensureAttendanceSchema();
  next();
}

function publicErr(e: unknown, res: Response) {
  const err = e as { status?: number; publicMessage?: string; message?: string };
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 400;
  fail(res, status, "bad_request", err.publicMessage || "درخواست نامعتبر است.");
}

router.get("/attendance/me", requireAuth, (req, res) => {
  const u = res.locals.authUser as AuthUser;
  const enabled = attendanceOn();
  res.json({ enabled, flag: ATTENDANCE_FLAG, isAdmin: u.role === "admin", canManage: enabled && u.role === "admin" });
});

router.get("/attendance/settings", requireAuth, requireAdmin, guarded, (_req, res) => {
  res.json(getSettings());
});

router.put("/attendance/settings", requireAuth, requireAdmin, guarded, (req, res) => {
  try {
    const b = (req.body || {}) as Record<string, unknown>;
    const u = res.locals.authUser as AuthUser;
    const weeklyOff = Array.isArray(b.weeklyOff) ? (b.weeklyOff as unknown[]).map(Number) : undefined;
    const settings = saveSettings({
      host: String(b.host ?? ""),
      port: b.port != null ? Number(b.port) : undefined,
      commKey: typeof b.commKey === "string" ? b.commKey : undefined,
      clearCommKey: b.clearCommKey === true,
      shiftStart: typeof b.shiftStart === "string" ? b.shiftStart : undefined,
      shiftEnd: typeof b.shiftEnd === "string" ? b.shiftEnd : undefined,
      graceMinutes: b.graceMinutes != null ? Number(b.graceMinutes) : undefined,
      weeklyOff,
      updatedBy: u.id,
    });
    res.json(settings);
  } catch (e) { publicErr(e, res); }
});

router.post("/attendance/test", requireAuth, requireAdmin, guarded, async (req, res) => {
  try {
    const b = (req.body || {}) as Record<string, unknown>;
    const result = await testConnection({
      host: typeof b.host === "string" ? b.host : undefined,
      port: b.port != null ? Number(b.port) : undefined,
      commKey: typeof b.commKey === "string" ? b.commKey : undefined,
    });
    res.json(result);
  } catch (e) { publicErr(e, res); }
});

router.post("/attendance/pull", requireAuth, requireAdmin, guarded, async (_req, res) => {
  try { res.json(await pullLogs()); }
  catch (e) { publicErr(e, res); }
});

router.get("/attendance/staff", requireAuth, requireAdmin, guarded, (req, res) => {
  const deviceUsers = Array.isArray(req.query.hint) ? [] : undefined;
  // Optional device users come from the last test (client sends them in POST body via /attendance/map-preview)
  res.json({ staff: listStaff(), map: listMap() });
  void deviceUsers;
});

router.post("/attendance/staff", requireAuth, requireAdmin, guarded, (req, res) => {
  const b = (req.body || {}) as { deviceUsers?: { userId: string; name: string }[] };
  const deviceUsers = Array.isArray(b.deviceUsers) ? b.deviceUsers.map((d) => ({ userId: String(d.userId || ""), name: String(d.name || "") })) : [];
  res.json({ staff: listStaff(deviceUsers), map: listMap() });
});

router.put("/attendance/map", requireAuth, requireAdmin, guarded, (req, res) => {
  try {
    const b = (req.body || {}) as { entries?: { deviceUserId: string; deviceUserName?: string | null; crmUserId: number | null }[] };
    saveMap(Array.isArray(b.entries) ? b.entries : []);
    res.json({ map: listMap(), staff: listStaff() });
  } catch (e) { publicErr(e, res); }
});

router.get("/attendance/board", requireAuth, requireAdmin, guarded, (req, res) => {
  try {
    const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    res.json(todayBoard(new Date(), date));
  } catch (e) { publicErr(e, res); }
});

router.get("/attendance/report", requireAuth, requireAdmin, guarded, (req, res) => {
  try {
    const nowJ = jalaliParts();
    const year = req.query.year != null ? Number(req.query.year) : nowJ.year;
    const month = req.query.month != null ? Number(req.query.month) : nowJ.month;
    res.json(monthlyReport(year, month));
  } catch (e) { publicErr(e, res); }
});

export { attendanceTick };
export default router;
