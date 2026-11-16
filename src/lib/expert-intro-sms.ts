/** crm-expert-intro-sms glue: live DB, IPPanel relay sender, worker (see expert-intro-sms-core.ts). Default OFF. */
import { crmDb } from "./crm-db";
import { logger } from "./logger";
import { getNotificationSettings } from "./customer-notifications";
import { mergeTeamSalesConfig } from "./team-sales-rules";
import {
  ensureExpertIntroSchema, expertIntroTick, onSalespersonChange, sendPatternViaRelay, type ChangeInput, type SendArgs,
} from "./expert-intro-sms-core";
import { einsTick } from "./expert-intro-newlead-core";

export function teamSalesIds(): { qualifierId: number | null; closerIds: number[] } {
  let raw: unknown = null;
  try {
    const r = crmDb.prepare("SELECT value FROM notification_settings WHERE key='team_sales_config'").get() as { value?: string } | undefined;
    raw = r?.value ? JSON.parse(r.value) : null;
  } catch { raw = null; }
  const cfg = mergeTeamSalesConfig(raw);
  const q = Number(cfg.qualifierSalespersonId);
  return { qualifierId: Number.isInteger(q) && q > 0 ? q : null, closerIds: cfg.closerSalespersonIds.map(Number) };
}

/** Hook for logPriorityChange. Never throws: a failure here must not break a hand-off. */
export function noteSalespersonChange(change: Omit<ChangeInput, "qualifierId"> & { qualifierId?: number | null }): void {
  try {
    if (change.oldSalespersonId === change.newSalespersonId) return;
    const qualifierId = change.qualifierId !== undefined ? change.qualifierId : teamSalesIds().qualifierId;
    onSalespersonChange(crmDb, { ...change, qualifierId }, { ippanelEnabled: getNotificationSettings().ippanelEnabled });
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "expert intro SMS enqueue failed");
  }
}

export function sendExpertIntroPattern(args: SendArgs): Promise<string> {
  const s = getNotificationSettings();
  if (!s.ippanelEnabled) return Promise.reject(new Error("sms_disabled"));
  return sendPatternViaRelay(args, { relayUrl: s.ippanelRelayUrl, fromNumber: s.ippanelFromNumber, secret: process.env.IR_RELAY_SHARED_SECRET });
}

let started = false;
export function startExpertIntroSmsWorker(): void {
  if (started) return;
  started = true;
  ensureExpertIntroSchema(crmDb);
  if (process.env.NODE_ENV !== "production" && process.env.ENABLE_EXPERT_INTRO_SMS !== "true") {
    logger.info("Expert intro SMS sending is disabled in development");
    return;
  }
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    expertIntroTick(crmDb, { send: sendExpertIntroPattern, qualifierId: teamSalesIds().qualifierId, ippanelEnabled: () => getNotificationSettings().ippanelEnabled })
      .catch(() => logger.error("Expert intro SMS worker failed"))
      .then(() => einsTick(crmDb, { send: sendExpertIntroPattern, ippanelEnabled: () => getNotificationSettings().ippanelEnabled }))
      .catch(() => logger.error("Expert intro (new lead) SMS worker failed"))
      .finally(() => { busy = false; });
  };
  setTimeout(tick, 20_000).unref();
  setInterval(tick, 30_000).unref();
  logger.info("Expert intro SMS worker started");
}
