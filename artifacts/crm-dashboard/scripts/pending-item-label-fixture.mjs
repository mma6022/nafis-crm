/** Small unit test for TodaySplit pending_item → Persian mapping (follow-up r2). Never hits live. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { pendingItemLabel } from "../src/features/today-split/pending-item-label.ts";

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log("ok", name); }
  catch (e) { failed += 1; console.error("FAIL", name, e?.message || e); }
}

ok("collateral → وثیقه", () => {
  assert.equal(pendingItemLabel("collateral"), "وثیقه");
});
ok("guarantor → ضامن", () => {
  assert.equal(pendingItemLabel("guarantor"), "ضامن");
});
ok("any other non-null key → مورد دیگر", () => {
  assert.equal(pendingItemLabel("other"), "مورد دیگر");
  assert.equal(pendingItemLabel("pending_item"), "مورد دیگر");
  assert.equal(pendingItemLabel("collateral_stage"), "مورد دیگر");
});
ok("null / empty stay empty", () => {
  assert.equal(pendingItemLabel(null), null);
  assert.equal(pendingItemLabel(undefined), null);
  assert.equal(pendingItemLabel(""), null);
});

const src = readFileSync(new URL("../src/features/today-split/TodaySplit.tsx", import.meta.url), "utf8");
ok("reasonOf maps pending_item through pendingItemLabel under «منتظر»", () => {
  assert.match(src, /pendingItemLabel/);
  assert.match(src, /if \(f\.pending_item\)/);
  assert.match(src, /k: 'منتظر'/);
  assert.doesNotMatch(src, /t: f\.pending_item/);
});
ok("the منتظر box is a span, not a quoting <q>, and does not repeat منتظر in the value", () => {
  assert.match(src, /r\.k === "منتظر" \? <span data-testid="ts-reason">\{r\.t\}<\/span>/);
  assert.doesNotMatch(src, /t: 'منتظر'/);
  assert.doesNotMatch(src, /t: `منتظر/);
});

const inbox = readFileSync(new URL("../src/features/bale-bot/BaleBotInbox.tsx", import.meta.url), "utf8");
ok("Bale / sign-reminder customer column heading is «پرونده در سامانه»", () => {
  const n = (inbox.match(/<h3>پرونده در سامانه<\/h3>/g) || []).length;
  assert.ok(n >= 11, "expected at least 11 headings, got " + n);
  assert.doesNotMatch(inbox, /<h3>پرونده در CRM<\/h3>/);
});

if (failed) { console.error(failed, "failed"); process.exit(1); }
console.log("pending-item-label fixture PASS");
