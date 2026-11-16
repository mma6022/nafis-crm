import { crmDb } from "./crm-db";
import { logger } from "./logger";
import { getNotificationSettings, normalizeIranianMobile } from "./customer-notifications";
import { createReminderSmsQueue } from "./reminder-sms-core";
import { sendReminderPattern } from "./reminder-sms-transport";

export async function sendExpertReminderSms(mobile: string, name: string): Promise<string> {
  const settings = getNotificationSettings();
  const recipient = normalizeIranianMobile(mobile);
  if (!recipient) throw new Error("invalid_phone");
  return sendReminderPattern(recipient,name,{enabled:settings.ippanelEnabled,
    relayUrl:settings.ippanelRelayUrl,fromNumber:settings.ippanelFromNumber,secret:process.env.IR_RELAY_SHARED_SECRET});
}

let expertReminderSmsStarted=false;
export function startExpertReminderSmsWorker() {
  if (expertReminderSmsStarted) return;
  expertReminderSmsStarted=true;
  const queue=createReminderSmsQueue(crmDb,sendExpertReminderSms);
  // Development previews must not send a second copy of production reminders.
  if (process.env.NODE_ENV!=="production" && process.env.ENABLE_EXPERT_REMINDER_SMS!=="true") {
    logger.info("Expert reminder SMS sending is disabled in development");
    return;
  }
  const tick=()=>void queue.tick().catch(()=>logger.error("Expert reminder SMS worker failed"));
  tick();
  setInterval(tick,15_000).unref();
  logger.info("Expert reminder SMS is off (SMS-OFF-71): worker only marks reminders in-app only");
}
