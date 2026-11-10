/**
 * Synthetic multi-case fixture. No live database, no wallet provider, no SMS.
 * Plans use the real product names ترنم and ترنم ( بازنشسته ها ).
 */
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(tmpdir(), "multi-case-fixture-"));
const dbFile = path.join(temp, "synthetic.db");
const database = `
import { DatabaseSync } from 'node:sqlite';
export const crmDb = new DatabaseSync(process.env.MC_FIXTURE_DB);
crmDb.exec('PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, full_name TEXT, username TEXT, salesperson_id INTEGER, telegram_id TEXT)');
export const queryRow = (s, p = []) => crmDb.prepare(s).get(...p);
export const queryRows = (s, p = []) => crmDb.prepare(s).all(...p);
export const execute = (s, p = []) => Number(crmDb.prepare(s).run(...p).lastInsertRowid);
export const executeChanges = (s, p = []) => Number(crmDb.prepare(s).run(...p).changes);
export const runImmediateTransaction = (fn) => {
  crmDb.exec('BEGIN IMMEDIATE');
  try { const r = fn(); crmDb.exec('COMMIT'); return r; }
  catch (e) { try { crmDb.exec('ROLLBACK'); } catch { /* already rolled */ } throw e; }
};
export const runTransaction = runImmediateTransaction;
`;
const worker = `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { crmDb, execute, queryRow } from './src/lib/crm-db';
import * as mc from './src/lib/multi-case';
import { createDraft, ensureLoanRequestDraftSchema, reloadLoanRequestDraftSchema } from './src/lib/loan-request-drafts';
import { expertLockdownGuard, elTarget, elFlagOn } from './src/lib/expert-lockdown';
import { cqRaw } from './src/lib/call-queue';

crmDb.exec(\`
CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, salesperson_id INTEGER, merged_into_customer_id INTEGER, phone TEXT);
CREATE TABLE salespersons(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, full_name TEXT, username TEXT, salesperson_id INTEGER);
CREATE TABLE loan_plans(id INTEGER PRIMARY KEY, name TEXT, active INTEGER, filing_fee_toman TEXT);
CREATE TABLE loan_applications(
  id INTEGER PRIMARY KEY, customer_id INTEGER, plan_id INTEGER, stage TEXT, status TEXT,
  deleted_at TEXT, requested_amount TEXT, created_at TEXT
);
CREATE TABLE loan_filing_fee_charges(
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, plan_id INTEGER, amount_toman TEXT,
  idempotency_key TEXT UNIQUE, application_id INTEGER, actor_user_id INTEGER, actor_customer_id INTEGER, created_at TEXT
);
CREATE TABLE loan_request_drafts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, status TEXT, source TEXT,
  created_by_user_id INTEGER, salesperson_id INTEGER, step INTEGER, payload_json TEXT,
  fee_charge_id INTEGER, application_id INTEGER, version INTEGER, created_at TEXT, updated_at TEXT,
  updated_by_user_id INTEGER, deleted_at TEXT, request_key TEXT
);
CREATE TABLE loan_request_draft_events(id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id INTEGER, customer_id INTEGER, action TEXT, actor_user_id INTEGER, reason TEXT, detail_json TEXT, created_at TEXT);
CREATE TABLE customer_credit_checks(id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, completed_at TEXT);
CREATE TABLE call_queue_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE call_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, subject TEXT, created_at TEXT);
CREATE TABLE reminders(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, subject TEXT, remind_at TEXT, user_id INTEGER);
INSERT INTO customers VALUES(1,'مشتری آزمایشی',11,NULL,'09120000000'),(2,'مشتری دیگر',22,NULL,'09120000001');
INSERT INTO salespersons VALUES(11,'کارشناس آزمایشی'),(22,'کارشناس دیگر');
INSERT INTO users(id,full_name,username,salesperson_id) VALUES(1,'مدیر','admin',NULL),(8,'کارشناس','expert',11),(9,'کارشناس دیگر','other',22);
INSERT INTO loan_plans VALUES(7,'ترنم',1,'1000'),(21,'ترنم ( بازنشسته ها )',1,'1000');
\`);

const admin = { id: 1, role: 'admin', customerScope: 'all', permissions: ['loan_applications.create'], salespersonId: null };
const expert = { id: 8, role: 'salesperson', customerScope: 'assigned', salespersonId: 11, permissions: ['loan_applications.create'] };
const other = { id: 9, role: 'salesperson', customerScope: 'assigned', salespersonId: 22, permissions: ['loan_applications.create'] };
const setFlag = (on) => crmDb.prepare("INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.multi_case_v1',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(on ? '1' : '0');

setFlag(false);
assert.equal(mc.mcFlagOn(1), false, 'flag default off');
assert.equal(mc.mcGlobalOn(), false);
mc.ensureMultiCaseSchema();
ensureLoanRequestDraftSchema();

// Flag off: a second keyed request is stored as a legacy draft (request key ignored) and then conflicts.
const first = createDraft(admin, { customerId: 1, step: 2, payload: { amount: '1000' }, requestKey: 'request-one-legacy' });
assert.equal(first.requestKey, null, 'flag off does not store a request key');
assert.throws(() => createDraft(admin, { customerId: 1, step: 2, payload: {}, requestKey: 'request-two-legacy' }), (e) => e.code === 'draft_exists');

setFlag(true);
assert.equal(mc.mcFlagOn(8), true);
const second = createDraft(admin, { customerId: 1, step: 3, payload: { planId: 21, planName: 'ترنم ( بازنشسته ها )', amount: '2000' }, requestKey: 'request-tarnam-retirees' });
assert.equal(second.requestKey, 'request-tarnam-retirees');
assert.notEqual(second.id, first.id);
assert.throws(() => createDraft(admin, { customerId: 1, step: 3, payload: {}, requestKey: 'request-tarnam-retirees' }), (e) => e.code === 'draft_exists');
const open = queryRow('SELECT COUNT(*) n FROM loan_request_drafts WHERE customer_id=1 AND deleted_at IS NULL');
assert.equal(Number(open.n), 2, 'two open drafts for one customer');

// Two plans can be reserved. The second same-plan reserve conflicts and inserts no charge.
const fee = (customerId, planId, key) => mc.runImmediateTransaction?.() ;
mc.reserveOpenPlan(1, 7);
mc.bindSlotCharge(1, 7, execute("INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(?,?,?,?,?)", [1, 7, '1000', 'fee-tarnam-1', new Date().toISOString()]));
mc.reserveOpenPlan(1, 21);
mc.bindSlotCharge(1, 21, execute("INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(?,?,?,?,?)", [1, 21, '1000', 'fee-retire-1', new Date().toISOString()]));
assert.equal(queryRow('SELECT COUNT(*) n FROM loan_filing_fee_charges').n, 2);
let clash;
try { mc.reserveOpenPlan(1, 7); } catch (e) { clash = e; }
assert.equal(clash?.message, 'open_same_plan_case');
assert.equal(clash.held, 'request');
assert.equal(queryRow('SELECT COUNT(*) n FROM loan_filing_fee_charges').n, 2, 'conflict does not add a fee');

const app1 = execute("INSERT INTO loan_applications(customer_id,plan_id,stage,status,requested_amount,created_at) VALUES(1,7,'draft','requested','5000000',?)", [new Date().toISOString()]);
mc.claimSlotForApplication(1, 7, queryRow('SELECT id FROM loan_filing_fee_charges WHERE idempotency_key=?','fee-tarnam-1'.includes('x') ? '' : 'fee-tarnam-1').id, app1);
execute("UPDATE loan_filing_fee_charges SET application_id=? WHERE idempotency_key='fee-tarnam-1'", [app1]);
const app2 = execute("INSERT INTO loan_applications(customer_id,plan_id,stage,status,requested_amount,created_at) VALUES(1,21,'draft','requested','8000000',?)", [new Date().toISOString()]);
mc.claimSlotForApplication(1, 21, queryRow("SELECT id FROM loan_filing_fee_charges WHERE idempotency_key='fee-retire-1'").id, app2);
try { mc.claimSlotForApplication(1, 7, 999, app2 + 50); assert.fail('second open same plan must conflict'); }
catch (e) { assert.equal(e.message, 'open_same_plan_case'); assert.equal(e.held, 'case'); assert.equal(e.applicationId, app1); assert.equal(e.planName, 'ترنم'); }

// Closing the case releases the plan. A later case gets its own fee.
execute("UPDATE loan_applications SET status='rejected' WHERE id=?", [app1]);
assert.equal(queryRow('SELECT COUNT(*) n FROM loan_plan_open_slots WHERE plan_id=7').n, 0, 'trigger released the slot');
assert.equal(mc.findOpenSamePlan(1, 7), undefined);
mc.reserveOpenPlan(1, 7);
const fee2 = execute("INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(1,7,'1000','fee-tarnam-2',?)", [new Date().toISOString()]);
mc.bindSlotCharge(1, 7, fee2);
assert.notEqual(fee2, queryRow("SELECT id FROM loan_filing_fee_charges WHERE idempotency_key='fee-tarnam-1'").id);

// Fee 0 does not need a charge row. Fee above 0 still does, and that charge stays on its own plan.
assert.equal(mc.planRequiresFilingFee('0'), false);
assert.equal(mc.planRequiresFilingFee(0), false);
assert.equal(mc.planRequiresFilingFee('300000'), true);
assert.equal(mc.planRequiresFilingFee(''), true);
assert.equal(mc.planRequiresFilingFee('12a'), true);
const beforeZero = queryRow('SELECT COUNT(*) n FROM loan_filing_fee_charges').n;
mc.reserveOpenPlan(2, 99);
const appZero = execute("INSERT INTO loan_applications(customer_id,plan_id,stage,status,requested_amount,created_at) VALUES(2,99,'draft','requested','1000000',?)", [new Date().toISOString()]);
mc.claimSlotForApplication(2, 99, null, appZero);
assert.equal(queryRow('SELECT COUNT(*) n FROM loan_filing_fee_charges').n, beforeZero, 'fee 0 does not insert a charge');
assert.equal(queryRow('SELECT application_id FROM loan_plan_open_slots WHERE customer_id=2 AND plan_id=99').application_id, appZero);
assert.equal(queryRow('SELECT charge_id FROM loan_plan_open_slots WHERE customer_id=2 AND plan_id=99').charge_id, null);
try { mc.reserveOpenPlan(2, 99); assert.fail('a second open zero-fee case on the same plan must conflict'); }
catch (e) { assert.equal(e.message, 'open_same_plan_case'); }
mc.reserveOpenPlan(2, 98);
const paid = execute("INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(2,98,'300000','fee-positive',?)", [new Date().toISOString()]);
mc.bindSlotCharge(2, 98, paid);
const appPaid = execute("INSERT INTO loan_applications(customer_id,plan_id,stage,status,requested_amount,created_at) VALUES(2,98,'draft','requested','1000000',?)", [new Date().toISOString()]);
mc.claimSlotForApplication(2, 98, paid, appPaid);
execute("UPDATE loan_filing_fee_charges SET application_id=? WHERE id=?", [appPaid, paid]);
assert.equal(queryRow('SELECT amount_toman, application_id FROM loan_filing_fee_charges WHERE id=?', [paid]).amount_toman, '300000');
assert.equal(queryRow('SELECT application_id FROM loan_filing_fee_charges WHERE id=?', [paid]).application_id, appPaid, 'fee above 0 keeps its own charge');

// A template-excluded plan is rejected, stays out of the 30-day top 3, and sorts last.
assert.equal(mc.newCasePlanBlock(false), 'plan_not_selectable');
assert.equal(mc.newCasePlanBlock(true), null);
const recentAt = new Date().toISOString();
const oldAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
const addCase = (planId, at) => execute("INSERT INTO loan_applications(customer_id,plan_id,stage,status,requested_amount,created_at) VALUES(2,?,'draft','requested','1000',?)", [planId, at]);
for (let i = 0; i < 5; i++) addCase(17, recentAt);
addCase(30, recentAt);
addCase(31, recentAt); addCase(31, recentAt);
addCase(32, recentAt);
for (let i = 0; i < 9; i++) addCase(40, oldAt);
const top = mc.popularPlanIds([30, 31, 32, 40]);
assert.deepEqual(top, [31, 30, 32], 'top 3 is the last 30 days, and plan 17 is not counted');
assert.equal(top.includes(17), false);
assert.equal(top.includes(40), false, 'cases older than 30 days are not in the top 3');
const order = mc.orderMultiCasePlanIds([9, 30, 17, 31, 32, 1], [17, 31, 30, 32], [17, 1]);
assert.deepEqual(order, [9, 31, 30, 32, 17, 1]);
assert.equal(order.at(-1), 1);
assert.ok(order.indexOf(17) > order.indexOf(32), 'disabled plans sit after the active plans and the top 3');
assert.equal(order.filter((id) => id === 17).length, 1, 'an unready plan is not also kept in the top 3');

// Case link ownership. Missing choice stays general.
const caseId = app2;
assert.equal(mc.resolveCaseLink(expert, 1, {}), null);
assert.equal(mc.resolveCaseLink(expert, 1, { caseScope: 'general' }), null);
assert.equal(mc.resolveCaseLink(expert, 1, { loanApplicationId: caseId, caseScope: 'case' }), caseId);
assert.throws(() => mc.resolveCaseLink(other, 1, { loanApplicationId: caseId }), (e) => e.message === 'case_not_found' && e.status === 404);
assert.throws(() => mc.resolveCaseLink(expert, 2, { loanApplicationId: caseId }), (e) => e.message === 'case_customer_mismatch' && e.status === 409);
assert.throws(() => mc.resolveCaseLink(expert, 1, { loanApplicationId: 99999 }), (e) => e.message === 'case_not_found');
assert.equal(mc.customerVisible(expert, 1), true);
assert.equal(mc.customerVisible(expert, 2), false);
assert.equal(mc.customerVisible({ id: 3, role: 'registrar', customerScope: 'all', salespersonId: null }, 2), true);

// Concurrent reserve: the open write lock makes the second insert fail closed.
const childCode = \`
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.MC_FIXTURE_DB);
db.exec('PRAGMA busy_timeout=200');
try {
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO loan_plan_open_slots(customer_id,plan_id,created_at) VALUES(2,7,?)').run(new Date().toISOString());
  db.exec('COMMIT');
  console.log('inserted');
} catch (e) {
  console.log('blocked:' + (e && e.message ? e.message : e));
}
\`;
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
writeFileSync(process.env.MC_CHILD, childCode);
crmDb.exec('BEGIN IMMEDIATE');
execute("INSERT INTO loan_plan_open_slots(customer_id,plan_id,created_at) VALUES(2,21,?)", [new Date().toISOString()]);
const child = spawnSync(process.execPath, [process.env.MC_CHILD], { env: process.env, encoding: 'utf8' });
const out = (child.stdout || '') + (child.stderr || '');
assert.match(out, /blocked:/, out);
crmDb.exec('ROLLBACK');
const after = spawnSync(process.execPath, [process.env.MC_CHILD], { env: process.env, encoding: 'utf8' });
assert.match(after.stdout || '', /inserted/);
assert.equal(queryRow('SELECT COUNT(*) n FROM loan_plan_open_slots WHERE customer_id=2 AND plan_id=7').n, 1);

crmDb.exec(\`ALTER TABLE reminders ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN registered_by INTEGER;
INSERT INTO salespersons VALUES(6,'کاظمی آزمایشی'),(3,'حسنی آزمایشی');
INSERT INTO customers(id,name,salesperson_id,merged_into_customer_id,phone) VALUES(3,'مشتری قفل کاظمی',6,NULL,'09120000031'),(4,'مشتری قفل حسنی',3,NULL,'09120000032');
INSERT INTO loan_applications(customer_id,plan_id,stage,status,requested_amount,created_at) VALUES(3,7,'draft','requested','1000','2026-11-10T00:00:00Z'),(4,21,'draft','requested','1000','2026-11-10T00:00:00Z');
INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.expert_lockdown','1',datetime('now'));
\`);
const lockHit = (user, path) => {
  let status = 200, body = null, next = false;
  const res = { locals: { authUser: user }, status(code) { status = code; return this; }, json(payload) { body = payload; return this; } };
  expertLockdownGuard({ method: 'GET', path, query: {}, body: {} }, res, () => { next = true; });
  return { status, body, next };
};
const kazemi = { id: 8, role: 'salesperson', salespersonId: 6 };
const hasani = { id: 2, role: 'salesperson', salespersonId: 3 };
const registrar = { id: 7, role: 'registrar', customerScope: 'all', salespersonId: null };
assert.equal(lockHit(kazemi, '/multi-case/status').next, true, 'status is open for a locked expert');
assert.equal(lockHit(kazemi, '/multi-case/customers/3').next, true, 'assigned expert');
const denied = lockHit(hasani, '/multi-case/customers/3');
let cqErr = '';
try { cqRaw('flag.expert_lockdown'); } catch (e) { cqErr = e && e.message ? e.message : String(e); }
if (denied.next) throw new Error(JSON.stringify({ target: elTarget(hasani), flagOn: elFlagOn(), cqErr }));
assert.equal(denied.next, false, 'other expert');
assert.equal(denied.status, 403);
assert.ok(denied.body && (denied.body.error === 'expert_lockdown_customer' || denied.body.error === 'expert_lockdown'));
const lockedCase = queryRow('SELECT id FROM loan_applications WHERE customer_id=3').id;
assert.equal(lockHit(kazemi, '/multi-case/cases/' + lockedCase).next, true, 'assigned expert case');
assert.equal(lockHit(hasani, '/multi-case/cases/' + lockedCase).status, 403, 'other expert case');
assert.equal(lockHit(registrar, '/multi-case/customers/3').next, true, 'registrar is not locked');
assert.equal(mc.customerVisible(registrar, 3), true);
assert.equal(mc.customerVisible({ id: 7, role: 'registrar', customerScope: 'assigned', salespersonId: 99 }, 3), false, 'registrar assigned scope unchanged');

crmDb.exec("DROP INDEX IF EXISTS idx_loan_request_drafts_one_open; DROP INDEX IF EXISTS idx_loan_request_drafts_one_legacy; DROP INDEX IF EXISTS idx_loan_request_drafts_request;");
reloadLoanRequestDraftSchema();
assert.equal(queryRow("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_loan_request_drafts_one_open'"), undefined, 'boot must not recreate the one-open-draft index');
assert.ok(queryRow("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_loan_request_drafts_one_legacy'"), 'legacy null-key index');
const stillTwo = queryRow('SELECT COUNT(*) n FROM loan_request_drafts WHERE customer_id=1 AND deleted_at IS NULL');
assert.equal(Number(stillTwo.n), 2, 'two open drafts survive a schema reload');

console.log('PASS multi-case fixture: flag off legacy draft, two plans, same-plan conflict, separate fees, close-and-reopen, expert/registrar scope, lockdown, draft-schema restart, concurrent slot');
`;
// The claim line above has a silly ternary. I'll fix the worker source before build.
const fixed = worker.replace(
  `mc.claimSlotForApplication(1, 7, queryRow('SELECT id FROM loan_filing_fee_charges WHERE idempotency_key=?','fee-tarnam-1'.includes('x') ? '' : 'fee-tarnam-1').id, app1);`,
  `mc.claimSlotForApplication(1, 7, queryRow("SELECT id FROM loan_filing_fee_charges WHERE idempotency_key='fee-tarnam-1'").id, app1);`,
);
const childPath = path.join(temp, "child.mjs");
await writeFile(path.join(temp, "worker.ts"), fixed);
const output = path.join(temp, "fixture.mjs");
try {
  await build({
    stdin: { contents: fixed, resolveDir: root, sourcefile: "multi-case-fixture.ts", loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
    banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    plugins: [{ name: "synthetic-db", setup(ctx) {
      ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
      ctx.onLoad({ filter: /^db$/, namespace: "fixture" }, () => ({ contents: database, loader: "js" }));
      ctx.onLoad({ filter: /\/routes\/simotel-recordings\.ts$/ }, () => ({ contents: "export function authorizedVoipRecording(){return null}", loader: "js" }));
      ctx.onResolve({ filter: /^(express|pino|@workspace\/)/ }, (args) => ({ path: args.path, namespace: "stub" }));
      ctx.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
        loader: "js",
        contents: args.path === "pino"
          ? "export default function pino(){const l={info(){},warn(){},error(){},debug(){},child(){return l},fatal(){}};return l}"
          : "const z=new Proxy(function(){},{get:()=>z,apply:()=>z}); export default z; export {z};",
      }));
    } }],
  });
  const result = spawnSync(process.execPath, [output], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, MC_FIXTURE_DB: dbFile, MC_CHILD: childPath, SESSION_SECRET: "fixture-secret" },
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) throw new Error(`multi-case fixture failed (${result.status})`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
