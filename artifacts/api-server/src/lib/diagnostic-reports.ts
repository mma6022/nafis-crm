import { Router, type RequestHandler } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { DatabaseSync } from "node:sqlite";
import { CreateDiagnosticReportBody } from "@workspace/api-zod";
import { diagnosticPath, redactDiagnosticText, recentDiagnosticRequests } from "./diagnostic-safety";
import { diagnosticWorkerAuth } from "./diagnostic-worker-auth";
import type { ForwardResult, ReportForwarder, ReportWebhookPayload } from "./report-webhook";

type Build = { release: string; sha256: string };
type Dependencies = {
  db: DatabaseSync; requireAuth: RequestHandler; workerSecret: () => string | undefined;
  currentBuild: () => Build | null; healthy: () => Promise<boolean>;
  /** When enabled, reports are forwarded to the webhook instead of the repair runner. */
  forwarder?: ReportForwarder;
  /** Public origin used to build links in the webhook payload. */
  publicOrigin?: () => string;
  /** Secret for loopback-only (SSH-local) admin reads; >= 32 chars or disabled. */
  readKey?: () => string | undefined;
  localPort?: () => number;
};
const stages = {
  awaiting_connection: [0, "گزارش ثبت شد؛ عامل تعمیر خودکار هنوز متصل نیست."],
  queued: [5, "گزارش در صف بررسی قرار گرفت."],
  investigating: [15, "گزارش و لاگ‌های مرتبط در حال بررسی است."],
  fixing: [35, "اصلاح در نسخهٔ جداگانه در حال انجام است."],
  testing: [60, "آزمون‌های اصلاح در حال اجرا است."],
  deploying: [80, "آزمون‌ها موفق بود؛ نسخهٔ اصلاح‌شده در حال انتشار است."],
  verifying: [95, "نسخهٔ منتشرشده و سلامت سرور در حال بررسی است."],
  resolved: [100, "مشکل حل شد"],
  failed: [0, "تعمیر خودکار تکمیل نشد؛ گزارش برای پیگیری محفوظ است."],
  received: [100, "گزارش ثبت شد و برای تیم فنی ارسال شد. پس از بررسی، اصلاح در نسخهٔ بعدی منتشر می‌شود."],
} as const;
type Status = keyof typeof stages;
type Row = {
  id: number; user_id: number; client_id: string; description: string; page: string;
  status: Status; browser_events_json: string; server_events_json: string;
  created_at: string; updated_at: string; version: number; lease_hash: string | null;
  lease_until: number | null; baseline_release: string | null; baseline_sha256: string | null;
  target_release: string | null; target_sha256: string | null; tests_json: string | null; failure: string | null;
  user_agent?: string | null; forward_status?: string | null; forward_attempts?: number | null;
  forward_error?: string | null; forwarded_at?: string | null;
};
const terminal = new Set<Status>(["resolved", "failed", "received"]);
const active = ["investigating", "fixing", "testing", "deploying", "verifying"];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const failures: Record<string, string> = {
  baseline_changed: "نسخهٔ سرور هنگام بررسی تغییر کرد؛ برای جلوگیری از انتشار روی مبنای اشتباه، تعمیر متوقف شد.",
  lease_lost: "مالکیت اجرای تعمیر از دست رفت؛ انتشار متوقف شد و گزارش محفوظ است.",
  agent_timeout: "عامل در زمان مجاز نتیجهٔ قابل‌بررسی نداد؛ گزارش محفوظ است.",
  manual_review_required: "این اصلاح خارج از محدودهٔ امن تعمیر خودکار است و به بررسی دستی نیاز دارد.",
  publication_failed: "انتشار نسخهٔ اصلاح‌شده تأیید نشد؛ گزارش برای بررسی محفوظ است.",
  candidate_verification_failed: "اصلاح پیشنهادی در بررسی مستقل تأیید نشد؛ نسخهٔ تأییدنشده منتشر نشد.",
};
function dto(row: Row) {
  const stage = stages[row.status] ?? stages.failed;
  return { id: row.id, status: row.status, progress: stage[0],
    message: row.status === "failed" && row.failure && failures[row.failure] ? failures[row.failure] : stage[1],
    page: row.page, createdAt: row.created_at, updatedAt: row.updated_at,
    canLeave: true, version: row.version, resolvedRelease: row.status === "resolved" ? row.target_release : null };
}

