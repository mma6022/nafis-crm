// crm-first-call-edit fixture: «ویرایش» on «خلاصه‌ی تماس اول» (access, no new call, history, priority never lowered,
// «ذخیره و ارسال به کارشناس فروش» = the promote path / Kazemi's 0.75% upgrade event).
// Runs on a throwaway copy of a DB; HTTP over a unix socket inside the temp dir. Never touches live; no SMS, no staff notifications sent.
// Usage: FIRST_CALL_EDIT_FIXTURE_DB=/path/to/copy.db node scripts/run-bundled-fixture.mjs scripts/first-call-edit-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const src = process.env.FIRST_CALL_EDIT_FIXTURE_DB;
if (!src) { console.log("SKIP (set FIRST_CALL_EDIT_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-call-edit-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
// Placeholders only (unreachable host); the fixture never calls AI or SMS.
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

const now = new Date("2026-10-25T10:00:00+03:30");
const v2 = { mode: "simple", callResult: "answered", urgency: "month", amountMillion: 100, docsReady: "partial", creditRank: "A1",
  checkStatus: "any", canPromissory: "yes", bouncedCheque: "no", formVersion: 2, guarantorAvailable: "no",
  military: "has_card", jobType: "unknown", city: "شهر نمونه", noPlanFit: true }; // «هیچ طرحی نمی‌خوره» + month → exactly P2
const note = "مشتری جواب داد؛ بخشی از مدارک آماده است و توضیح کامل ثبت شد برای پیگیری.";
const note2 = "ویرایش: مبلغ و شهر درست شد، مشتری دوباره تأیید کرد و توضیحات تکمیل شد.";

let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const tc = await import("../src/lib/team-commission.ts");
  const { queryRow, queryRows, execute } = db;
  const express = (await import("express")).default;
  const crmRouter = (await import("../src/routes/crm.ts")).default;
  const tsRouter = (await import("../src/routes/team-sales.ts")).default;
  execute("DELETE FROM notification_settings WHERE key='team_sales_config'");
  execute("INSERT INTO notification_settings(key,value,updated_at) VALUES('team_sales_config','{\"enabled\":true}',datetime('now'))");
  const cfg = ts.getTeamSalesConfig();
  const [closerA] = cfg.closerSalespersonIds;
  const closerUser = Number(queryRow("SELECT id FROM users WHERE salesperson_id=? ORDER BY id LIMIT 1", [closerA]).id);

  const P = ["customers.view", "customers.update", "calls.create"];
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: [], customerScope: "all" },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned" },
    closer: { id: closerUser, role: "salesperson", salespersonId: closerA, fullName: "closer", permissions: P, customerScope: "assigned" },
    otherAll: { id: 4, role: "salesperson", salespersonId: 5, fullName: "other", permissions: P, customerScope: "all" },
    registrar: { id: 7, role: "registrar", salespersonId: null, fullName: "registrar", permissions: P, customerScope: "all" },
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", crmRouter); app.use("/api", tsRouter);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });

  const pool = queryRows(`SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND merged_into_customer_id IS NULL ORDER BY id LIMIT 12`).map((r) => Number(r.id));
  assert.ok(pool.length >= 8, "need 8 customers of salesperson 6");
  for (const id of pool) execute("UPDATE customers SET priority=NULL, city=NULL WHERE id=?", [id]);
  const next = (() => { let i = 0; return () => pool[i++]; })();
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi" };
  const counts = (id) => ({
    calls: Number(queryRow("SELECT count(*) n FROM call_logs WHERE customer_id=?", [id]).n),
    quals: Number(queryRow("SELECT count(*) n FROM team_sales_qualifications WHERE customer_id=?", [id]).n),
    hist: Number(queryRow("SELECT count(*) n FROM customer_priority_history WHERE customer_id=?", [id]).n),
    qf: Number(queryRow("SELECT count(*) n FROM customer_priority_history WHERE customer_id=? AND source='qualifier_form'", [id]).n),
    sms: Number(queryRow("SELECT count(*) n FROM sqlite_master WHERE name='sms_outbox'").n)
      ? Number(queryRow("SELECT count(*) n FROM sms_outbox").n) : 0,
  });
  const fc = async (id, actor = "admin") => (await call("GET", `/customers/${id}`, actor)).body?.firstCall;
  const body = (fcRow, patch = {}, extra = {}) => ({ answers: { ...v2, ...patch }, note: note2, baseId: fcRow.id, send: false, ...extra });
  const url = (id) => `/customers/${id}/team-sales/first-call/edit`;
  const info = (id, a) => call("GET", `/customers/${id}/team-sales/first-call/edit-info`, a);

  /* P2 customer of Kazemi, edited (save only) */
  const c1 = next();
  ts.submitQualification(c1, kazemi, v2, note, now);
  assert.equal(Number(queryRow("SELECT priority p FROM customers WHERE id=?", [c1]).p), 2);
  const fc1 = await fc(c1);

  await ok("edit-info: admin / Kazemi (qualifier) may edit + send; registrar and a non-owner salesperson may not", async () => {
    for (const a of ["admin", "kazemi"]) { const r = await info(c1, a); assert.equal(r.status, 200); assert.equal(r.body.canEdit, true, a); assert.equal(r.body.canSend, true, a); }
    for (const a of ["registrar", "otherAll"]) { const r = await info(c1, a); assert.equal(r.status, 200); assert.equal(r.body.canEdit, false, a); assert.equal(r.body.canSend, false, a); }
  });
  await ok("server enforces: registrar / non-owner salesperson → 403, assigned-scope stranger → 404; nothing written", async () => {
    const before = counts(c1);
    assert.equal((await call("POST", url(c1), "registrar", body(fc1, { amountMillion: 300 }))).status, 403);
    assert.equal((await call("POST", url(c1), "otherAll", body(fc1, { amountMillion: 300 }))).status, 403);
    assert.equal((await call("POST", url(c1), "closer", body(fc1, { amountMillion: 300 }))).status, 404);
    assert.deepEqual(counts(c1), before);
    assert.equal(Number(queryRow("SELECT count(*) n FROM team_sales_first_call_edits").n), 0);
  });
  await ok("note too short / no change / stale base → 400 / 400 / 409", async () => {
    assert.equal((await call("POST", url(c1), "kazemi", { ...body(fc1, { amountMillion: 300 }), note: "کوتاه" })).status, 400);
    assert.equal((await call("POST", url(c1), "kazemi", { ...body(fc1), note })).status, 400);
    assert.equal((await call("POST", url(c1), "kazemi", { ...body(fc1, { amountMillion: 300 }), baseId: fc1.id + 999999 })).status, 409);
  });
  await ok("save only: no call_log, no new qualification row, fee events untouched; summary + consult profile updated; history old→new", async () => {
    const before = counts(c1);
    const r = await call("POST", url(c1), "kazemi", body(fc1, { amountMillion: 250, city: "شهر دیگر" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = counts(c1);
    assert.equal(after.calls, before.calls); assert.equal(after.quals, before.quals); assert.equal(after.qf, before.qf); assert.equal(after.sms, before.sms);
    assert.equal(r.body.handoff, null); assert.equal(r.body.priorityAfter, 2);
    const ch = Object.fromEntries(r.body.changed.map((c) => [c.field, c]));
    assert.deepEqual([ch.amountMillion.old, ch.amountMillion.new], [100, 250]);
    assert.deepEqual([ch.city.old, ch.city.new], ["شهر نمونه", "شهر دیگر"]);
    assert.ok(ch.note);
    const s = await fc(c1); assert.equal(s.answers.amountMillion, 250); assert.equal(s.note, note2); assert.equal(s.id, fc1.id);
    assert.equal(s.createdAt, fc1.createdAt);
    const e = queryRow("SELECT * FROM team_sales_first_call_edits WHERE customer_id=?", [c1]);
    assert.equal(Number(e.actor_user_id), 8); assert.equal(Number(e.sent_to_closer), 0);
    assert.equal(JSON.parse(e.before_json).answers.amountMillion, 100);
    const v = queryRow("SELECT * FROM customer_consult_profile_versions WHERE customer_id=? ORDER BY id DESC LIMIT 1", [c1]);
    assert.equal(v.source, "edit"); assert.ok(JSON.parse(v.changed_fields_json).includes("city"));
    const hist = (await info(c1, "admin")).body.edits; assert.equal(hist.length, 1); assert.equal(hist[0].changed.length, 3);
  });
  await ok("never lowered: P2 edited to «فقط کنجکاوه» stays P2 (suggestion 3 reported)", async () => {
    const r = await call("POST", url(c1), "kazemi", body(await fc(c1), { amountMillion: 250, city: "شهر دیگر", urgency: "curious" }));
    assert.equal(r.status, 200); assert.equal(r.body.suggestedPriority, 3); assert.equal(r.body.priorityAfter, 2);
    assert.equal(Number(queryRow("SELECT priority p FROM customers WHERE id=?", [c1]).p), 2);
  });
  await ok("never auto-P1 / transfer: edit to «همین الان + همه مدارک» suggests 1 but keeps P2 and the owner", async () => {
    const r = await call("POST", url(c1), "kazemi", body(await fc(c1), { urgency: "now", docsReady: "all", noPlanFit: false }));
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.priorityAfter, 2);
    console.log("   (suggested priority with now + all docs:", r.body.suggestedPriority, ")");
    assert.deepEqual({ ...queryRow("SELECT priority, salesperson_id FROM customers WHERE id=?", [c1]) }, { priority: 2, salesperson_id: 6 });
  });
  await ok("raise only: P3 (curious) edited to «تا یک ماه» → P2 with source first_call_edit (ignored by commission)", async () => {
    const c = next(); ts.submitQualification(c, kazemi, { ...v2, urgency: "curious" }, note, now);
    assert.equal(Number(queryRow("SELECT priority p FROM customers WHERE id=?", [c]).p), 3);
    const r = await call("POST", url(c), "kazemi", body(await fc(c), { urgency: "month" }));
    assert.equal(r.status, 200); assert.equal(r.body.priorityAfter, 2); assert.equal(r.body.priorityRaised, true);
    const h = queryRow("SELECT * FROM customer_priority_history WHERE customer_id=? ORDER BY id DESC LIMIT 1", [c]);
    assert.equal(h.source, "first_call_edit"); assert.equal(Number(h.old_priority), 3); assert.equal(Number(h.new_priority), 2);
    assert.equal(tc.qualifierP1Event(c, { ...tc.settingsAt().settings, modelStartDate: "1400-01-01" }, new Date(Date.now() + 86400000)), null);
  });
  await ok("no suitable plan → warning flag only, save still allowed", async () => {
    const c = next(); ts.submitQualification(c, kazemi, v2, note, now);
    const r = await call("POST", url(c), "kazemi", body(await fc(c), { bouncedCheque: "yes", creditRank: "E3", amountMillion: 5000, noPlanFit: true }, { noPlanNote: "شرایط هیچ طرحی جور نیست" }));
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(typeof r.body.noSuitablePlan, "boolean");
    assert.equal(r.body.noPlanFit, true);
  });
  let sentId;
  await ok("«ذخیره و ارسال» by Kazemi = promote path: P1, round-robin closer, history source promote old 2 → Kazemi upgrade (0.75%) event", async () => {
    const c = next(); sentId = c; ts.submitQualification(c, kazemi, v2, note, now);
    const before = counts(c);
    const r = await call("POST", url(c), "kazemi", body(await fc(c), { amountMillion: 180 }, { send: true }));
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.handoff); assert.equal(r.body.priorityAfter, 1);
    const cu = queryRow("SELECT priority, salesperson_id FROM customers WHERE id=?", [c]);
    assert.equal(Number(cu.priority), 1); assert.ok(cfg.closerSalespersonIds.includes(Number(cu.salesperson_id)));
    const h = queryRow("SELECT * FROM customer_priority_history WHERE customer_id=? ORDER BY id DESC LIMIT 1", [c]);
    assert.equal(h.source, "promote"); assert.equal(Number(h.old_priority), 2); assert.equal(Number(h.actor_user_id), 8);
    const after = counts(c);
    assert.equal(after.quals, before.quals); assert.equal(after.calls, before.calls + 1, "only the promote path's own «ارتقا» timeline row"); assert.equal(after.sms, before.sms);
    const ev = tc.qualifierP1Event(c, { ...tc.settingsAt().settings, modelStartDate: "1400-01-01" }, new Date(Date.now() + 86400000)); assert.equal(ev?.kind, "upgrade");
    assert.equal(Number(queryRow("SELECT sent_to_closer s FROM team_sales_first_call_edits WHERE customer_id=? ORDER BY id DESC LIMIT 1", [c]).s), 1);
  });
  await ok("owner is a closer: edit-info canSend=false with a clear reason; send → 409; the owner (closer) may edit (save only)", async () => {
    const owner = Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [sentId]).s);
    const ownerUser = Number(queryRow("SELECT id FROM users WHERE salesperson_id=? ORDER BY id LIMIT 1", [owner]).id);
    actors.closer = { ...actors.closer, id: ownerUser, salespersonId: owner };
    const i = await info(sentId, "admin"); assert.equal(i.body.canSend, false); assert.equal(i.body.ownerIsCloser, true); assert.match(i.body.sendBlockedReason, /کارشناس فروش/);
    const ci = await info(sentId, "closer"); assert.equal(ci.status, 200); assert.equal(ci.body.canEdit, true); assert.equal(ci.body.canSend, false);
    assert.equal((await call("POST", url(sentId), "admin", body(await fc(sentId), { amountMillion: 190 }, { send: true }))).status, 409);
    const r = await call("POST", url(sentId), "closer", body(await fc(sentId, "closer"), { amountMillion: 190 }));
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.priorityAfter, 1);
    assert.equal(Number(queryRow("SELECT priority p FROM customers WHERE id=?", [sentId]).p), 1);
  });
  await ok("admin «ذخیره و ارسال» works; history actor = admin (finding: no Kazemi upgrade share under current commission rules)", async () => {
    const c = next(); ts.submitQualification(c, kazemi, v2, note, now);
    const r = await call("POST", url(c), "admin", body(await fc(c), { amountMillion: 120 }, { send: true }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const h = queryRow("SELECT * FROM customer_priority_history WHERE customer_id=? ORDER BY id DESC LIMIT 1", [c]);
    assert.equal(h.source, "promote"); assert.equal(Number(h.actor_user_id), 1);
  });
  await ok("customer without a first-call form → 404", async () => {
    const c = next(); const r = await call("POST", url(c), "kazemi", { answers: v2, note: note2, send: false });
    assert.equal(r.status, 404);
  });
  console.log(`first-call-edit fixture: ${passed} passed`);
} finally {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
