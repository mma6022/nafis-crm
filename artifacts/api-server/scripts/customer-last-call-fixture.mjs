import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run only extracted production SQL against synthetic in-memory records.
// Never import the CRM module (which starts provider/background services).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "src/routes/crm.ts"), "utf8");
const select = source.match(/const customerSelect = `([\s\S]*?)`;/)[1];
const orderSource = source.match(/const orderBy = parsed.data.sortBy === "lastCallAt"[\s\S]*?;\n/)[0];
const order = new Function("parsed", `${orderSource}return orderBy;`);
const db = new DatabaseSync(":memory:");
const customerFields = [...new Set([...select.matchAll(/\bc\.(\w+)/g)].map(match => match[1]))];
db.exec(`CREATE TABLE customers(${customerFields.map(field => `${field} ${field === "id" ? "INTEGER PRIMARY KEY" : "TEXT"}`).join(",")});
  CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
  CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,created_at TEXT);
  INSERT INTO salespersons VALUES(11,'Synthetic owner'),(22,'Synthetic other');`);
const databaseSource = await readFile(path.join(root, "src/lib/crm-db.ts"), "utf8");
db.exec(databaseSource.match(/CREATE INDEX IF NOT EXISTS idx_call_logs_customer_actual_time[\s\S]*?DESC\)/)[0]);
const plan = db.prepare("EXPLAIN QUERY PLAN SELECT created_at FROM call_logs WHERE customer_id=? ORDER BY julianday(created_at) DESC,id DESC LIMIT 1").all(1);
assert.ok(plan.some(row => row.detail.includes("idx_call_logs_customer_actual_time")));
for (const [id, owner, archived] of [[1,11,null],[2,11,null],[3,11,null],[4,22,null],[5,11,null],[6,11,null],[7,11,4]]) {
  db.prepare("INSERT INTO customers(id,name,salesperson_id,created_at,priority,status,merged_into_customer_id) VALUES(?,?,?,?,?,?,?)")
    .run(id, `Synthetic ${id}`, owner, "2030-01-01T00:00:00Z", id % 2 ? null : 1, "in_progress", archived);
}
for (const [id, customer, time] of [
  [1,1,"2026-01-01T12:00:00Z"],[2,1,"2026-01-01T15:00:00+03:30"],
  [3,2,"2026-01-01T09:00:00-05:00"],[4,4,"2026-01-02T12:00:00Z"],
  [5,5,"not-a-date"],[6,6,"2026-01-01T12:00:00Z"],[7,7,"2031-01-01T00:00:00Z"],
]) db.prepare("INSERT INTO call_logs VALUES(?,?,?)").run(id,customer,time);
function list(direction, { owner, limit = 100, offset = 0, minimum } = {}) {
  const filters = ["c.merged_into_customer_id IS NULL"];
  const params = [];
  if (owner != null) { filters.push("c.salesperson_id=?"); params.push(owner); }
  const having = minimum == null ? "" : " HAVING COUNT(cl.id)>=?";
  if (minimum != null) params.push(minimum);
  return db.prepare(`${select} WHERE ${filters.join(" AND ")} GROUP BY c.id${having}
    ORDER BY ${order({data:{sortBy:"lastCallAt",sortDirection:direction}})} LIMIT ? OFFSET ?`)
    .all(...params,limit,offset);
}
assert.deepEqual(list("desc").map(row => row.id), [4,2,6,1,5,3]);
assert.deepEqual(list("asc").map(row => row.id), [6,1,2,4,5,3]);
assert.equal(list("desc").find(row => row.id === 1).last_call_at, "2026-01-01T12:00:00Z");
assert.equal(list("desc").find(row => row.id === 3).last_call_at, null);
assert.equal(list("desc").find(row => row.id === 5).last_call_at, null);
assert.deepEqual(list("desc", {owner:11}).map(row => row.id), [2,6,1,5,3]);
assert.deepEqual(list("desc", {limit:2,offset:2}).map(row => row.id), [6,1]);
assert.deepEqual(list("asc", {owner:11,minimum:2}).map(row => row.id), [1]);
assert.equal(order({data:{}}), "(c.priority IS NOT NULL) ASC, c.created_at DESC, c.id DESC");
db.exec(`CREATE TABLE customer_portal_registrations(customer_id INTEGER PRIMARY KEY);
  CREATE TABLE customer_tags(customer_id INTEGER,tag TEXT);
  INSERT INTO customer_portal_registrations VALUES(1),(5);
  INSERT INTO customer_tags VALUES(2,'repeat_request'),(5,'repeat_request'),(6,'repeat_request');
  UPDATE customers SET is_urgent=1 WHERE id IN (3,5,6);`);
const boardOrder = order({data:{sortBy:"boardTags"}});
function board({ limit = 100, offset = 0, priority } = {}) {
  return db.prepare(`SELECT c.id FROM customers c
    WHERE c.merged_into_customer_id IS NULL ${priority === undefined ? "" : "AND c.priority=?"}
    ORDER BY ${boardOrder} LIMIT ? OFFSET ?`)
    .all(...(priority === undefined ? [] : [priority]), limit, offset).map(row => row.id);
}
assert.deepEqual(board(), [5,1,6,2,3,4], "portal first, repeat second, urgent third; multi-tag uses highest group");
assert.deepEqual(board({priority:1}), [6,2,4], "each priority retains its own customers");
assert.deepEqual(board({limit:2,offset:2}), [6,2], "tag ordering happens before pagination");
for (let id = 8; id < 28; id++) {
  db.prepare("INSERT INTO customers(id,created_at,status) VALUES(?,?,?)")
    .run(id, "2035-01-01T00:00:00Z", "in_progress");
}
assert.deepEqual(board({limit:15}).slice(0,5), [5,1,6,2,3], "older tagged customers precede newer untagged customers beyond first page");
assert.equal(new Set(board()).size, board().length, "multiple tags never duplicate customers");
db.close();
console.log("PASS: last-call sorting and unchanged default order; board portal/repeat/urgent ordering, multi-tag precedence, per-priority scope and global pagination.");
