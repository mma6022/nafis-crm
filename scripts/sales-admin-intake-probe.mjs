// «مدیریت فروش» v1.2 intake probe (t358s1318 §1): on a COPY of the given DB, creates new customers through the real create path
// (insertCustomerRecord, the same one every intake uses) for every registration source × priority × registrar, plus the portal owner
// and the staff-form decision, and prints who owns each one. Used by sales-admin-merge-fixture to prove "exactly as today".
// Usage: SMC_FIXTURE_DB=/path/copy.db node scripts/run-bundled-fixture.mjs scripts/sales-admin-intake-probe.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const src = process.env.SMC_FIXTURE_DB;
if (!src || fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") { console.error("refusing: no DB or live DB"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sam-probe-")); const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "silent", DP_TEST_NO_BELLS: "1",
  SESSION_SECRET: `probe-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789` });
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9"; process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "probe-placeholder";
globalThis.fetch = async () => { throw new Error("no network in probe"); };
try {
  const db = await import("../src/lib/crm-db.ts");
  await import("../src/routes/index.ts"); // same module graph as the server (installs the intake hook exactly like production)
  const cc = await import("../src/lib/customer-create.ts");
  const pf = await import("../src/lib/customer-portal-features.ts");
  const dor = await import("../src/lib/default-owner-rule.ts");
  const out = { owners: {}, decisions: {}, portal: null, history: null };
  let i = 0;
  for (const s of ["staff_form", "site_lead", "site_callback", "instagram", "instagram_auto", "portal", "assistant", "api"]) for (const pri of [null, 1, 2, 3]) for (const reg of [null, 1, 2, 7, 8]) {
    try {
      const id = cc.insertCustomerRecord({ name: "probe", phone: `0900${String(9000000 + i++)}`, priority: pri, registeredByUserId: reg, registrationSource: s });
      out.owners[`${s}/${pri ?? "-"}/${reg ?? "-"}`] = db.queryRow("SELECT salesperson_id sp FROM customers WHERE id=?", [id]).sp;
    } catch (e) { out.owners[`${s}/${pri ?? "-"}/${reg ?? "-"}`] = `ERR:${String(e?.message ?? e).slice(0, 60)}`; }
  }
  for (const s of ["staff_form", "portal", "site_lead"]) for (const reg of [null, 1, 2, 8]) {
    const d = dor.defaultOwnerDecision(s, reg); out.decisions[`${s}/${reg ?? "-"}`] = d.apply ? { owner: d.ownerSalespersonId, via: d.via ?? "rule" } : { skip: d.skip };
  }
  out.portal = pf.portalNewCustomerOwner();
  out.history = db.queryRows("SELECT source, COUNT(*) n FROM customer_priority_history WHERE customer_id IN (SELECT id FROM customers WHERE name='probe') GROUP BY source ORDER BY source");
  console.log("PROBE " + JSON.stringify(out));
} catch (e) { console.error("probe failed", e); process.exitCode = 1; }
finally { fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(process.exitCode ?? 0), 20); }
