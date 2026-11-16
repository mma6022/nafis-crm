// DCI-QUEUE 440000 masked shape check: real "now", users 8/2/3 on a masked COPY. Prints counts/timings only (no names, phones, ids).
import assert from "node:assert/strict";
import fs from "node:fs";
const src = process.env.DQ_FIXTURE_DB; assert.ok(src); assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
Object.assign(process.env, { CRM_DATABASE_PATH: src, NODE_ENV: "production", LOG_LEVEL: "warn", SESSION_SECRET: `shape-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789` });
let net = 0; globalThis.fetch = async () => { net++; throw new Error("no network"); };
const db = await import("../src/lib/crm-db.ts"); const dq = await import("../src/lib/dci-queue.ts");
const P = ["customers.view", "customers.update", "calls.create", "calls.view", "payment_orders.view", "payment_orders.sales_approve", "bank_accounts.view"];
for (const id of [8, 2, 3]) {
  const u = db.queryRow("SELECT id, role, salesperson_id FROM users WHERE id=?", [id]); if (!u) { console.log("user", id, "absent"); continue; }
  const user = { id, role: u.role, salespersonId: u.salesperson_id, fullName: "x", permissions: P, customerScope: "assigned", active: true };
  const t0 = performance.now(); const q = dq.dqQueue(user, new Date()); const ms = Math.round(performance.now() - t0);
  console.log(`user ${id}: ${ms}ms items=${q.items.length} open=${q.openCount} nowBlock=${q.nowBlock} inHours=${q.inHours} counts=${JSON.stringify(q.counts)} done=${q.items.filter((x) => x.done).length} urgent=${q.items.filter((x) => x.urgent && !x.done).length} unknown=${q.items.filter((x) => x.customer_id == null).length}`);
}
const t = db.queryRow("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'dci_queue_%'");
console.log("dq tables after read-only queue calls:", t.n, "network:", net);
assert.equal(net, 0);
