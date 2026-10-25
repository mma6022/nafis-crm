// crm-nonp1-to-kazemi fixture: a closer's (Hasani 3 / Ghasemi 4) customer set to any priority ≠ 1 moves to Kazemi (6)
// in the same transaction, on every write path, with every exception; plus the one-time catch-up script and its rollback.
// Runs on throwaway copies of a DB; HTTP over a unix socket in the temp dir. ALL outbound fetch is stubbed (recorded,
// never sent) and the stored SMS relay URL is blanked in the copy: no SMS, no Telegram, no staff notifications.
// Usage: NONP1_FIXTURE_DB=/path/to/copy.db node scripts/run-bundled-fixture.mjs scripts/nonp1-kazemi-fixture.mjs
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
const src = process.env.NONP1_FIXTURE_DB;
if (!src) { console.log("SKIP (set NONP1_FIXTURE_DB to a DB copy)"); process.exit(0); }
const scriptsDir = process.env.NONP1_SCRIPTS_DIR || path.resolve(process.cwd(), "scripts");
const srcHash = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nonp1-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
const migPath = path.join(dir, "migration.db");
fs.copyFileSync(src, migPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY/i.test(k)) delete process.env[k];
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

const v2 = { mode: "simple", callResult: "answered", urgency: "month", amountMillion: 100, docsReady: "partial", creditRank: "A1",
  checkStatus: "any", canPromissory: "yes", bouncedCheque: "no", formVersion: 2, guarantorAvailable: "no",
  military: "has_card", jobType: "unknown", city: "شهر نمونه", noPlanFit: true }; // exactly P2 (see first-call-edit fixture)
const note = "مشتری جواب داد؛ بخشی از مدارک آماده است و توضیح کامل ثبت شد برای پیگیری.";

