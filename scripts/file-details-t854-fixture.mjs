// t854 Armita «جزئیات پرونده‌ی مشتری»: retiree type, معوق rows, خیر exclusivity, old files.
// Throwaway COPY of a masked DB only. Never live, never user 29, no network, no sapi/ICS24.
// Usage: DCI_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/file-details-t854-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.env.DCI_FIXTURE_DB || process.env.CS_FIELDS_FIXTURE_DB || process.env.DOSSIER_FIXTURE_DB;
if (!src) { console.log("SKIP (set DCI_FIXTURE_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t854-cfd-"));
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
globalThis.fetch = async () => { throw new Error("unexpected network call in t854 file-details fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const db = await import("../src/lib/crm-db.ts");
const { queryRow, queryRows, execute } = db;
const dossier = await import("../src/lib/customer-dossier.ts");
const helper = await import("../src/lib/dossier-retiree-overdue.ts");
const { TeamSalesError } = await import("../src/lib/team-sales.ts");

const admin = { id: 1, role: "admin", salespersonId: null, fullName: "admin" };
const pick = (offset = 0) => {
  const rows = queryRows(
    "SELECT id, name FROM customers WHERE id<>29 AND IFNULL(merged_into_customer_id,0)=0 AND lower(name) NOT LIKE '%kazemi%' AND lower(name) NOT LIKE '%کاظمی%' ORDER BY id",
  );
  const row = rows[offset] || rows[0];
  if (!row) throw new Error("no usable customer on masked copy");
  return Number(row.id);
};
const cid = pick(0);
const oid = pick(1);
const oldId = pick(2);
assert.notEqual(cid, 29);
assert.notEqual(oid, 29);
assert.notEqual(oldId, 29);

const base = {
  city: "تهران", amount: "150000000", amount_range: "100m_300m", loan_purpose: "goods",
  documents: ["payslip", "sayadi_cheque"], has_military_card: "yes", can_refer_retiree: "no",
  has_bounced_or_overdue: "no", need_timing: "this_week", credit_rank: "B2",
};

dossier.ensureDossierSchema();
const plansBefore = queryRow("SELECT COUNT(*) AS n FROM loan_plans");
const dossierColsBefore = queryRows("PRAGMA table_info(customer_dossier)").map((c) => c.name).sort();

await ok("خیر exclusivity: چک برگشتی and معوق can both be on; خیر clears both and rows", () => {
  let st = {
    has_cheque_bounced: "", has_overdue: "", has_bounced_or_overdue: "",
    overdue_rows: [{ amount_toman: "15000000", bank: "tejarat", bank_other: "", note: "قسط مهر" }],
  };
  st = { ...st, ...helper.applyBouncedPick(st, "cheque") };
  assert.equal(st.has_cheque_bounced, "yes");
  assert.equal(st.has_overdue, "no");
  assert.equal(st.has_bounced_or_overdue, "yes");
  st = { ...st, ...helper.applyBouncedPick(st, "overdue") };
  assert.equal(st.has_cheque_bounced, "yes");
  assert.equal(st.has_overdue, "yes");
  assert.equal(st.has_bounced_or_overdue, "yes");
  assert.equal(helper.bouncedLabel(st.has_cheque_bounced, st.has_overdue, st.has_bounced_or_overdue), "چک برگشتی، معوق");
  st = { ...st, ...helper.applyBouncedPick(st, "no") };
  assert.equal(st.has_cheque_bounced, "no");
  assert.equal(st.has_overdue, "no");
  assert.equal(st.has_bounced_or_overdue, "no");
  assert.deepEqual(st.overdue_rows, []);
  assert.equal(helper.bouncedLabel(st.has_cheque_bounced, st.has_overdue, st.has_bounced_or_overdue), "خیر");
});

await ok("final save rejects retired customer without a type", () => {
  assert.throws(
    () => dossier.saveDossier(cid, admin, { ...base, job_status: "retired" }, new Date(), { final: true }),
    (e) => e instanceof TeamSalesError && e.status === 400 && e.message === helper.RETIRED_KIND_ERR,
  );
  const r = dossier.saveDossier(cid, admin, { ...base, job_status: "retired" }, new Date(), { final: false });
  assert.equal(r.ok, true);
  assert.equal(r.complete, false);
  const st = dossier.buildDossier(cid, {});
  assert.equal(st.job_status, "retired");
  assert.equal(st.retired_kind, "");
  assert.equal(helper.jobLabel(st.job_status, st.retired_kind, dossier.SITE_JOB_FA), helper.RETIRED_KIND_UNKNOWN);
});

await ok("final save accepts a customer type and shows the exact label", () => {
  const r = dossier.saveDossier(cid, admin, { ...base, job_status: "retired", retired_kind: "tamin" }, new Date(), { final: true });
  assert.equal(r.complete, true);
  const st = dossier.buildDossier(cid, {});
  assert.equal(st.retired_kind, "tamin");
  assert.equal(helper.jobLabel(st.job_status, st.retired_kind, dossier.SITE_JOB_FA), "بازنشسته‌ی تأمین اجتماعی");
});

await ok("guarantor retiree type is mandatory too", () => {
  const gbase = {
    ...base, job_status: "employee", documents: ["payslip", "guarantor"],
    g_job_status: "retired", g_credit_rank: "C1", g_conditions: "چک ضامن",
  };
  assert.throws(
    () => dossier.saveDossier(oid, admin, gbase, new Date(), { final: true }),
    (e) => e instanceof TeamSalesError && e.status === 400 && e.message === helper.RETIRED_KIND_ERR,
  );
  const r = dossier.saveDossier(oid, admin, { ...gbase, g_retired_kind: "military" }, new Date(), { final: true });
  assert.equal(r.complete, true);
  const st = dossier.buildDossier(oid, {});
  assert.equal(st.g_retired_kind, "military");
  assert.equal(helper.jobLabel(st.g_job_status, st.g_retired_kind, dossier.SITE_JOB_FA), "بازنشسته‌ی نیروهای مسلح");
});

await ok("معوق rows: at least one complete amount+bank row; multiple banks allowed", () => {
  const body = {
    ...base, job_status: "employee",
    has_bounced_or_overdue: "yes", has_cheque_bounced: "yes", has_overdue: "yes",
    overdue_rows: [{ amount_toman: "15000000", bank: "", note: "ناقص" }],
  };
  assert.throws(
    () => dossier.saveDossier(cid, admin, body, new Date(), { final: true }),
    (e) => e instanceof TeamSalesError && e.status === 400 && e.message === helper.OVERDUE_ROWS_ERR,
  );
  const r = dossier.saveDossier(cid, admin, {
    ...body,
    job_status: "retired", retired_kind: "civil",
    overdue_rows: [
      { amount_toman: "۱۵۰۰۰۰۰۰", bank: "tejarat", note: "قسط مهر" },
      { amount_toman: "8000000", bank: "mellat", note: "" },
    ],
  }, new Date(), { final: true });
  assert.equal(r.complete, true);
  const st = dossier.buildDossier(cid, {});
  assert.equal(st.has_cheque_bounced, "yes");
  assert.equal(st.has_overdue, "yes");
  assert.equal(st.has_bounced_or_overdue, "yes");
  assert.equal(st.overdue_rows.length, 2);
  assert.equal(st.overdue_rows[0].amount_toman, "15000000");
  assert.equal(st.overdue_rows[0].bank, "tejarat");
  assert.equal(st.overdue_rows[1].bank, "mellat");
  assert.equal(helper.bouncedLabel(st.has_cheque_bounced, st.has_overdue, st.has_bounced_or_overdue), "چک برگشتی، معوق");
});

await ok("old files render: unknown retiree chip and legacy «بله، دارد»", () => {
  const at = new Date().toISOString();
  execute(`DELETE FROM customer_dossier WHERE customer_id=?`, [oldId]);
  execute(
    `INSERT INTO customer_dossier (customer_id, city, amount_toman, credit_rank, answers_json, updated_at, actor_user_id)
     VALUES (?,?,?,?,?,?,?)`,
    [oldId, "قم", 100000000, "A2", JSON.stringify({
      amount_range: "50m_100m", job_status: "retired", documents: ["payslip"],
      has_military_card: "yes", can_refer_retiree: "no", has_bounced_or_overdue: "yes",
      need_timing: "this_week",
    }), at, 1],
  );
  const st = dossier.buildDossier(oldId, {});
  assert.equal(st.job_status, "retired");
  assert.equal(st.retired_kind, "");
  assert.equal(helper.jobLabel(st.job_status, st.retired_kind, dossier.SITE_JOB_FA), helper.RETIRED_KIND_UNKNOWN);
  assert.equal(st.has_bounced_or_overdue, "yes");
  assert.equal(st.has_cheque_bounced, "");
  assert.equal(st.has_overdue, "");
  assert.equal(helper.bouncedLabel(st.has_cheque_bounced, st.has_overdue, st.has_bounced_or_overdue), "بله، دارد");
  assert.equal(dossier.dossierComplete(st), false);
  const card = dossier.enrichFileCard({ customerId: oldId, answers: {}, city: "قم", note: null }, oldId);
  assert.equal(card.dossier.job_status, "retired");
  assert.equal(card.dossier.retired_kind, "");
  assert.equal(card.dossierComplete, false);
  // site-only retired also lands as unknown (wizard itself is unchanged)
});

await ok("plan matching stays on generic بازنشسته; loan_plans and dossier columns are unchanged", async () => {
  const sales = await import("../src/lib/team-sales.ts");
  const profile = sales.latestApplicantProfile(cid);
  assert.equal(profile?.jobType, "retired");
  const st = dossier.buildDossier(cid, {});
  assert.equal(st.retired_kind, "civil");
  const plansAfter = queryRow("SELECT COUNT(*) AS n FROM loan_plans");
  assert.equal(Number(plansAfter.n), Number(plansBefore.n));
  const cols = queryRows("PRAGMA table_info(customer_dossier)").map((c) => c.name).sort();
  assert.deepEqual(cols, dossierColsBefore);
  const names = queryRows("SELECT name FROM loan_plans ORDER BY id").map((r) => r.name);
  assert.ok(Array.isArray(names));
});

console.log(`passed ${passed}`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
