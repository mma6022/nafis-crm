/**
 * plan-advisor v1 display helpers (no new calculator math).
 *   node --experimental-strip-types scripts/plan-advisor-fixture.mjs
 */
import assert from "node:assert/strict";
import { faMonths, faNum, faToman, formatPrincipalInput, parsePrincipalInput, paStepLabel, paTotalPayable } from "../src/features/plan-advisor/helpers.ts";
import { pa390DockTabs, pa390TabHrefs } from "../src/features/plan-advisor/dock-tabs.ts";
import { bnv2Slots } from "../src/features/bottom-nav-v2/layout.ts";

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log("ok -", name); };

ok("§6.3 total payable is installment×count + down payment + file fee (commission stays out)", () => {
  assert.equal(paTotalPayable(22_332_024, 18, 0, 1_500_000), 22_332_024 * 18 + 1_500_000);
  assert.equal(paTotalPayable(1_000_000, 12, 5_000_000, 1_500_000), 18_500_000);
  assert.notEqual(paTotalPayable(1_000_000, 12, 0, 0) + 3_000_000, paTotalPayable(1_000_000, 12, 0, 0));
});

ok("Persian grouping and month list", () => {
  assert.equal(faNum(350_000_000), "۳۵۰٬۰۰۰٬۰۰۰");
  assert.ok(faToman(245_000_000).includes("تومان"));
  assert.equal(faMonths([]), "");
  assert.ok(faMonths([18]).includes("۱۸"));
  assert.ok(faMonths([12, 18, 24]).includes("و"));
});

ok("rendered numbers use the Persian thousands separator ٬, never a Latin comma", () => {
  const samples = [
    faNum(300_000_000), faNum(2301), faNum(18), faNum(12_300_000),
    faToman(19_864_314), faToman(357_857_652), faToman(12_300_000),
    formatPrincipalInput("300000000"), formatPrincipalInput("۳۰۰۰۰۰۰۰۰"),
    `سقف ${faToman(300_000_000)}`, `#${faNum(2301)}`,
  ];
  for (const s of samples) {
    assert.equal(s.includes(","), false, `Latin comma in ${JSON.stringify(s)}`);
    assert.equal(s.includes(","), false, s);
  }
  assert.equal(faNum(300_000_000), "۳۰۰٬۰۰۰٬۰۰۰");
  assert.equal(faNum(2301), "۲٬۳۰۱");
  assert.equal(faNum(18), "۱۸");
  assert.equal(faNum(12_300_000), "۱۲٬۳۰۰٬۰۰۰");
  assert.equal(formatPrincipalInput("300000000"), "۳۰۰٬۰۰۰٬۰۰۰");
  assert.ok(faNum(300_000_000).includes("٬"));
  assert.ok(faNum(2301).includes("٬"));
});

ok("principal input parses Western and Persian digits", () => {
  assert.equal(parsePrincipalInput("350000000"), 350_000_000);
  assert.equal(parsePrincipalInput("۳۵۰٬۰۰۰٬۰۰۰"), 350_000_000);
  assert.equal(parsePrincipalInput(""), null);
  assert.ok(formatPrincipalInput("350000000").includes("۳"));
});

ok("wizard step labels", () => {
  assert.ok(paStepLabel(0).includes("مشتری"));
  assert.ok(paStepLabel(1).includes("شرایط"));
  assert.ok(paStepLabel(3).includes("ماشین‌حساب"));
});


