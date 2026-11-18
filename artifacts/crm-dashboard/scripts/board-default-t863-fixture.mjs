/**
 * t863u (Mohammad: «پیش فرض نمایش مشتریان من رو باید بورد بکنی»): «مشتریان من» opens on the board every time,
 * on desktop and phone, for locked experts (MyCustomersPage) and for everyone else on /customers (Customers.tsx).
 * A «فهرست» pick is component state for that visit only: no localStorage read/write, no table-state (query-cache) restore.
 * Stale saved «table» values are removed. While the flag probe is pending, neither page fetches or shows the list.
 *   node --experimental-strip-types scripts/board-default-t863-fixture.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { CUSTOMERS_DEFAULT_VIEW, clearStaleCpkView, cpkViewKey } from "../src/features/customers-priority-kanban/helpers.ts";
import * as helpers from "../src/features/customers-priority-kanban/helpers.ts";

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log("ok -", name); };
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const cust = read("../src/pages/Customers.tsx");
const mine = read("../src/features/sales-fixes/MyCustomers.tsx");
const helpersSrc = read("../src/features/customers-priority-kanban/helpers.ts");

ok("default view constant is the board", () => {
  assert.equal(CUSTOMERS_DEFAULT_VIEW, "board");
  assert.match(mine, /export const MY_CUSTOMERS_DEFAULT_VIEW: CpkView = "board"/);
});

ok("no lasting view pick: readCpkView/writeCpkView are gone and nothing writes a view to storage", () => {
  assert.equal(typeof helpers.readCpkView, "undefined");
  assert.equal(typeof helpers.writeCpkView, "undefined");
  assert.doesNotMatch(helpersSrc, /localStorage\.setItem|localStorage\.getItem/);
  for (const src of [cust, mine]) {
    assert.doesNotMatch(src, /readCpkView|writeCpkView/);
    assert.doesNotMatch(src, /localStorage\.(get|set)Item\([^)]*[Vv]iew/);
    assert.doesNotMatch(src, /sessionStorage\.(get|set)Item\([^)]*[Vv]iew/);
  }
});

ok("/customers: view is plain component state starting at the board (not table-state, not 'table')", () => {
  assert.match(cust, /const \[view, setView\] = useState<CpkView>\(CUSTOMERS_DEFAULT_VIEW\);/);
  assert.doesNotMatch(cust, /useTableState<'table' \| 'board'>\('customers\.view'/);
  assert.doesNotMatch(cust, /useTableState\([^)]*'customers\.view'/);
  assert.match(cust, /useEffect\(\(\) => \{ clearStaleCpkView\(cpkUserId\); \}, \[cpkUserId\]\);/);
});

ok("/customers: the board is not desktop-only while the flag is ON or still loading (same on 390 and 1280)", () => {
  assert.match(cust, /const isBoard = view === 'board' && \(cpkOn \|\| cpkPending \? true : \(isDesktop && !reg\)\);/);
  assert.match(cust, /isBoard && cpkPending \? <div[^>]*data-testid="customers-view-pending"/);
  // list query stays disabled while isBoard is true (incl. pending)
  assert.match(cust, /enabled: !isBoard && canView/);
});

ok("«مشتریان من» (locked experts): no list fetch or list render while the flag probe is pending", () => {
  assert.match(mine, /const cpkPending = cpkMe\.isPending;/);
  assert.match(mine, /enabled: !cpkPending && \(!cpkOn \|\| view === 'table'\)/);
  assert.match(mine, /if \(cpkPending\) \{[\s\S]*?data-testid="sf-mc-pending"/);
  assert.ok(mine.indexOf("if (cpkPending)") < mine.indexOf("if (cpkOn && view === 'board')"));
});

ok("stale saved «table» is removed for the signed-in expert only, and never throws", () => {
  const store = new Map([[cpkViewKey(1), "table"], [cpkViewKey(5), "board"]]);
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  clearStaleCpkView(1);
  assert.equal(store.has(cpkViewKey(1)), false);
  assert.equal(store.get(cpkViewKey(5)), "board");
  clearStaleCpkView(null);
  globalThis.localStorage = { removeItem: () => { throw new Error("SecurityError"); } };
  clearStaleCpkView(5); // private mode: no throw
  delete globalThis.localStorage;
  clearStaleCpkView(5); // no localStorage at all: no throw
});

console.log(`PASS board-default t863u (${passed} checks)`);
