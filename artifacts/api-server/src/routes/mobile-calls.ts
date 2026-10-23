import { Router, type RequestHandler } from "express";
import { StartMobileCallBody, StartMobileCallResponse, EndMobileCallBody, EndMobileCallResponse,
  ListMobileCallsQueryParams, ListMobileCallsResponse, CreateMobileCallDeviceBody, CreateMobileCallDeviceResponse,
  ListMobileCallDevicesResponse, ListMobileCallExpertsResponse, RevokeMobileCallDeviceParams } from "@workspace/api-zod";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { authenticateMobileDevice, createMobileDevice, ensureMobileCallSchema, ingestMobileCall, listMobileCalls,
  listMobileDevices, MobileCallError, mobileExperts, revokeMobileDevice } from "../lib/mobile-calls";

ensureMobileCallSchema();
const respond: RequestHandler = (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); };
const wrap = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  try { handler(req, res, next); }
  catch (error) {
    if (error instanceof MobileCallError) { res.status(error.status).json({ error: error.message }); return; }
    req.log.error({ err: error }, "Mobile call request failed");
    res.status(503).json({ error: "ثبت یا دریافت تماس انجام نشد؛ با همان شناسه دوباره تلاش کنید." });
  }
};
export const mobileCallIngress = Router();
mobileCallIngress.use(respond);
// Bounded, in-memory abuse protection; identity always comes from a device key.
const buckets = new Map<string, { count: number; until: number }>();
mobileCallIngress.use((req, res, next) => {
  if (req.method !== "POST" || !["/start", "/end"].includes(req.path)) { next(); return; }
  const now = Date.now(), key = req.ip ?? "unknown";
  if (buckets.size > 10000) for (const [ip, value] of buckets) if (value.until < now) buckets.delete(ip);
  if (buckets.size >= 10000 && !buckets.has(key)) buckets.delete(buckets.keys().next().value!);
  const existing = buckets.get(key), bucket = existing && existing.until > now ? existing : { count: 0, until: now + 60000 };
  bucket.count++; buckets.set(key, bucket);
  if (bucket.count > 1000) { res.setHeader("Retry-After", "60"); res.status(429).json({ error: "تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید." }); return; }
  next();
});
for (const [path, ending] of [["/start", false], ["/end", true]] as const) {
  mobileCallIngress.post(path, wrap((req, res) => {
    const connection = authenticateMobileDevice(req.get("authorization"));
    const parsed = (ending ? EndMobileCallBody : StartMobileCallBody).safeParse(req.body);
    const keys = ["callId", "direction", "callerNumber", "calleeNumber", "contactName", "startedAt", "answeredAt", ...(ending ? ["endedAt", "durationSeconds", "status"] : [])];
    const validTimes = ["startedAt", ...(ending ? ["endedAt"] : []), ...(req.body?.answeredAt != null ? ["answeredAt"] : [])]
      .every(key => typeof req.body?.[key] === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(req.body[key]));
    if (!parsed.success || !validTimes || Object.keys(req.body).some(key => !keys.includes(key))) {
      res.status(400).json({ error: "اطلاعات تماس معتبر نیست؛ شماره‌ها، جهت و زمان دارای منطقهٔ زمانی لازم است." }); return;
    }
    const response = ingestMobileCall(connection, parsed.data, ending);
    res.json((ending ? EndMobileCallResponse : StartMobileCallResponse).parse(response));
  }));
}
const router = Router();
router.use(respond);
const admin: RequestHandler = (_req, res, next) => {
  if ((res.locals.authUser as AuthUser).role !== "admin") { res.status(403).json({ error: "مدیریت اتصال موبایل فقط برای مدیر مجاز است." }); return; } next();
};
router.get("/mobile-calls", requirePermission("calls.view"), wrap((req, res) => {
  const parsed = ListMobileCallsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "فیلتر گزارش معتبر نیست." }); return; }
  res.json(ListMobileCallsResponse.parse(listMobileCalls(res.locals.authUser as AuthUser, parsed.data)));
}));
router.get("/mobile-call-experts", admin, wrap((_req, res) => res.json(ListMobileCallExpertsResponse.parse(mobileExperts()))));
router.get("/mobile-call-devices", admin, wrap((_req, res) => res.json(ListMobileCallDevicesResponse.parse(listMobileDevices()))));
router.post("/mobile-call-devices", admin, wrap((req, res) => {
  const parsed = CreateMobileCallDeviceBody.safeParse(req.body);
  if (!parsed.success || Object.keys(req.body).some(key => !["userId", "deviceName"].includes(key))) { res.status(400).json({ error: "کارشناس و نام دستگاه معتبر نیست." }); return; }
  res.status(201).json(CreateMobileCallDeviceResponse.parse(createMobileDevice(res.locals.authUser as AuthUser, parsed.data.userId, parsed.data.deviceName)));
}));
router.delete("/mobile-call-devices/:id", admin, wrap((req, res) => {
  const parsed = RevokeMobileCallDeviceParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "شناسهٔ دستگاه معتبر نیست." }); return; }
  res.json(revokeMobileDevice(parsed.data.id, res.locals.authUser as AuthUser));
}));
export default router;
