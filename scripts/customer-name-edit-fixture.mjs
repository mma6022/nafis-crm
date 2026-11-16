/**
 * customer-name-edit (flag.customer_name_edit): permissions, validation, history,
 * contracts/templates untouched, one edit across every case, flag OFF rejects.
 * Runs on a throwaway COPY of a masked DB. Never prints phones, secrets, or live names.
 * No SMS / Bale / calls. Usage:
 *   CUSTOMER_NAME_EDIT_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/customer-name-edit-fixture.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

globalThis.fetch = async (input) => { throw new Error(`outbound blocked: ${String(input).slice(0, 40)}`); };

const candidates = [
  process.env.CUSTOMER_NAME_EDIT_FIXTURE_DB,
  "/workspace/name-edit/masked-src.db",
  "/workspace/signrem/rel-250000/masked-pkgtest.db",
].filter(Boolean);
const src = candidates.find((p) => fs.existsSync(p));
if (!src) { console.log("SKIP (set CUSTOMER_NAME_EDIT_FIXTURE_DB to a masked DB copy)"); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cne-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE|OPENAI|DEEPSEEK/i.test(k)) delete process.env[k];
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log("ok -", name); };

const FLAG = "flag.customer_name_edit";
let server;

try {
  const db = await import("../src/lib/crm-db.ts");
  const lib = await import("../src/lib/customer-name-edit.ts");
  const { queryRow, queryRows, execute, executeChanges } = db;
  const express = (await import("express")).default;
  const router = (await import("../src/routes/customer-name-edit.ts")).default;
  lib.ensureCneSchema();

  const uid = (role, extraSql = "", params = []) => {
    const row = queryRow(`SELECT id, salesperson_id sp FROM users WHERE role=? AND active=1 ${extraSql} ORDER BY id LIMIT 1`, [role, ...params]);
    if (!row) throw new Error(`missing user ${role}`);
    return { id: Number(row.id), sp: row.sp == null ? null : Number(row.sp) };
  };
  const admin = uid("admin", "AND id<>29");
  const salesManager = uid("sales_manager");
  const registrar = uid("registrar");
  const hasani = queryRow("SELECT id, salesperson_id sp FROM users WHERE salesperson_id=3 AND role='salesperson' AND active=1 ORDER BY id LIMIT 1");
  const kazemi = queryRow("SELECT id, salesperson_id sp FROM users WHERE salesperson_id=6 AND role='salesperson' AND active=1 ORDER BY id LIMIT 1");
  assert.ok(hasani && kazemi, "expected hasani (sp 3) and kazemi (sp 6)");
  const P = ["customers.view", "customers.create", "customers.update", "loan_applications.view"];
  const actors = {
    admin: { id: admin.id, role: "admin", baseRole: "admin", salespersonId: null, fullName: "مدیر سیستم", username: "admin", permissions: [], customerScope: "all" },
    salesmgr: { id: salesManager.id, role: "admin", baseRole: "sales_manager", salesManager: true, salespersonId: salesManager.sp, fullName: "مدیر فروش", username: "sm", permissions: P, customerScope: "all" },
    registrar: { id: registrar.id, role: "registrar", baseRole: "registrar", salespersonId: registrar.sp, fullName: "کارشناس ثبت", username: "reg", permissions: P, customerScope: "all" },
    hasani: { id: Number(hasani.id), role: "salesperson", baseRole: "salesperson", salespersonId: 3, fullName: "خانم حسنی", username: "hasani", permissions: P, customerScope: "assigned" },
    kazemi: { id: Number(kazemi.id), role: "salesperson", baseRole: "salesperson", salespersonId: 6, fullName: "آقای کاظمی", username: "kazemi", permissions: P, customerScope: "assigned" },
  };

  const setFlag = (on) => {
    if (on) {
      execute(
        "INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        [FLAG, "1", new Date().toISOString()],
      );
    } else {
      executeChanges("DELETE FROM call_queue_settings WHERE key=? OR key LIKE ?", [FLAG, FLAG + ".%"]);
    }
  };
  setFlag(false);
  assert.equal(lib.cneFlagOn(), false);

  const planId = Number(queryRow("SELECT id FROM loan_plans ORDER BY id LIMIT 1")?.id ?? 1);
  const now = "2026-11-11T06:42:00.000Z";
  const ownId = 910001;
  const verId = 910002;
  const othId = 910003;
  const seedCustomer = (id, sp, name, first, last, verified) => {
    execute(
      `INSERT INTO customers(id,name,phone,created_at,salesperson_id,status,verification_status,first_name,last_name,
         official_first_name,official_last_name)
       VALUES(?,?,?,?,?,'in_progress',?,?,?,?,?)`,
      [id, name, `0999${String(id).slice(-7)}`, now, sp, verified ? "verified" : "unverified", first, last,
        verified ? "بهرام" : "رسمی", verified ? "صالحی" : "قدیمی"],
    );
  };
  seedCustomer(ownId, 3, "سمیره نادری", "سمیره", "نادری", false);
  seedCustomer(verId, 3, "بهرام صالحی", "بهرام", "صالحی", true);
  seedCustomer(othId, 6, "نگار سلیمی", "نگار", "سلیمی", false);

  const consultFor = (customerId) => {
    const existing = queryRow("SELECT id FROM consultation_forms WHERE customer_id=? ORDER BY id LIMIT 1", [customerId]);
    if (existing) return Number(existing.id);
    return execute("INSERT INTO consultation_forms(customer_id, created_at, updated_at) VALUES(?,?,?)", [customerId, now, now]);
  };
  const insertApp = (id, customerId, stage, snapshot) => {
    const cols = queryRows("PRAGMA table_info(loan_applications)").map((c) => c.name);
    const row = {
      id, customer_id: customerId, consultation_id: consultFor(customerId),
      plan_id: planId, plan_ids: `[${planId}]`, requested_amount: "1000000",
      status: "reviewing", stage, created_at: now, updated_at: now, plan_snapshot_json: snapshot,
    };
    const keys = Object.keys(row).filter((k) => cols.includes(k));
    execute(`INSERT INTO loan_applications(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`, keys.map((k) => row[k]));
    return id;
  };
  const snapA = JSON.stringify({ customer_name: "سمیره نادری", frozen: true, label: "fixture-contract-a" });
  const snapB = JSON.stringify({ customer_name: "سمیره نادری", frozen: true, label: "fixture-contract-b" });
  const appA = insertApp(920001, ownId, "customer_documents_upload", snapA);
  const appB = insertApp(920002, ownId, "primary_contract_pending_signature", snapB);
  insertApp(920003, verId, "customer_documents_upload", JSON.stringify({ customer_name: "بهرام صالحی" }));
  insertApp(920004, othId, "customer_documents_upload", JSON.stringify({ customer_name: "نگار سلیمی" }));

  const hasGen = queryRow("SELECT 1 x FROM sqlite_master WHERE name='contract_generations'");
  if (hasGen) {
    const templateId = Number(queryRow("SELECT id FROM contract_templates ORDER BY id LIMIT 1")?.id ?? 0);
    const gcols = queryRows("PRAGMA table_info(contract_generations)").map((c) => c.name);
    const grow = {
      id: 930001, template_id: templateId || 1, customer_id: ownId, loan_application_id: appA, status: "signed",
      created_by: admin.id, generation_purpose: "primary", manual_values_json: "{}",
      created_at: now, updated_at: now, mappings_snapshot_json: snapA,
      docx_path: "/tmp/cne-fixture-unsigned.docx", pdf_path: "/tmp/cne-fixture-unsigned.pdf", docx_sha256: "a".repeat(64), pdf_sha256: "b".repeat(64),
    };
    const keys = Object.keys(grow).filter((k) => gcols.includes(k));
    execute(`INSERT INTO contract_generations(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`, keys.map((k) => grow[k]));
  }

  const contractHash = () => crypto.createHash("sha256").update(JSON.stringify([
    queryRow("SELECT 1 x FROM sqlite_master WHERE name='contract_generations'")
      ? queryRows("SELECT * FROM contract_generations ORDER BY id") : null,
    queryRow("SELECT 1 x FROM sqlite_master WHERE name='contract_templates'")
      ? queryRows("SELECT id, sha256, mappings_json, variables_json, storage_path, deleted_at, updated_at FROM contract_templates ORDER BY id") : null,
    queryRow("SELECT 1 x FROM sqlite_master WHERE name='contract_template_analyses'")
      ? queryRows("SELECT * FROM contract_template_analyses ORDER BY rowid") : null,
    queryRow("SELECT 1 x FROM sqlite_master WHERE name='contract_update_notices'")
      ? queryRows("SELECT * FROM contract_update_notices ORDER BY rowid") : null,
    queryRow("SELECT official_first_name, official_last_name, official_father_name, official_address, official_postal_code FROM customers WHERE id=?", [ownId]),
    queryRows("SELECT id, plan_snapshot_json FROM loan_applications WHERE id IN (?,?,?,?) ORDER BY id", [920001, 920002, 920003, 920004]),
  ])).digest("hex");
  const contractsBefore = contractHash();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.authUser = actors[req.headers["x-actor"]];
    if (!res.locals.authUser) { res.sendStatus(401); return; }
    req.log = { warn() {}, info() {}, error() {} };
    next();
  });
  app.use("/api", router);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock);
  await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => { s += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });

  await ok("flag OFF: GET and PATCH are rejected; no UI payload", async () => {
    const g = await call("GET", `/customers/${ownId}/name-edit`, "hasani");
    assert.equal(g.status, 404);
    assert.equal(g.body.error, "customer_name_edit_off");
    const p = await call("PATCH", `/customers/${ownId}/name`, "hasani", { firstName: "سمیرا", lastName: "نادری" });
    assert.equal(p.status, 404);
    assert.equal(p.body.error, "customer_name_edit_off");
    const row = queryRow("SELECT name, first_name, last_name FROM customers WHERE id=?", [ownId]);
    assert.equal(row.name, "سمیره نادری");
    assert.equal(row.first_name, "سمیره");
  });

  setFlag(true);
  assert.equal(lib.cneFlagOn(), true);

  await ok("owner can see the pencil payload for their unverified customer", async () => {
    const g = await call("GET", `/customers/${ownId}/name-edit`, "hasani");
    assert.equal(g.status, 200);
    assert.equal(g.body.flagOn, true);
    assert.equal(g.body.canEdit, true);
    assert.equal(g.body.identityVerified, false);
    assert.equal(g.body.showVerifiedBadge, false);
    assert.equal(g.body.firstName, "سمیره");
    assert.equal(g.body.lastName, "نادری");
  });

  await ok("other expert is rejected (403) and sees no badge", async () => {
    const g = await call("GET", `/customers/${ownId}/name-edit`, "kazemi");
    assert.equal(g.status, 200);
    assert.equal(g.body.canEdit, false);
    assert.equal(g.body.showVerifiedBadge, false);
    const p = await call("PATCH", `/customers/${ownId}/name`, "kazemi", { firstName: "سمیرا", lastName: "نادری" });
    assert.equal(p.status, 403);
    assert.equal(p.body.error, "forbidden");
  });

  await ok("admin can edit another expert's unverified customer", async () => {
    const g = await call("GET", `/customers/${othId}/name-edit`, "admin");
    assert.equal(g.status, 200);
    assert.equal(g.body.canEdit, true);
  });

  await ok("sales manager and filing registrar cannot edit (403)", async () => {
    for (const who of ["salesmgr", "registrar"]) {
      const g = await call("GET", `/customers/${ownId}/name-edit`, who);
      assert.equal(g.status, 200, who);
      assert.equal(g.body.canEdit, false, who);
      const p = await call("PATCH", `/customers/${ownId}/name`, who, { firstName: "سمیرا", lastName: "نادری" });
      assert.equal(p.status, 403, who);
    }
  });

  await ok("verified customer is rejected and shows the lock badge to the owner", async () => {
    const g = await call("GET", `/customers/${verId}/name-edit`, "hasani");
    assert.equal(g.status, 200);
    assert.equal(g.body.canEdit, false);
    assert.equal(g.body.identityVerified, true);
    assert.equal(g.body.showVerifiedBadge, true);
    const p = await call("PATCH", `/customers/${verId}/name`, "hasani", { firstName: "بهرام", lastName: "کاظمی" });
    assert.equal(p.status, 409);
    assert.equal(p.body.message, "نام از احراز هویت آمده و قابل ویرایش نیست.");
    const row = queryRow("SELECT name FROM customers WHERE id=?", [verId]);
    assert.equal(row.name, "بهرام صالحی");
  });

  await ok("validation: required, Latin letters, length", async () => {
    const empty = await call("PATCH", `/customers/${ownId}/name`, "hasani", { firstName: "  ", lastName: "نادری" });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.field, "firstName");
    assert.equal(empty.body.message, "این فیلد لازم است.");
    const latin = await call("PATCH", `/customers/${ownId}/name`, "hasani", { firstName: "سمیره", lastName: "Naderi" });
    assert.equal(latin.status, 400);
    assert.equal(latin.body.field, "lastName");
    assert.equal(latin.body.message, "فقط حروف فارسی وارد کنید.");
    const short = await call("PATCH", `/customers/${ownId}/name`, "hasani", { firstName: "س", lastName: "نادری" });
    assert.equal(short.status, 400);
    const long = await call("PATCH", `/customers/${ownId}/name`, "hasani", { firstName: "س".repeat(31), lastName: "نادری" });
    assert.equal(long.status, 400);
  });

  await ok("unchanged values do not write a history row", async () => {
    const p = await call("PATCH", `/customers/${ownId}/name`, "hasani", { firstName: "سمیره", lastName: "نادری" });
    assert.equal(p.status, 200);
    assert.equal(p.body.unchanged, true);
    const n = queryRow("SELECT COUNT(*) n FROM customer_name_edits WHERE customer_id=?", [ownId]);
    assert.equal(Number(n.n), 0);
  });

  await ok("owner save: name, history row, actor and time; both cases show the new name", async () => {
    const p = await call("PATCH", `/customers/${ownId}/name`, "hasani", { firstName: "سمیرا", lastName: "نادری" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.unchanged, false);
    assert.equal(p.body.name, "سمیرا نادری");
    assert.equal(p.body.firstName, "سمیرا");
    assert.equal(p.body.lastName, "نادری");
    const row = queryRow("SELECT name, first_name, last_name, official_first_name, official_last_name FROM customers WHERE id=?", [ownId]);
    assert.equal(row.name, "سمیرا نادری");
    assert.equal(row.first_name, "سمیرا");
    assert.equal(row.last_name, "نادری");
    assert.equal(row.official_first_name, "رسمی");
    assert.equal(row.official_last_name, "قدیمی");
    const edit = queryRow("SELECT old_name, new_name, actor_user_id, actor_name, created_at FROM customer_name_edits WHERE customer_id=?", [ownId]);
    assert.equal(edit.old_name, "سمیره نادری");
    assert.equal(edit.new_name, "سمیرا نادری");
    assert.equal(Number(edit.actor_user_id), actors.hasani.id);
    assert.equal(edit.actor_name, "خانم حسنی");
    assert.ok(edit.created_at);
    const names = queryRows("SELECT id, (SELECT name FROM customers WHERE id=loan_applications.customer_id) n FROM loan_applications WHERE id IN (?,?) ORDER BY id", [appA, appB]);
    assert.deepEqual(names.map((r) => r.n), ["سمیرا نادری", "سمیرا نادری"]);
    const hist = queryRows("SELECT application_id, action, reason, actor_id FROM loan_application_stage_history WHERE action=? AND application_id IN (?,?) ORDER BY application_id", ["customer-name-changed", appA, appB]);
    assert.equal(hist.length, 2);
    for (const h of hist) {
      assert.equal(h.action, "customer-name-changed");
      assert.equal(Number(h.actor_id), actors.hasani.id);
      const reason = JSON.parse(h.reason);
      assert.equal(reason.oldName, "سمیره نادری");
      assert.equal(reason.newName, "سمیرا نادری");
    }
    assert.deepEqual(p.body.history.applicationIds.slice().sort(), [appA, appB]);
  });

  await ok("item 6: one edit renames the customer across all of their cases", async () => {
    const again = queryRows("SELECT id, (SELECT name FROM customers c WHERE c.id=loan_applications.customer_id) n FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL ORDER BY id", [ownId]);
    assert.ok(again.length >= 2);
    assert.ok(again.every((r) => r.n === "سمیرا نادری"));
    const other = queryRow("SELECT name FROM customers WHERE id=?", [othId]);
    assert.equal(other.name, "نگار سلیمی");
  });

  await ok("issued contracts, templates, snapshots, and official names stay untouched", async () => {
    assert.equal(contractHash(), contractsBefore);
  });

  await ok("no edit cap: a second change also writes history", async () => {
    const p = await call("PATCH", `/customers/${ownId}/name`, "admin", { firstName: "سمیرا", lastName: "نادران" });
    assert.equal(p.status, 200);
    assert.equal(p.body.name, "سمیرا نادران");
    const n = queryRow("SELECT COUNT(*) n FROM customer_name_edits WHERE customer_id=?", [ownId]);
    assert.equal(Number(n.n), 2);
    const hist = queryRow("SELECT COUNT(*) n FROM loan_application_stage_history WHERE action=? AND application_id=?", ["customer-name-changed", appA]);
    assert.equal(Number(hist.n), 2);
  });

  await ok("turning the flag off again rejects the endpoint", async () => {
    setFlag(false);
    const p = await call("PATCH", `/customers/${ownId}/name`, "hasani", { firstName: "سمیره", lastName: "نادری" });
    assert.equal(p.status, 404);
    const row = queryRow("SELECT name FROM customers WHERE id=?", [ownId]);
    assert.equal(row.name, "سمیرا نادران");
  });

  console.log(`customer-name-edit fixture PASS (${passed} checks)`);
} catch (err) {
  console.error("FAIL", err && err.stack ? err.stack : err);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
