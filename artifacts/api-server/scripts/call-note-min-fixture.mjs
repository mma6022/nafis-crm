// crm-call-note-min fixture: «یادداشت تماس حداقل ۱۰ نویسه باشد.» on every call-note entry (server side).
// Runs on a throwaway copy of a DB; HTTP over a unix socket inside the temp dir. Never touches live; no SMS, no staff notifications.
// Usage: CALL_NOTE_MIN_FIXTURE_DB=/path/to/copy.db node scripts/run-bundled-fixture.mjs scripts/call-note-min-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const MSG = "یادداشت تماس حداقل ۱۰ نویسه باشد.";
const rule = await import("../src/lib/call-note-rule.ts");
await ok("rule: trims, counts code points, whitespace-only fails, message text", async () => {
  assert.equal(rule.CALL_NOTE_MIN, 10);
  assert.equal(rule.callNoteMinMessage(), MSG);
  for (const bad of [undefined, null, "", "          ", " \n\t ", "۱۲۳۴۵۶۷۸۹", "   abcdefghi   ", 12345678901])
    assert.equal(rule.callNoteError(bad), MSG, JSON.stringify(bad));
  for (const good of ["0123456789", "  0123456789  ", "مشتری جواب داد", "می‌خواهد وام", "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂"])
    assert.equal(rule.callNoteError(good), null, good);
  assert.equal(rule.callNoteLength("  ۱۲۳  "), 3);
  assert.equal(rule.callNoteLength("🙂🙂"), 2); // code points, not UTF-16 units
});