let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const np = await import("../src/lib/nonp1-transfer.ts");
  const { queryRow, queryRows, execute } = db;
  const express = (await import("express")).default;
  const crmRouter = (await import("../src/routes/crm.ts")).default;
  const tsRouter = (await import("../src/routes/team-sales.ts")).default;
  const acRouter = (await import("../src/routes/voip-after-call.ts")).default;
  ts.ensureTeamSalesSchema();
  // Copy only: no relay URL, team sales on with the live config value.
  execute("UPDATE notification_settings SET value='' WHERE key='ippanelRelayUrl'");
  execute("DELETE FROM notification_settings WHERE key='team_sales_config'");
  execute("INSERT INTO notification_settings(key,value,updated_at) VALUES('team_sales_config','{\"enabled\":true}',datetime('now'))");
  const cfg = ts.getTeamSalesConfig();
  await ok("live config: qualifier 6, closers [3,4]", () => { assert.equal(Number(cfg.qualifierSalespersonId), 6); assert.deepEqual(cfg.closerSalespersonIds.map(Number), [3, 4]); });

  const uid = (sp) => Number(queryRow("SELECT id FROM users WHERE salesperson_id=? ORDER BY id LIMIT 1", [sp]).id);
  const kazemiUsers = queryRows("SELECT id FROM users WHERE salesperson_id=6 AND active=1").map((r) => Number(r.id));
  const P = ["customers.view", "customers.create", "customers.update", "calls.view", "calls.create"];
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: [], customerScope: "all" },
    hasani: { id: uid(3), role: "salesperson", salespersonId: 3, fullName: "h", permissions: P, customerScope: "assigned" },
    ghasemi: { id: uid(4), role: "salesperson", salespersonId: 4, fullName: "g", permissions: P, customerScope: "assigned" },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "k", permissions: P, customerScope: "assigned" },
    trainee: { id: uid(5), role: "salesperson", salespersonId: 5, fullName: "t", permissions: P, customerScope: "assigned" },
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } req.log = { warn() {}, info() {}, error() {} }; next(); });
  app.use("/api", crmRouter); app.use("/api", tsRouter); app.use("/api", acRouter);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, body: j, moved: res.headers["x-nafis-customer-transferred"] ?? null }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });

  // Subjects: in_progress, unmerged, no open case, not #181/#649, no team-sales history yet (copy only).
  const pool = queryRows(`SELECT id FROM customers WHERE status='in_progress' AND merged_into_customer_id IS NULL AND id NOT IN (181,649)
    AND salesperson_id IN (3,4,6) ORDER BY id DESC LIMIT 400`).map((r) => Number(r.id)).filter((id) => np.openCaseReason(id) == null);
  assert.ok(pool.length >= 30, `need 30 clean customers, got ${pool.length}`);
  let pi = 0;
  const subject = (sp, priority, status = "in_progress") => { const id = pool[pi++]; execute("UPDATE customers SET salesperson_id=?, priority=?, status=? WHERE id=?", [sp, priority, status, id]); return id; };
  const owner = (id) => { const r = queryRow("SELECT salesperson_id s, priority p FROM customers WHERE id=?", [id]); return { sp: r.s == null ? null : Number(r.s), p: r.p == null ? null : Number(r.p) }; };
  const hist = (id) => queryRows("SELECT * FROM customer_priority_history WHERE customer_id=? AND source='nonp1_auto_transfer' ORDER BY id", [id]);
  const unreadForKazemi = (id) => kazemiUsers.length ? Number(queryRow(`SELECT count(*) n FROM site_notification_events e WHERE e.customer_id=?
    AND NOT EXISTS (SELECT 1 FROM site_notification_reads r WHERE r.event_id=e.id AND r.user_id=?)`, [id, kazemiUsers[0]]).n) : 0;
  const introCount = () => Number(queryRow("SELECT (SELECT count(*) FROM expert_intro_sms)+(SELECT count(*) FROM expert_intro_sms_log) n").n);
  const moneyTables = ["goods_purchases", "goods_finance_ledger", "goods_salesperson_wallets", "goods_company_wallets", "team_commission_purchases",
    "team_commission_ledger_meta", "team_commission_settings", "wallet_ledger", "wallet_ledger_v2", "loan_filing_fee_charges", "company_wallet_ledger",
    "loan_applications", "contract_generations", "customer_payment_orders"];
  const moneyHash = () => crypto.createHash("sha256").update(JSON.stringify(moneyTables.map((t) =>
    queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [t]) ? queryRows(`SELECT * FROM ${t} ORDER BY rowid`) : null))).digest("hex");
  const assertMoved = async (id, from, oldP, newP, actorId, r) => {
    const o = owner(id);
    assert.equal(o.sp, 6, `#${id} owner`); assert.equal(o.p, newP, `#${id} priority`);
    const h = hist(id); assert.equal(h.length, 1, `#${id} one history row`);
    assert.deepEqual([h[0].old_priority, h[0].new_priority, Number(h[0].old_salesperson_id), Number(h[0].new_salesperson_id), h[0].actor_user_id == null ? null : Number(h[0].actor_user_id)],
      [oldP, newP, from, 6, actorId]);
    assert.ok(h[0].created_at && /انتقال خودکار/.test(h[0].reason));
    assert.equal(Number(queryRow("SELECT count(*) n FROM customer_priority_history WHERE customer_id=? AND source='customer_update' AND id>?", [id, h[0].id]).n), 0, "no duplicate customer_update row");
    assert.equal(unreadForKazemi(id), 0, "no unread bell for Kazemi");
    if (r) assert.equal(r.moved, String(id), "transfer header");
  };
  const assertStayed = (id, sp, r) => { assert.equal(owner(id).sp, sp, `#${id} must stay with ${sp}`); assert.equal(hist(id).length, 0); if (r) assert.equal(r.moved, null, "no header"); };

  /* ---------- synthetic open cases (copy only, FK off just for these inserts) ---------- */
  const openSubjects = {};
  const fill = (table, values) => {
    const cols = queryRows(`PRAGMA table_info(${table})`);
    const row = {};
    for (const c of cols) {
      if (c.name in values) row[c.name] = values[c.name];
      else if (c.notnull && c.dflt_value == null && !c.pk) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$/.test(c.name) ? new Date().toISOString() : `fixture-${crypto.randomUUID()}`);
    }
    const k = Object.keys(row);
    execute(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map((x) => row[x]));
  };
  execute("PRAGMA foreign_keys=OFF");
  const nowIso = new Date().toISOString();
  const openDefs = [
    ["loan_application", "loan_applications", { status: "reviewing", deleted_at: null }],
    ["goods_purchase", "goods_purchases", { stage: "invoice_draft" }],
    ["payment_order", "customer_payment_orders", { stage: "awaiting_payment" }],
    ["loan_draft", "loan_request_drafts", { status: "pending_registration", deleted_at: null }],
    ["contract", "contract_generations", { status: "sent", deleted_at: null, superseded_at: null }],
    ["wallet_payment", "wallet_payment_intents", { status: "created", created_at: nowIso }],
  ];
  for (const [reason, table, vals] of openDefs) {
    if (!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [table])) { console.log(`  (table ${table} absent: ${reason} not testable)`); continue; }
    const id = subject(3, 1);
    fill(table, { customer_id: id, ...vals });
    assert.equal(np.openCaseReason(id), reason, `open case ${reason}`);
    openSubjects[reason] = id;
  }
  let staleWallet = null;
  if (openSubjects.wallet_payment) { staleWallet = subject(4, 1); fill("wallet_payment_intents", { customer_id: staleWallet, status: "created", created_at: new Date(Date.now() - 25 * 3600e3).toISOString() }); }
  execute("PRAGMA foreign_keys=ON");

  const money0 = moneyHash(), intro0 = introCount();

  /* ---------- A. the rule on every path ---------- */
  await ok("PATCH (quick edit / board / customer page): Hasani sets P1→P2 → Kazemi, history, header, toast-ready, unscoped 200", async () => {
    const id = subject(3, 1);
    const r = await call("PATCH", `/customers/${id}`, "hasani", { priority: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(Number(r.body.salespersonId), 6);
    await assertMoved(id, 3, 1, 2, actors.hasani.id, r);
    assert.equal((await call("GET", `/customers/${id}`, "hasani")).status, 404, "Hasani no longer sees it");
  });
  await ok("PATCH: Ghasemi sets P1→«بدون اولویت» (null) → Kazemi", async () => {
    const id = subject(4, 1);
    const r = await call("PATCH", `/customers/${id}`, "ghasemi", { priority: null });
    assert.equal(r.status, 200, JSON.stringify(r.body)); await assertMoved(id, 4, 1, null, actors.ghasemi.id, r);
  });
  await ok("PATCH: Hasani P2→P3 (already non-1, still a change) → Kazemi", async () => {
    const id = subject(3, 2);
    const r = await call("PATCH", `/customers/${id}`, "hasani", { priority: 3 });
    assert.equal(r.status, 200); await assertMoved(id, 3, 2, 3, actors.hasani.id, r);
  });
  await ok("PATCH: admin sets a closer's customer P1→P3 → Kazemi (actor = admin)", async () => {
    const id = subject(4, 1);
    const r = await call("PATCH", `/customers/${id}`, "admin", { priority: 3 });
    assert.equal(r.status, 200); await assertMoved(id, 4, 1, 3, 1, r);
  });
  await ok("PATCH: admin's form re-sending the SAME salesperson (CustomerForm always sends it) still transfers", async () => {
    const id = subject(3, 1);
    const r = await call("PATCH", `/customers/${id}`, "admin", { priority: 2, salespersonId: 3 });
    assert.equal(r.status, 200); await assertMoved(id, 3, 1, 2, 1, r);
  });
  await ok("POST create: Hasani creates a P2 customer → owned by Kazemi, header", async () => {
    const r = await call("POST", "/customers", "hasani", { name: "مشتری آزمایشی فیکسچر", phone: "09129990001", priority: 2 });
    assert.equal(r.status, 201, JSON.stringify(r.body)); const id = Number(r.body.id);
    await assertMoved(id, 3, null, 2, actors.hasani.id, r);
  });
  await ok("POST create without priority stays with the creator; admin create with explicit expert + P3 stays", async () => {
    const r1 = await call("POST", "/customers", "hasani", { name: "مشتری آزمایشی دو", phone: "09129990002" });
    assert.equal(r1.status, 201); assertStayed(Number(r1.body.id), 3, r1);
    const r2 = await call("POST", "/customers", "admin", { name: "مشتری آزمایشی سه", phone: "09129990003", priority: 3, salespersonId: 4 });
    assert.equal(r2.status, 201); assertStayed(Number(r2.body.id), 4, r2);
  });
  await ok("«نتیجه تماس» (after-call form): Hasani sets P2 → Kazemi, header", async () => {
    const id = subject(3, 1);
    const evt = execute(`INSERT INTO voip_after_call_events (external_id,phone,direction,status,started_at,ended_at,extensions_json,expert_user_id,salesperson_id,customer_id,has_recording,mobile_device_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,1)`, [`nonp1-fx-${id}`, "09120000000", "outgoing", "ANSWERED", nowIso, nowIso, "[]", actors.hasani.id, 3, id]);
    const r = await call("PATCH", `/voip/after-call/${evt}`, "hasani", { expertNotes: "تماس گرفته شد و مشتری فعلاً فوریت ندارد.", priority: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); await assertMoved(id, 3, 1, 2, actors.hasani.id, r);
  });
  await ok("فرم تماس اول by admin on a closer's customer (P2 result) → Kazemi, single history row, header", async () => {
    const id = subject(4, null);
    const qf = () => Number(queryRow("SELECT count(*) n FROM customer_priority_history WHERE customer_id=? AND source='qualifier_form'", [id]).n);
    const qf0 = qf();
    const r = await call("POST", `/customers/${id}/team-sales/qualify`, "admin", { answers: v2, note });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.transferredToQualifier, true);
    await assertMoved(id, 4, null, 2, 1, r);
    assert.equal(qf(), qf0, "no second (qualifier_form) row for the same change");
  });

  /* ---------- B. exceptions: customer stays ---------- */
  await ok("Kazemi's own priority changes trigger nothing (HTTP) and actor=qualifier never transfers (helper)", async () => {
    const id = subject(6, 1);
    const r = await call("PATCH", `/customers/${id}`, "kazemi", { priority: 3 });
    assert.equal(r.status, 200); assertStayed(id, 6, r);
    const c = subject(3, 2);
    assert.equal(np.nonP1Decision({ customerId: c, oldPriority: 1, oldSalespersonId: 3, actor: { id: 8, salespersonId: 6 }, via: "x" }).skip, "actor_is_qualifier");
  });
  await ok("trainees (5, 19, 20) are never touched — trainee or admin changing their customer's priority", async () => {
    const id = subject(5, 1);
    const r = await call("PATCH", `/customers/${id}`, "trainee", { priority: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assertStayed(id, 5, r);
    const r2 = await call("PATCH", `/customers/${id}`, "admin", { priority: 3 });
    assert.equal(r2.status, 200); assertStayed(id, 5, r2);
    for (const sp of [19, 20]) { const c = subject(sp, 2); assert.equal(np.nonP1Decision({ customerId: c, oldPriority: 1, oldSalespersonId: sp, actor: { id: 1, role: "admin" }, via: "x" }).skip, "trainee"); }
  });
  await ok("customers #181 and #649 stay", async () => {
    for (const [id, sp] of [[181, 3], [649, 4]]) {
      execute("UPDATE customers SET salesperson_id=?, priority=1, status='in_progress' WHERE id=?", [sp, id]);
      const r = await call("PATCH", `/customers/${id}`, "admin", { priority: 2 });
      assert.equal(r.status, 200, JSON.stringify(r.body)); assertStayed(id, sp, r);
    }
  });
  for (const [reason, id] of Object.entries(openSubjects)) {
    await ok(`open case «${reason}» stays with the expert`, async () => {
      const r = await call("PATCH", `/customers/${id}`, "hasani", { priority: 2 });
      assert.equal(r.status, 200, JSON.stringify(r.body)); assertStayed(id, 3, r);
    });
  }
  if (staleWallet) await ok("a wallet payment intent older than 24h is abandoned → transfers", async () => {
    const r = await call("PATCH", `/customers/${staleWallet}`, "ghasemi", { priority: 3 });
    assert.equal(r.status, 200); await assertMoved(staleWallet, 4, 1, 3, actors.ghasemi.id, r);
  });
  await ok("admin explicitly assigning another expert in the same save wins", async () => {
    const id = subject(3, 1);
    const r = await call("PATCH", `/customers/${id}`, "admin", { priority: 2, salespersonId: 4 });
    assert.equal(r.status, 200); assertStayed(id, 4, r);
  });
  await ok("cancelled in the same save / already cancelled → stays", async () => {
    const a = subject(3, 1);
    const r = await call("PATCH", `/customers/${a}`, "hasani", { priority: 2, status: "cancelled" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assertStayed(a, 3, r);
    const b = subject(4, 1, "cancelled");
    const r2 = await call("PATCH", `/customers/${b}`, "admin", { priority: 3 });
    assert.equal(r2.status, 200); assertStayed(b, 4, r2);
  });
  await ok("unchanged priority (other fields edited) → stays", async () => {
    const id = subject(3, 2);
    const r = await call("PATCH", `/customers/${id}`, "hasani", { priority: 2, description: "ویرایش توضیح بدون تغییر اولویت" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assertStayed(id, 3, r);
  });
  await ok("priority 1 → stays (admin raising P2→P1)", async () => {
    const id = subject(4, 2);
    const r = await call("PATCH", `/customers/${id}`, "admin", { priority: 1 });
    assert.ok([200, 400, 403, 409].includes(r.status)); assertStayed(id, 4, r);
  });

  /* ---------- C. side effects ---------- */
  await ok("no expert-intro SMS queued, no outbound request of any kind (SMS/Telegram) during all of the above", () => {
    assert.equal(introCount(), intro0);
    assert.deepEqual(outbound, []);
  });
  await ok("commission / ledger / closed-case tables unchanged (byte-identical rows)", () => assert.equal(moneyHash(), money0));

  /* ---------- D. one-time catch-up script + batch rollback (separate copy) ---------- */
  const node = process.execPath;
  const run = (script, extra) => {
    const r = spawnSync(node, [path.join(scriptsDir, "team-sales", script), "--db", migPath, ...extra], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stderr); const j = r.stdout.slice(r.stdout.indexOf("{"), r.stdout.lastIndexOf("}") + 1); return JSON.parse(j);
  };
  const mdb = new DatabaseSync(migPath);
  // Fixture setup writes status, which fires the unique-mobile trigger (the scripts themselves never write status).
  mdb.function("crm_customer_mobile_key", (v) => (v == null ? null : String(v).replace(/\D/g, "").slice(-10) || null));
  mdb.function("crm_customer_national_code_key", (v) => (v == null ? null : String(v).replace(/\D/g, "") || null));
  const mOpen = (id) => mdb.prepare("SELECT 1 FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL AND status IN ('requested','reviewing')").get(id);
  const mPool = mdb.prepare("SELECT id FROM customers WHERE status='in_progress' AND merged_into_customer_id IS NULL AND salesperson_id IN (3,4,6) AND id NOT IN (181,649) ORDER BY id LIMIT 300").all()
    .map((r) => Number(r.id)).filter((id) => !mOpen(id) && !mdb.prepare("SELECT 1 FROM goods_purchases WHERE customer_id=? AND COALESCE(stage,'')<>'completed'").get(id)
      && !mdb.prepare("SELECT 1 FROM customer_payment_orders WHERE customer_id=? AND COALESCE(stage,'')<>'paid'").get(id));
  let mi = 0; const mSet = (sp, p, st = "in_progress") => { const id = mPool[mi++]; mdb.prepare("UPDATE customers SET salesperson_id=?, priority=?, status=? WHERE id=?").run(sp, p, st, id); return id; };
  const expectMove = [mSet(3, 2), mSet(3, 3), mSet(3, null), mSet(4, 2), mSet(4, null)];
  const keepP1 = mSet(3, 1), keepCancelled = mSet(4, 2, "cancelled"), keepKazemi = mSet(6, 3), keepTrainee = mSet(5, 2);
  mdb.prepare("UPDATE customers SET salesperson_id=3, priority=2, status='in_progress' WHERE id=181").run();
  const keepOpen = mSet(4, 3);
  mdb.exec("PRAGMA foreign_keys=OFF");
  { const cols = mdb.prepare("PRAGMA table_info(loan_applications)").all(); const row = { customer_id: keepOpen, status: "requested", deleted_at: null };
    for (const c of cols) if (!(c.name in row) && c.notnull && c.dflt_value == null && !c.pk) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : "fixture";
    const k = Object.keys(row); mdb.prepare(`INSERT INTO loan_applications (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).run(...k.map((x) => row[x])); }
  // Leave every other in_progress non-P1 customer of 3/4 out of the expectation by parking them on P1 (copy only).
  const others = mdb.prepare(`SELECT id FROM customers WHERE salesperson_id IN (3,4) AND status='in_progress' AND merged_into_customer_id IS NULL AND (priority IS NULL OR priority<>1)
    AND id NOT IN (${[...expectMove, keepOpen, 181].join(",")})`).all().map((r) => Number(r.id));
  for (const id of others) mdb.prepare("UPDATE customers SET priority=1 WHERE id=?").run(id);
  const snap = () => mdb.prepare("SELECT id, salesperson_id, priority, status FROM customers ORDER BY id").all().map((r) => `${r.id}:${r.salesperson_id}:${r.priority}:${r.status}`).join(",");
  const before = snap(); const unread0 = mdb.prepare("SELECT count(*) n FROM site_notification_events").get().n;
  const csv = path.join(dir, "plan.csv");
  await ok("catch-up dry run: exactly the expected customers, nothing written, CSV has no phone / national id / name", () => {
    const rep = run("nonp1-to-qualifier.mjs", ["--csv", csv]);
    assert.equal(rep.move, expectMove.length);
    assert.equal(snap(), before);
    const text = fs.readFileSync(csv, "utf8"); const lines = text.trim().split("\n");
    assert.equal(lines[0], "customer_id,from_salesperson_id,priority,action");
    assert.ok(!/09\d{9}|\+98/.test(text)); assert.ok(lines.slice(1).every((l) => /^\d+,\d+,\d*,[a-z_]+$/.test(l)));
    const act = Object.fromEntries(lines.slice(1).map((l) => l.split(",")).map((p) => [Number(p[0]), p[3]]));
    for (const id of expectMove) assert.equal(act[id], "move_to_kazemi");
    assert.equal(act[181], "stay_protected_customer"); assert.equal(act[keepOpen], "stay_open_case_loan_application"); assert.equal(act[keepCancelled], "stay_closed_cancelled");
    assert.equal(act[keepP1], undefined); assert.equal(act[keepKazemi], undefined); assert.equal(act[keepTrainee], undefined);
    assert.equal((fs.statSync(csv).mode & 0o777), 0o600);
  });
  let batch;
  await ok("catch-up --apply: moves exactly those, history rows, snapshot batch, no new bells, verified backup", () => {
    const rep = run("nonp1-to-qualifier.mjs", ["--apply", "--batch", "nonp1-fixture", "--backup-dir", path.join(dir, "bk"), "--csv", csv]);
    batch = rep.batch; assert.equal(rep.applied.updated, expectMove.length); assert.equal(rep.backup.integrity, "ok");
    for (const id of expectMove) assert.equal(Number(mdb.prepare("SELECT salesperson_id s FROM customers WHERE id=?").get(id).s), 6);
    for (const [id, sp] of [[keepP1, 3], [keepCancelled, 4], [keepKazemi, 6], [keepTrainee, 5], [181, 3], [keepOpen, 4]]) assert.equal(Number(mdb.prepare("SELECT salesperson_id s FROM customers WHERE id=?").get(id).s), sp, `#${id}`);
    assert.equal(Number(mdb.prepare("SELECT count(*) n FROM customer_priority_history WHERE source='nonp1_auto_transfer' AND customer_id IN (" + expectMove.join(",") + ")").get().n), expectMove.length);
    assert.equal(mdb.prepare("SELECT count(*) n FROM site_notification_events").get().n, unread0, "no bell for Kazemi");
    assert.equal(Number(mdb.prepare("SELECT count(*) n FROM team_sales_transfer_snapshot WHERE batch=?").get(batch).n), expectMove.length);
  });
  await ok("batch rollback (rollback-transfer.mjs --batch): ownership/priority/status byte-identical to before", () => {
    const dry = run("rollback-transfer.mjs", ["--batch", batch]); assert.equal(dry.revertable, expectMove.length); assert.equal(dry.conflicts, 0);
    const rep = run("rollback-transfer.mjs", ["--batch", batch, "--apply"]); assert.equal(rep.applied.reverted, expectMove.length);
    assert.equal(snap(), before);
    assert.equal(mdb.prepare("SELECT count(*) n FROM site_notification_events").get().n, unread0, "rollback leaves no bell either");
  });
  mdb.close();
  await ok("source DB copy never modified", () => assert.equal(crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex"), srcHash));
  console.log(`\n${passed} passed`);
} finally {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
