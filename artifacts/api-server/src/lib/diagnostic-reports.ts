import { Router, type RequestHandler } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CreateDiagnosticReportBody } from "@workspace/api-zod";
import { diagnosticPath, redactDiagnosticText, recentDiagnosticRequests } from "./diagnostic-safety";
import { diagnosticWorkerAuth } from "./diagnostic-worker-auth";

type Build = { release: string; sha256: string };
type Dependencies = {
  db: DatabaseSync; requireAuth: RequestHandler; workerSecret: () => string | undefined;
  currentBuild: () => Build | null; healthy: () => Promise<boolean>;
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
} as const;
type Status = keyof typeof stages;
type Row = {
  id: number; user_id: number; client_id: string; description: string; page: string;
  status: Status; browser_events_json: string; server_events_json: string;
  created_at: string; updated_at: string; version: number; lease_hash: string | null;
  lease_until: number | null; baseline_release: string | null; baseline_sha256: string | null;
  target_release: string | null; target_sha256: string | null; tests_json: string | null; failure: string | null;
};
const terminal = new Set<Status>(["resolved", "failed"]);
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
  return { id: row.id, status: row.status, progress: stages[row.status][0],
    message: row.status === "failed" && row.failure && failures[row.failure] ? failures[row.failure] : stages[row.status][1],
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
    const pending = db.prepare("SELECT * FROM diagnostic_reports WHERE user_id=? AND status NOT IN ('resolved','failed') ORDER BY id DESC LIMIT 1")
      .get(actorId) as Row | undefined;
    if (pending) { res.status(409).json({ error: "diagnostic_report_pending", reportId: pending.id }); return; }
    const count = db.prepare("SELECT COUNT(*) n FROM diagnostic_reports WHERE user_id=? AND created_at>?")
      .get(actorId, new Date(Date.now() - 24 * 60 * 60_000).toISOString()) as { n: number };
    if (count.n >= 10) { res.status(429).json({ error: "diagnostic_report_rate_limited" }); return; }
    const build = deps.currentBuild(), status = connected() ? "queued" : "awaiting_connection";
    const browserEvents = (input.browserEvents ?? []).map(event => ({
      kind: event.kind, message: redactDiagnosticText(event.message), at: redactDiagnosticText(event.at, 40),
      ...(event.path ? { path: diagnosticPath(event.path) } : {}),
      ...(event.requestId && /^[a-zA-Z0-9_-]{1,80}$/.test(event.requestId) ? { requestId: event.requestId } : {}),
      ...(event.status !== undefined ? { status: event.status } : {}),
    }));
    const id = transaction(() => {
      const result = db.prepare(`INSERT INTO diagnostic_reports(user_id,client_id,description,page,status,browser_events_json,
        server_events_json,created_at,updated_at,baseline_release,baseline_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(actorId, input.clientId, redactDiagnosticText(input.description.trim(), 4000), diagnosticPath(input.page), status,
          JSON.stringify(browserEvents), JSON.stringify(recentDiagnosticRequests(actorId)), now(), now(),
          build?.release ?? null, build?.sha256 ?? null);
      const id = Number(result.lastInsertRowid); step(id, status); return id;
    });
    res.status(201).json(dto(row(id)!));
  });
  router.get("/diagnostics/reports/:id", (req, res) => {
    const id = Number(req.params.id), report = Number.isSafeInteger(id) && id > 0 ? row(id) : undefined;
    if (!report || (report.user_id !== Number(res.locals.authUser.id) && res.locals.authUser.role !== "admin")) {
      res.status(404).json({ error: "diagnostic_report_not_found" }); return;
    }
    res.json(dto(report));
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