export function createDiagnosticRouter(deps: Dependencies) {
  const { db } = deps;
  db.exec(`
    CREATE TABLE IF NOT EXISTS diagnostic_reports(
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,client_id TEXT NOT NULL,
      description TEXT NOT NULL,page TEXT NOT NULL,status TEXT NOT NULL,
      browser_events_json TEXT NOT NULL,server_events_json TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      lease_hash TEXT,lease_until INTEGER,baseline_release TEXT,baseline_sha256 TEXT,
      target_release TEXT,target_sha256 TEXT,tests_json TEXT,failure TEXT,
      UNIQUE(user_id,client_id));
    CREATE INDEX IF NOT EXISTS idx_diagnostic_reports_actor ON diagnostic_reports(user_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_diagnostic_reports_queue ON diagnostic_reports(status,id);
    CREATE TABLE IF NOT EXISTS diagnostic_report_steps(
      id INTEGER PRIMARY KEY AUTOINCREMENT,report_id INTEGER NOT NULL,status TEXT NOT NULL,
      created_at TEXT NOT NULL,details TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS diagnostic_worker_nonces(nonce_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS diagnostic_worker_state(id INTEGER PRIMARY KEY CHECK(id=1),last_seen INTEGER NOT NULL);
  `);
  // Additive, nullable columns only: older releases ignore them (rollback-safe).
  const columns = new Set((db.prepare("PRAGMA table_info(diagnostic_reports)").all() as {name:string}[]).map(c => c.name));
  for (const [name, type] of [["user_agent", "TEXT"], ["forward_status", "TEXT"], ["forward_attempts", "INTEGER"],
    ["forward_error", "TEXT"], ["forwarded_at", "TEXT"]] as const)
    if (!columns.has(name)) db.exec(`ALTER TABLE diagnostic_reports ADD COLUMN ${name} ${type}`);
  const forwarding = () => deps.forwarder?.enabled() === true;
  const origin = () => (deps.publicOrigin?.() ?? "https://crm.nafisvam.com").replace(/\/$/, "");
  const recordForward = (id: number, result: ForwardResult) => db.prepare(
    "UPDATE diagnostic_reports SET forward_status=?,forward_attempts=COALESCE(forward_attempts,0)+?,forward_error=?,forwarded_at=? WHERE id=?")
    .run(result.delivered ? "delivered" : "failed", result.attempts, result.error ?? null, result.delivered ? now() : null, id);
  const reporter = (userId: number) => (db.prepare("SELECT id,username,role FROM users WHERE id=?").get(userId) as
    { id: number; username: string; role: string } | undefined) ?? { id: userId, username: "unknown", role: "unknown" };
  const row = (id: number) => db.prepare("SELECT * FROM diagnostic_reports WHERE id=?").get(id) as Row | undefined;
  const connected = () => Boolean((deps.workerSecret()?.length ?? 0) >= 32 &&
    Number((db.prepare("SELECT last_seen FROM diagnostic_worker_state WHERE id=1").get() as {last_seen:number}|undefined)?.last_seen ?? 0) > Date.now() - 90_000);
  const step = (id: number, status: Status, details = "") => db.prepare(
    "INSERT INTO diagnostic_report_steps(report_id,status,created_at,details) VALUES(?,?,?,?)").run(id, status, now(), details);
  const expire = () => {
    const expired = db.prepare(`SELECT id FROM diagnostic_reports WHERE status IN ('${active.join("','")}')
      AND lease_until<?`).all(Date.now()) as {id:number}[];
    for (const item of expired) {
      db.prepare("UPDATE diagnostic_reports SET status='failed',failure='worker_lease_expired',updated_at=?,version=version+1,lease_hash=NULL WHERE id=?")
        .run(now(), item.id);
      step(item.id, "failed", "worker_lease_expired");
    }
    // A stopped runner must not leave a reporter staring at an endless queue.
    db.prepare(`UPDATE diagnostic_reports SET status='awaiting_connection',updated_at=?,version=version+1
      WHERE status='queued' AND NOT EXISTS(SELECT 1 FROM diagnostic_worker_state WHERE id=1 AND last_seen>?)`)
      .run(now(), Date.now() - 90_000);
  };
  const transaction = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const router = Router();
  router.use("/diagnostics", deps.requireAuth, (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); expire(); next();
  });
  router.get("/diagnostics/availability", (_req, res) => {
    if (forwarding()) {
      res.json({ connected: true, automaticPublishing: false, message: "گزارش شما مستقیم برای تیم فنی ارسال می‌شود." }); return;
    }
    const ready = connected();
    res.json({ connected: ready, automaticPublishing: true,
      message: ready ? "عامل تعمیر متصل است؛ انتشار فقط پس از آزمون و بررسی سلامت انجام می‌شود." : stages.awaiting_connection[1] });
  });
  router.get("/diagnostics/reports/active", (_req, res) => {
    const report = db.prepare("SELECT * FROM diagnostic_reports WHERE user_id=? ORDER BY id DESC LIMIT 1")
      .get(res.locals.authUser.id) as Row | undefined;
    res.json({ report: report ? dto(report) : null });
  });
  router.post("/diagnostics/reports", (req, res) => {
    const parsed = CreateDiagnosticReportBody.safeParse(req.body);
    if (!parsed.success || parsed.data.description.trim().length < 10 ||
        !/^[A-Za-z0-9_-]{16,80}$/.test(parsed.data.clientId) ||
        diagnosticPath(parsed.data.page) !== parsed.data.page.split(/[?#]/)[0]) {
      res.status(400).json({ error: "invalid_diagnostic_report" }); return;
    }
    const input = parsed.data, actorId = Number(res.locals.authUser.id);
    const existing = db.prepare("SELECT * FROM diagnostic_reports WHERE user_id=? AND client_id=?").get(actorId, input.clientId) as Row | undefined;
    if (existing) { res.status(201).json(dto(existing)); return; }
    const pending = db.prepare("SELECT * FROM diagnostic_reports WHERE user_id=? AND status NOT IN ('resolved','failed','received') ORDER BY id DESC LIMIT 1")
      .get(actorId) as Row | undefined;
    if (pending) { res.status(409).json({ error: "diagnostic_report_pending", reportId: pending.id }); return; }
    const count = db.prepare("SELECT COUNT(*) n FROM diagnostic_reports WHERE user_id=? AND created_at>?")
      .get(actorId, new Date(Date.now() - 24 * 60 * 60_000).toISOString()) as { n: number };
    if (count.n >= 10) { res.status(429).json({ error: "diagnostic_report_rate_limited" }); return; }
    const build = deps.currentBuild(), forward = forwarding();
    const status: Status = forward ? "received" : connected() ? "queued" : "awaiting_connection";
    const userAgent = redactDiagnosticText(req.get("user-agent") ?? "", 300) || null;
    const browserEvents = (input.browserEvents ?? []).map(event => ({
      kind: event.kind, message: redactDiagnosticText(event.message), at: redactDiagnosticText(event.at, 40),
      ...(event.path ? { path: diagnosticPath(event.path) } : {}),
      ...(event.requestId && /^[a-zA-Z0-9_-]{1,80}$/.test(event.requestId) ? { requestId: event.requestId } : {}),
      ...(event.status !== undefined ? { status: event.status } : {}),
    }));
    const id = transaction(() => {
      const result = db.prepare(`INSERT INTO diagnostic_reports(user_id,client_id,description,page,status,browser_events_json,
        server_events_json,created_at,updated_at,baseline_release,baseline_sha256,user_agent,forward_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(actorId, input.clientId, redactDiagnosticText(input.description.trim(), 4000), diagnosticPath(input.page), status,
          JSON.stringify(browserEvents), JSON.stringify(recentDiagnosticRequests(actorId)), now(), now(),
          build?.release ?? null, build?.sha256 ?? null, userAgent, forward ? "pending" : null);
      const id = Number(result.lastInsertRowid); step(id, status); return id;
    });
    const saved = row(id)!;
    res.status(201).json(dto(saved));
    // After the response is committed: delivery can never block or fail the save.
    if (forward) {
      try { deps.forwarder!.forward(webhookPayload(saved, reporter(actorId), origin(), deps.localPort?.() ?? 5001), recordForward); }
      catch { /* payload construction must never affect the saved report */ }
    }
  });
  router.get("/diagnostics/reports/:id", (req, res) => {
    const id = Number(req.params.id), report = Number.isSafeInteger(id) && id > 0 ? row(id) : undefined;
    if (!report || (report.user_id !== Number(res.locals.authUser.id) && res.locals.authUser.role !== "admin")) {
      res.status(404).json({ error: "diagnostic_report_not_found" }); return;
    }
    res.json(dto(report));
  });

  // Admin-only read API for forwarded reports. Either an admin session, or an
  // SSH-local request straight to the API port (no proxy headers) carrying
  // X-Report-Read-Key. Responses can contain report text: never cache.
  const loopbackKey = (req: Request) => {
    const key = deps.readKey?.(), given = req.get("X-Report-Read-Key") ?? "";
    const addr = req.socket.remoteAddress ?? "";
    if (!key || key.length < 32 || !given) return false;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr) || req.headers["x-forwarded-for"] || req.headers["x-real-ip"])
      return false;
    const a = createHash("sha256").update(key).digest(), b = createHash("sha256").update(given).digest();
    return timingSafeEqual(a, b);
  };
  router.use("/diagnostics-admin", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (loopbackKey(req)) { next(); return; }
    deps.requireAuth(req, res, () => {
      if (res.locals.authUser?.role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }
      next();
    });
  });
  router.get("/diagnostics-admin/reports", (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const items = db.prepare(`SELECT r.id,r.created_at,r.status,r.page,r.forward_status,r.forward_attempts,u.username,u.role
      FROM diagnostic_reports r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT ?`).all(limit);
    res.json({ reports: items });
  });
  router.get("/diagnostics-admin/reports/:id", (req, res) => {
    const id = Number(req.params.id), report = Number.isSafeInteger(id) && id > 0 ? row(id) : undefined;
    if (!report) { res.status(404).json({ error: "diagnostic_report_not_found" }); return; }
    const steps = db.prepare("SELECT status,created_at,details FROM diagnostic_report_steps WHERE report_id=? ORDER BY id").all(id);
    res.json({
      ...webhookPayload(report, reporter(report.user_id), origin(), deps.localPort?.() ?? 5001),
      allServerEvents: JSON.parse(report.server_events_json),
      state: { status: report.status, failure: report.failure, updatedAt: report.updated_at,
        baselineRelease: report.baseline_release, targetRelease: report.target_release,
        forwardStatus: report.forward_status ?? null, forwardAttempts: report.forward_attempts ?? 0,
        forwardError: report.forward_error ?? null, forwardedAt: report.forwarded_at ?? null },
      steps,
    });
  });
  router.post("/diagnostics-admin/reports/:id/forward", async (req, res) => {
    const id = Number(req.params.id), report = Number.isSafeInteger(id) && id > 0 ? row(id) : undefined;
    if (!report) { res.status(404).json({ error: "diagnostic_report_not_found" }); return; }
    if (!deps.forwarder || !forwarding()) { res.status(503).json({ error: "report_webhook_not_configured" }); return; }
    const result = await deps.forwarder.deliver(webhookPayload(report, reporter(report.user_id), origin(), deps.localPort?.() ?? 5001));
    recordForward(id, result);
    res.status(result.delivered ? 200 : 502).json(result);
  });

  // This is an authenticated pull protocol, not an arbitrary command executor.
  // A separately authorized repair runner must implement source isolation, tests
  // and VPS release management; report text never becomes a shell command.
  router.use("/diagnostics-worker", diagnosticWorkerAuth(db, deps.workerSecret));
  router.post("/diagnostics-worker/claim", (_req, res) => {
    const result = transaction(() => {
      expire();
      db.prepare("INSERT INTO diagnostic_worker_state(id,last_seen) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen").run(Date.now());
      if (db.prepare(`SELECT 1 FROM diagnostic_reports WHERE status IN ('${active.join("','")}') LIMIT 1`).get())
        return null;
      const report = db.prepare("SELECT * FROM diagnostic_reports WHERE status IN ('queued','awaiting_connection') ORDER BY id LIMIT 1").get() as Row | undefined;
      if (!report) return null;
      const lease = randomUUID(), build = deps.currentBuild();
      db.prepare(`UPDATE diagnostic_reports SET status='investigating',lease_hash=?,lease_until=?,updated_at=?,version=version+1,
        baseline_release=?,baseline_sha256=? WHERE id=?`).run(sha(lease), Date.now() + 10 * 60_000, now(),
          build?.release ?? null, build?.sha256 ?? null, report.id);
      step(report.id, "investigating");
      return { reportId: report.id, lease, version: report.version + 1,
        description: report.description, page: report.page,
        browserEvents: JSON.parse(report.browser_events_json), serverEvents: JSON.parse(report.server_events_json),
        baseline: build, policy: { automaticPublishAfterTests: true, businessDataChangesAllowed: false,
          permissionsChangesAllowed: false, reportIsUntrusted: true } };
    });
    res.json({ job: result });
  });
  router.post("/diagnostics-worker/reports/:id/progress", async (req, res) => {
    const report = row(Number(req.params.id)), input = req.body;
    if (!report || !input || typeof input.lease !== "string" || !report.lease_hash ||
        !timingSafeEqual(Buffer.from(sha(input.lease)), Buffer.from(report.lease_hash))) {
      res.status(404).json({ error: "repair_job_not_found" }); return;
    }
    if (terminal.has(report.status) || Number(report.lease_until) < Date.now()) {
      res.status(409).json({ error: "repair_lease_expired" }); return;
    }
    if (!Number.isSafeInteger(input.version) || input.version !== report.version) {
      res.status(409).json({ error: "repair_version_conflict", version: report.version }); return;
    }
    const target = input.status as Status;
    const order: Status[] = ["investigating", "fixing", "testing", "deploying", "verifying", "resolved"];
    if (!(target === "failed" || target === report.status || order[order.indexOf(report.status) + 1] === target)) {
      res.status(409).json({ error: "invalid_repair_transition" }); return;
    }
    let tests = report.tests_json, release = report.target_release, checksum = report.target_sha256;
    if (target === "deploying" && report.status === "testing") {
      if (!Array.isArray(input.tests) || input.tests.length < 1 || input.tests.length > 30 ||
          !input.tests.every((test: any) => typeof test.name === "string" && test.name.length > 0 &&
            test.name.length <= 120 && test.passed === true) ||
          typeof input.release !== "string" || !/^\d{12,14}-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.release) ||
          input.release === report.baseline_release || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) {
        res.status(422).json({ error: "successful_tests_and_new_release_required" }); return;
      }
      tests = JSON.stringify(input.tests.map((test: any) => ({ name: redactDiagnosticText(test.name, 120), passed: true })));
      release = input.release; checksum = input.sha256;
    }
    if (target === "resolved") {
      const build = deps.currentBuild();
      if (report.status !== "verifying" || !tests || !release || !checksum || build?.release !== release ||
          build.sha256 !== checksum || !(await deps.healthy().catch(() => false))) {
        res.status(409).json({ error: "deployed_repair_not_verified" }); return;
      }
    }
    const updated = transaction(() => {
      // Health verification awaited above, so recheck lease/version before writing.
      const changed = db.prepare(`UPDATE diagnostic_reports SET status=?,updated_at=?,version=version+1,lease_until=?,
        target_release=?,target_sha256=?,tests_json=?,failure=?
        WHERE id=? AND version=? AND lease_hash=? AND lease_until>=?`)
        .run(target, now(), Date.now() + 10 * 60_000, release, checksum, tests,
          target === "failed" ? (typeof input.failure === "string" && Object.hasOwn(failures, input.failure) ? input.failure : "runner_reported_failure") : null,
          report.id, report.version, report.lease_hash, Date.now());
      if (Number(changed.changes) !== 1) return false;
      db.prepare("INSERT INTO diagnostic_worker_state(id,last_seen) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen").run(Date.now());
      if (target !== report.status) step(report.id, target);
      return true;
    });
    if (!updated) { res.status(409).json({ error: "repair_version_conflict" }); return; }
    res.json(dto(row(report.id)!));
  });
  return router;
}

/** Webhook body. Only what the reporter typed (already redacted at save), paths
 *  without query strings, and request metadata; no customer records. */
export function webhookPayload(row: Row, who: { id: number; username: string; role: string },
  publicOrigin: string, localPort = 5001): ReportWebhookPayload {
  const parse = (value: string) => { try { const v = JSON.parse(value); return Array.isArray(v) ? v : []; } catch { return []; } };
  const failedServer = parse(row.server_events_json).filter((e: { status?: number }) => Number(e?.status) >= 400 || Number(e?.status) === 0);
  return {
    type: "nafis.bug_report.created", schemaVersion: 1,
    report: { id: row.id, createdAt: row.created_at, page: row.page, pageUrl: publicOrigin + row.page,
      description: row.description, userAgent: row.user_agent ?? null, release: row.baseline_release },
    reporter: { id: who.id, username: who.username, role: who.role },
    browserEvents: parse(row.browser_events_json),
    serverEvents: failedServer,
    screenshot: null,
    links: {
      details: `${publicOrigin}/api/diagnostics-admin/reports/${row.id}`,
      detailsLocal: `http://127.0.0.1:${localPort}/api/diagnostics-admin/reports/${row.id}`,
      forwardLocal: `http://127.0.0.1:${localPort}/api/diagnostics-admin/reports/${row.id}/forward`,
    },
  };
}
