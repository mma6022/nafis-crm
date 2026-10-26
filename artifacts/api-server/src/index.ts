import app from "./app";
import { logger } from "./lib/logger";
import { startAfterCallMonitor } from "./lib/voip-after-call";
import { startTranscriptWorker } from "./lib/recording-transcript-jobs";
import { startWalletPaymentRecovery } from "./lib/wallet-payment-recovery";
import { startExpertReminderSmsWorker } from "./lib/expert-reminder-sms";
import { startExpertIntroSmsWorker } from "./lib/expert-intro-sms";
import { startTeamBonusScheduler } from "./lib/team-commission";
import { startSiteLeadWorker } from "./lib/site-leads";
import { notifySiteLeadWindow } from "./lib/customer-notifications";
import { crmDb } from "./lib/crm-db";
import { ensureLedgerSchema } from "./lib/ledger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// General ledger G1: schema only (additive, idempotent; nothing posts yet, every gl.* flag OFF).
// Never blocks startup: a failure is logged and the CRM runs exactly as before.
try {
  ensureLedgerSchema(crmDb);
} catch (err) {
  logger.error({ err }, "general ledger schema not ensured");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startAfterCallMonitor();
  startTranscriptWorker();
  startWalletPaymentRecovery();
  startExpertReminderSmsWorker();
  startExpertIntroSmsWorker();
  startSiteLeadWorker({ info: (m) => logger.info(m), error: (m) => logger.error(m) }, notifySiteLeadWindow);
  startTeamBonusScheduler(); // inert unless the team model AND the monthly team bonus are enabled
});
