// VOIP-ANYWHERE registrar scope (t836u, flag.voip_call.registrar_scope): who a registrar may start a VoIP click call for.
// Temp COPY of the CRM DB (VCA_FIXTURE_DB, else ../../attached_assets like voip-fixture) + synthetic rows 990001..; the source DB is never written.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "vca-reg-"));
const file = path.join(dir, "crm.db");
copyFileSync(process.env.VCA_FIXTURE_DB || path.resolve("..", "..", "attached_assets", "customers_1789823100050.db"), file);
process.env.CRM_DATABASE_PATH = file;
process.env.SESSION_SECRET ||= "voip-registrar-scope-fixture"; // test-only
const { crmDb: raw } = await import("../src/lib/crm-db.ts");
const { ensureElSchema, elTarget, elLocked } = await import("../src/lib/expert-lockdown.ts");
ensureElSchema();
const cols = (t) => new Set(raw.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
const sfCols = cols("smart_filing_jobs");
const R = 7, R2 = 4, SP = 4, OTHER_SP = 6;
const C = { reg: 990001, job: 990002, approved: 990003, jobDone: 990004, grant: 990005, grantOld: 990006, other: 990007, otherReg: 990008, merged: 990009, jobOther: 990010 };
const cc = cols("customers");
const insC = (id, sp, regBy, merged = null) => {
  const f = { id, name: `fixture ${id}`, phone: `0912${String(id).slice(-7)}`, salesperson_id: sp, registered_by: regBy, merged_into_customer_id: merged };
  if (cc.has("created_at")) f.created_at = new Date().toISOString();
  if (cc.has("updated_at")) f.updated_at = new Date().toISOString();
  const k = Object.keys(f).filter((x) => cc.has(x));
  raw.prepare(`INSERT OR REPLACE INTO customers(${k.join(",")}) VALUES(${k.map(() => "?").join(",")})`).run(...k.map((x) => f[x]));
};
insC(C.reg, SP, R); insC(C.job, SP, null); insC(C.approved, OTHER_SP, null); insC(C.jobDone, SP, null); insC(C.grant, SP, null); insC(C.grantOld, SP, null);
insC(C.other, OTHER_SP, null); insC(C.otherReg, OTHER_SP, R2); insC(C.merged, SP, R, C.reg); insC(C.jobOther, SP, null);
const now = new Date().toISOString();
const insJ = (cid, by, appr, fin, status) => {
  const f = { customer_id: cid, status, created_by_user_id: by, submit_approved_by_user_id: appr, finished_at: fin, job_type: "real", application_id: 1, panel_id: 1, progress: 0, attempt: 1, source: "manual", created_at: now, updated_at: now };
  const k = Object.keys(f).filter((x) => sfCols.has(x));
  raw.exec("PRAGMA foreign_keys=OFF");
  raw.prepare(`INSERT INTO smart_filing_jobs(${k.join(",")}) VALUES(${k.map(() => "?").join(",")})`).run(...k.map((x) => f[x]));
};
insJ(C.job, R, null, null, "waiting_human"); insJ(C.approved, null, R, null, "ready_for_approval"); insJ(C.jobDone, R, null, now, "submitted"); insJ(C.jobOther, R2, null, null, "running");
raw.prepare("INSERT INTO el_grants(user_id,customer_id,source,granted_at,expires_at) VALUES(?,?,?,?,?)").run(R, C.grant, "incoming", now, new Date(Date.now() + 3600e3).toISOString());
raw.prepare("INSERT INTO el_grants(user_id,customer_id,source,granted_at,expires_at) VALUES(?,?,?,?,?)").run(R, C.grantOld, "incoming", now, new Date(Date.now() - 60e3).toISOString());
const setFlag = (k, v) => v == null ? raw.prepare("DELETE FROM call_queue_settings WHERE key=?").run(k) : raw.prepare("INSERT OR REPLACE INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?)").run(k, v, now);
for (const k of ["flag.voip_call.registrar_scope", `flag.voip_call.registrar_scope.user.${R}`, `flag.voip_call.registrar_scope.user.${R2}`]) setFlag(k, null);

const { vcCustomerAllowed } = await import("../src/lib/voip-call.ts");
const { vcIsScopedRegistrar, vcRegistrarWhy } = await import("../src/lib/voip-registrar-scope.ts");
const { vcAnywhereOwnIds } = await import("../src/lib/voip-anywhere.ts");

const reg = { id: R, role: "registrar", salespersonId: null, customerScope: "all" };
const reg2 = { id: R2, role: "registrar", salespersonId: null, customerScope: "all" };
const admin = { id: 1, role: "admin", salespersonId: null, customerScope: "all" };
const expert = { id: 8, role: "salesperson", salespersonId: OTHER_SP, customerScope: "assigned" };
const all = Object.values(C);
const allowedOf = (u) => all.filter((id) => vcCustomerAllowed(u, id));
let n = 0; const t = (name, fn) => { fn(); n++; console.log(`PASS ${name}`); };

t("flag OFF → today's rule unchanged (registrar customer_scope 'all' passes every live customer)", () => {
  assert.equal(vcIsScopedRegistrar(reg), false);
  assert.deepEqual(allowedOf(reg), all.filter((id) => id !== C.merged));
  assert.deepEqual(vcAnywhereOwnIds(reg, all.join(",")), [], "no anywhere ids for a registrar while off");
});
setFlag(`flag.voip_call.registrar_scope.user.${R}`, "1");
t("flag ON for user 7 → allowed set = registered by her / her open smart-filing file (created or submit-approved) / unexpired incoming grant", () => {
  assert.equal(vcIsScopedRegistrar(reg), true);
  assert.deepEqual(allowedOf(reg), [C.reg, C.job, C.approved, C.grant]);
  assert.equal(vcRegistrarWhy(reg, C.reg), "registered"); assert.equal(vcRegistrarWhy(reg, C.job), "open_filing");
  assert.equal(vcRegistrarWhy(reg, C.approved), "open_filing"); assert.equal(vcRegistrarWhy(reg, C.grant), "incoming_grant");
  assert.deepEqual(vcAnywhereOwnIds(reg, all.join(",")), [C.reg, C.job, C.approved, C.grant]);
});
t("flag ON → denied: other expert's customer, customer another registrar registered / files, finished file, expired grant, merged, unknown", () => {
  for (const id of [C.other, C.otherReg, C.jobDone, C.grantOld, C.merged, C.jobOther, 123456789]) assert.equal(vcCustomerAllowed(reg, id), false, String(id));
});
t("per-user flag: another registrar (user 4) keeps today's rule; global flag scopes every registrar", () => {
  assert.equal(vcIsScopedRegistrar(reg2), false); assert.equal(vcCustomerAllowed(reg2, C.other), true);
  setFlag("flag.voip_call.registrar_scope", "1");
  assert.deepEqual(allowedOf(reg2), [C.otherReg, C.jobOther]);
  setFlag("flag.voip_call.registrar_scope", null);
});
t("experts and admins untouched by the flag (expert = own salesperson only → other expert's customer 403; admin = all)", () => {
  setFlag("flag.voip_call.registrar_scope", "1");
  assert.equal(vcIsScopedRegistrar(expert), false); assert.equal(vcIsScopedRegistrar(admin), false);
  assert.deepEqual(allowedOf(expert), [C.approved, C.other, C.otherReg]);
  assert.deepEqual(allowedOf(admin), all.filter((id) => id !== C.merged));
  assert.equal(vcIsScopedRegistrar({ ...reg, salespersonId: 5 }), false, "a registrar account with a salesperson id follows the expert rule");
  setFlag("flag.voip_call.registrar_scope", null);
});
t("lockdown interaction: registrar is never a lockdown target; lockdown ON neither widens nor narrows her set; locked expert unchanged", () => {
  setFlag("flag.expert_lockdown", "1");
  assert.equal(elTarget(reg), false); assert.equal(elLocked(reg), false); assert.equal(elLocked(expert), true);
  assert.deepEqual(allowedOf(reg), [C.reg, C.job, C.approved, C.grant]);
  assert.deepEqual(allowedOf(expert), [C.approved, C.other, C.otherReg]);
  setFlag("flag.expert_lockdown", null);
});
console.log(`PASS voip-registrar-scope: ${n} groups`);
rmSync(dir, { recursive: true, force: true });
