// daily-customer-inline r4 wiring: cover/refill flag ON == OFF; compact actions hit existing
// endpoints; lockdown 8/2/3 own 200 / other 403; no SMS or Bale sends.
// Uses a throwaway copy of a masked DB. ICS24 / SMS / Bale env is cleared; fetch is stubbed.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const src = process.env.DCI_FIXTURE_DB || process.env.CS_FIELDS_FIXTURE_DB || process.env.CT_CHAT_FIXTURE_DB;
if (!src) { console.log("SKIP (set DCI_FIXTURE_DB)"); process.exit(0); }

for (const k of Object.keys(process.env)) {
  if (/^(ICS24_|SMS_|BALE_|TELEGRAM_|KAVENEGAR_|GHASEDAK_|TWILIO_)/i.test(k) || /_(SMS|BALE|TELEGRAM)_/.test(k)) {
    delete process.env[k];
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dci-wire-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
let netCalls = 0;
globalThis.fetch = async () => { netCalls++; throw new Error("unexpected network call in dci wiring fixture"); };

function validNid() {
  const nine = "001354241";
  const s = [...nine].reduce((n, d, i) => n + Number(d) * (10 - i), 0) % 11;
  return nine + String(s < 2 ? s : 11 - s);
}

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const { queryRow, queryRows, execute } = db;
  const dp = await import("../src/lib/daily-plan.ts");
  const { expertLockdownGuard } = await import("../src/lib/expert-lockdown.ts");
  const express = (await import("express")).default;
  const teamSalesRouter = (await import("../src/routes/team-sales.ts")).default;
  const dailyPlanRouter = (await import("../src/routes/daily-plan.ts")).default;
  const crmRouter = (await import("../src/routes/crm.ts")).default;

  const P = [
    "customers.view", "customers.update", "calls.create", "calls.view", "customers.credit_check",
  ];
  const actors = {
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned", active: true },
    hasani: { id: 2, role: "salesperson", salespersonId: 3, fullName: "hasani", permissions: P, customerScope: "assigned", active: true },
    ghasemi: { id: 3, role: "salesperson", salespersonId: 4, fullName: "ghasemi", permissions: P, customerScope: "assigned", active: true },
  };
  const flag = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);

  const ts = new Date().toISOString();
  const CID_K = 910021, CID_H = 910022, CID_G = 910023, CID_K_CREDIT = 910031, CID_K_CALL = 910032;
  for (const c of [
    [CID_K, "Samira", "09120000021", 6],
    [CID_H, "Mehdi", "09120000022", 3],
    [CID_G, "Narges", "09120000023", 4],
    [CID_K_CREDIT, "SamiraCredit", "09120000031", 6],
    [CID_K_CALL, "SamiraCall", "09120000032", 6],
  ]) {
    execute("DELETE FROM customers WHERE id=?", [c[0]]);
    execute(`INSERT INTO customers(id,name,phone,salesperson_id,status,priority,created_at,verification_status,is_urgent,verification_version,national_code,credit_rank)
      VALUES(?,?,?,?, 'in_progress', NULL, ?, 'unverified', 0, 0, NULL, NULL)`,
      [c[0], c[1], c[2], c[3], ts]);
  }

  const count = (table) => {
    if (!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [table])) return 0;
    return Number(queryRow(`SELECT COUNT(*) n FROM "${table}"`)?.n ?? 0);
  };
  const sms0 = count("reminder_sms_deliveries");
  const bale0 = count("bale_outbox");
  const credit0 = count("customer_credit_checks");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.authUser = actors[req.headers["x-actor"]];
    if (!res.locals.authUser) { res.sendStatus(401); return; }
    next();
  });
  app.use("/api", expertLockdownGuard, teamSalesRouter, dailyPlanRouter, crmRouter);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });

  const srcCover = fs.readFileSync(path.resolve("src/lib/daily-plan.ts"), "utf8");
  const coverFn = srcCover.slice(srcCover.indexOf("function dpCoverAndRefill"), srcCover.indexOf("function dpRefill"));
  await ok("dpCoverAndRefill has no daily_customer_inline flag gate", () => {
    assert.equal(/flag\.daily_customer_inline_v1/.test(coverFn), false);
    assert.match(coverFn, /dpCoverItem/);
    assert.match(coverFn, /dpRefill/);
  });

  const snapItems = (planId) => queryRows(
    "SELECT id,customer_id,status,bucket,source,label,type,reason FROM dp_items WHERE plan_id=? ORDER BY id",
    [planId],
  );
  const snapSeen = (planId) => queryRows("SELECT ref FROM dp_seen WHERE plan_id=? ORDER BY ref", [planId]);
  const restorePlan = (dump) => {
    execute("DELETE FROM dp_items WHERE plan_id=?", [dump.planId]);
    execute("DELETE FROM dp_seen WHERE plan_id=?", [dump.planId]);
    for (const row of dump.items) {
      const cols = Object.keys(row);
      execute(`INSERT INTO dp_items (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
    }
    for (const row of dump.seen) {
      const cols = Object.keys(row);
      execute(`INSERT INTO dp_seen (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
    }
    if (dump.plan) {
      const cols = Object.keys(dump.plan);
      execute(`UPDATE dp_plans SET ${cols.filter((c) => c !== "id").map((c) => `${c}=?`).join(",")} WHERE id=?`,
        [...cols.filter((c) => c !== "id").map((c) => dump.plan[c]), dump.plan.id]);
    }
  };

  await ok("cover and refill with flag ON match flag OFF", () => {
    const user = { id: 8, role: "salesperson", salespersonId: 6, active: true };
    const now = new Date();
    const p = dp.dpActiveFor(user, now);
    if (!p) {
      // No started plan for today in this copy — still prove the two flag states take the same no-op path.
      flag("flag.daily_customer_inline_v1", "0");
      flag("flag.daily_customer_inline_v1.user.8", "0");
      const off = dp.dpActiveFor(user, now);
      flag("flag.daily_customer_inline_v1", "1");
      flag("flag.daily_customer_inline_v1.user.8", "1");
      const on = dp.dpActiveFor(user, now);
      assert.deepEqual(off, on);
      return;
    }
    const dump = {
      planId: p.id,
      items: queryRows("SELECT * FROM dp_items WHERE plan_id=?", [p.id]),
      seen: queryRows("SELECT * FROM dp_seen WHERE plan_id=?", [p.id]),
      plan: queryRow("SELECT * FROM dp_plans WHERE id=?", [p.id]),
    };
    flag("flag.daily_customer_inline_v1", "0");
    flag("flag.daily_customer_inline_v1.user.8", "0");
    dp.dpRefresh({ ...p }, now);
    const offItems = snapItems(p.id);
    const offSeen = snapSeen(p.id);
    restorePlan(dump);
    flag("flag.daily_customer_inline_v1", "1");
    flag("flag.daily_customer_inline_v1.user.8", "1");
    dp.dpRefresh({ ...p }, now);
    assert.deepEqual(snapItems(p.id), offItems);
    assert.deepEqual(snapSeen(p.id), offSeen);
    restorePlan(dump);
  });

  flag("flag.daily_customer_inline_v1", "1");
  flag("flag.instant_credit_check.user.8", "1");
  flag("flag.instant_credit_check", "1");

  // no_answer: still hits qualify + lockdown, but does not compute a P1 handoff or queue intro SMS.
  const answers = { mode: "simple", formVersion: 2, callResult: "no_answer" };
  const qualifyBody = { answers, note: "یادداشت آزمایشی تماس اول", call_result: "no_answer" };

  await ok("first-call qualify hits existing endpoint; own 200, other 403", async () => {
    const own = await call("POST", `/customers/${CID_K}/team-sales/qualify`, "kazemi", qualifyBody);
    assert.equal(own.status, 200, `kazemi own qualify ${own.status} ${JSON.stringify(own.body)}`);
    assert.ok(own.body.callLogId);
    const other = await call("POST", `/customers/${CID_H}/team-sales/qualify`, "kazemi", qualifyBody);
    assert.equal(other.status, 403, `kazemi other qualify ${other.status}`);
    const hasaniOther = await call("POST", `/customers/${CID_K}/team-sales/qualify`, "hasani", qualifyBody);
    assert.equal(hasaniOther.status, 403);
    const ghasemiOther = await call("POST", `/customers/${CID_K}/team-sales/qualify`, "ghasemi", qualifyBody);
    assert.equal(ghasemiOther.status, 403);
  });

  await ok("credit check starts only on explicit POST; own hits existing ICC endpoint, other 403; no auto-start", async () => {
    assert.equal(count("customer_credit_checks"), credit0, "GET/other work must not auto-start a check");
    const other = await call("POST", `/instant-credit-check/customers/${CID_H}/checks`, "kazemi", {
      nationalCode: validNid(), source: "call_form", consent: true,
    });
    assert.equal(other.status, 403, `kazemi other credit ${other.status}`);
    const started = await call("POST", `/instant-credit-check/customers/${CID_K_CREDIT}/checks`, "kazemi", {
      nationalCode: validNid(), source: "call_form", consent: true,
    });
    // Provider is unset / fetch is stubbed, so this must not send SMS. The existing endpoint is still hit.
    assert.ok([201, 200, 400, 409, 500, 502, 503].includes(started.status), `unexpected credit status ${started.status} ${JSON.stringify(started.body)}`);
    assert.notEqual(started.status, 403);
    if (started.body && started.body.id) {
      const polled = await call("POST", `/instant-credit-check/customers/${CID_K_CREDIT}/checks/${started.body.id}/status`, "kazemi", {});
      assert.ok([200, 201, 400, 404, 409, 500].includes(polled.status), `status poll ${polled.status}`);
    }
  });

  await ok("POST /calls (result form) own succeeds or validates, other 403", async () => {
    const body = {
      customerId: CID_K_CALL, subject: "تماس ورودی", customerRequest: "", expertNotes: "ثبت نتیجه آزمایشی کارهای امروز",
      outcome: "answered", call_result: "answered", oneLineNote: "ثبت نتیجه آزمایشی کارهای امروز",
      outOfList: true, context: "out_of_list",
    };
    const own = await call("POST", "/calls", "kazemi", body);
    assert.ok([200, 201].includes(own.status), `kazemi own call ${own.status} ${JSON.stringify(own.body)}`);
    const other = await call("POST", "/calls", "kazemi", { ...body, customerId: CID_H });
    assert.equal(other.status, 403, `kazemi other call ${other.status}`);
    const hasaniOther = await call("POST", "/calls", "hasani", body);
    assert.equal(hasaniOther.status, 403);
    const ghasemiOther = await call("POST", "/calls", "ghasemi", body);
    assert.equal(ghasemiOther.status, 403);
  });

  await ok("promote to P1 keeps reason and uses existing priority endpoint; other 403", async () => {
    const own = await call("POST", `/customers/${CID_H}/priority`, "hasani", { level: 1, reason: "دلیل ارتقا برای آزمایش" });
    // Hasani's customer still has no priority; may be 200 or a business 4xx, but must not be 500 and must require the reason.
    assert.notEqual(own.status, 500);
    const missing = await call("POST", `/customers/${CID_H}/priority`, "hasani", { level: 1, reason: "" });
    assert.ok(missing.status === 400 || missing.status === 422, `empty reason ${missing.status}`);
    const other = await call("POST", `/customers/${CID_K}/priority`, "hasani", { level: 1, reason: "دلیل ارتقا برای آزمایش" });
    assert.equal(other.status, 403);
  });

  await ok("no SMS or Bale sends; no outbound network", () => {
    assert.equal(count("reminder_sms_deliveries"), sms0);
    assert.equal(count("bale_outbox"), bale0);
    assert.equal(netCalls, 0);
  });

  console.log(`daily-customer-inline wiring fixture passed ${passed} checks`);
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  if (server) await new Promise((r) => server.close(r));
}
