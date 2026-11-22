// t874 (Mohammad t874s3003): admin stage correction that sends a case back before the final funder decision clears
// funder_decision / funder_reason / expert_reviewed_at (old values in the audit 'before'), so expert-approve can record
// the new decision. Forward / decision-dependent corrections are unchanged. Throwaway COPY of a masked DB only; never live,
// no network. Usage: T874_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t874-admin-stage-decision-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.env.T874_FIXTURE_DB;
if (!src) { console.log("SKIP (set T874_FIXTURE_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db" || fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t874-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, CONTRACTS_STORAGE_DIR: path.join(dir, "contracts"), NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
globalThis.fetch = async () => { throw new Error("unexpected network call in t874 fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const { queryRow, executeChanges } = await import("../src/lib/crm-db.ts");
const router = (await import("../src/routes/loan-applications.ts")).default;

const admin = (() => {
  const u = queryRow("SELECT id,username,full_name,role,salesperson_id FROM users WHERE role='admin' AND active=1 AND id<>29 ORDER BY id LIMIT 1");
  return { id: u.id, username: u.username, fullName: u.full_name, mobile: null, telegramId: null, priorityColors: {}, role: "admin", roleName: "admin",
    permissions: ["loan_applications.view", "loan_applications.update", "loan_applications.review"], customerScope: "all",
    salespersonId: u.salesperson_id, salespersonName: null, active: true, createdAt: new Date().toISOString() };
})();
const route = (method, p) => {
  const l = router.stack.find(x => x.route?.path === p && x.route.methods[method]);
  assert.ok(l, `${method} ${p}`); return l.route.stack[l.route.stack.length - 1].handle;
};
const call = async (method, p, id, body = {}) => {
  let status = 200, json = null; const headers = {};
  const res = { locals: { authUser: admin }, setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; },
    status(s) { status = s; return this; }, json(b) { json = b; return this; }, send(b) { json = b; return this; } };
  await route(method, p)({ params: { id: String(id) }, body, query: {}, headers: {}, log: { warn() {}, info() {}, error() {} } }, res);
  return { status, json };
};
const row = (id) => queryRow("SELECT * FROM loan_applications WHERE id=?", [id]);
const fixed = (a) => ({ stage: a.stage, status: a.status, approved_amount: a.approved_amount, net_amount: a.net_amount, duration_months: a.duration_months,
  current_primary_generation_id: a.current_primary_generation_id, approved_amount_generation_id: a.approved_amount_generation_id,
  initial_approval_at: a.initial_approval_at, plan_id: a.plan_id });
const revisionOf = async (id) => { const r = await call("get", "/loan-applications/:id/admin-controls", id); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.revision; };
const stageTo = async (id, stage) => call("post", "/loan-applications/:id/admin-stage", id,
  { stage, reason: "t874 fixture", confirmed: true, expectedRevision: await revisionOf(id) });
const lastAudit = (id) => { const h = queryRow("SELECT * FROM loan_application_stage_history WHERE application_id=? ORDER BY id DESC LIMIT 1", [id]); return { ...h, payload: JSON.parse(h.reason) }; };
const approve = (id) => call("post", "/loan-applications/:id/expert-approve", id, {});

const A = 249;
const start = row(A);
// The masked copy has no contract PDFs: give the case's current primary generation a synthetic PDF (throwaway copy only)
// so the real expert-approve PDF-integrity gate runs instead of failing on a missing file.
{
  const g = Number(start.current_primary_generation_id);
  const gen = path.join(dir, "contracts", "generations"); fs.mkdirSync(gen, { recursive: true });
  const pdf = path.join(gen, "0000874f-0000-4000-8000-000000000874.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4\n% t874 synthetic fixture, not a real contract\n%%EOF\n");
  const sha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(pdf)).digest("hex");
  assert.equal(executeChanges("UPDATE contract_generations SET pdf_path=?,pdf_sha256=? WHERE id=?", [pdf, sha, g]), 1);
}
assert.equal(start.stage, "funder_result_review"); assert.equal(start.funder_decision, "approved"); assert.ok(start.expert_reviewed_at);

await ok("249 repro: approved → admin sends back to collateral_upload → decision cleared, old values in audit 'before'", async () => {
  const r = await stageTo(A, "collateral_upload"); assert.equal(r.status, 200, JSON.stringify(r.json));
  const a = row(A);
  assert.equal(a.stage, "collateral_upload"); assert.equal(a.funder_decision, null); assert.equal(a.funder_reason, null); assert.equal(a.expert_reviewed_at, null);
  const h = lastAudit(A);
  assert.equal(h.action, "admin-stage-corrected"); assert.equal(h.payload.funderDecisionCleared, true);
  assert.equal(h.payload.before.funderDecision, "approved"); assert.equal(h.payload.before.expertReviewedAt, start.expert_reviewed_at);
  assert.equal(h.payload.after.funderDecision, null);
  assert.deepEqual({ ...fixed(a), stage: start.stage, status: start.status }, fixed(start), "terms/generation/contract untouched");
});
await ok("249 repro: back at expert_approval → expert-approve succeeds (no reconciliation conflict), terms unchanged", async () => {
  assert.equal((await stageTo(A, "expert_approval")).status, 200);
  const r = await approve(A); assert.equal(r.status, 200, JSON.stringify(r.json));
  const a = row(A);
  assert.equal(a.stage, "funder_result_review"); assert.equal(a.funder_decision, "approved"); assert.ok(a.expert_reviewed_at);
  assert.equal(a.approved_amount_generation_id, start.approved_amount_generation_id); assert.equal(a.approved_amount, start.approved_amount);
  assert.equal(lastAudit(A).action, "expert-approve");
});
await ok("forward correction (funder_result_review → physical_documents_submission) keeps the decision and old audit shape", async () => {
  const b = row(A);
  assert.equal((await stageTo(A, "physical_documents_submission")).status, 200);
  const a = row(A); assert.equal(a.funder_decision, "approved"); assert.equal(a.expert_reviewed_at, b.expert_reviewed_at);
  const h = lastAudit(A); assert.equal(h.payload.funderDecisionCleared, undefined); assert.equal("funderDecision" in h.payload.before, false);
});
await ok("decision-dependent targets (funder_amendment_review, funder_documents_correction) keep the decision", async () => {
  for (const s of ["funder_amendment_review", "funder_documents_correction"]) {
    assert.equal((await stageTo(A, s)).status, 200);
    assert.equal(row(A).funder_decision, "approved", s);
  }
});
await ok("live 249 state (expert_approval + stale decision): old fixture of the bug → 409 reconciliation conflict", async () => {
  executeChanges("UPDATE loan_applications SET stage='expert_approval',status='reviewing',funder_decision='approved',expert_reviewed_at=? WHERE id=?", [start.expert_reviewed_at, A]);
  const r = await approve(A); assert.equal(r.status, 409); assert.equal(r.json?.error ?? r.json?.code, "approved_financial_terms_reconciliation_conflict", JSON.stringify(r.json));
});
await ok("one-time repair shape (funder_decision/funder_reason → NULL only, expert_reviewed_at kept) → expert-approve succeeds", async () => {
  executeChanges("UPDATE loan_applications SET funder_decision=NULL,funder_reason=NULL WHERE id=?", [A]);
  const r = await approve(A); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(row(A).stage, "funder_result_review"); assert.equal(row(A).funder_decision, "approved");
});
await ok("an early case with no decision: back-correction writes no decision fields into the audit", async () => {
  const e = queryRow("SELECT id FROM loan_applications WHERE deleted_at IS NULL AND status<>'rejected' AND funder_decision IS NULL AND expert_reviewed_at IS NULL AND funder_reason IS NULL AND stage IN ('collateral_review','customer_documents_review','collateral_upload') ORDER BY id DESC LIMIT 1");
  if (!e) { console.log("   (no such case in masked copy; skipped)"); return; }
  const target = row(e.id).stage === "collateral_upload" ? "collateral_review" : "collateral_upload";
  const r = await stageTo(e.id, target); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(lastAudit(e.id).payload.funderDecisionCleared, undefined);
});
console.log(`t874 fixture: ${passed} passed. masked copy only, never live.`);
fs.rmSync(dir, { recursive: true, force: true });
