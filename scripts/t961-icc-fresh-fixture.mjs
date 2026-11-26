// t961 FSD-22 — instant credit check never reuses a 24h result; end-to-end fixture on a COPY of the masked DB (never the live DB, no network).
// Chain: requireAuth → leadAnnotatorMask → registrarWriteGuard → expertLockdownGuard → filesCarouselGuard → pageAccessGuard → router.
// Usage: ICC_FIXTURE_DB=/workspace/social-hub-send/run/sh.db node scripts/run-bundled-fixture.mjs scripts/t961-icc-fresh-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

globalThis.__DatabaseSync = DatabaseSync;
globalThis.fetch = async () => { throw new Error("no network in fixture"); };
const src = process.env.ICC_FIXTURE_DB || "/workspace/social-hub-send/run/sh.db";
if (!fs.existsSync(src)) { console.log("SKIP (missing ICC_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE|OPENAI|DEEPSEEK|KAVENEGAR|VOIP|ISSABEL/i.test(k)) delete process.env[k];
const SECRET = `fixture-only-${crypto.randomBytes(8).toString("hex")}-not-a-real-secret-0123456789`;
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", SESSION_SECRET: SECRET, SMS_DISABLED: "1",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9", AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-placeholder" });

let passed = 0, failed = 0;
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log("ok -", name); }
  catch (e) { failed++; console.log("not ok -", name, "::", String(e?.message || e), "\n   ", String(e?.stack || "").split("\n").slice(1, 4).join(" | ")); }
};
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const { queryRow, queryRows, execute } = db;
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const { requireAuth } = await import("../src/lib/auth.ts");
  const { leadAnnotatorMask } = await import("../src/lib/lead-annotator-mask.ts");
  const { makeRegistrarWriteGuard } = await import("../src/lib/registrar-view.ts");
  const { expertLockdownGuard } = await import("../src/lib/expert-lockdown.ts");
  const { filesCarouselGuard } = await import("../src/lib/files-carousel.ts");
  const { pageAccessGuard, pageAccessLockdownBypass, paEffective } = await import("../src/lib/page-access.ts");
  const reg = await import("../src/lib/page-access-registry.ts");
  const router = (await import("../src/routes/index.ts")).default;
  const authRouter = (await import("../src/routes/auth.ts")).default;
  const app = express();
  app.use(express.json({ limit: "2mb" })); app.use(cookieParser());
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, leadAnnotatorMask, makeRegistrarWriteGuard(() => db.crmDb), pageAccessLockdownBypass, expertLockdownGuard, filesCarouselGuard, pageAccessGuard, router);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, p, tok, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ socketPath: sock, path: "/api" + p, method, headers: { Cookie: `crm_session=${tok}`, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, (r) => {
      let s = ""; r.on("data", (c) => (s += c)); r.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: r.statusCode, body: j }); });
    });
    rq.on("error", reject); if (data) rq.write(data); rq.end();
  });
  const session = (uid) => {
    const t = crypto.randomBytes(24).toString("base64url"); const h = crypto.createHmac("sha256", SECRET).update(t).digest("hex"); const now = new Date();
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", [h, uid, new Date(+now + 864e5).toISOString(), now.toISOString()]);
    return t;
  };
  const flag = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const hash = (sql) => { try { return crypto.createHash("sha256").update(JSON.stringify(queryRows(sql))).digest("hex"); } catch { return "absent"; } };
  const guarded = ["team_sales_config", "notification_settings", "contracts", "users", "loan_plans", "role_permissions", "app_roles"];
  const guardBefore = Object.fromEntries(guarded.map((t) => [t, hash(`SELECT * FROM ${t} ORDER BY rowid`)]));
  const tableExists = (t) => Boolean(queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [t]));

  const validNid = (base9) => { let s = 0; for (let i = 0; i < 9; i++) s += Number(base9[i]) * (10 - i); const r = s % 11; return base9 + String(r < 2 ? r : 11 - r); };
  const NID = validNid("123456789");
  const ADMIN = session(1);
  const CUST = 1522;
  const cust = queryRow("SELECT phone FROM customers WHERE id=?", [CUST]); assert.ok(cust, "customer 1522 exists on the copy");
  execute("UPDATE customers SET national_code=?, identity_changed_at=NULL WHERE id=?", [NID, CUST]);
  execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.instant_credit_check.user.1','1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='1'");
  const now = new Date().toISOString();
  execute("INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,provider,national_code,provider_reference,provider_status,status,score,score_label,summary,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [CUST, 1, "ics24", NID, "fixture-ref", "done", "report_generated", 700, "B", "fixture", now, now, now]);
  const before = queryRow("SELECT COUNT(*) n FROM customer_credit_checks WHERE customer_id=?", [CUST]).n;
  await ok("quick credit check: a report younger than 24h is NOT reused (no `reused`, a fresh inquiry is attempted)", async () => {
    const r = await call("POST", `/instant-credit-check/customers/${CUST}/checks`, ADMIN, { nationalCode: NID, consent: true, source: "call_form" });
    assert.notEqual(r.body?.reused, true, JSON.stringify(r.body).slice(0, 200));
    assert.ok(!(r.status === 200 && r.body?.status === "report_generated"), "must not answer with the old report");
    const after = queryRow("SELECT COUNT(*) n FROM customer_credit_checks WHERE customer_id=?", [CUST]).n;
    assert.ok(after >= before, "no row removed");
  });
  await ok("the generic /customers/:id/credit-checks route is unchanged (still reuses)", async () => {
    const r = await call("POST", `/customers/${CUST}/credit-checks`, ADMIN, { nationalCode: NID, mobileNumber: cust.phone });
    assert.equal(r.body?.reused, true, JSON.stringify(r.body).slice(0, 200));
  });
} finally {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`t961-icc-fresh: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