const today = { key: "today", href: "/today", label: "امروز" };
const pay = { key: "pay", href: "/payment-orders", label: "دستور پرداخت" };
const files = { key: "files", href: "/loan-applications", label: "پرونده‌ها" };
const bale = { key: "bale", href: "/bale-bot", label: "ربات بله" };
const pa = { key: "pa", label: "دستیار" };
const rem = { key: "rem", href: "/reminders", label: "یادآورها" };
const team = { key: "team", href: "/internal-chat", label: "داخلی" };
const adminLive = [today, pay, files, bale];
const expertLive = [today, pay, files];
const ADMIN_VISIBLE = [
  "/today", "/customers", "/loan-applications", "/reminders", "/payment-orders",
  "/messengers", "/internal-chat", "/bale-bot", "/bale-bot/admin", "/goods-purchases",
  "/sales-reports", "/users", "/settings/assistants",
];
const EXPERT_VISIBLE = [
  "/today", "/customers", "/loan-applications", "/reminders", "/payment-orders",
  "/messengers", "/internal-chat", "/bale-bot", "/goods-purchases", "/my-wallet", "/my-performance",
];

ok("flag OFF leaves the live 390 dock tabs unchanged (admin and expert, including bnv2 live slots)", () => {
  const offAdmin = pa390DockTabs(false, adminLive, [], pa);
  assert.deepEqual(offAdmin.tabs, adminLive);
  assert.deepEqual(offAdmin.movedToMore, []);
  const offExpert = pa390DockTabs(false, expertLive, [rem, bale, team], pa);
  assert.deepEqual(offExpert.tabs, expertLive);
  assert.deepEqual(offExpert.movedToMore, []);
  // no pa item (flag effectively off) even if paOn is true
  assert.deepEqual(pa390DockTabs(true, adminLive, [], null).tabs, adminLive);
  const liveAdmin = bnv2Slots({ flagOn: true, role: "admin", visible: ADMIN_VISIBLE });
  const fromLive = liveAdmin.tabs.map((href) => ({ key: href, href }));
  assert.deepEqual(pa390TabHrefs(pa390DockTabs(false, fromLive, [], pa).tabs), liveAdmin.tabs);
  const liveExpert = bnv2Slots({ flagOn: true, role: "salesperson", visible: EXPERT_VISIBLE });
  const fromEx = liveExpert.tabs.map((href) => ({ key: href, href }));
  assert.deepEqual(pa390TabHrefs(pa390DockTabs(false, fromEx, [], pa).tabs), liveExpert.tabs);
  // bnv2 itself is not rewritten: live admin still has دستور پرداخت on the 390 tabs
  assert.deepEqual(liveAdmin.tabs, ["/today", "/payment-orders", "/loan-applications", "/bale-bot"]);
});

ok("flag ON 390 order is امروز، پرونده‌ها، ربات بله، دستیار; دستور پرداخت moves to بیشتر", () => {
  const r = pa390DockTabs(true, adminLive, [], pa);
  assert.deepEqual(r.tabs.map((t) => t.label), ["امروز", "پرونده‌ها", "ربات بله", "دستیار"]);
  assert.deepEqual(pa390TabHrefs(r.tabs), ["/today", "/loan-applications", "/bale-bot", "pa"]);
  assert.deepEqual(r.movedToMore.map((t) => t.href), ["/payment-orders"]);
  assert.ok(!r.tabs.some((t) => t.href === "/payment-orders"));
});

ok("flag ON expert: ربات بله is pulled from daily onto the dock; دستور پرداخت still goes to بیشتر", () => {
  const r = pa390DockTabs(true, expertLive, [rem, bale, team], pa);
  assert.deepEqual(pa390TabHrefs(r.tabs), ["/today", "/loan-applications", "/bale-bot", "pa"]);
  assert.ok(r.movedToMore.some((t) => t.href === "/payment-orders"));
  assert.ok(!r.movedToMore.some((t) => t.href === "/bale-bot"));
});

ok("flag ON without a bale tab does not invent one; pay still leaves the dock", () => {
  const r = pa390DockTabs(true, expertLive, [rem, team], pa);
  assert.deepEqual(pa390TabHrefs(r.tabs), ["/today", "/loan-applications", "pa"]);
  assert.ok(r.movedToMore.some((t) => t.href === "/payment-orders"));
});

console.log(`\n${passed} passed`);