const src = process.env.CALL_NOTE_MIN_FIXTURE_DB;
if (!src) { console.log(`SKIP DB section (set CALL_NOTE_MIN_FIXTURE_DB). call-note-min fixture: ${passed} passed`); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "call-note-min-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

const now = new Date("2026-10-25T10:00:00+03:30");
const v2 = { mode: "simple", callResult: "answered", urgency: "month", amountMillion: 100, docsReady: "partial", creditRank: "A1",
  checkStatus: "any", canPromissory: "yes", bouncedCheque: "no", formVersion: 2, guarantorAvailable: "no",
  military: "has_card", jobType: "unknown", city: "شهر نمونه", noPlanFit: true };
const SHORT9 = "۱۲۳۴۵۶۷۸۹", PAD = "    abcdefghi    ", BLANK = "            ", OK10 = "  تماس خوب بود  "; // OK10 trims to 12

let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const vac = await import("../src/lib/voip-after-call.ts");
  const { queryRow, queryRows, execute } = db;
  const express = (await import("express")).default;
  const crmRouter = (await import("../src/routes/crm.ts")).default;
  const tsRouter = (await import("../src/routes/team-sales.ts")).default;
  const vacRouter = (await import("../src/routes/voip-after-call.ts")).default;
  const crRouter = (await import("../src/routes/call-reports.ts")).default;
  execute("DELETE FROM notification_settings WHERE key='team_sales_config'");
  execute("INSERT INTO notification_settings(key,value,updated_at) VALUES('team_sales_config','{\"enabled\":true}',datetime('now'))");
  assert.equal(ts.getTeamSalesConfig().noteMinLength, 10);
  vac.ensureAfterCallSchema();
  const P = ["customers.view", "customers.update", "calls.create", "calls.view"];
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: [], customerScope: "all" },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned" },
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  for (const r of [crmRouter, tsRouter, vacRouter, crRouter]) app.use("/api", r);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
  const calls = (id) => Number(queryRow("SELECT count(*) n FROM call_logs WHERE customer_id=?", [id]).n);
  const sms = () => Number(queryRow("SELECT count(*) n FROM sqlite_master WHERE name='sms_outbox'").n) ? Number(queryRow("SELECT count(*) n FROM sms_outbox").n) : 0;
  const sms0 = sms();
  const pool = queryRows(`SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND merged_into_customer_id IS NULL ORDER BY id LIMIT 8`).map((r) => Number(r.id));
  assert.ok(pool.length >= 5);
  for (const id of pool) execute("UPDATE customers SET priority=NULL WHERE id=?", [id]);
  // No pending after-call event may swallow the manual call in these tests.
  execute("UPDATE voip_after_call_events SET completed_at=COALESCE(completed_at,'2026-01-01T00:00:00Z')");

  await ok("«ثبت تماس» (legacy form, POST /calls): missing / blank / 9 / padded-9 → 400 with the message; nothing written", async () => {
    const c = pool[0], before = calls(c);
    for (const expertNotes of [undefined, "", BLANK, SHORT9, PAD]) {
      const r = await call("POST", "/calls", "admin", { customerId: c, subject: "پیگیری", ...(expertNotes === undefined ? {} : { expertNotes }) });
      assert.equal(r.status, 400, JSON.stringify(expertNotes)); assert.equal(r.body.error, MSG);
    }
    assert.equal(calls(c), before);
    const r = await call("POST", "/calls", "admin", { customerId: c, subject: "پیگیری", expertNotes: OK10 });
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    assert.equal(calls(c), before + 1);
    assert.equal(queryRow("SELECT expert_notes n FROM call_logs WHERE customer_id=? ORDER BY id DESC LIMIT 1", [c]).n, OK10.trim());
  });

  await ok("team-sales «ثبت تماس» (answered and no-answer): < 10 → 400 with the message; 10 → saved", async () => {
    const c = pool[1], before = calls(c);
    for (const note of ["", BLANK, SHORT9, PAD]) {
      for (const answers of [v2, { ...v2, callResult: "no_answer" }]) {
        const r = await call("POST", `/customers/${c}/team-sales/qualify`, "kazemi", { answers, note });
        assert.equal(r.status, 400, `${answers.callResult} ${JSON.stringify(note)}`); assert.equal(r.body.error, MSG);
      }
    }
    assert.equal(calls(c), before);
    const r = await call("POST", `/customers/${c}/team-sales/qualify`, "kazemi", { answers: v2, note: "0123456789" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const r2 = await call("POST", `/customers/${pool[4]}/team-sales/qualify`, "kazemi", { answers: { ...v2, callResult: "no_answer" }, note: "جواب نداد." + " " });
    assert.equal(r2.status, 200, JSON.stringify(r2.body)); // «جواب نداد.» = 10 after trim
  });

  await ok("first-call edit wizard: < 10 → 400 with the message; 10 → saved", async () => {
    const c = pool[1];
    const fc = (await call("GET", `/customers/${c}`, "admin")).body.firstCall;
    const base = { answers: { ...v2, amountMillion: 222 }, baseId: fc.id, send: false };
    for (const note of [BLANK, SHORT9, PAD]) {
      const r = await call("POST", `/customers/${c}/team-sales/first-call/edit`, "kazemi", { ...base, note });
      assert.equal(r.status, 400); assert.equal(r.body.error, MSG);
    }
    const r = await call("POST", `/customers/${c}/team-sales/first-call/edit`, "kazemi", { ...base, note: "ویرایش شد!" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  const mkEvent = (customerId, { live = 0, withLog = true } = {}) => {
    const started = "2026-10-25T06:00:00.000Z";
    const logId = withLog ? Number(execute(`INSERT INTO call_logs(customer_id,salesperson_id,salesperson_name_snapshot,subject,customer_request,expert_notes,created_at) VALUES(?,NULL,'admin',NULL,NULL,'',?)`, [customerId, started])) : null;
    return Number(execute(`INSERT INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,extensions_json,expert_user_id,expert_name,customer_id,call_log_id,has_recording,is_live)
      VALUES(?,?,?,?,?,?,'[]',1,'admin',?,?,0,?)`, [`fx-cnm-${Math.random().toString(36).slice(2)}`, "09120000000", "outgoing", live ? "active" : "ANSWER", started, started, customerId, logId, live]));
  };
  const ev = (id) => queryRow("SELECT completed_at,expert_notes FROM voip_after_call_events WHERE id=?", [id]);

  await ok("after-call «نتیجه تماس» (PATCH /voip/after-call/:id): blank / 9 → 400, still pending; 10 → completed; «عدم ثبت» with no note still works", async () => {
    const e = mkEvent(pool[2]);
    for (const expertNotes of ["", BLANK, SHORT9]) {
      const r = await call("PATCH", `/voip/after-call/${e}`, "admin", { expertNotes });
      assert.equal(r.status, 400); assert.equal(r.body.error, MSG);
    }
    assert.equal(ev(e).completed_at, null);
    assert.equal((await call("PATCH", `/voip/after-call/${e}`, "admin", { expertNotes: OK10 })).status, 200);
    assert.ok(ev(e).completed_at);
    const d = mkEvent(pool[2]);
    assert.equal((await call("PATCH", `/voip/after-call/${d}`, "admin", { expertNotes: "", discardHistory: true })).status, 200);
  });

  await ok("call report (PATCH /calls/:id/report and /voip/after-call/:id/report): finished call < 10 → 400; live draft may be short but stays pending until the note reaches 10", async () => {
    const logId = Number(execute(`INSERT INTO call_logs(customer_id,salesperson_id,salesperson_name_snapshot,subject,customer_request,expert_notes,created_at) VALUES(?,NULL,'admin','x',NULL,'یادداشت قبلی کامل',?)`, [pool[3], now.toISOString()]));
    let rep = (await call("GET", `/calls/${logId}/report`, "admin")).body;
    let r = await call("PATCH", `/calls/${logId}/report`, "admin", { subject: "x", expertNotes: SHORT9, expectedRevision: rep.revision });
    assert.equal(r.status, 400); assert.equal(r.body.error, MSG);
    r = await call("PATCH", `/calls/${logId}/report`, "admin", { subject: "x", expertNotes: "یادداشت اصلاح شد", expectedRevision: rep.revision });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const live = mkEvent(pool[3], { live: 1 });
    rep = (await call("GET", `/voip/after-call/${live}/report`, "admin")).body;
    assert.equal(rep.isLive, true);
    r = await call("PATCH", `/voip/after-call/${live}/report`, "admin", { subject: null, expertNotes: "سلام", expectedRevision: rep.revision });
    assert.equal(r.status, 200, "live autosave draft is allowed");
    execute("UPDATE voip_after_call_events SET is_live=0,status='ANSWER' WHERE id=?", [live]);
    vac.finishSavedLiveReport(live);
    assert.equal(ev(live).completed_at, null, "short live draft is not auto-completed");
    rep = (await call("GET", `/voip/after-call/${live}/report`, "admin")).body;
    r = await call("PATCH", `/voip/after-call/${live}/report`, "admin", { subject: null, expertNotes: "سلام", expectedRevision: rep.revision });
    assert.equal(r.status, 400); assert.equal(r.body.error, MSG);
    r = await call("PATCH", `/voip/after-call/${live}/report`, "admin", { subject: null, expertNotes: "سلام، مشتری پیگیری می‌کند", expectedRevision: rep.revision });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(ev(live).completed_at, "finishing the report with a valid note completes it");
  });

  await ok("no SMS queued by any of the above", async () => { assert.equal(sms(), sms0); });
} finally {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`call-note-min fixture: ${passed} passed`);
