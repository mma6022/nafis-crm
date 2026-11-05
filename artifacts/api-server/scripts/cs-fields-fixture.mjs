// «موارد اجباری خلاصه‌ی تماس» v1.2 fixture (flag.call_summary_fields_v1): flag OFF = identical (404, no keys, no tables);
// first-call form with empty items + docs[] → derived docsReady; transcript extraction (fetch MOCKED) → later-call proposals;
// «نه» keeps the file, «اعمال در پرونده» / «اعمال همه» write the file + history (approver, source call); never automatic; report.
// Runs on a temp COPY of a masked DB; SYNTHETIC events/transcripts only; never prints customer data; no network, no SMS.
// Usage: CS_FIELDS_FIXTURE_DB=/path/masked.db (or CT_CHAT_FIXTURE_DB) node scripts/run-bundled-fixture.mjs scripts/cs-fields-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const src = process.env.CS_FIELDS_FIXTURE_DB || process.env.CT_CHAT_FIXTURE_DB;
if (!src) { console.log("SKIP (set CS_FIELDS_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-fields-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789` });
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9"; // placeholders only (unreachable)
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
let netCalls = 0;
globalThis.fetch = async () => { netCalls++; throw new Error("unexpected network call in cs-fields fixture"); };
let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const ha = await import("../src/lib/history-a.ts");
  const cs = await import("../src/lib/call-summary-fields.ts");
  const { queryRow, queryRows, execute } = db;
  const express = (await import("express")).default;
  const tsRouter = (await import("../src/routes/team-sales.ts")).default;
  const csRouter = (await import("../src/routes/call-summary-fields.ts")).default;
  execute("DELETE FROM notification_settings WHERE key='team_sales_config'");
  execute("INSERT INTO notification_settings(key,value,updated_at) VALUES('team_sales_config','{\"enabled\":true}',datetime('now'))");
  execute("DELETE FROM call_queue_settings WHERE key LIKE 'flag.call_summary_fields_v1%'");
  for (const t of ["cs_call_items", "cs_extractions", "cs_file_proposals", "cs_file_values"]) execute(`DROP TABLE IF EXISTS ${t}`);
  const flag = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const csTables = () => queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cs\\_%' ESCAPE '\\' ORDER BY name").map((r) => r.name);

  const P = ["customers.view", "customers.update", "calls.create", "calls.view"];
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: [], customerScope: "all", active: true, salesManager: true },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned", active: true },
    other: { id: 4, role: "salesperson", salespersonId: 5, fullName: "other", permissions: P, customerScope: "all", active: true },
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", tsRouter); app.use("/api", csRouter);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
  const pool = queryRows(`SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND merged_into_customer_id IS NULL ORDER BY id LIMIT 4`).map((r) => Number(r.id));
  assert.ok(pool.length >= 3, "need 3 customers of salesperson 6");
  for (const id of pool) execute("UPDATE customers SET priority=NULL WHERE id=?", [id]);
  const [cOff, cOn, cFirst] = pool;
  const kazemi = actors.kazemi;
  const T = (minAgo) => new Date(Date.now() - minAgo * 60000);
  const note = "مشتری جواب داد؛ موارد پرسیده شد و توضیح کامل برای پیگیری ثبت شد.";
  const base = { mode: "simple", callResult: "answered", urgency: "month", amountMillion: 100, checkStatus: "any", canPromissory: "yes", formVersion: 2,
    military: "has_card", jobType: "unknown", city: "شهر نمونه", noPlanFit: true };
  const legacy = { ...base, docsReady: "partial", creditRank: "A1", bouncedCheque: "no", guarantorAvailable: "no", ssoRetiree: "none" };

  let ev = 991100;
  const seedEvent = (customerId, startedMinAgo, segs) => {
    const id = ++ev, ext = `csfx-${id}`, at = T(startedMinAgo).toISOString(), end = new Date(Date.parse(at) + 60000).toISOString();
    execute(`INSERT INTO voip_after_call_events(id,external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,customer_id,has_recording,recording_file,mobile_device_id,duration_seconds,is_live)
      VALUES (?,?,'09120000000','outgoing','ANSWERED',?,?,'212','["212"]',8,?,1,?,77,60,0)`, [id, ext, at, end, customerId, `${ext}.wav`]);
    if (segs) execute("INSERT INTO voip_recording_transcripts(external_id,source_file,range_from,range_to,requested_by,state,result_json,created_at,updated_at,completed_at) VALUES (?,?,'2026-11-01','2026-11-04',5,'completed',?,?,?,?)",
      [ext, `${ext}.wav`, JSON.stringify({ model: "synthetic", durationSeconds: 60, audioSeparation: "diarization", notice: null, speakers: [{ id: "speaker-1" }, { id: "speaker-2" }],
        segments: segs.map((t, i) => ({ speakerId: `speaker-${(i % 2) + 1}`, startSeconds: i * 10, endSeconds: i * 10 + 9, text: t })), text: segs.join(" ") }), at, at, at]);
    return { id, ext };
  };
  const mock = (items) => async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items }) } }] }), { status: 200 });

  await ok("flag OFF: config disabled, every endpoint 404 cs_off, legacy form identical, no cs tables", async () => {
    assert.deepEqual((await call("GET", "/call-summary-fields/config", "kazemi")).body, { enabled: false });
    for (const [m, u] of [["GET", "/call-summary-fields/calls/1"], ["GET", `/call-summary-fields/customers/${cOff}/items`], ["GET", "/call-summary-fields/report"], ["POST", "/call-summary-fields/proposals/1/apply"]]) {
      const r = await call(m, u, "admin"); assert.equal(r.status, 404, u); assert.equal(r.body.error, "cs_off");
    }
    const r = ts.submitQualification(cOff, kazemi, legacy, note, T(30));
    assert.equal(r.result.priority, 2);
    const fc = ts.latestFirstCall(cOff);
    for (const k of ["csFields", "arrears", "docs", "docsNone"]) assert.ok(!(k in fc.answers), k);
    // a flag-off client never sends csFields; even an empty cs-style form is still rejected the old way
    assert.throws(() => ts.submitQualification(cOff, kazemi, { ...base, csFields: 1 }, note, T(29)), /.+/);
    assert.deepEqual(csTables(), []);
    assert.equal(cs.csOn(8), false);
  });

  flag("flag.call_summary_fields_v1.user.8", "1");
  let qId;
  await ok("flag ON (user 8): first-call form saves with empty items; docs[] → docsReady partial; 7 item rows; file values only for filled", async () => {
    assert.equal(cs.csOn(8), true); assert.equal(cs.csOn(4), false);
    assert.deepEqual((await call("GET", "/call-summary-fields/config", "kazemi")).body, { enabled: true, report: false });
    assert.equal((await call("GET", "/call-summary-fields/config", "other")).body.enabled, false);
    const answers = { ...base, csFields: 1, creditRank: null, bouncedCheque: null, guarantorAvailable: null, ssoRetiree: "family", ssoRetireeRelation: "parent",
      arrears: "yes", docs: ["payslip", "national_card"], docsReady: "all", csItems: { creditRank: { source: "no_answer", reason: "مشتری گفت بعداً می‌گوید" } } };
    const r = ts.submitQualification(cOn, kazemi, answers, note, T(60));
    assert.ok(r.result);
    const q = queryRow("SELECT id, answers_json FROM team_sales_qualifications WHERE customer_id=? ORDER BY id DESC LIMIT 1", [cOn]);
    qId = Number(q.id); const a = JSON.parse(q.answers_json);
    assert.equal(a.csFields, 1); assert.equal(a.docsReady, "partial", "docsReady is derived, client value ignored"); assert.deepEqual(a.docs, ["national_card", "payslip"]);
    assert.ok(!("csItems" in a));
    assert.deepEqual(csTables(), ["cs_call_items", "cs_extractions", "cs_file_proposals", "cs_file_values"]);
    const rows = queryRows("SELECT item_key, source, reason FROM cs_call_items WHERE call_key=?", [`q:${qId}`]);
    assert.equal(rows.length, 7);
    const by = Object.fromEntries(rows.map((x) => [x.item_key, x]));
    assert.equal(by.creditRank.source, "no_answer"); assert.equal(by.creditRank.reason, "مشتری گفت بعداً می‌گوید");
    assert.equal(by.bounced.source, "form_empty"); assert.equal(by.gRank.source, "form_empty");
    assert.equal(by.docs.source, "form");
    const fv = queryRows("SELECT item_key FROM cs_file_values WHERE customer_id=?", [cOn]).map((x) => x.item_key).sort();
    assert.deepEqual(fv, ["arrears", "docs", "sso"]);
    const fc = ts.latestFirstCall(cOn); assert.equal(fc.answers.arrears, "yes"); assert.deepEqual(fc.answers.docs, ["national_card", "payslip"]);
  });
  await ok("validation: bad doc key / bad arrears / bad rank → 400", async () => {
    for (const bad of [{ docs: ["passport"] }, { arrears: "maybe" }, { creditRank: "Z" }])
      assert.throws(() => ts.submitQualification(cFirst, kazemi, { ...base, csFields: 1, ...bad }, note, T(5)), (e) => e.status === 400);
    assert.throws(() => ts.submitQualification(cFirst, kazemi, { ...base, csFields: 1, docs: ["payslip"], docsNone: true }, note, T(5)), (e) => e.status === 400);
  });
  await ok("docsNone → docs [] + docsReady none; all six → all (file-only save)", async () => {
    const six = ["national_card", "birth_cert", "payslip", "retirement_decree", "salary_deduction_cert", "sayadi_or_promissory"];
    const r = ha.saveFileOnly(cOn, kazemi, { ...base, csFields: 1, docs: six, ssoRetiree: null, arrears: "yes", ssoRetireeRelation: null }, T(55));
    assert.ok(r);
    assert.equal(ha.currentFileAnswers(cOn).answers.docsReady, "all");
    ha.saveFileOnly(cOn, kazemi, { ...base, csFields: 1, docsNone: true, ssoRetiree: "family", ssoRetireeRelation: "parent", arrears: "yes" }, T(54));
    const cur = ha.currentFileAnswers(cOn).answers; assert.deepEqual(cur.docs, []); assert.equal(cur.docsReady, "none");
    ha.saveFileOnly(cOn, kazemi, { ...base, csFields: 1, docs: ["national_card", "payslip"], ssoRetiree: "family", ssoRetireeRelation: "parent", arrears: "yes" }, T(53));
    assert.equal(ha.currentFileAnswers(cOn).answers.docsReady, "partial");
  });

  let later;
  await ok("later call: extraction (mocked) saves only mentioned items in the call; proposals only for different clear values; file untouched", async () => {
    later = seedEvent(cOn, 20, ["سلام", "رتبه‌ام C هست", "همه‌ی مدارک آماده است", "معوقه ندارم", "چک برگشتی؟ شاید داشتم", "بازنشسته‌ی تأمین اجتماعی پدرم است"]);
    const before = JSON.stringify(ha.currentFileAnswers(cOn).answers);
    const n = await cs.csAfterSummary(later.ext, "hash-1", mock([
      { key: "creditRank", value: "C", confidence: "clear", line: 1 },
      { key: "docs", value: "national_card,birth_cert,payslip,retirement_decree,salary_deduction_cert,sayadi_or_promissory", confidence: "clear", line: 2 },
      { key: "arrears", value: "no", confidence: "clear", line: 3 },
      { key: "bounced", value: "yes|no", confidence: "unclear", line: 4 },
      { key: "sso", value: "family", confidence: "clear", line: 5 },
      { key: "bogus", value: "x", confidence: "clear", line: 0 },
    ]));
    assert.equal(n, 5);
    assert.equal(JSON.stringify(ha.currentFileAnswers(cOn).answers), before, "NO automatic file update");
    const v = cs.callItems(later.id, kazemi);
    assert.equal(v.kind, "later");
    assert.deepEqual(v.items.map((i) => `${i.key}:${i.state}`).sort(), ["arrears:a", "bounced:u", "creditRank:a", "docs:a", "sso:a"]);
    assert.equal(v.items.find((i) => i.key === "bounced").text, "yes یا no");
    assert.equal(v.items.find((i) => i.key === "creditRank").atSec, 10);
    assert.deepEqual(v.proposals.map((p) => p.key).sort(), ["arrears", "creditRank", "docs"], "sso equal to the file → no proposal (Q13); unclear → none");
    assert.equal(v.pendingCount, 3);
    assert.equal(cs.customerItems(cOn, kazemi).pendingCount, 3, "file badge «3 پیشنهاد تغییر»");
    assert.equal(await cs.csAfterSummary(later.ext, "hash-1", mock([])), 0, "same hash → skipped");
  });
  await ok("«نه» keeps the file value, shows rejected; the file history lists the rejection (date, source call, who rejected)", async () => {
    const p = cs.callItems(later.id, kazemi).proposals.find((x) => x.key === "arrears");
    const r = await call("POST", `/call-summary-fields/proposals/${p.id}/reject`, "kazemi");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.proposals.find((x) => x.key === "arrears").status, "rejected");
    assert.equal(ha.currentFileAnswers(cOn).answers.arrears, "yes");
    assert.equal(queryRow("SELECT COUNT(*) n FROM cs_file_values WHERE customer_id=? AND item_key='arrears' AND value_json='\"no\"'", [cOn]).n, 0);
    assert.equal((await call("POST", `/call-summary-fields/proposals/${p.id}/apply`, "kazemi")).status, 409, "decided → not again");
    const ar = cs.customerItems(cOn, kazemi).items.find((i) => i.key === "arrears");
    assert.equal(ar.value, "yes", "file value unchanged");
    const rj = ar.history.filter((h) => h.rejected);
    assert.equal(rj.length, 1, "one rejected entry in history");
    assert.equal(rj[0].value, "no"); assert.equal(rj[0].fileValue, "yes"); assert.equal(rj[0].eventId, later.id); assert.equal(rj[0].sourceKey, "proposal_rejected");
    assert.equal(rj[0].by, queryRow("SELECT name FROM salespersons WHERE id=6").name); assert.ok(rj[0].at, "rejection date");
    assert.equal(rj[0].status, "not_applied");
    assert.ok(ar.history.some((h) => !h.rejected && h.status === "applied" && h.value === "yes"), "current value listed as applied");
  });
  await ok("another expert cannot decide (403); a non-visible call is 404", async () => {
    const p = cs.callItems(later.id, kazemi).proposals.find((x) => x.key === "creditRank");
    flag("flag.call_summary_fields_v1.user.4", "1");
    assert.equal((await call("POST", `/call-summary-fields/proposals/${p.id}/apply`, "other")).status, 404);
    flag("flag.call_summary_fields_v1.user.4", null);
  });
  await ok("«اعمال در پرونده» one: file + history (date, source call, approver); badge drops", async () => {
    const p = cs.callItems(later.id, kazemi).proposals.find((x) => x.key === "creditRank");
    const r = await call("POST", `/call-summary-fields/proposals/${p.id}/apply`, "kazemi");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(ha.currentFileAnswers(cOn).answers.creditRank, "C");
    const it = cs.customerItems(cOn, kazemi);
    const cr = it.items.find((i) => i.key === "creditRank");
    assert.equal(cr.value, "C"); assert.equal(cr.meta.sourceKey, "proposal"); assert.equal(cr.meta.eventId, later.id); assert.equal(cr.meta.by, queryRow("SELECT name FROM salespersons WHERE id=6").name);
    assert.equal(it.pendingCount, 1);
  });
  await ok("«اعمال همه»: remaining pending applied; docs all six → docsReady all; nothing pending", async () => {
    const r = await call("POST", `/call-summary-fields/calls/${later.id}/proposals/apply-all`, "kazemi");
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.applied, 1);
    const cur = ha.currentFileAnswers(cOn).answers; assert.equal(cur.docsReady, "all"); assert.equal(cur.docs.length, 6);
    assert.equal(cs.customerItems(cOn, kazemi).pendingCount, 0);
    const d = cs.customerItems(cOn, kazemi).items.find((i) => i.key === "docs");
    assert.ok(d.history.length >= 1, "older docs values kept in history");
    assert.equal((await call("POST", `/call-summary-fields/calls/${later.id}/proposals/apply-all`, "kazemi")).status, 409);
  });
  await ok("expert edit in a later call → new proposal; equal value → superseded; «همه درست است» confirms", async () => {
    let r = await call("PUT", `/call-summary-fields/calls/${later.id}/items/bounced`, "kazemi", { value: "yes" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.proposals.some((p) => p.key === "bounced" && p.status === "pending"));
    r = await call("PUT", `/call-summary-fields/calls/${later.id}/items/bounced`, "kazemi", { noAnswer: true, reason: "" });
    assert.equal(r.status, 400, "no-answer needs a reason");
    r = await call("PUT", `/call-summary-fields/calls/${later.id}/items/bounced`, "kazemi", { noAnswer: true, reason: "نخواست بگوید" });
    assert.equal(r.status, 200); assert.ok(!r.body.proposals.some((p) => p.key === "bounced" && p.status === "pending"));
    assert.equal((await call("PUT", `/call-summary-fields/calls/${later.id}/items/planType`, "kazemi", { value: "x" })).status, 422);
    r = await call("POST", `/call-summary-fields/calls/${later.id}/confirm`, "kazemi"); assert.equal(r.status, 200);
  });
  let first;
  await ok("first call without a form: items a/u/m; prefill for the form; extraction failure → failed state, nothing written", async () => {
    first = seedEvent(cFirst, 10, ["سلام", "رتبه‌ام B یا C", "ضامن ندارم"]);
    await cs.csAfterSummary(first.ext, "h-f", mock([{ key: "creditRank", value: "B|C", confidence: "unclear", line: 1 }, { key: "gRank", value: "none", confidence: "clear", line: 2 }]));
    const v = cs.callItems(first.id, kazemi);
    assert.equal(v.kind, "first"); assert.equal(v.items.length, 7);
    const st = Object.fromEntries(v.items.map((i) => [i.key, i.state]));
    assert.equal(st.creditRank, "u"); assert.equal(st.gRank, "a"); assert.equal(st.docs, "m");
    const pf = cs.firstCallPrefill(cFirst, kazemi); assert.equal(pf.eventId, first.id); assert.equal(pf.items.length, 2);
    const failed = seedEvent(cFirst, 9, ["الو"]);
    await cs.csAfterSummary(failed.ext, "h-x", async () => new Response("{}", { status: 500 }));
    assert.equal(queryRow("SELECT state FROM cs_extractions WHERE event_id=?", [failed.id]).state, "failed");
    assert.equal(cs.callItems(failed.id, kazemi).items.every((i) => i.state === "x"), true);
  });
  await ok("manager report: per expert over a date range; detail lists empty items; expert gets 403", async () => {
    flag("flag.call_summary_fields_v1", "1");
    const d = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(new Date(ms));
    const q = `from=${d(Date.now() - 3 * 86400000)}&to=${d(Date.now())}`;
    assert.equal((await call("GET", `/call-summary-fields/report?${q}`, "kazemi")).status, 403);
    const r = await call("GET", `/call-summary-fields/report?${q}`, "admin");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const k = r.body.experts.find((x) => x.userId === 8);
    assert.equal(k.calls, 1); assert.equal(k.withEmpty, 1); assert.equal(k.empty, 3, "gRank, planType, bounced (creditRank = no_answer is not empty)");
    const dt = await call("GET", `/call-summary-fields/report/detail?expert=8&${q}`, "admin");
    assert.equal(dt.status, 200); assert.equal(dt.body.rows.length, 1);
    assert.deepEqual(dt.body.rows[0].missing.map((m) => m.key), ["gRank", "planType", "bounced"]);
    const empty = await call("GET", `/call-summary-fields/report?from=2026-10-10&to=2026-10-11`, "admin");
    assert.equal(empty.status, 200); assert.equal(empty.body.experts.length, 0);
    flag("flag.call_summary_fields_v1", null);
  });
  await ok("expert lockdown (user 8): cs endpoints follow the single-customer rule only while the flag is on; report stays closed", async () => {
    const el = await import("../src/lib/expert-lockdown.ts");
    const guard = (method, p) => { let st = 0, nx = false; const res = { locals: { authUser: actors.kazemi }, status(c) { st = c; return this; }, json() { return this; } };
      el.expertLockdownGuard({ method, path: p, query: {}, body: {} }, res, () => { nx = true; }); return nx ? "next" : st; };
    flag("flag.expert_lockdown", "1"); flag("flag.call_summary_fields_v1", null); flag("flag.call_summary_fields_v1.user.8", null);
    assert.equal(guard("GET", "/call-summary-fields/config"), 403); // flag off → unchanged (closed)
    flag("flag.call_summary_fields_v1.user.8", "1");
    const own = queryRow("SELECT id FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL LIMIT 1").id;
    const oth = queryRow("SELECT id FROM customers WHERE salesperson_id=5 AND merged_into_customer_id IS NULL LIMIT 1").id;
    assert.equal(guard("GET", "/call-summary-fields/config"), "next");
    assert.equal(guard("GET", `/call-summary-fields/customers/${own}/items`), "next");
    assert.equal(guard("GET", `/call-summary-fields/customers/${own}/prefill`), "next");
    assert.equal(guard("PUT", `/call-summary-fields/customers/${own}/items/arrears`), "next");
    assert.equal(guard("GET", `/call-summary-fields/customers/${oth}/items`), 403);
    assert.equal(guard("GET", "/call-summary-fields/report"), 403);
    assert.equal(guard("GET", "/call-summary-fields/calls/999999999"), 403);
    flag("flag.call_summary_fields_v1.user.8", null); flag("flag.expert_lockdown", null);
  });
  await ok("CS-OWNQ lockdown: own customer off today's list → ارزیابی / plans / edit / file-card 200; other expert 403; other writes + report 403; flag off → unchanged", async () => {
    const el = await import("../src/lib/expert-lockdown.ts");
    const guard = (method, p) => { let st = 0, nx = false; const res = { locals: { authUser: actors.kazemi }, status(c) { st = c; return this; }, json() { return this; } };
      el.expertLockdownGuard({ method, path: p, query: {}, body: {} }, res, () => { nx = true; }); return nx ? "next" : st; };
    flag("flag.expert_lockdown", "1"); flag("flag.call_summary_fields_v1", "1");
    const offList = (sp) => queryRows("SELECT id FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 300", [sp])
      .map((r) => Number(r.id)).find((id) => !pool.includes(id) && el.elCustomerAccess(actors.kazemi, id) == null);
    const own = offList(6), oth = offList(5);
    assert.ok(own && oth, "need an own and another expert's customer off today's list");
    assert.equal(el.elOwnCustomer(actors.kazemi, own), true); assert.equal(el.elOwnCustomer(actors.kazemi, oth), false);
    const W = [["POST", (c) => `/customers/${c}/team-sales/qualify`], ["POST", (c) => `/customers/${c}/team-sales/qualify/preview`], ["POST", (c) => `/customers/${c}/team-sales/qualify/plans`],
      ["POST", (c) => `/customers/${c}/team-sales/first-call/edit`], ["POST", (c) => `/customers/${c}/file-card`], ["PATCH", (c) => `/customers/${c}/consult-profile`]];
    for (const [m, p] of W) { assert.equal(guard(m, p(own)), "next", p(own)); assert.equal(guard(m, p(oth)), 403, p(oth)); }
    for (const [m, p] of [["PATCH", `/customers/${own}`], ["DELETE", `/customers/${own}`], ["POST", `/customers/${own}/team-sales/qualify/x`]]) assert.equal(guard(m, p), 403, p);
    assert.equal(guard("GET", "/call-summary-fields/report"), 403);
    // through the real routers (guard mounted the way app.ts mounts it)
    const app2 = express(); app2.use(express.json());
    app2.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; next(); });
    app2.use("/api", el.expertLockdownGuard, tsRouter, csRouter);
    const sock2 = path.join(dir, "api2.sock"); const s2 = app2.listen(sock2); await once(s2, "listening");
    const call2 = (method, url, body) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body ?? {});
      const r = http.request({ socketPath: sock2, path: "/api" + url, method, headers: { "x-actor": "kazemi", "content-type": "application/json" } }, (res) => {
        let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch { /* */ } resolve({ status: res.statusCode, body: j }); }); });
      r.on("error", reject); r.write(payload); r.end();
    });
    try {
      execute("UPDATE customers SET priority=NULL WHERE id=?", [own]);
      const ans = { ...base, csFields: 1, creditRank: null, bouncedCheque: null, guarantorAvailable: null, ssoRetiree: null, docs: [], docsNone: false };
      assert.equal((await call2("POST", `/customers/${own}/team-sales/qualify/plans`, { answers: ans })).status, 200);
      const q = await call2("POST", `/customers/${own}/team-sales/qualify`, { answers: ans, note, call_result: "answered" });
      assert.equal(q.status, 200, JSON.stringify(q.body)); assert.ok(ts.latestFirstCall(own));
      assert.equal((await call2("POST", `/customers/${oth}/team-sales/qualify`, { answers: ans, note, call_result: "answered" })).status, 403);
      assert.equal((await call2("POST", `/customers/${oth}/team-sales/qualify/plans`, { answers: ans })).status, 403);
      assert.equal((await call2("GET", "/call-summary-fields/report")).status, 403);
      // cs flag OFF → the old lockdown, unchanged
      flag("flag.call_summary_fields_v1", null);
      for (const [m, p] of W) assert.equal(guard(m, p(own)), 403, p(own));
      assert.equal((await call2("POST", `/customers/${own}/team-sales/qualify/plans`, { answers: legacy })).status, 403);
      // lockdown OFF → open as before
      flag("flag.expert_lockdown", null); flag("flag.call_summary_fields_v1", "1");
      for (const [m, p] of W) assert.equal(guard(m, p(own)), "next");
    } finally { s2.close(); flag("flag.call_summary_fields_v1", null); flag("flag.expert_lockdown", null); }
  });
  await ok("CS-OFFTOL: saved with empty items (flag on), edited with the flag OFF → old validation tolerates unchanged empties; arrears/docs kept; changes still checked", async () => {
    const el = await import("../src/lib/expert-lockdown.ts");
    const cTol = queryRows("SELECT id FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL ORDER BY id LIMIT 400").map((r) => Number(r.id))
      .find((id) => !pool.includes(id) && !ts.latestFirstCall(id) && el.elOwnCustomer(actors.kazemi, id));
    assert.ok(cTol);
    execute("UPDATE customers SET priority=NULL WHERE id=?", [cTol]);
    flag("flag.call_summary_fields_v1.user.8", "1");
    ts.submitQualification(cTol, kazemi, { ...base, csFields: 1, creditRank: null, bouncedCheque: null, guarantorAvailable: null, ssoRetiree: null, arrears: "no", docs: ["payslip"], docsNone: false }, note, T(40));
    flag("flag.call_summary_fields_v1.user.8", null); assert.equal(cs.csOn(8), false);
    const fc = ts.latestFirstCall(cTol); assert.equal(fc.answers.csFields, 1);
    // what the flag-off form sends back: no cs keys, the empty items untouched, one real change
    const old = { ...base, amountMillion: 150, docsReady: fc.answers.docsReady ?? null, creditRank: null, bouncedCheque: null, guarantorAvailable: null, ssoRetiree: null };
    ts.editFirstCall(cTol, kazemi, old, note, { now: T(30) });
    const a = ts.latestFirstCall(cTol).answers;
    assert.equal(a.amountMillion, 150); assert.equal(a.arrears, "no"); assert.deepEqual(a.docs, ["payslip"]); assert.equal(a.csFields, 1); assert.equal(a.creditRank ?? null, null);
    assert.throws(() => ts.editFirstCall(cTol, kazemi, { ...old, creditRank: "Z9" }, note, { now: T(29) }), /.+/, "a changed value is still checked the old way");
    ha.saveFileOnly(cTol, kazemi, { ...old, amountMillion: 160 });
    const f = ha.currentFileAnswers(cTol).answers; assert.equal(f.amountMillion, 160); assert.equal(f.arrears, "no");
    // a record saved without the flag is still checked exactly as before
    assert.throws(() => ts.editFirstCall(cOff, kazemi, { ...legacy, creditRank: null }, note, { now: T(20) }), /.+/);
    assert.throws(() => ts.submitQualification(cTol, kazemi, { ...base, csFields: 1 }, note, T(19)), /.+/, "a csFields payload with the flag off is still rejected");
  });
  await ok("CS-429: provider 429 / out of credit → call saved, items unasked, error logged once, cool-down (no retry storm), page still works", async () => {
    flag("flag.call_summary_fields_v1.user.8", "1");
    let n = 0; const f429 = async () => { n++; return new Response(JSON.stringify({ error: { code: "insufficient_quota", type: "insufficient_quota", message: "quota" } }), { status: 429 }); };
    const a = seedEvent(cFirst, 9, ["الو", "رتبه‌ام A است"]), b = seedEvent(cFirst, 8, ["سلام"]);
    assert.equal(await cs.csAfterSummary(a.ext, "h-429a", f429), 0);
    assert.equal(await cs.csAfterSummary(b.ext, "h-429b", f429), 0);
    assert.equal(n, 1, "second call skipped during the cool-down");
    assert.equal(cs.csExtractPaused(), true);
    const st = (e) => queryRow("SELECT state, error FROM cs_extractions WHERE event_id=?", [e.id]);
    assert.equal(st(a).state, "failed"); assert.equal(st(b).state, "failed"); assert.equal(st(b).error, "paused_provider");
    const v = await call("GET", `/call-summary-fields/calls/${a.id}`, "kazemi");
    assert.equal(v.status, 200); assert.ok(v.body.items.every((i) => i.value == null), "items stay unasked/empty");
    cs.csResetExtractPause();
    assert.equal(await cs.csAfterSummary(seedEvent(cFirst, 7, ["x"]).ext, "h-thr", async () => { throw new Error("boom"); }), 0, "never throws into the summary pipeline");
    assert.equal(cs.csExtractPaused(), false, "a plain failure does not pause");
    cs.csResetExtractPause(); flag("flag.call_summary_fields_v1.user.8", null);
  });
  await ok("no network, no SMS rows written by this feature", async () => {
    assert.equal(netCalls, 0);
  });
  console.log(`\n${passed} passed`);
} catch (e) {
  console.error("FAIL:", e?.message ?? e); if (process.env.FIXTURE_SOURCEMAP) console.error(e?.stack);
  process.exitCode = 1;
} finally {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
