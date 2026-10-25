/** crm-expert-intro-sms admin API. Every write is admin-only; the switch defaults OFF. */
import { Router, type IRouter, type Response } from "express";
import { requireAdmin, type AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { crmDb } from "../lib/crm-db";
import { getNotificationSettings } from "../lib/customer-notifications";
import { getCustomer } from "./crm";
import {
  EXPERT_INTRO_PARAM_CUSTOMER, EXPERT_INTRO_PARAM_NAME, EXPERT_INTRO_PARAM_PHONE, customerParam, EXPERT_INTRO_TEMPLATE, EXPERT_INTRO_TRAINEE_SALESPERSON_IDS, ExpertIntroError,
  customerIntroLog, ensureExpertIntroSchema, expertInfo, expertOverview, failureText, getExpertIntroSettings, introStats, logIntro,
  mobileKey, normalizeContactPhone, renderIntroText, saveExpertIntroSettings, setUserContactPhone, userContactPhones,
} from "../lib/expert-intro-sms-core";
import { sendExpertIntroPattern, teamSalesIds } from "../lib/expert-intro-sms";

const router: IRouter = Router();
ensureExpertIntroSchema(crmDb);

function fail(res: Response, error: unknown): void {
  if (error instanceof ExpertIntroError) { res.status(error.status).json({ error: error.message }); return; }
  throw error;
}
function view() {
  const s = getExpertIntroSettings(crmDb);
  const ns = getNotificationSettings();
  const ids = teamSalesIds();
  return {
    enabled: s.enabled, patternCode: s.patternCode, blockedPhones: s.blockedPhones,
    template: EXPERT_INTRO_TEMPLATE, paramNames: { customer: EXPERT_INTRO_PARAM_CUSTOMER, name: EXPERT_INTRO_PARAM_NAME, phone: EXPERT_INTRO_PARAM_PHONE },
    provider: "IPPanel", fromNumber: ns.ippanelFromNumber, ippanelEnabled: ns.ippanelEnabled,
    relayConfigured: Boolean(process.env.IR_RELAY_SHARED_SECRET),
    sendWindow: "08:00–21:00 Asia/Tehran", traineeSalespersonIds: [...EXPERT_INTRO_TRAINEE_SALESPERSON_IDS],
    qualifierSalespersonId: ids.qualifierId, experts: expertOverview(crmDb, ids.qualifierId, ids.closerIds), stats: introStats(crmDb),
  };
}

router.get("/expert-intro-sms/settings", requireAdmin, (_req, res): void => { res.json(view()); });

router.put("/expert-intro-sms/settings", requireAdmin, (req, res): void => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    saveExpertIntroSettings(crmDb, { enabled: b.enabled, patternCode: b.patternCode, blockedPhones: b.blockedPhones });
    res.json(view());
  } catch (error) { fail(res, error); }
});

let lastTestAt = 0;
/**
 * Admin-only «ارسال آزمایشی» to a number the admin types (real SMS; works with the switch OFF).
 * Expert = a salesperson with «شماره تماس برای مشتری», or a placeholder name + phone typed by the admin.
 * The recipient number is never stored: the log row records only that a test happened.
 */
router.post("/expert-intro-sms/test-send", requireAdmin, async (req, res): Promise<void> => {
  const user = res.locals.authUser as AuthUser;
  const b = (req.body ?? {}) as { phone?: unknown; salespersonId?: unknown; expertName?: unknown; expertPhone?: unknown; patternCode?: unknown; customerName?: unknown };
  const customer = customerParam(b.customerName);
  const phone = mobileKey(b.phone);
  if (!phone) { res.status(400).json({ error: "شماره‌ی موبایل آزمایشی معتبر نیست." }); return; }
  let name: string; let expertPhone: string; let spId: number | null = null;
  if (b.salespersonId !== undefined && b.salespersonId !== null && b.salespersonId !== "") {
    const expert = expertInfo(crmDb, Number(b.salespersonId));
    if (!expert) { res.status(400).json({ error: "کارشناس پیدا نشد." }); return; }
    if (!expert.phone) { res.status(400).json({ error: "برای این کارشناس «شماره تماس برای مشتری» تعریف نشده است." }); return; }
    name = expert.name; expertPhone = expert.phone; spId = expert.salespersonId;
  } else {
    name = typeof b.expertName === "string" ? b.expertName.trim().slice(0, 40) : "";
    const p = typeof b.expertPhone === "string" ? b.expertPhone.trim().slice(0, 20) : "";
    expertPhone = normalizeContactPhone(p) ?? p;
    if (!name || !expertPhone) { res.status(400).json({ error: "کارشناس یا نام و شماره‌ی نمونه را وارد کنید." }); return; }
  }
  const s = getExpertIntroSettings(crmDb);
  const code = typeof b.patternCode === "string" && /^[A-Za-z0-9_-]{3,64}$/.test(b.patternCode.trim()) ? b.patternCode.trim() : s.patternCode;
  if (!code) { res.status(400).json({ error: "ابتدا کد الگوی پیامک را ذخیره کنید." }); return; }
  if (Date.now() - lastTestAt < 20_000) { res.status(429).json({ error: "چند ثانیه بعد دوباره امتحان کنید." }); return; }
  lastTestAt = Date.now();
  try {
    const providerId = await sendExpertIntroPattern({ recipient: phone, patternCode: code, params: { [EXPERT_INTRO_PARAM_CUSTOMER]: customer, [EXPERT_INTRO_PARAM_NAME]: name, [EXPERT_INTRO_PARAM_PHONE]: expertPhone } });
    logIntro(crmDb, { customerId: null, salespersonId: spId, expertName: name, status: "test_sent", reason: "ارسال آزمایشی", actorUserId: user.id }, new Date());
    res.json({ ok: true, providerId, text: renderIntroText(customer, name, expertPhone) });
  } catch (error) {
    const err = error instanceof Error ? error.message : "sms_failed";
    logIntro(crmDb, { customerId: null, salespersonId: spId, expertName: name, status: "test_failed", reason: failureText(err), actorUserId: user.id }, new Date());
    res.status(502).json({ error: failureText(err), code: err });
  }
});

router.get("/expert-intro-sms/user-phones", requireAdmin, (_req, res): void => { res.json(userContactPhones(crmDb)); });

router.put("/users/:id/customer-contact-phone", requireAdmin, (req, res): void => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "شناسه‌ی کاربر نامعتبر است." }); return; }
  try { res.json({ userId: id, phone: setUserContactPhone(crmDb, id, (req.body ?? {}).phone) }); } catch (error) { fail(res, error); }
});

router.get("/customers/:id/expert-intro-sms", requirePermission("customers.view"), (req, res): void => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || !getCustomer(id, res.locals.authUser as AuthUser)) { res.status(404).json({ error: "Customer not found" }); return; }
  res.json(customerIntroLog(crmDb, id));
});

export default router;
