// t868 (Mohammad t868s2964): the non-P1 transfer toast names the customer's ACTUAL new owner (team rule), and the
// pre-save confirm uses the same team rule. Routing is unchanged. Throwaway COPY of a masked DB only; never live,
// never user 29, no network. Usage: T868_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t868-nonp1-toast-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.env.T868_FIXTURE_DB;
if (!src) { console.log("SKIP (set T868_FIXTURE_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db" || fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t868-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
globalThis.fetch = async () => { throw new Error("unexpected network call in t868 fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const { queryRow, execute } = await import("../src/lib/crm-db.ts");
const ps = await import("../src/lib/sales-experts-priority-status.ts");
const nonp1 = await import("../src/lib/nonp1-transfer.ts");
const crmRouter = (await import("../src/routes/crm.ts")).default;
const tsRouter = (await import("../src/routes/team-sales.ts")).default;

const teamsBefore = JSON.stringify([queryRow("SELECT group_concat(team_id||':'||salesperson_id||':'||owns_none||owns_p1||owns_p2||owns_p3) g FROM sales_team_members")]);
const tscBefore = queryRow("SELECT value FROM notification_settings WHERE key='team_sales_config'")?.value;
assert.equal(queryRow("SELECT value FROM call_queue_settings WHERE key='flag.multi_team_v1'")?.value, "1", "masked copy mirrors live multi_team_v1=1");

let nextId = Number(queryRow("SELECT MAX(id) AS m FROM customers").m) + 1;
const mk = (sp) => {
  const id = nextId++; assert.notEqual(id, 29);
  execute(`INSERT INTO customers (id,name,phone,created_at,salesperson_id,priority,status) VALUES (?,?,?,?,?,1,'in_progress')`,
    [id, `مشتری نمونه t868 ${id}`, `0900${String(9000000 + id).slice(-7)}`, new Date().toISOString(), sp]);
  return id;
};
const userFor = (uid) => {
  const u = queryRow("SELECT id,username,full_name,role,salesperson_id FROM users WHERE id=?", [uid]);
  return { id: u.id, username: u.username, fullName: u.full_name, mobile: null, telegramId: null, priorityColors: {}, role: u.role, roleName: u.role,
    permissions: ["customers.update", "customers.view"], customerScope: u.role === "admin" ? "all" : "assigned", salespersonId: u.salesperson_id,
    salespersonName: null, active: true, createdAt: new Date().toISOString() };
};
const layer = crmRouter.stack.find((l) => l.route?.path === "/customers/:id" && l.route.methods.patch);
assert.ok(layer, "PATCH /customers/:id");
const handler = layer.route.stack[layer.route.stack.length - 1].handle;
const patch = (cid, uid, body) => {
  let status = 200, json = null; const headers = {};
  const res = { locals: { authUser: userFor(uid) }, setHeader(k, v) { headers[k.toLowerCase()] = v; }, getHeader(k) { return headers[k.toLowerCase()]; },
    status(s) { status = s; return this; }, json(b) { json = b; return this; } };
  handler({ params: { id: String(cid) }, body, query: {}, log: { warn() {}, info() {}, error() {} } }, res);
  const to = headers["x-nafis-customer-transferred-to"];
  return { status, json, transferred: headers["x-nafis-customer-transferred"], to: to ? decodeURIComponent(to) : null };
};
const spName = (id) => queryRow("SELECT name FROM salespersons WHERE id=?", [id]).name;

await ok("team 2 (Arash sp5 → P2): moves to Khordkar sp20 and the toast says Khordkar, not Kazemi", () => {
  const cid = mk(5);
  assert.equal(ps.psPriorityDemoteTransferName(cid, { id: 6, role: "salesperson", salespersonId: 5 }), spName(20));
  const r = patch(cid, 6, { priority: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [cid]).s), 20);
  assert.equal(r.transferred, String(cid));
  assert.equal(r.to, spName(20)); assert.ok(!/کاظمی/.test(r.to)); assert.ok(/خردکار/.test(r.to));
  console.log("   team2 toast:", nonp1.nonP1ToastFor(r.to));
});
await ok("team 2 P1→P3 and P1→بدون اولویت also name Khordkar", () => {
  for (const pr of [3, null]) {
    const cid = mk(5); const r = patch(cid, 6, { priority: pr });
    assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [cid]).s), 20);
    assert.equal(r.to, spName(20));
  }
});
await ok("team 1 (Hasani sp3 → P2): moves to Kazemi sp6 and the toast still says «آقای کاظمی»", () => {
  const cid = mk(3);
  assert.equal(ps.psPriorityDemoteTransferName(cid, { id: 2, role: "salesperson", salespersonId: 3 }), "آقای کاظمی");
  const r = patch(cid, 2, { priority: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [cid]).s), 6);
  assert.equal(r.to, "آقای کاظمی");
  console.log("   team1 toast:", nonp1.nonP1ToastFor(r.to));
});
await ok("team 1 Ghasemi sp4 → P3 also Kazemi", () => {
  const cid = mk(4); const r = patch(cid, 3, { priority: 3 });
  assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [cid]).s), 6);
  assert.equal(r.to, "آقای کاظمی");
});
await ok("no transfer → no header / no message (P1 kept, cancelled customer, open case)", () => {
  const a = mk(5); let r = patch(a, 6, { description: "x" });
  assert.equal(r.transferred, undefined); assert.equal(r.to, null);
  const b = mk(5); execute("UPDATE customers SET status='cancelled' WHERE id=?", [b]);
  r = patch(b, 6, { priority: 2 }); assert.equal(r.transferred, undefined); assert.equal(r.to, null);
  assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [b]).s), 5);
  assert.equal(ps.psPriorityDemoteTransferName(b, { id: 6, role: "salesperson", salespersonId: 5 }), null);
  const c = mk(5); execute("INSERT INTO loan_request_drafts (customer_id, status, created_at, updated_at) VALUES (?, 'pending_registration', ?, ?)", [c, new Date().toISOString(), new Date().toISOString()]);
  r = patch(c, 6, { priority: 2 }); assert.equal(r.transferred, undefined); assert.equal(r.to, null);
  assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [c]).s), 5);
  execute("UPDATE customers SET priority=1 WHERE id=?", [c]);
  assert.equal(ps.psPriorityDemoteTransferName(c, { id: 6, role: "salesperson", salespersonId: 5 }), null);
});
await ok("Khordkar's own change on a team-2 customer: no confirm (actor is the destination)", () => {
  const cid = mk(5);
  assert.equal(ps.psPriorityDemoteTransferName(cid, { id: 28, role: "salesperson", salespersonId: 20 }), null);
});
await ok("multi_team OFF on the copy: legacy name (Kazemi), unchanged behaviour", () => {
  execute("UPDATE call_queue_settings SET value='0' WHERE key='flag.multi_team_v1'");
  const cid = mk(3);
  assert.equal(ps.psPriorityDemoteTransferName(cid, { id: 2, role: "salesperson", salespersonId: 3 }), "آقای کاظمی");
  assert.equal(nonp1.nonP1QualifierDisplayName(), "آقای کاظمی");
  execute("UPDATE call_queue_settings SET value='1' WHERE key='flag.multi_team_v1'");
});
await ok("GET /team-sales/config: nonP1OwnerName follows the expert's team (Arash → Khordkar, Hasani → Kazemi), old fields unchanged", () => {
  const l = tsRouter.stack.find((x) => x.route?.path === "/team-sales/config" && x.route.methods.get);
  assert.ok(l);
  const h = l.route.stack[l.route.stack.length - 1].handle;
  const get = (uid) => { let body; h({ query: {} }, { locals: { authUser: userFor(uid) }, json(b) { body = b; return this; }, status() { return this; } }); return body; };
  const a = get(6), b = get(2);
  assert.equal(a.nonP1OwnerName, spName(20)); assert.equal(b.nonP1OwnerName, "آقای کاظمی");
  for (const k of ["enabled", "qualifierSalespersonId", "closerSalespersonIds", "noteMinLength"]) assert.deepEqual(a[k], b[k]);
});
await ok("team config and team_sales_config untouched", () => {
  assert.equal(JSON.stringify([queryRow("SELECT group_concat(team_id||':'||salesperson_id||':'||owns_none||owns_p1||owns_p2||owns_p3) g FROM sales_team_members")]), teamsBefore);
  assert.equal(queryRow("SELECT value FROM notification_settings WHERE key='team_sales_config'")?.value, tscBefore);
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(`t868 fixture: ${passed}/9 passed (masked copy only)`);
process.exit(passed === 9 ? 0 : 1);
