import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { crmDb } from "./crm-db";
import { requireAuth } from "./auth";
import { createDiagnosticRouter } from "./diagnostic-reports";
import { createReportForwarder, webhookConfigFromEnv } from "./report-webhook";
import { logger } from "./logger";

function currentBuild() {
  const root = fs.realpathSync(path.resolve(process.cwd(), "../.."));
  if (!root.startsWith("/opt/nafisvam/releases/")) return null;
  const release = path.basename(root);
  if (!/^\d{12,14}-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(release)) return null;
  const bundle = path.join(root, "artifacts/api-server/dist/index.mjs");
  return { release, sha256: createHash("sha256").update(fs.readFileSync(bundle)).digest("hex") };
}
const webhookConfig = webhookConfigFromEnv();
if (process.env.REPORT_WEBHOOK_URL && !webhookConfig)
  logger.error({}, "report_webhook_config_invalid: forwarding disabled (need https URL, key, valid header name)");
export const reportForwarder = createReportForwarder({ config: () => webhookConfig, log: logger });
export const diagnosticRouter = createDiagnosticRouter({
  db: crmDb, requireAuth,
  forwarder: reportForwarder,
  publicOrigin: () => process.env.REPORT_PUBLIC_ORIGIN || "https://crm.nafisvam.com",
  readKey: () => process.env.REPORT_READ_KEY,
  localPort: () => Number(process.env.PORT) || 5001,
  workerSecret: () => {
    if (process.env.CRM_REPAIR_WORKER_SECRET) return process.env.CRM_REPAIR_WORKER_SECRET;
    try { return fs.readFileSync("/etc/nafisvam-repair-transport/worker-key", "utf8").trim(); }
    catch { return undefined; }
  },
  currentBuild,
  healthy: async () => {
    const port = Number(process.env.PORT);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return false;
    const response = await fetch(`http://127.0.0.1:${port}/api/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const body = await response.json() as { status?: unknown };
    return body.status === "ok";
  },
});
