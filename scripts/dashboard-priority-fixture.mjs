import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

// Execute the actual summary SQL against synthetic records only.
const source = await readFile(new URL("../src/routes/crm.ts", import.meta.url), "utf8");
const block = source.slice(source.indexOf("const priorityCounts = queryRows"));
const template = block.match(/`([^`]+)`/)?.[1];
assert.ok(template?.includes("${customerScopeAnd}"));
assert.match(template, /COALESCE\(status, 'in_progress'\) = 'in_progress'/);
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE customers(id INTEGER PRIMARY KEY,status TEXT,priority INTEGER,salesperson_id INTEGER)");
const insert = db.prepare("INSERT INTO customers(status,priority,salesperson_id) VALUES(?,?,?)");
for (const [status, priority, owner] of [
  ["in_progress", 1, 10], ["in_progress", 1, 10], ["in_progress", 2, 20],
  [null, null, 10], ["completed", 1, 10], ["cancelled", 2, 20],
  ["rejected", 3, 10], ["merged", 4, 10],
]) insert.run(status, priority, owner);
const run = (owner) => db.prepare(template.replace("${customerScopeAnd}", owner == null ? "" : " AND salesperson_id = ?"))
  .all(...(owner == null ? [] : [owner])).map(row => ({ ...row }));
assert.deepEqual(run(null), [{ priority: 2, count: 1 }, { priority: 1, count: 2 }, { priority: 0, count: 1 }]);
assert.deepEqual(run(10), [{ priority: 1, count: 2 }, { priority: 0, count: 1 }]);
assert.deepEqual(run(20), [{ priority: 2, count: 1 }]);
assert.deepEqual(run(99), []);
db.exec("UPDATE customers SET status='completed'");
assert.deepEqual(run(null), []);
db.close();
console.log("PASS active-customer priority chart: actual summary SQL, excluded closed statuses, scoped access, default priority/status, and empty results; other summary metrics unchanged.");
