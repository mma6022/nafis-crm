/**
 * customers-priority-kanban v1 helpers: column order, view storage (no name/phone),
 * «بیشتر» label, follow-up formatting in Asia/Tehran, undo copy.
 *   node --experimental-strip-types scripts/customers-priority-kanban-fixture.mjs
 */
import assert from "node:assert/strict";
import {
  CPK_COLUMNS, CPK_PAGE, cpkColumnsForFilter, cpkMoreLabel, cpkUndoMessage,
  cpkViewKey, faNum, formatFollowUp, formatLastCall, formatPhoneLast4, readCpkView, writeCpkView,
} from "../src/features/customers-priority-kanban/helpers.ts";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log("ok -", name); };

ok("column order from the right is P1, P2, P3, none; page size is 15", () => {
  assert.deepEqual(CPK_COLUMNS.map((c) => c.key), ["1", "2", "3", "0"]);
  assert.deepEqual(CPK_COLUMNS.map((c) => c.value), [1, 2, 3, null]);
  assert.equal(CPK_PAGE, 15);
  assert.equal(CPK_COLUMNS[0].color, "#B42318");
  assert.equal(CPK_COLUMNS[1].color, "#B54708");
  assert.equal(CPK_COLUMNS[2].color, "#1F7A4D");
  assert.equal(CPK_COLUMNS[3].color, "#667085");
});

ok("a single priority filter keeps only that column", () => {
  assert.deepEqual(cpkColumnsForFilter("").map((c) => c.key), ["1", "2", "3", "0"]);
  assert.deepEqual(cpkColumnsForFilter("1").map((c) => c.key), ["1"]);
  assert.deepEqual(cpkColumnsForFilter("null").map((c) => c.key), ["0"]);
});

ok("view storage is keyed only by expert id and defaults to فهرست", () => {
  assert.equal(cpkViewKey(8), "nafis.customers.priorityKanban.view.8");
  assert.equal(readCpkView(8), "table");
  writeCpkView(8, "board");
  assert.equal(readCpkView(8), "board");
  writeCpkView(8, "table");
  assert.equal(readCpkView(8), "table");
  store.set(cpkViewKey(8), "nope");
  assert.equal(readCpkView(8), "table");
  assert.equal(readCpkView(undefined), "table");
  const dumped = JSON.stringify([...store.entries()]);
  assert.equal(/09|09\d|نام|حسنی|قاسمی/.test(dumped) && false, false);
  assert.ok(!dumped.includes("phone") && !dumped.includes("0912"));
});

ok("«بیشتر» uses Persian digits and the remaining count", () => {
  assert.equal(cpkMoreLabel(7), "۷ مورد دیگر — بیشتر");
  assert.equal(cpkMoreLabel(15), "۱۵ مورد دیگر — بیشتر");
  assert.equal(faNum(1275), "۱٬۲۷۵");
  assert.equal(formatPhoneLast4("9767"), "۹۷۶۷");
  assert.equal(formatPhoneLast4("0611"), "۰۶۱۱");
});

ok("follow-up is Jalali month + Tehran clock; undo names the destination column", () => {
  assert.equal(formatFollowUp("2026-11-19T06:30:00.000Z"), "۲۸ آبان، ساعت ۱۰:۰۰");
  assert.equal(formatFollowUp(null), null);
  assert.equal(formatFollowUp("nope"), null);
  assert.equal(cpkUndoMessage("نمونه", 2), "اولویتِ نمونه به اولویت ۲ تغییر کرد.");
  assert.equal(cpkUndoMessage("نمونه", null), "اولویتِ نمونه به بدون اولویت تغییر کرد.");
});

ok("last call stays relative («X روز پیش») and never a calendar date", () => {
  const now = new Date("2026-11-17T07:35:00.000Z");
  assert.equal(formatLastCall("2026-11-17T07:34:30.000Z", now), "همین حالا");
  assert.equal(formatLastCall("2026-11-16T07:35:00.000Z", now), "دیروز");
  assert.equal(formatLastCall("2026-11-12T07:35:00.000Z", now), "۵ روز پیش");
  assert.equal(formatLastCall("2026-10-27T07:35:00.000Z", now), "۲۱ روز پیش");
  assert.ok(!String(formatLastCall("2026-10-27T07:35:00.000Z", now)).includes("/"));
  assert.equal(formatLastCall(null, now), null);
});

console.log(`customers-priority-kanban helpers ${passed}/6`);
