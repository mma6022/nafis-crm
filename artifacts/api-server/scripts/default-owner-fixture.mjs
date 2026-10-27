// crm-default-owner fixture: «قانون ثبت» (every new customer → default owner 6, registered_by = real registrar) on every
// create path, its settings/validation, the «ثبت‌شده‌ها بر اساس ثبت‌کننده» report (counts only, user 29 excluded), and the
// one-time sp22 → sp6 transfer script (dry-run / apply / undo) on a throwaway copy.
// Runs on copies of a (masked) DB; HTTP over a unix socket in the temp dir; ALL outbound fetch stubbed (never sent).
// Usage: DEFAULT_OWNER_FIXTURE_DB=/path/copy.db [DEFAULT_OWNER_TRANSFER=/path/transfer22.py DEFAULT_OWNER_RULE_ON=/path/rule_on.py] \
//        node scripts/run-bundled-fixture.mjs scripts/default-owner-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

const outbound = [];
globalThis.fetch = async (input) => { outbound.push(String(input).replace(/\?.*$/, "").slice(0, 60)); return new Response("{}", { status: 503 }); };
let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const src = process.env.DEFAULT_OWNER_FIXTURE_DB;
if (!src) { console.log("SKIP (set DEFAULT_OWNER_FIXTURE_DB to a DB copy)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "defowner-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE/i.test(k)) delete process.env[k];
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const rule = await import("../src/lib/default-owner-rule.ts");
  const rep = await import("../src/lib/registered-by-report.ts");
  const pl = await import("../src/lib/public-leads.ts");
  const cb = await import("../src/lib/callback-requests.ts");
  const portal = await import("../src/lib/customer-portal-features.ts");
  const cc = await import("../src/lib/customer-create.ts");
  const { queryRow, queryRows, execute, crmDb } = db;
  const express = (await import("express")).default;
  const crmRouter = (await import("../src/routes/crm.ts")).default;
  const doRouter = (await import("../src/routes/default-owner.ts")).default;
  execute("UPDATE notification_settings SET value='' WHERE key='ippanelRelayUrl'");

  const uid = (sp) => Number(queryRow("SELECT id FROM users WHERE salesperson_id=? ORDER BY id LIMIT 1", [sp]).id);
  const P = ["customers.view", "customers.create", "customers.update", "calls.view", "calls.create", "callbacks.view", "callbacks.manage"];
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: [], customerScope: "all" },
    u29: { id: 29, role: "admin", salespersonId: null, fullName: "x", permissions: [], customerScope: "all" },
    hasani: { id: uid(3), role: "salesperson", salespersonId: 3, fullName: "h", permissions: P, customerScope: "assigned" },
    trainee: { id: uid(5), role: "salesperson", salespersonId: 5, fullName: "t", permissions: P, customerScope: "assigned" },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "k", permissions: P, customerScope: "assigned" },
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } req.log = { warn() {}, info() {}, error() {} }; next(); });
  app.use("/api", doRouter); app.use("/api", crmRouter);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* */ } resolve({ status: res.statusCode, body: j, raw: s, moved: res.headers["x-nafis-customer-transferred"] ?? null }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
  let seq = 0;
  const phone = () => `0999${String(Date.now() % 1000).padStart(3, "0")}${String(++seq).padStart(4, "0")}`;
  const cust = (id) => queryRow("SELECT salesperson_id sp, registered_by rb, registration_source src, source ch FROM customers WHERE id=?", [id]);
  const ruleHist = (id) => queryRows("SELECT * FROM customer_priority_history WHERE customer_id=? AND source='default_owner_rule'", [id]);
  const cursor = () => JSON.stringify(queryRows("SELECT id, cursor_item_index, cursor_item_used FROM allocation_programs ORDER BY id"));
  const ON = { enabled: true, ownerSalespersonId: 6, registrarMode: "all", registrarUserIds: [], sourceMode: "all", sources: [] };
  const maxIdBefore = Number(queryRow("SELECT MAX(id) m FROM customers").m);
  const protectedHash = () => crypto.createHash("sha256").update(JSON.stringify([
    queryRows("SELECT key, value FROM notification_settings WHERE key IN ('team_sales_config') ORDER BY key"),
    queryRows("SELECT id, salesperson_id FROM customers WHERE salesperson_id IN (5,19,20) AND id<=? ORDER BY id", [maxIdBefore]),
    queryRows("SELECT id, role, active, salesperson_id FROM users WHERE id=29"),
    queryRow("SELECT 1 x FROM sqlite_master WHERE name='contract_generations'") ? queryRows("SELECT * FROM contract_generations ORDER BY rowid") : null,
  ])).digest("hex");
  const protBefore = protectedHash();
  const existingHash = () => crypto.createHash("sha256").update(JSON.stringify(queryRows("SELECT id, salesperson_id, registered_by, registration_source FROM customers WHERE id<=? ORDER BY id", [maxIdBefore]))).digest("hex");
  const existingBefore = existingHash();

  await ok("schema: customers.registered_by + registration_source; settings tables; default config OFF", () => {
    const cols = queryRows("PRAGMA table_info(customers)").map((c) => c.name);
    assert.ok(cols.includes("registered_by") && cols.includes("registration_source"));
    assert.ok(queryRow("SELECT 1 x FROM sqlite_master WHERE name='default_owner_rule_settings_log'"));
    const c = rule.getDefaultOwnerConfig(); assert.equal(c.enabled, false); assert.equal(c.ownerSalespersonId, 6); assert.equal(c.registrarMode, "all"); assert.equal(c.sourceMode, "all");
  });

  await ok("OFF: trainee's staff-form customer stays with the trainee; registrar + source still stored; no rule history", async () => {
    const r = await call("POST", "/customers", "trainee", { name: "مشتری نمونه یک", phone: phone(), status: "in_progress" });
    assert.equal(r.status, 201, r.raw); const c = cust(r.body.id);
    assert.equal(Number(c.sp), 5); assert.equal(Number(c.rb), actors.trainee.id); assert.equal(c.src, "staff_form"); assert.equal(ruleHist(r.body.id).length, 0); assert.equal(r.moved, null);
    const x = queryRow("SELECT source, credit_grade FROM customers WHERE id=?", [r.body.id]); assert.equal(x.source, "staff"); assert.equal(x.credit_grade, null);
  });

  await ok("settings API: admin only (user 29 and experts 403); validation (inactive owner, empty selections, bad body)", async () => {
    assert.equal((await call("GET", "/admin/default-owner-rule", "u29")).status, 403);
    assert.equal((await call("GET", "/admin/default-owner-rule", "hasani")).status, 403);
    assert.equal((await call("PUT", "/admin/default-owner-rule", "hasani", ON)).status, 403);
    const g = await call("GET", "/admin/default-owner-rule", "admin"); assert.equal(g.status, 200);
    assert.ok(g.body.options.salespersons.some((s) => s.id === 6)); assert.ok(!g.body.options.registrars.some((u) => u.id === 29));
    assert.ok(g.body.options.sources.some((s) => s.key === "portal"));
    assert.equal((await call("PUT", "/admin/default-owner-rule", "admin", { ...ON, ownerSalespersonId: 99999 })).status, 400);
    assert.equal((await call("PUT", "/admin/default-owner-rule", "admin", { ...ON, registrarMode: "selected", registrarUserIds: [] })).status, 400);
    assert.equal((await call("PUT", "/admin/default-owner-rule", "admin", { ...ON, sourceMode: "selected", sources: ["nope"] })).status, 400);
    assert.equal((await call("PUT", "/admin/default-owner-rule", "admin", { ownerSalespersonId: 6 })).status, 400);
    execute("UPDATE salespersons SET active=0 WHERE id=20");
    assert.equal((await call("PUT", "/admin/default-owner-rule", "admin", { ...ON, ownerSalespersonId: 20 })).status, 400);
    execute("UPDATE salespersons SET active=1 WHERE id=20");
    const p = await call("PUT", "/admin/default-owner-rule", "admin", ON); assert.equal(p.status, 200); assert.equal(p.body.settings.enabled, true);
    const log = queryRows("SELECT * FROM default_owner_rule_settings_log ORDER BY id"); assert.equal(log.length, 1); assert.equal(Number(log[0].actor_user_id), 1);
  });

  await ok("ON, staff form: trainee / closer / Kazemi / admin(explicit 3) → owner 6, one history row (old NULL → 6, actor = registrar), cursor untouched", async () => {
    for (const [who, extra, header] of [["trainee", {}, true], ["hasani", {}, true], ["kazemi", {}, false], ["admin", { salespersonId: 3 }, true], ["admin", {}, false]]) {
      const before = cursor();
      const r = await call("POST", "/customers", who, { name: `مشتری نمونه ${who}`, phone: phone(), status: "in_progress", ...extra });
      assert.equal(r.status, 201, `${who}: ${r.raw}`); assert.equal(Number(r.body.salespersonId), 6, who);
      const c = cust(r.body.id); assert.equal(Number(c.sp), 6); assert.equal(Number(c.rb), actors[who].id); assert.equal(c.src, "staff_form");
      const h = ruleHist(r.body.id); assert.equal(h.length, 1);
      assert.deepEqual([h[0].old_salesperson_id, Number(h[0].new_salesperson_id), Number(h[0].actor_user_id)], [null, 6, actors[who].id]);
      assert.match(h[0].reason, /^قانون ثبت: مالک پیش‌فرض — /);
      assert.equal(r.moved == null ? false : true, header, `${who} header`);
      assert.equal(cursor(), before, "allocation cursor not consumed");
      assert.equal(Number(queryRow("SELECT count(*) n FROM customer_priority_history WHERE customer_id=? AND source<>'default_owner_rule'", [r.body.id]).n), 0, "no nonP1 row on top");
    }
  });
  await ok("ON, P2 by a closer: rule wins, no extra nonP1 transfer row", async () => {
    const r = await call("POST", "/customers", "hasani", { name: "مشتری نمونه پ۲", phone: phone(), status: "in_progress", priority: 2 });
    assert.equal(r.status, 201, r.raw); assert.equal(Number(cust(r.body.id).sp), 6);
    assert.equal(queryRows("SELECT * FROM customer_priority_history WHERE customer_id=?", [r.body.id]).length, 1);
  });

  await ok("ON, site form / callback convert / portal / Instagram auto+manual: owner 6, registrar = real (null for system), source per channel", async () => {
    const before = cursor();
    const lead = pl.recordPublicLead({ name: "سرنخ نمونه", phone: phone(), need: pl.NEEDS[0], amountBand: pl.AMOUNT_BANDS[0], planId: null, term: null, contactTime: pl.CONTACT_TIMES[0], src: null, utm: {} }, "x".repeat(64));
    let c = cust(lead.customerId); assert.equal(Number(c.sp), 6); assert.equal(c.rb, null); assert.equal(c.src, "site_lead"); assert.equal(c.ch, "form"); assert.equal(ruleHist(lead.customerId).length, 1);
    const cbr = pl.recordPublicCallback({ name: "تماس نمونه", phone: phone(), contactTime: pl.CALLBACK_TIMES[0], need: null, planId: null, src: null, utm: {} }, "y".repeat(64));
    const conv = cb.convertCallback({ id: actors.trainee.id, role: "salesperson", permissions: P, customerScope: "all" }, cbr.id);
    assert.ok(conv.ok, JSON.stringify(conv)); const cid = Number(queryRow("SELECT customer_id FROM callback_requests WHERE id=?", [cbr.id]).customer_id);
    c = cust(cid); assert.equal(Number(c.sp), 6); assert.equal(Number(c.rb), actors.trainee.id); assert.equal(c.src, "site_callback"); assert.equal(c.ch, "site");
    const pid = db.runTransaction(() => { const o = portal.portalNewCustomerOwner();
      const id = execute("INSERT INTO customers(name,phone,verification_status,is_urgent,created_at,salesperson_id,status,registered_by,registration_source) VALUES (?,?,'unverified',0,?,?,'in_progress',NULL,'portal')", ["پرتال نمونه", phone(), new Date().toISOString(), o.salespersonId]);
      portal.portalOwnerLogged(id, o); return id; });
    c = cust(pid); assert.equal(Number(c.sp), 6); assert.equal(c.src, "portal"); assert.equal(ruleHist(pid).length, 1);
    for (const [srcKey, reg] of [["instagram_auto", null], ["instagram", actors.hasani.id]]) {
      const id = db.runTransaction(() => cc.insertCustomerRecord({ name: `اینستا ${srcKey}`, phone: phone(), allocationProgramId: 6, registeredByUserId: reg, registrationSource: srcKey }));
      c = cust(id); assert.equal(Number(c.sp), 6); assert.equal(c.src, srcKey); assert.equal(c.rb == null ? null : Number(c.rb), reg);
    }
    assert.equal(cursor(), before, "allocation cursor not consumed on any channel");
  });

  await ok("customers.source: user 31's staff-form customer defaults to instagram (mapping exception)", () => {
    const id = db.runTransaction(() => cc.insertCustomerRecord({ name: "میلاد نمونه", phone: phone(), registeredByUserId: 31, registrationSource: "staff_form" }));
    assert.equal(cust(id).ch, "instagram"); assert.equal(cust(id).src, "staff_form");
    execute("DELETE FROM customer_priority_history WHERE customer_id=?", [id]); execute("DELETE FROM customers WHERE id=?", [id]);
  });
  await ok("selected registrars / sources: outside the selection → old path (assigned / allocation), null registrar never matches", async () => {
    rule.saveDefaultOwnerConfig({ ...ON, registrarMode: "selected", registrarUserIds: [actors.hasani.id] }, 1);
    let r = await call("POST", "/customers", "trainee", { name: "مشتری نمونه انتخابی", phone: phone(), status: "in_progress" });
    assert.equal(Number(cust(r.body.id).sp), 5); assert.equal(ruleHist(r.body.id).length, 0);
    r = await call("POST", "/customers", "hasani", { name: "مشتری نمونه انتخابی۲", phone: phone(), status: "in_progress" });
    assert.equal(Number(cust(r.body.id).sp), 6);
    assert.deepEqual(rule.defaultOwnerDecision("site_lead", null), { apply: false, skip: "registrar_not_selected" });
    rule.saveDefaultOwnerConfig({ ...ON, sourceMode: "selected", sources: ["site_lead"] }, 1);
    r = await call("POST", "/customers", "trainee", { name: "مشتری نمونه منبع", phone: phone(), status: "in_progress" });
    assert.equal(Number(cust(r.body.id).sp), 5);
    assert.equal(rule.defaultOwnerDecision("site_lead", null).apply, true);
  });
  await ok("owner inactive → rule skipped (lead never lost; old path decides)", () => {
    rule.saveDefaultOwnerConfig(ON, 1);
    execute("UPDATE salespersons SET active=0 WHERE id=6");
    assert.deepEqual(rule.defaultOwnerDecision("staff_form", 1), { apply: false, skip: "owner_inactive" });
    execute("UPDATE salespersons SET active=1 WHERE id=6");
    assert.equal(rule.defaultOwnerDecision("staff_form", 1).apply, true);
  });

  await ok("report «ثبت‌شده‌ها بر اساس ثبت‌کننده»: per registrar + source, user 29 excluded, reached registration / deposit, counts only", async () => {
    const today = new Date(Date.now() + 3.5 * 3600e3).toISOString().slice(0, 10);
    const id29 = execute("INSERT INTO customers(name,phone,verification_status,is_urgent,created_at,salesperson_id,status,registered_by,registration_source) VALUES (?,?,'unverified',0,?,6,'in_progress',29,'staff_form')", ["پنهان نمونه", phone(), new Date().toISOString()]);
    const a = await call("GET", `/admin/registered-by?from=${today}&to=${today}`, "admin"); assert.equal(a.status, 200, a.raw);
    const R = a.body; assert.equal(R.countsOnly, true); assert.ok(!R.registrars.some((x) => x.userId === 29));
    const tr = R.registrars.find((x) => x.userId === actors.trainee.id); assert.ok(tr && tr.registered >= 4, JSON.stringify(tr));
    assert.equal(tr.salespersonId, 5); assert.ok(tr.bySource.some((s) => s.source === "site_callback" && s.count === 1));
    const sys = R.registrars.find((x) => x.userId == null); assert.ok(sys.bySource.some((s) => s.source === "portal"));
    assert.equal(R.totals.registered, R.registrars.reduce((t, x) => t + x.registered, 0));
    for (const k of ["reachedRegistration", "reachedDeposit"]) assert.ok(R.definitions[k]);
    const txt = a.raw; assert.ok(!/0999\d{7}/.test(txt), "no phone"); assert.ok(!txt.includes("مشتری نمونه"), "no customer name"); assert.ok(!/"customerId"|"customerIds"/.test(txt));
    // registration + deposit on one trainee customer (copy only, FK off for the synthetic rows)
    const cid = Number(queryRow("SELECT id FROM customers WHERE registered_by=? AND registration_source='staff_form' ORDER BY id LIMIT 1", [actors.trainee.id]).id);
    execute("PRAGMA foreign_keys=OFF");
    const fill = (table, values) => { const row = {}; for (const c of queryRows(`PRAGMA table_info(${table})`)) { if (c.name in values) row[c.name] = values[c.name];
      else if (c.notnull && c.dflt_value == null && !c.pk) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$/.test(c.name) ? new Date().toISOString() : `fx-${crypto.randomUUID()}`); }
      const k = Object.keys(row); return execute(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map((x) => row[x])); };
    const app1 = fill("loan_applications", { customer_id: cid, deleted_at: null });
    fill("loan_application_stage_history", { application_id: app1, from_stage: "customer_documents_upload", to_stage: "customer_documents_review" });
    fill("customer_payment_orders", { customer_id: cid, stage: "paid", amount_toman: "1000" });
    execute("PRAGMA foreign_keys=ON");
    const b = (await call("GET", `/admin/registered-by?from=${today}&to=${today}`, "admin")).body.registrars.find((x) => x.userId === actors.trainee.id);
    assert.equal(b.reachedRegistration, tr.reachedRegistration + 1); assert.equal(b.reachedDeposit, tr.reachedDeposit + 1); assert.equal(b.depositPaymentOrders, tr.depositPaymentOrders + 1);
    for (const q of ["from=2026-13-01", "from=2026-10-27&to=2026-10-01", "from=2024-01-01&to=2026-10-27"]) assert.equal((await call("GET", `/admin/registered-by?${q}`, "admin")).status, 400, q);
    assert.equal((await call("GET", `/admin/registered-by`, "u29")).status, 403);
    assert.equal((await call("GET", `/admin/registered-by`, "hasani")).status, 403);
    execute("DELETE FROM customers WHERE id=?", [id29]);
  });

  await ok("nothing else changed: existing customers' owners, trainees' customers, user 29, team_sales_config, contracts; 0 outbound", () => {
    assert.equal(protectedHash(), protBefore);
    assert.equal(existingHash(), existingBefore, "existing customers untouched (owner, registered_by, source)");
    assert.equal(outbound.length, 0, `outbound: ${outbound.join(",")}`);
  });

  /* ---------- one-time transfer script (sp22 → sp6) on a fresh copy ---------- */
  const tScript = process.env.DEFAULT_OWNER_TRANSFER, onScript = process.env.DEFAULT_OWNER_RULE_ON;
  if (tScript && onScript) {
    // synthetic sp22 / user 31 + 7 customers on the fixture copy (crmDb has the SQL functions the triggers need), then a fresh copy.
    const fillM = (table, values) => { const row = {}; for (const c of queryRows(`PRAGMA table_info(${table})`)) { if (c.name in values) row[c.name] = values[c.name];
      else if (c.notnull && c.dflt_value == null && !c.pk) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$/.test(c.name) ? new Date().toISOString() : `fx-${crypto.randomUUID()}`); }
      const k = Object.keys(row); return execute(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map((x) => row[x])); };
    if (!queryRow("SELECT id FROM salespersons WHERE id=22")) fillM("salespersons", { id: 22, name: "کارشناس نمونه", active: 1 });
    if (!queryRow("SELECT id FROM users WHERE id=31")) fillM("users", { id: 31, username: "fx-user-31", full_name: "کاربر نمونه", role: "salesperson", salesperson_id: 22, active: 1 });
    else execute("UPDATE users SET salesperson_id=22 WHERE id=31");
    for (let i = 0; i < 7; i++) execute("INSERT INTO customers(name,phone,verification_status,is_urgent,created_at,salesperson_id,status) VALUES (?,?,'unverified',0,?,22,'in_progress')", [`سرنخ نمونه ${i}`, phone(), new Date().toISOString()]);
    const t = path.join(dir, "transfer.db"); crmDb.exec(`VACUUM INTO '${t}'`);
    const T = new DatabaseSync(t);
    const t1 = (s, p = []) => T.prepare(s).get(...p);
    const kz = Number(t1("SELECT id FROM users WHERE salesperson_id=6 AND active=1 ORDER BY id LIMIT 1")?.id ?? 0);
    T.close();
    const snap = () => { const D = new DatabaseSync(t, { readOnly: true }); const h = crypto.createHash("sha256").update(JSON.stringify([
      D.prepare("SELECT id, salesperson_id, registered_by, source FROM customers ORDER BY id").all(), D.prepare("SELECT * FROM customer_priority_history ORDER BY id").all(),
      D.prepare("SELECT * FROM site_notification_events ORDER BY id").all(), D.prepare("SELECT * FROM site_notification_reads ORDER BY user_id, event_id").all(),
      D.prepare("SELECT * FROM notification_settings ORDER BY key").all()])).digest("hex"); D.close(); return h; };
    const run = (args) => { const r = spawnSync("python3", [tScript, "--db", t, ...args], { encoding: "utf8" }); return { code: r.status, out: r.stdout + r.stderr }; };
    const h0 = snap();
    await ok("transfer dry-run: counts only, nothing written", () => {
      const r = run([]); assert.equal(r.code, 0, r.out); assert.match(r.out, /"sp22_customers": 7/); assert.equal(snap(), h0);
      assert.ok(!/0999\d{7}|سرنخ نمونه/.test(r.out), "no phones / names printed");
    });
    const map = path.join(dir, "map.json");
    await ok("transfer apply: --expect guard, 7 moved to 6, registered_by=31, 7 history rows, no new bells, map 600; second apply refused", () => {
      assert.notEqual(run(["--apply", "--map", map, "--expect", "6"]).code, 0); assert.ok(!fs.existsSync(map)); assert.equal(snap(), h0);
      const r = run(["--apply", "--map", map, "--expect", "7"]); assert.equal(r.code, 0, r.out); assert.match(r.out, /"moved": 7/);
      assert.equal((fs.statSync(map).mode & 0o777), 0o600);
      const D = new DatabaseSync(t, { readOnly: true });
      assert.equal(Number(D.prepare("SELECT count(*) n FROM customers WHERE salesperson_id=22").get().n), 0);
      const moved = JSON.parse(fs.readFileSync(map, "utf8")).customers; assert.equal(moved.length, 7);
      for (const m of moved) { const c = D.prepare("SELECT salesperson_id sp, registered_by rb, source FROM customers WHERE id=?").get(m.id); assert.equal(Number(c.sp), 6); assert.equal(Number(c.rb), 31); assert.equal(c.source, "instagram"); assert.ok("oldSource" in m); }
      const h = D.prepare("SELECT * FROM customer_priority_history WHERE source='default_owner_transfer'").all(); assert.equal(h.length, 7);
      assert.ok(h.every((x) => Number(x.old_salesperson_id) === 22 && Number(x.new_salesperson_id) === 6 && x.reason === "قانون ثبت: همه‌ی مشتری‌های جدید به کاظمی" && x.actor_user_id == null));
      const ids = moved.map((m) => m.id).join(",");
      if (kz) assert.equal(Number(D.prepare(`SELECT count(*) n FROM site_notification_events e WHERE e.customer_id IN (${ids}) AND NOT EXISTS (SELECT 1 FROM site_notification_reads r WHERE r.event_id=e.id AND r.user_id=?)`).get(kz).n), 0, "no unread bell for Kazemi");
      const preMax = JSON.parse(fs.readFileSync(map, "utf8")).bellPreMax;
      assert.equal(Number(D.prepare(`SELECT count(*) n FROM site_notification_events WHERE id>? AND customer_id IN (${ids})`).get(preMax).n), 0, "no bell from the move");
      D.close();
      assert.notEqual(run(["--apply", "--map", map]).code, 0, "second apply refused");
    });
    await ok("rule ON script: snapshot + ON config; undo restores exactly", () => {
      const sn = path.join(dir, "rule.snap"); const before = snap();
      const D0 = new DatabaseSync(t, { readOnly: true }); const row0 = JSON.stringify(D0.prepare("SELECT * FROM default_owner_rule_settings").all()); D0.close();
      let r = spawnSync("python3", [onScript, "--db", t, "--on", "--snap", sn], { encoding: "utf8" }); assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /"enabled": true/); assert.match(r.stdout, /"ownerSalespersonId": 6/);
      r = spawnSync("python3", [onScript, "--db", t, "--undo", "--snap", sn], { encoding: "utf8" }); assert.equal(r.status, 0, r.stdout + r.stderr);
      const D1 = new DatabaseSync(t, { readOnly: true }); assert.equal(JSON.stringify(D1.prepare("SELECT * FROM default_owner_rule_settings").all()), row0); D1.close();
      assert.equal(snap(), before);
    });
    await ok("transfer undo: owners + registered_by restored, only its history rows / read marks removed → identical to before", () => {
      const r = run(["--undo", "--map", map]); assert.equal(r.code, 0, r.out); assert.match(r.out, /"restored": 7/); assert.match(r.out, /"history_deleted": 7/);
      assert.equal(snap(), h0);
    });
  } else console.log("note: transfer script tests skipped (set DEFAULT_OWNER_TRANSFER and DEFAULT_OWNER_RULE_ON)");
  console.log(`\n${passed} passed`);
} finally {
  if (server) server.close();
}
