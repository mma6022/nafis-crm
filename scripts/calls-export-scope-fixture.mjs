// Calls CSV export keeps the 8d97c9e scope for every role, while the on-screen list
// (GET /calls without purpose=export) uses the 2026-10-24 salesperson scope
// (logged by me, incl. handed-off first-call forms, OR on a customer I own now).
// Synthetic in-memory data only.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { callListActorScope, isCallExportRequest } from "../src/lib/call-history-scope";

// ---- frozen copy of artifacts/api-server/src/lib/call-history-scope.ts at 8d97c9e ----
function oldCallHistoryScope(actor) {
  if (actor.role === "admin") return { sql: "", params: [] };
  const customer = actor.customerScope === "assigned" ? " AND c.salesperson_id=?" : "";
  return {
    sql: `((EXISTS (SELECT 1 FROM voip_after_call_events mobile WHERE mobile.call_log_id=cl.id AND mobile.mobile_device_id IS NOT NULL AND mobile.expert_user_id=?))
      OR (EXISTS (SELECT 1 FROM voip_after_call_events e
      JOIN voip_extensions own ON own.user_id=? AND (own.extension=e.extension
        OR EXISTS (SELECT 1 FROM json_each(e.extensions_json) participant WHERE participant.value=own.extension))
      WHERE e.call_log_id=cl.id))
      OR (NOT EXISTS (SELECT 1 FROM voip_after_call_events e WHERE e.call_log_id=cl.id)
        AND cl.salesperson_id=?${customer}))`,
    params: [actor.id, actor.id, actor.salespersonId ?? -1, ...(actor.customerScope === "assigned" ? [actor.salespersonId ?? -1] : [])],
  };
}
function oldForcedCallSalespersonId(actor) {
  if (actor.role === "admin" || actor.permissions.includes("customers.view")) return undefined;
  return actor.salespersonId ?? -1;
}
// 8d97c9e GET /calls: scope, forced salesperson, name search guarded by "owned now".
function oldQuery(actor, { search, salespersonId } = {}) {
  const f = [], p = [];
  const s = oldCallHistoryScope(actor);
  if (s.sql) { f.push(s.sql); p.push(...s.params); }
  if (search) {
    const owner = actor.role === "admin" || actor.customerScope === "all" ? "1=1" : "c.salesperson_id=?";
    f.push(`((c.name LIKE ? AND ${owner}) OR LOWER(COALESCE(cl.subject,'')) LIKE LOWER(?))`);
    p.push(`%${search}%`, ...(owner === "1=1" ? [] : [actor.salespersonId]), `%${search}%`);
  }
  const sp = oldForcedCallSalespersonId(actor) ?? salespersonId;
  if (sp !== undefined) { f.push("cl.salesperson_id=?"); p.push(sp); }
  return { f, p };
}
// Current route composition (crm.ts GET /calls) for the same inputs.
function newQuery(actor, purpose, { search, salespersonId } = {}) {
  const scope = callListActorScope(actor, purpose);
  const f = [...scope.filters], p = [...scope.params];
  if (search) {
    f.push(`((c.name LIKE ? AND ${scope.ownerOnly.sql}) OR LOWER(COALESCE(cl.subject,'')) LIKE LOWER(?))`);
    p.push(`%${search}%`, ...scope.ownerOnly.params, `%${search}%`);
  }
  const sp = scope.forcedSalespersonId ?? salespersonId;
  if (sp !== undefined) { f.push("cl.salesperson_id=?"); p.push(sp); }
  return { f, p };
}

