/**
 * The old PATCH /customers/:id «ویرایش پرونده» path must follow the same name-edit rules:
 * only unverified customers, only the case expert or a system admin, history written, all cases
 * updated, contracts/templates/official names untouched, customer not notified.
 * The dedicated /name route is unchanged (flag still required there). This fixture hits the
 * generic PATCH. Runs on a throwaway COPY of a masked DB. Never prints phones, secrets, or live names.
 *   CUSTOMER_NAME_EDIT_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/customer-patch-name-guard-fixture.mjs
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
  process.env.CUSTOMER_PATCH_NAME_GUARD_FIXTURE_DB,
  process.env.CUSTOMER_NAME_EDIT_FIXTURE_DB,
  "/workspace/name-edit/masked-src.db",
  "/workspace/signrem/rel-250000/masked-pkgtest.db",
].filter(Boolean);
const src = candidates.find((p) => fs.existsSync(p));
if (!src) { console.log("SKIP (set CUSTOMER_NAME_EDIT_FIXTURE_DB to a masked DB copy)"); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cne-patch-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE|OPENAI|DEEPSEEK/i.test(k)) delete process.env[k];
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
process.env.OPENAI_API_KEY ||= "fixture-placeholder-not-a-key";

let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log("ok -", name); };

const FLAG = "flag.customer_name_edit";
let server;

try {
  const db = await import("../src/lib/crm-db.ts");
  const lib = await import("../src/lib/customer-name-edit.ts");
  const { queryRow, queryRows, execute, executeChanges } = db;
  const express = (await import("express")).default;
  const router = (await import("../src/routes/crm.ts")).default;
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
  const now = "2026-11-12T16:00:00.000Z";
  const ownId = 940001;
  const verId = 940002;
  const othId = 940003;
  const seedCustomer = (id, sp, name, first, last, verified) => {
    execute(
      `INSERT INTO customers(id,name,phone,created_at,salesperson_id,status,verification_status,first_name,last_name,
         official_first_name,official_last_name,description)
       VALUES(?,?,?,?,?,'in_progress',?,?,?,?,?,?)`,
      [id, name, `0998${String(id).slice(-7)}`, now, sp, verified ? "verified" : "unverified", first, last,
        verified ? "بهرام" : "رسمی", verified ? "صالحی" : "قدیمی", "یادداشت اولیه"],
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
  const appA = insertApp(950001, ownId, "customer_documents_upload", snapA);
  const appB = insertApp(950002, ownId, "primary_contract_pending_signature", snapB);
  insertApp(950003, verId, "customer_documents_upload", JSON.stringify({ customer_name: "بهرام صالحی" }));
  insertApp(950004, othId, "customer_documents_upload", JSON.stringify({ customer_name: "نگار سلیمی" }));

  const hasGen = queryRow("SELECT 1 x FROM sqlite_master WHERE name='contract_generations'");
  if (hasGen) {
    const templateId = Number(queryRow("SELECT id FROM contract_templates ORDER BY id LIMIT 1")?.id ?? 0);
    const gcols = queryRows("PRAGMA table_info(contract_generations)").map((c) => c.name);
    const grow = {
      id: 960001, template_id: templateId || 1, customer_id: ownId, loan_application_id: appA, status: "signed",
      created_by: admin.id, generation_purpose: "primary", manual_values_json: "{}",
      created_at: now, updated_at: now, mappings_snapshot_json: snapA,
      docx_path: "/tmp/cne-patch-unsigned.docx", pdf_path: "/tmp/cne-patch-unsigned.pdf", docx_sha256: "a".repeat(64), pdf_sha256: "b".repeat(64),
    };
    const keys = Object.keys(grow).filter((k) => gcols.includes(k));
    execute(`INSERT INTO contract_generations(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`, keys.map((k) => grow[k]));
  }

  const contractHash = () => crypto.createHash("sha256").update(JSON.stringify([
    queryRow("SELECT 1 x FROM sqlite_master WHERE name='contract_generations'")
      ? queryRows("SELECT * FROM contract_generations ORDER BY id") : null,
    queryRow("SELECT 1 x FROM sqlite_master WHERE name='contract_templates'")
      ? queryRows("SELECT id, sha256, mappings_json, variables_json, storage_path, deleted_at, updated_at FROM contract_templates ORDER BY id") : null,
    queryRow("SELECT official_first_name, official_last_name, official_father_name, official_address, official_postal_code FROM customers WHERE id=?", [ownId]),
    queryRows("SELECT id, plan_snapshot_json FROM loan_applications WHERE id IN (?,?,?,?) ORDER BY id", [950001, 950002, 950003, 950004]),
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

  const patchName = (id, actor, name, extra = {}) => call("PATCH", `/customers/${id}`, actor, { name, ...extra });

  await ok("flag OFF: old PATCH still allows an unverified owner rename and writes history", async () => {
    const p = await patchName(ownId, "hasani", "سمیرا نادری");
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const row = queryRow("SELECT name, first_name, last_name FROM customers WHERE id=?", [ownId]);
    assert.equal(row.name, "سمیرا نادری");
    assert.equal(row.first_name, "سمیرا");
    assert.equal(row.last_name, "نادری");
    const n = queryRow("SELECT COUNT(*) n FROM customer_name_edits WHERE customer_id=?", [ownId]);
    assert.equal(Number(n.n), 1);
  });

  await ok("flag OFF: verified customer still cannot be renamed on the old path", async () => {
    const p = await patchName(verId, "hasani", "بهرام کاظمی");
    assert.equal(p.status, 409);
    assert.equal(p.body.error, "identity_verified");
    assert.equal(p.body.message, "نام از احراز هویت آمده و قابل ویرایش نیست.");
    const row = queryRow("SELECT name FROM customers WHERE id=?", [verId]);
    assert.equal(row.name, "بهرام صالحی");
  });

  setFlag(true);

  await ok("other expert cannot rename (403 or out of scope) and the name is unchanged", async () => {
    const before = queryRow("SELECT name FROM customers WHERE id=?", [ownId]);
    const p = await patchName(ownId, "kazemi", "سمیه نادری");
    assert.ok(p.status === 403 || p.status === 404, JSON.stringify(p.body));
    if (p.status === 403) assert.equal(p.body.error, "forbidden");
    const row = queryRow("SELECT name FROM customers WHERE id=?", [ownId]);
    assert.equal(row.name, before.name);
  });

  await ok("sales manager and registrar cannot rename", async () => {
    for (const who of ["salesmgr", "registrar"]) {
      const p = await patchName(ownId, who, "سمیه نادری");
      assert.equal(p.status, 403, who + " " + JSON.stringify(p.body));
    }
  });

  await ok("same name on a verified customer still lets other fields save", async () => {
    const p = await patchName(verId, "hasani", "بهرام صالحی", { description: "فقط توضیح" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const row = queryRow("SELECT name, description, verification_status FROM customers WHERE id=?", [verId]);
    assert.equal(row.name, "بهرام صالحی");
    assert.equal(row.description, "فقط توضیح");
    assert.equal(row.verification_status, "verified");
    const n = queryRow("SELECT COUNT(*) n FROM customer_name_edits WHERE customer_id=?", [verId]);
    assert.equal(Number(n.n), 0);
  });

  await ok("Latin / empty full name is rejected", async () => {
    const latin = await patchName(ownId, "hasani", "Samira نادری");
    assert.equal(latin.status, 400);
    const empty = await patchName(ownId, "hasani", "   ");
    assert.equal(empty.status, 400);
  });

  await ok("admin rename writes history on every case and leaves contracts alone", async () => {
    const p = await patchName(ownId, "admin", "سمیرا نادران");
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const row = queryRow("SELECT name, first_name, last_name, official_first_name, official_last_name FROM customers WHERE id=?", [ownId]);
    assert.equal(row.name, "سمیرا نادران");
    assert.equal(row.first_name, "سمیرا");
    assert.equal(row.last_name, "نادران");
    assert.equal(row.official_first_name, "رسمی");
    assert.equal(row.official_last_name, "قدیمی");
    const names = queryRows("SELECT (SELECT name FROM customers WHERE id=loan_applications.customer_id) n FROM loan_applications WHERE id IN (?,?) ORDER BY id", [appA, appB]);
    assert.deepEqual(names.map((r) => r.n), ["سمیرا نادران", "سمیرا نادران"]);
    const hist = queryRows("SELECT application_id, action, reason, actor_id FROM loan_application_stage_history WHERE action=? AND application_id IN (?,?) ORDER BY application_id", ["customer-name-changed", appA, appB]);
    assert.ok(hist.length >= 2);
    const last = hist.filter((h) => JSON.parse(h.reason).newName === "سمیرا نادران");
    assert.equal(last.length, 2);
    assert.equal(contractHash(), contractsBefore);
    const other = queryRow("SELECT name FROM customers WHERE id=?", [othId]);
    assert.equal(other.name, "نگار سلیمی");
  });

  console.log(`customer-patch-name-guard fixture PASS (${passed} checks)`);
} catch (err) {
  console.error("FAIL", err && err.stack ? err.stack : err);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
