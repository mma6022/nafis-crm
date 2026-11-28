/* t979 v1.1 — «پیام‌های آماده» three tabs: pure model + source guards (no browser). node --experimental-strip-types scripts/t979-quick-replies-ui-fixture.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "../src/features/quick-replies/model.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "features");
const src = (p) => readFileSync(join(root, p), "utf8");
const code = (p) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
let n = 0; const ok = (name, fn) => { fn(); n++; console.log("  ok ", name); };
const it = (id, o) => ({ id, kind: "free", planId: null, planTitle: null, title: `پیام ${id}`, body: `متن ${id}`, ...o });
const items = [
  it(1, { kind: "plan", planId: 10, planTitle: "طرح کارمندی", tab: "plans", body: "سلام ‹نام مشتری›، من ‹نام کارشناس› هستم؛ ‹نام طرح›" }),
  it(2, { kind: "plan", planId: 10, planTitle: "طرح کارمندی", tab: "plans" }),
  it(3, { kind: "plan", planId: 11, planTitle: "طرح خرید کالا", tab: "plans" }),
  it(4, { kind: "plan", planId: 12, planTitle: "طرح نقدی ۱۸ ماهه", tab: "plans" }),
  it(5, { tab: "general", category: "general" }), it(6, { tab: "general", category: "general" }),
  it(7, { category: "educational" }),
];

ok("tab of an item: plans / general / educational; absent tab is derived (flag-off shapes)", () => {
  assert.deepEqual(items.map(M.tabOf), ["plans", "plans", "plans", "plans", "general", "general", "educational"]);
  assert.equal(M.tabOf({ kind: "free" }), "general"); assert.equal(M.tabOf({ kind: "plan" }), "plans");
});
ok("counters per tab; every message lives in exactly one tab", () => {
  const c = M.countByTab(items); assert.deepEqual(c, { plans: 4, general: 2, educational: 1 });
  assert.equal(c.plans + c.general + c.educational, items.length);
  assert.deepEqual(M.inTab(items, "educational").map((x) => x.id), [7]);
});
ok("plan groups: the explained plan first and open, the rest closed; current plan next", () => {
  const g = M.planGroups(items, { explained: [11], currentPlanId: 12 });
  assert.deepEqual(g.map((x) => [x.planId, x.open]), [[11, true], [12, false], [10, false]]);
  assert.equal(g[0].items.length, 1);
});
ok("no plan explained → the current plan is open; nothing known → all closed; the expert's toggles win", () => {
  assert.deepEqual(M.planGroups(items, { currentPlanId: 10 }).map((x) => [x.planId, x.open]), [[10, true], [11, false], [12, false]]);
  assert.ok(M.planGroups(items).every((x) => !x.open));
  assert.deepEqual(M.planGroups(items, { explained: [10], toggled: { 10: false, 12: true } }).map((x) => [x.planId, x.open]), [[10, false], [11, false], [12, true]]);
});
ok("search finds by message or plan, opens the groups that match, hides the rest; Persian normalisation (ي/ك/digits/ZWNJ)", () => {
  const g = M.planGroups(items, { query: "كالا" }); assert.deepEqual(g.map((x) => [x.planId, x.open]), [[11, true]]);
  assert.deepEqual(M.planGroups(items, { query: "۱۸" }).map((x) => x.planId), [12]);
  assert.deepEqual(M.planGroups(items, { query: "پیام 2" }).map((x) => x.planId), [10]);
  assert.deepEqual(M.planGroups(items, { query: "چیزی نیست" }), []);
  assert.deepEqual(M.planGroups(items, { only: 11 }).map((x) => x.planId), [11]);
});
ok("default tab: remembered tab if valid; else «طرح‌ها» when a plan was explained in this chat, else «عمومی»", () => {
  assert.equal(M.defaultTab(items, [10], null), "plans"); assert.equal(M.defaultTab(items, [], null), "general");
  assert.equal(M.defaultTab(items, [10], "educational"), "educational"); assert.equal(M.defaultTab(items, [10], "bogus"), "plans");
  assert.equal(M.defaultTab(items.filter((x) => x.tab !== "plans"), [10], null), "general", "no plan messages → never an empty plans tab");
  const mem = {}; M.saveTab("educational", { setItem: (k, v) => { mem[k] = v; } }); assert.equal(M.loadTab({ getItem: (k) => mem[k] ?? null }), "educational");
  assert.equal(M.loadTab({ getItem: () => { throw new Error("denied"); } }), null);
});
ok("rendered text: customer, expert and plan names; unknown placeholder → empty (same rule as the server)", () => {
  assert.equal(M.renderText(items[0], { customer: "علی", expert: "رضا" }), "سلام علی، من رضا هستم؛ طرح کارمندی");
  assert.equal(M.renderText(it(9, { kind: "free", body: "برای ‹نام طرح›" }), {}), "برای");
});
ok("copy: the educational empty state is the design's words", () => {
  assert.equal(M.QR_EMPTY.educational.h + " " + M.QR_EMPTY.educational.p, "هنوز پیام آموزشی‌ای نیست. مدیر فروش این پیام‌ها را در مدیریت شبکه‌های اجتماعی می‌سازد.");
  assert.deepEqual(M.QR_TABS.map((t) => t.label), ["طرح‌ها", "عمومی", "آموزشی"]);
  assert.match(M.QR_ERR.already_sent, /دیگر برگردانده نمی‌شود/);
});

const files = ["quick-replies/ReadyTray.tsx", "quick-replies/ChatReady.tsx", "quick-replies/TabBar.tsx", "quick-replies/model.ts", "quick-replies/api.ts"];
ok("direct send + undo toast; no composer fill (the old «درج در پیام» path is gone); the tray stays open", () => {
  const t = src("quick-replies/ReadyTray.tsx"), a = src("quick-replies/api.ts");
  assert.match(a, /\/bale-bot\/chats\/\$\{chatId\}\/ready\/\$\{messageId\}/); assert.match(a, /\/bale-bot\/messages\/\$\{outId\}\/undo/); assert.match(a, /\/bale-bot\/ready\/\$\{messageId\}\/type/);
  assert.match(t, /ارسال شد/); assert.match(t, /برگرداندن/); assert.doesNotMatch(t, /putText|onPickText|setText|درج در پیام/);
  assert.match(t, /hold - 1000/, "the toast lasts about 5 s of the 6 s hold");
  assert.doesNotMatch(src("bale-workspace/Tray.tsx"), /putText|onPickText/);
});
ok("every surface is gated on the server's v11 answer → flag OFF keeps the old UI", () => {
  assert.match(src("bale-workspace/Tray.tsx"), /a\?\.ready\?\.v11 \? a\.ready : null/);
  assert.match(src("bale-bot/BaleBotInbox.tsx"), /me\.quickReplies \? " qr11"/); assert.match(src("bale-bot/BaleBotInbox.tsx"), /me\.quickReplies \? <QrBar/);
  assert.match(src("bale-bot/BaleBotCustomerSection.tsx"), /me\.quickReplies && c\.canOpen/);
  assert.match(src("social-hub/TodayBox.tsx"), /step === 1 && d\.v11/); assert.match(src("social-hub/Messages.tsx"), /const v11 = !!q\.data\.v11/);
  assert.match(src("quick-replies/ChatReady.tsx"), /ready\?\.v11 \? ready : null/);
});
ok("the tray no longer reads sab.quick_messages while v1.1 is on; the old rows stay for flag-off", () => {
  const t = src("bale-workspace/Tray.tsx"); assert.match(t, /a\?\.quick\.length && !qr/);
});
ok("settings: type cards with a hint, the plan only for «طرح‌ها», category sent only for free messages", () => {
  const m = src("social-hub/Messages.tsx");
  assert.match(m, /data-testid="sh-msg-type"/); assert.match(m, /\.\.\.\(v11 && kind === 'free' \? \{ category: cat \} : \{\}\)/); assert.match(m, /kind === 'plan' \? <label className="sh-frow">/);
  assert.deepEqual(M.QR_TABS.map((t) => M.QR_TAB_HINT[t.id]), ["وابسته به یک طرح", "پیام روزمره", "راهنمای مشتری"]);
});
ok("no technical words or forbidden terms in the new UI; targets ≥44px; AA bubble tokens exactly as the design", () => {
  for (const f of files) assert.doesNotMatch(code(f), /sh_messages|quick_messages|flag\.|سپرده|برآورد|تخمین|لندتک|۲۹/, f);
  const css = src("quick-replies/quick-replies.css");
  for (const h of ["#EEEFF5", "#FFFFFF", "#D8DCE8", "#C9CEDF", "#0B1450", "#C5CDED", "#A8B0E0", "#5E6BC4", "#212C85"]) assert.ok(css.includes(h), h);
  assert.match(css, /\.qr-tab\{[^}]*min-height:44px/); assert.match(css, /\.qr-btn\{[^}]*min-height:44px/); assert.match(css, /\.qr-chip\{[^}]*min-height:44px/);
  assert.match(css, /border-right:3px solid var\(--chat-in-edge\)/); assert.match(css, /border-left:3px solid var\(--chat-out-edge\)/);
  assert.match(css, /scroll-snap-type:y proximity/, "a row is never cut half in the scrolled list");
});
console.log(`PASS ${n}`);