const db = new DatabaseSync(":memory:");
db.exec(`
CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, salesperson_id INTEGER);
CREATE TABLE call_logs(id INTEGER PRIMARY KEY, customer_id INTEGER, salesperson_id INTEGER, subject TEXT);
CREATE TABLE voip_after_call_events(id INTEGER PRIMARY KEY, call_log_id INTEGER, mobile_device_id TEXT, expert_user_id INTEGER, extension TEXT, extensions_json TEXT);
CREATE TABLE voip_extensions(user_id INTEGER, extension TEXT);
CREATE TABLE team_sales_qualifications(id INTEGER PRIMARY KEY, call_log_id INTEGER, actor_user_id INTEGER);
-- salespersons: 1 (user 11), 2 (user 12), 3 (user 13, calls-only)
INSERT INTO customers VALUES (1,'علی',1),(2,'رضا',2),(3,'سارا',1),(4,'مریم',3),(5,'نادر',NULL);
INSERT INTO call_logs VALUES
 (101,1,1,'own call, own customer'),
 (102,2,1,'own call, customer handed to sp2'),       -- handoff
 (103,1,2,'sp2 call on sp1 customer'),
 (104,2,2,'sp2 call, sp2 customer'),
 (105,3,NULL,'pbx call ext 201'),
 (106,5,2,'mobile call by user 11'),
 (107,4,3,'calls-only own'),
 (108,2,3,'calls-only call handed to sp2'),
 (109,4,1,'sp1 call on calls-only customer'),
 (110,2,2,'qualified by user 11 (form authored)');
INSERT INTO voip_after_call_events VALUES (1,105,NULL,NULL,'201',NULL),(2,106,'dev',11,'999',NULL);
INSERT INTO voip_extensions VALUES (11,'201');
INSERT INTO team_sales_qualifications VALUES (1,110,11);
`);
const ids = ({ f, p }) => db.prepare(`SELECT cl.id FROM call_logs cl JOIN customers c ON c.id=cl.customer_id${f.length ? " WHERE " + f.join(" AND ") : ""} ORDER BY cl.id`)
  .all(...p).map(r => r.id);

const view = ["calls.view", "customers.view"];
const actors = {
  admin: { id: 1, role: "admin", customerScope: "all", salespersonId: null, permissions: view },
  registrar: { id: 2, role: "registrar", customerScope: "all", salespersonId: null, permissions: view },
  registrarWithSp: { id: 3, role: "registrar", customerScope: "all", salespersonId: 2, permissions: view },
  sp1: { id: 11, role: "salesperson", customerScope: "assigned", salespersonId: 1, permissions: view },
  sp2: { id: 12, role: "salesperson", customerScope: "assigned", salespersonId: 2, permissions: view },
  callsOnly: { id: 13, role: "caller", customerScope: "assigned", salespersonId: 3, permissions: ["calls.view"] },
  callsOnlyAll: { id: 14, role: "caller", customerScope: "all", salespersonId: 3, permissions: ["calls.view"] },
  noSalesperson: { id: 15, role: "salesperson", customerScope: "assigned", salespersonId: null, permissions: view },
};
const variants = [{}, { search: "ر" }, { search: "call" }, { salespersonId: 2 }, { salespersonId: 1, search: "ا" }];

let n = 0;
const ok = (name) => { n++; console.log("ok -", name); };

assert.equal(isCallExportRequest({ purpose: "export" }), true);
assert.equal(isCallExportRequest({}), false);
assert.equal(isCallExportRequest({ purpose: "list" }), false);
ok("purpose=export selects the export scope");

const table = [];
for (const [name, actor] of Object.entries(actors)) {
  for (const v of variants) {
    assert.deepEqual(ids(newQuery(actor, "export", v)), ids(oldQuery(actor, v)), `${name} export ${JSON.stringify(v)}`);
  }
  const list = ids(newQuery(actor, "list")), exp = ids(newQuery(actor, "export"));
  for (const id of exp) assert.ok(list.includes(id), `${name}: list must include every export row (${id})`);
  table.push(`${name}: export=${exp.length} [${exp}] list=${list.length} [${list}]`);
  ok(`${name}: export rows == 8d97c9e rows for ${variants.length} filter variants`);
}
// Spot-check the intended difference.
assert.deepEqual(ids(newQuery(actors.sp1, "export")), [101, 105, 106]);
assert.deepEqual(ids(newQuery(actors.sp1, "list")), [101, 102, 103, 105, 106, 109, 110]);
assert.deepEqual(ids(newQuery(actors.callsOnly, "export")), [107]);
assert.deepEqual(ids(newQuery(actors.callsOnly, "list")), [107, 108, 109]);
assert.deepEqual(ids(newQuery(actors.registrar, "list")), ids(newQuery(actors.registrar, "export")));
assert.deepEqual(ids(newQuery(actors.admin, "list")).length, 10);
ok("list adds handed-off / authored / owned-customer calls only; export unchanged");
console.log(table.join("\n"));
console.log(`calls-export-scope: ${n} checks passed`);
