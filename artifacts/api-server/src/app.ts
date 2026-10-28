import { leadAnnotatorMask } from "./lib/lead-annotator-mask";
import { makeRegistrarWriteGuard } from "./lib/registrar-view";
import { crmDb } from "./lib/crm-db";
import express, { type Express, type RequestHandler } from "express";
import { isPublicWalletRequest } from "./lib/wallet-public-access";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import router from "./routes";
import authRouter from "./routes/auth";
import customerPortalAdviceRouter from "./routes/customer-portal-advice";
import customerPortalLoansRouter from "./routes/customer-portal-loans";
import customerPortalWalletRouter from "./routes/customer-portal-wallet";
import { logger } from "./lib/logger";
import { requireAuth } from "./lib/auth";
import customerPortalAuthRouter from "./routes/customer-portal-auth";
import customerPortalProfileRouter from "./routes/customer-portal-profile";
import customerPortalIntakeRouter from "./routes/customer-portal-intake";
import { customerChatRouter } from "./routes/customer-chat";
import instagramWebhookRouter from "./routes/instagram-webhook";
import manychatRouter from "./routes/manychat";
import simotelCallEventsRouter from "./routes/simotel-call-events";
import { mobileCallIngress } from "./routes/mobile-calls";
import { diagnosticRouter } from "./lib/diagnostics-runtime";
import { captureDiagnosticRequests } from "./lib/diagnostic-safety";
import { codexOAuthCallback } from "./routes/diagnostic-codex-oauth";
import { createCodexOAuthSetup } from "./routes/diagnostic-codex-setup";
import { CodexLoginController } from "./lib/diagnostic-codex-login";
import { VpsRepairConnection } from "./lib/diagnostic-vps-connection";
import { socialMonitorFeature } from "./lib/social-monitor";
import { mountPublicLeads } from "./routes/public-leads";
import { smartFilingRunnerRouter } from "./routes/smart-filing";
import { assistantRunnerRouter } from "./routes/assistants";
import { baleInternalRouter } from "./routes/bale";
import { expertLockdownGuard } from "./lib/expert-lockdown";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0]?.replace(
            /(\/(?:api\/)?(?:wallet\/share-links|customers\/\d+\/wallet\/share-links)\/)[A-Za-z0-9_-]+(?=\/|$)/,
            "$1[redacted]",
          ),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Public website lead intake has its own strict CORS and must run first.
mountPublicLeads(app);
app.use(cors({ credentials: true, origin: true }));
// Meta signature verification must operate on the exact unparsed request bytes.
app.use(
  "/api/instagram/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  instagramWebhookRouter,
);
// Smart-filing runner: Bearer token, own 2 MB JSON limit and own 404, so it must run before the global 100 KB parser.
app.use("/api/smart-filing-runner", smartFilingRunnerRouter);
app.use("/api/assistant-runner", assistantRunnerRouter);
// Bale sidecar → API inbound messages: loopback + internal token, own JSON limit, outside /api (no CRM session).
app.use(baleInternalRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/api", captureDiagnosticRequests);
// Provider callbacks use their own constant-time Basic authentication, never
// a CRM user session. The rest of /api remains protected by requireApiAuth.
app.use("/api/voip/simotel/events",simotelCallEventsRouter);
app.use("/api/mobile-calls", mobileCallIngress);
app.use("/api/manychat", express.json({ limit: "16kb" }), manychatRouter);
app.use((req, res, next): void => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.headers.origin) {
    next();
    return;
  }
  const expectedHost = req.headers["x-forwarded-host"] ?? req.headers.host;
  try {
    if (new URL(req.headers.origin).host !== expectedHost) {
      res.status(403).json({ error: "Invalid request origin" });
      return;
    }
  } catch {
    res.status(403).json({ error: "Invalid request origin" });
    return;
  }
  next();
});
app.use("/api/auth", authRouter);
app.use("/api/customer-portal/auth", customerPortalAuthRouter);
app.use("/api/customer-portal", customerPortalProfileRouter);
app.use("/api/customer-portal", customerPortalAdviceRouter);
app.use("/api/customer-portal", customerPortalWalletRouter);
app.use("/api/customer-portal", customerPortalLoansRouter);
app.use("/api/customer-portal", customerPortalIntakeRouter);
app.use("/api/customer-portal", customerChatRouter);
// Staff routes authenticate internally; worker routes require independent HMAC.
// Only the temporary, Codex-validated GET OAuth callback precedes worker HMAC.
app.use("/api", codexOAuthCallback);
app.use("/api", createCodexOAuthSetup({
  requireAuth,
  enabled: () => process.env.NODE_ENV !== "production" && process.env.CRM_REPAIR_CODEX_OAUTH_PORT === "7436",
  origin: () => `https://${process.env.REPLIT_DEV_DOMAIN ?? ""}`,
  login: process.env.CRM_REPAIR_CONNECTION_TRANSPORT === "vps" ? new VpsRepairConnection() : new CodexLoginController(),
  persistentConnection: process.env.CRM_REPAIR_CONNECTION_TRANSPORT === "vps",
}));
app.use("/api", diagnosticRouter);
// Trusted ingest from the loopback-only social proxy; requests carry an HMAC
// over the body and are separately checked against the active CRM user.
app.use("/api/social-monitor", socialMonitorFeature.ingestRouter);

const requireApiAuth: RequestHandler = (req, res, next): void => {
  const isPublicLoanPlanRequest =
    req.method === "GET" &&
    /^\/public\/loan-plans(?:\/[^/]+(?:\/documents)?)?\/?$/.test(req.path);
  // Public calculator quote (payout + installment only; validated + per-IP rate limit in the route).
  const isPublicLoanPlanQuote = req.method === "POST" && /^\/public\/loan-plans\/[^/]+\/quote\/?$/.test(req.path);
  const isPublicWalletShare = isPublicWalletRequest(req.method, req.path);
  if (req.path === "/healthz" || isPublicLoanPlanRequest || isPublicLoanPlanQuote || isPublicWalletShare) {
    next();
    return;
  }
  requireAuth(req, res, next);
};

// lead_annotator: every phone in every /api response is masked for a user holding the capability (lib/lead-annotator-mask.ts).
// registrar_view (assistants53): read-only on customers the user registered but no longer owns — every write on them is 403.
// expert_lockdown (assistants54): users 2 / 3 / 8 only while flag.expert_lockdown = 1 — everyone else passes straight through.
app.use("/api", requireApiAuth, leadAnnotatorMask, makeRegistrarWriteGuard(() => crmDb), expertLockdownGuard, router);

export default app;
