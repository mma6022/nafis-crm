// Tests scripts/remove-deposit-collateral.mjs on a temp-file copy of a synthetic DB (never a real one).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planRemoval, applyRemoval, MARKER } from "./remove-deposit-collateral.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "remove-deposit-collateral.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "rm-deposit-"));
const dbFile = path.join(dir, "customers.db");
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const seed = new DatabaseSync(dbFile);
seed.exec(`
  CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE consult_options (id INTEGER PRIMARY KEY AUTOINCREMENT, field_key TEXT, option_value TEXT, label_fa TEXT, sort_order INTEGER, active INTEGER, UNIQUE(field_key, option_value));
  INSERT INTO consult_options(field_key,option_value,label_fa,sort_order,active) VALUES
    ('collateral_type','none','بدون وثیقه',1,1), ('collateral_type','promissory','سفته',4,1),
    ('collateral_type','deposit','legacy label',8,1), ('guarantor_collateral_type','deposit','legacy label',8,1),
    ('custom_field','deposit','custom',1,1), ('collateral_type','property','سند ملکی',6,0);
  CREATE TABLE loan_plans (id INTEGER PRIMARY KEY, name TEXT, active INTEGER, collateral_type TEXT, guarantor_collateral_type TEXT,
    customer_check TEXT, guarantor_check TEXT, needs_customer_check INTEGER, needs_customer_promissory INTEGER, needs_customer_salary_deduct INTEGER,
    needs_guarantor_check INTEGER, needs_guarantor_promissory INTEGER, needs_guarantor_salary_deduct INTEGER, deposit_percents TEXT);
  INSERT INTO loan_plans VALUES
    (1,'A',1,'deposit',NULL,NULL,NULL,0,1,0,0,0,0,'{"12":"80"}'),         -- other flag (promissory) → cleared
    (2,'B',1,'deposit',NULL,NULL,NULL,0,0,0,0,0,0,'{"12":"80"}'),         -- only collateral → manual review
    (3,'C',0,'property','["deposit","promissory"]',NULL,NULL,0,0,0,0,0,0,NULL), -- list → trimmed
    (4,'D',1,'physical_check','promissory',NULL,NULL,1,0,0,0,0,0,'{"12":"75"}'); -- untouched
  CREATE TABLE loan_plan_conditions (id INTEGER PRIMARY KEY, plan_id INTEGER, collateral_type TEXT, guarantor_collateral_type TEXT,
    needs_customer_check INTEGER, needs_customer_promissory INTEGER, needs_customer_salary_deduct INTEGER,
    needs_guarantor_check INTEGER, needs_guarantor_promissory INTEGER, needs_guarantor_salary_deduct INTEGER, needs_guarantor INTEGER);
  INSERT INTO loan_plan_conditions VALUES
    (10,1,'deposit',NULL,1,0,0,0,0,0,0),     -- other flag (check) → cleared
    (11,2,'deposit',NULL,0,0,0,0,0,0,0),     -- manual review
    (12,4,'promissory','deposit',0,0,0,0,0,0,1), -- guarantor side: nothing else → manual review
    (13,4,'salary_deduction',NULL,0,0,1,0,0,0,0); -- untouched
  CREATE TABLE consultation_forms (id INTEGER PRIMARY KEY, collateral_type TEXT, guarantor_collateral_type TEXT);
  INSERT INTO consultation_forms VALUES (100,'deposit',NULL),(101,'promissory',NULL);
  CREATE TABLE loan_application_collateral (id INTEGER PRIMARY KEY, application_id INTEGER, collateral_type TEXT, status TEXT);
  INSERT INTO loan_application_collateral VALUES (200,1,'deposit','approved'),(201,1,'check','submitted');
  CREATE TABLE loan_applications (id INTEGER PRIMARY KEY, plan_snapshot_json TEXT);
  INSERT INTO loan_applications VALUES (300,'{"collateral_type":"deposit","deposit_percents":"{}"}'),(301,'{"deposit_percents":"{\\"12\\":80}"}');
`);
seed.close();
const dump = (f) => { const d = new DatabaseSync(f, { readOnly: true }); const o = {};
  for (const t of ["consult_options", "loan_plans", "loan_plan_conditions", "consultation_forms", "loan_application_collateral", "loan_applications", "schema_migrations"])
    o[t] = d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map((r) => ({ ...r })); d.close(); return o; };
const before = dump(dbFile);

// CLI: --db is required
assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2, "no --db → usage error");
assert.equal(spawnSync(process.execPath, [script, "--apply"], { encoding: "utf8" }).status, 2, "--apply without --db → usage error");

