// v2.0 customer_dossier: additive columns, merge of site/simple/callback, partial save.
// Throwaway COPY of a masked DB only. Never live, never user 29, no network.
// Usage: DCI_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/customer-dossier-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.env.DCI_FIXTURE_DB || process.env.CS_FIELDS_FIXTURE_DB || process.env.DOSSIER_FIXTURE_DB;
if (!src) { console.log("SKIP (set DCI_FIXTURE_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dossier-fx-"));
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
globalThis.fetch = async () => { throw new Error("unexpected network call in dossier fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const db = await import("../src/lib/crm-db.ts");
const { queryRow, queryRows, execute } = db;
const dossier = await import("../src/lib/customer-dossier.ts");
const { TeamSalesError } = await import("../src/lib/team-sales.ts");

const admin = { id: 1, role: "admin", salespersonId: null, fullName: "admin" };
// Pick a customer that is not 29 and not named kazemi.
const cust = queryRow("SELECT id, name FROM customers WHERE id<>29 AND IFNULL(merged_into_customer_id,0)=0 AND lower(name) NOT LIKE '%kazemi%' AND lower(name) NOT LIKE '%کاظمی%' ORDER BY id LIMIT 1");
if (!cust) throw new Error("no usable customer on masked copy");
const cid = Number(cust.id);

await ok("new table is created additively and existing customers columns stay", () => {
  dossier.ensureDossierSchema();
  const row = queryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name='customer_dossier'");
  assert.ok(row?.sql);
  assert.match(row.sql, /amount_toman/);
  assert.match(row.sql, /customer_note/);
  const cols = queryRows("PRAGMA table_info(customers)").map((c) => c.name);
  // we must not have rebuilt customers
  assert.ok(cols.includes("id") && cols.includes("name"));
});

await ok("partial save does not require first-call required fields; columns are nullable", () => {
  const r = dossier.saveDossier(cid, admin, { city: "قم" });
  assert.equal(r.ok, true);
  assert.equal(r.complete, false);
  assert.equal(r.partial, true);
  const st = dossier.buildDossier(cid, {});
  assert.equal(st.city, "قم");
  const row = queryRow("SELECT city, amount_toman, credit_rank, customer_note FROM customer_dossier WHERE customer_id=?", [cid]);
  assert.equal(row.city, "قم");
  assert.equal(row.amount_toman, null);
  assert.equal(row.credit_rank, null);
  assert.equal(row.customer_note, null);
});

await ok("final save stores §5.2 fields and documents in answers_json; guarantor extras only with guarantor", () => {
  const body = {
    city: "تهران", amount: "350000000", amount_range: "100m_300m", loan_purpose: "goods",
    job_status: "employee", documents: ["payslip", "salary_deduction_cert", "sayadi_cheque", "guarantor"],
    has_military_card: "yes", can_refer_retiree: "no", has_bounced_or_overdue: "no", need_timing: "this_week",
    credit_rank: "B2", g_job_status: "employee", g_credit_rank: "C1", g_conditions: "چک ضامن",
    customer_note: "یادداشت مشتری", note: "یادداشت کارشناس",
  };
  const r = dossier.saveDossier(cid, admin, body);
  assert.equal(r.complete, true);
  const st = dossier.buildDossier(cid, {});
  assert.equal(st.amount, "350000000");
  assert.equal(st.credit_rank, "B2");
  assert.equal(st.g_job_status, "employee");
  assert.equal(st.g_credit_rank, "C1");
  assert.equal(st.g_conditions, "چک ضامن");
  assert.equal(st.customer_note, "یادداشت مشتری");
  assert.equal(st.note, "یادداشت کارشناس");
  assert.ok(st.documents.includes("guarantor") && st.documents.includes("salary_deduction_cert"));
});

await ok("invalid enum is rejected; existing columns on other tables are not written", () => {
  assert.throws(() => dossier.saveDossier(cid, admin, { credit_rank: "Z9" }), (e) => e instanceof TeamSalesError && e.status === 400);
  const plans = queryRow("SELECT COUNT(*) AS n FROM loan_plans");
  dossier.saveDossier(cid, admin, { city: "کرج", amount_range: "up_to_50m" });
  const plans2 = queryRow("SELECT COUNT(*) AS n FROM loan_plans");
  assert.equal(Number(plans.n), Number(plans2.n));
});

await ok("simple-form need does not fill loan_purpose; amountBand and contactTime are extras; plan name comes from loan_plans", () => {
  const other = queryRow("SELECT id FROM customers WHERE id<>? AND id<>29 AND IFNULL(merged_into_customer_id,0)=0 ORDER BY id LIMIT 1", [cid]);
  const oid = Number(other.id);
  execute(`CREATE TABLE IF NOT EXISTS public_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT 'website', customer_id INTEGER,
    outcome TEXT NOT NULL DEFAULT 'new_customer', name TEXT NOT NULL, phone TEXT NOT NULL,
    need TEXT NOT NULL, amount_band TEXT NOT NULL, plan_id INTEGER, term INTEGER, contact_time TEXT NOT NULL,
    src TEXT, ip_hash TEXT, created_at TEXT NOT NULL
  )`);
  let plan = null;
  try { plan = queryRow("SELECT id, name FROM loan_plans WHERE name IS NOT NULL AND trim(name)<>'' LIMIT 1"); } catch {}
  execute(
    `INSERT INTO public_leads (customer_id, outcome, name, phone, need, amount_band, plan_id, term, contact_time, ip_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [oid, "existing_customer", "نمونه", "00000000000", "cash", "100-300", plan?.id ?? null, 12, "morning", "x", new Date().toISOString()],
  );
  const st = dossier.buildDossier(oid, {});
  assert.equal(st.need, "cash");
  assert.equal(st.loan_purpose, "", "need must not map to loan_purpose");
  assert.equal(st.amountBand, "100-300");
  assert.equal(st.contactTime, "morning");
  assert.equal(st.term, "12");
  if (plan) assert.equal(st.planName, plan.name);
  else assert.equal(st.planName, "");
});

await ok("enrichFileCard is additive and keeps legacy answers/complete fields", () => {
  const base = { customerId: cid, answers: { amountMillion: 10, urgency: "now" }, city: "قدیم", note: null, complete: false, missing: ["docsReady"] };
  const out = dossier.enrichFileCard(base, cid);
  assert.equal(out.complete, false);
  assert.deepEqual(out.missing, ["docsReady"]);
  assert.ok(out.dossier);
  assert.equal(typeof out.dossierComplete, "boolean");
  assert.ok(out.answers.amountMillion === 10 || out.answers.amount_toman);
});

console.log(`passed ${passed}`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