// Dry run writes nothing (byte-identical file) and reports the plan
const h0 = sha(dbFile);
const dry = execFileSync(process.execPath, [script, "--db", dbFile], { encoding: "utf8" });
assert.equal(sha(dbFile), h0, "dry run is byte-identical");
assert.match(dry, /Dry run: nothing written/);
const plan = JSON.parse(dry.slice(0, dry.lastIndexOf("}") + 1)).plan;
assert.deepEqual(plan.options.deactivate.map((o) => o.id), [3, 4]);
assert.deepEqual(plan.options.review.map((o) => o.id), [5]);
assert.deepEqual(plan.rows.clear.map((r) => `${r.table}:${r.id}:${r.column}`), ["loan_plans:1:collateral_type", "loan_plan_conditions:10:collateral_type"]);
assert.deepEqual(plan.rows.trimList.map((r) => `${r.table}:${r.id}:${r.column}=${r.to}`), ['loan_plans:3:guarantor_collateral_type=["promissory"]']);
assert.deepEqual(plan.rows.review.map((r) => `${r.table}:${r.id}:${r.column}`), ["loan_plans:2:collateral_type", "loan_plan_conditions:11:collateral_type", "loan_plan_conditions:12:guarantor_collateral_type"]);
assert.deepEqual(plan.untouched, { consultation_forms: [100], loan_application_collateral: [200], loan_applications_plan_snapshot: [300] });

// Apply: backup first, then changes
const bak = path.join(dir, "backup.db");
const out = execFileSync(process.execPath, [script, "--db", dbFile, "--apply", "--backup", bak], { encoding: "utf8" });
assert.match(out, /Backup written and verified/);
assert.deepEqual(dump(bak), before, "backup holds the original data");
const after = dump(dbFile);
const opt = Object.fromEntries(after.consult_options.map((r) => [r.id, r]));
assert.equal(opt[3].active, 0); assert.equal(opt[4].active, 0); assert.equal(opt[3].label_fa, "legacy label", "row kept, label kept");
assert.equal(opt[5].active, 1, "unknown field_key only reviewed");
assert.equal(after.consult_options.length, before.consult_options.length, "nothing deleted");
const lp = Object.fromEntries(after.loan_plans.map((r) => [r.id, r]));
assert.equal(lp[1].collateral_type, null); assert.equal(lp[2].collateral_type, "deposit", "review rows unchanged");
assert.equal(lp[3].guarantor_collateral_type, '["promissory"]'); assert.deepEqual(lp[4], before.loan_plans[3]);
assert.equal(lp[1].deposit_percents, '{"12":"80"}', "payout percent field untouched");
const pc = Object.fromEntries(after.loan_plan_conditions.map((r) => [r.id, r]));
assert.equal(pc[10].collateral_type, null); assert.equal(pc[11].collateral_type, "deposit"); assert.equal(pc[12].guarantor_collateral_type, "deposit");
assert.deepEqual(pc[13], before.loan_plan_conditions[3]);
for (const t of ["consultation_forms", "loan_application_collateral", "loan_applications"]) assert.deepEqual(after[t], before[t], `${t} untouched`);
assert.deepEqual(after.schema_migrations.map((r) => r.version), [MARKER]);

// Idempotent: second --apply makes no change and takes no backup
const h1 = sha(dbFile);
const again = execFileSync(process.execPath, [script, "--db", dbFile, "--apply", "--backup", path.join(dir, "backup2.db")], { encoding: "utf8" });
assert.match(again, /Already applied/); assert.equal(sha(dbFile), h1); assert(!existsSync(path.join(dir, "backup2.db")));
// Even if the marker were missing, re-planning finds nothing left to auto-change
const copy = path.join(dir, "copy.db"); copyFileSync(dbFile, copy);
const c = new DatabaseSync(copy); c.exec(`DELETE FROM schema_migrations`); const p2 = planRemoval(c);
assert.equal(p2.options.deactivate.length + p2.rows.clear.length + p2.rows.trimList.length, 0, "no auto changes left");
assert.equal(applyRemoval(c).changed, 0); c.close();
// Refuses to overwrite an existing backup path
const d2 = path.join(dir, "fresh.db"); copyFileSync(bak, d2);
const r = spawnSync(process.execPath, [script, "--db", d2, "--apply", "--backup", bak], { encoding: "utf8" });
assert.notEqual(r.status, 0); assert.deepEqual(dump(d2), before, "nothing changed when backup fails");
rmSync(dir, { recursive: true, force: true });
console.log("remove-deposit-collateral: ok");
