// Team-sales commission model fixture: pure rules + full DB flows on a throwaway copy. Never touches live; sends nothing.
// Usage: TEAM_COMMISSION_FIXTURE_DB=/path/to/copy.db node scripts/run-bundled-fixture.mjs scripts/team-commission-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

// The DB module opens CRM_DATABASE_PATH on import: always point it at a throwaway file first.
const src = process.env.TEAM_COMMISSION_FIXTURE_DB;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-commission-fx-"));
const dbPath = path.join(dir, "customers.db");
if (!src) { fs.rmSync(dir, { recursive: true, force: true }); console.log("SKIP: set TEAM_COMMISSION_FIXTURE_DB to a local copy of the CRM DB (the DB module needs the real schema)."); process.exit(0); }
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; // plain JSON logs (pino-pretty transport cannot be bundled)
process.env.LOG_LEVEL = "warn";
const tc = await import("../src/lib/team-commission.ts");

let passed = 0; const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };
const throwsStatus = (fn, status, re) => assert.throws(fn, (e) => e.status === status && (!re || re.test(e.message) || re.test(JSON.stringify(e.errors ?? {}))));

/* ---------- pure ---------- */
ok("2 Aban 1405 = 2026-10-24 Tehran midnight", () => assert.equal(tc.jalaliDateStart("1405-08-02").toISOString(), "2026-10-23T20:30:00.000Z"));
ok("persian month of today = 1405-08, next = 1405-09, wraps year", () => {
  assert.equal(tc.persianMonthOf(new Date("2026-10-24T06:00:00Z")), "1405-08");
  assert.equal(tc.nextPersianMonth("1405-08"), "1405-09"); assert.equal(tc.nextPersianMonth("1405-12"), "1406-01"); assert.equal(tc.previousPersianMonth("1406-01"), "1405-12");
});
ok("defaults: OFF, deposit basis, payment-paid posting, 0.5/0.75%, 200k, team bonus off 0.3% >10bn 40/40/20", () => {
  const d = tc.DEFAULT_SETTINGS;
  assert.equal(d.enabled, false); assert.equal(d.basis, "deposit"); assert.equal(d.postingMoment, "payment_paid"); assert.equal(d.modelStartDate, "1405-08-02");
  assert.equal(d.p1FirstCallBps, 50); assert.equal(d.p1UpgradeBps, 75); assert.equal(d.dataAccuracyBonusToman, "200000");
  assert.equal(d.teamBonusEnabled, false); assert.equal(d.teamBonusBps, 30); assert.equal(d.teamBonusThresholdToman, "10000000000"); assert.equal(d.teamBonusBasis, "total");
  assert.deepEqual(d.teamSplitBps, { 3: 4000, 4: 4000, 6: 2000 });
});
const D = tc.DEFAULT_SETTINGS, V = tc.settingsView(D);
const bad = (patch, field, re) => assert.throws(() => tc.validateSettingsInput({ ...V, ...patch }, D), (e) => e.status === 400 && e.errors && field in e.errors && (!re || re.test(e.errors[field])));
ok("validation: split must total 100 (exact message)", () => bad({ teamSplit: [{ salespersonId: 3, percent: "40" }, { salespersonId: 4, percent: "30" }, { salespersonId: 6, percent: "20" }] }, "teamSplit", /^جمع سهم‌ها باید ۱۰۰٪ باشد؛ الان ۹۰٪ است\.$/));
ok("validation: percent 0–100, max 2 decimals", () => { bad({ p1FirstCallPercent: "101" }, "p1FirstCallPercent"); bad({ p1UpgradePercent: "0.755" }, "p1UpgradePercent"); bad({ teamBonusPercent: "-1" }, "teamBonusPercent"); });
ok("validation: amounts positive", () => { bad({ dataAccuracyBonusToman: "0" }, "dataAccuracyBonusToman"); bad({ teamBonusThresholdToman: "-5" }, "teamBonusThresholdToman"); });
ok("validation: Persian digits accepted", () => assert.equal(tc.validateSettingsInput({ ...V, p1FirstCallPercent: "۰٫۶" }, D).p1FirstCallBps, 60));
ok("team bonus math: total vs excess basis, floor, 40/40/20", () => {
  const on = { ...D, teamBonusEnabled: true };
  const a = tc.teamBonusAmounts(12_000_000_000n, on);
  assert.equal(a.bonus, 36_000_000n); assert.deepEqual(a.shares.map((s) => s.amountToman), ["14400000", "14400000", "7200000"]);
  const b = tc.teamBonusAmounts(12_000_000_000n, { ...on, teamBonusBasis: "above_threshold" });
  assert.equal(b.bonus, 6_000_000n); assert.deepEqual(b.shares.map((s) => s.amountToman), ["2400000", "2400000", "1200000"]);
  assert.equal(tc.teamBonusAmounts(10_000_000_000n, on).bonus, 0n);
});

/* ---------- DB flows on a copy ---------- */
try {
  const { queryRow, queryRows, execute, executeChanges, runTransaction } = await import("../src/lib/crm-db.ts");
  await import("../src/lib/goods-finance.ts");
  await import("../src/lib/payment-orders.ts").catch(() => null);
  const m = await import("../src/lib/team-commission.ts");
  m.ensureTeamCommissionSchema();
  // Throwaway copy only: the fixture marks orders paid directly (the real /pay route posts the accounting journal first;
  // that end-to-end path is exercised against the local server in the copy-DB demo).
  execute("DROP TRIGGER IF EXISTS accounting_require_payment_journal");

  const admin = { id: 1, role: "admin", salespersonId: null };
  const hasani = { id: 2, role: "salesperson", salespersonId: 3 };
  const ghasemi = { id: 3, role: "salesperson", salespersonId: 4 };
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6 };
  const ledgerSnap = () => JSON.stringify(queryRows("SELECT * FROM goods_finance_ledger ORDER BY id"));
  const legacySnap = () => JSON.stringify(queryRows("SELECT id,stage,commission_bps,commission_toman,commission_month FROM goods_purchases ORDER BY id"));
  const walletSnap = (sp) => BigInt(queryRow("SELECT balance_toman b FROM goods_salesperson_wallets WHERE salesperson_id=?", [sp])?.b ?? "0");
  const ledgerBefore = ledgerSnap(), legacyBefore = legacySnap();
  const traineeWallets = [5, 19, 20].map(walletSnap);
  const bellMax = () => Number(queryRow("SELECT MAX(id) m FROM site_notification_events")?.m ?? 0);

  const cols = (t) => queryRows(`PRAGMA table_info(${t})`).map((c) => c.name).filter((c) => c !== "id");
  const clone = (t, id, over) => {
    const cs = cols(t);
    return Number(execute(`INSERT INTO ${t}(${cs.join(",")}) SELECT ${cs.map((c) => (c in over ? "?" : c)).join(",")} FROM ${t} WHERE id=?`,
      [...cs.filter((c) => c in over).map((c) => over[c]), id]));
  };
  let seq = 0;
  const fakeCustomer = (sp) => clone("customers", 1249, { name: `مشتری نمونه ${++seq}`, phone: `0900000${String(1000 + seq)}`, salesperson_id: sp, priority: 1,
    national_code: null, merged_into_customer_id: null, created_at: new Date().toISOString() });
  const cfgJson = (sp) => { const r = queryRow("SELECT * FROM goods_salesperson_settings WHERE salesperson_id=?", [sp]); return JSON.stringify({ ...r }); };
  const fakePurchase = (customerId, sp, payout, base = payout) => clone("goods_purchases", 40, { customer_id: customerId, salesperson_id: sp, stage: "registrar_confirmation",
    payout_amount_toman: String(payout), base_payout_amount_toman: String(base), completed_at: null, commission_bps: null, commission_toman: null, commission_month: null,
    commission_settings_json: cfgJson(sp), created_at: new Date().toISOString() });
  const history = (customerId, source, oldP, closerSp, at = new Date(Date.now() - 3600e3)) => Number(execute(
    "INSERT INTO customer_priority_history(customer_id,old_priority,new_priority,old_salesperson_id,new_salesperson_id,actor_user_id,source,reason,created_at) VALUES(?,?,1,6,?,8,?,?,?)",
    [customerId, oldP, closerSp, source, "fixture", at.toISOString()]));
  const order = (purchaseId, customerId, sp, amount) => Number(execute(
    "INSERT INTO customer_payment_orders(purchase_id,customer_id,salesperson_id,amount_toman,stage,created_by,created_at,updated_at) VALUES(?,?,?,?, 'awaiting_payment',1,?,?)",
    [purchaseId, customerId, sp, String(amount), new Date().toISOString(), new Date().toISOString()]));
  const complete = (pid) => runTransaction(() => m.onGoodsPurchaseCompletion(queryRow("SELECT * FROM goods_purchases WHERE id=?", [pid]), 1));
  const pay = (pid) => runTransaction(() => { executeChanges("UPDATE customer_payment_orders SET stage='paid',paid_at=?,paid_by=1 WHERE purchase_id=?", [new Date().toISOString(), pid]); return m.onPaymentOrderPaid(pid, 1); });
  const ledgerOf = (pid, kind) => queryRows("SELECT salesperson_id sp, amount_toman a FROM goods_finance_ledger WHERE purchase_id=? AND kind=? ORDER BY id", [pid, kind]);
  const month = m.persianMonthOf(new Date());

  /* model OFF (as shipped): nothing changes */
  ok("model ships OFF: completion stays on the legacy path", () => {
    assert.equal(m.settingsAt().settings.enabled, false); assert.equal(m.settingsAt().versionId, 0);
    const c = fakeCustomer(3), p = fakePurchase(c, 3, 300_000_000);
    assert.equal(complete(p), "legacy");
    assert.equal(queryRow("SELECT stage FROM goods_purchases WHERE id=?", [p]).stage, "registrar_confirmation");
    execute("DELETE FROM goods_purchases WHERE id=?", [p]);
  });
  ok("state card hidden while OFF", () => { const c = fakeCustomer(3); history(c, "qualifier_form", null, 3); assert.equal(m.dataAccuracyState(c, hasani).visible, false); });

  // Hasani filler so the 300m case lands in the 2% tier (Aban prior >= 1.7bn) — synthetic, copy only.
  const fillerC = fakeCustomer(3);
  const filler = fakePurchase(fillerC, 3, 1_750_000_000);
  execute("UPDATE goods_purchases SET stage='completed',completed_at=?,commission_bps=150,commission_toman='26250000',commission_month=? WHERE id=?", [new Date().toISOString(), month, filler]);

  const v1 = m.saveSettings({ ...m.settingsView(m.settingsAt().settings), enabled: true }, 1);
  ok("enable: new settings version 1 effective now", () => { assert.equal(v1.versionId, 1); assert.equal(m.settingsAt().settings.enabled, true); });

  /* PM example: 300m deposit, P1 from first call, Hasani at 2% */
  const cA = fakeCustomer(3); const hA = history(cA, "qualifier_form", null, 3);
  const pA = fakePurchase(cA, 3, 300_000_000, 280_000_000); order(pA, cA, 3, 300_000_000);
  const kazW0 = walletSnap(6), hasW0 = walletSnap(3);
  let bell0 = 0;
  ok("final approval defers posting until the payment order is paid", () => {
    assert.equal(complete(pA), "deferred");
    assert.equal(queryRow("SELECT stage FROM goods_purchases WHERE id=?", [pA]).stage, "completed");
    assert.equal(ledgerOf(pA, "salesperson_commission").length, 0);
    assert.equal(queryRow("SELECT status FROM team_commission_purchases WHERE purchase_id=?", [pA]).status, "pending_payout");
    bell0 = bellMax();
  });
  ok("PM 300m: on «پرداخت‌شده» Hasani 6,000,000 (2% of deposit) + Kazemi 1,500,000 (0.5% first call)", () => {
    assert.deepEqual(pay(pA), { posted: true });
    assert.deepEqual(ledgerOf(pA, "salesperson_commission").map((r) => [r.sp, r.a]), [[3, "6000000"]]);
    assert.deepEqual(ledgerOf(pA, "p1_referral_share").map((r) => [r.sp, r.a]), [[6, "1500000"]]);
    assert.equal(walletSnap(3) - hasW0, 6_000_000n); assert.equal(walletSnap(6) - kazW0, 1_500_000n);
    const st = queryRow("SELECT * FROM team_commission_purchases WHERE purchase_id=?", [pA]);
    assert.equal(st.status, "posted"); assert.equal(st.closer_rate_bps, 200); assert.equal(st.basis_amount_toman, "300000000"); assert.equal(st.p1_kind, "first_call"); assert.equal(st.settings_version_id, 1);
  });
  ok("paying twice posts nothing more (idempotent)", () => { assert.deepEqual(pay(pA), { posted: false }); assert.equal(ledgerOf(pA, "salesperson_commission").length, 1); });
  ok("Kazemi share does not count in Kazemi's tier total; nothing deducted from the closer", () => {
    const r = queryRows("SELECT 1 FROM goods_purchases WHERE salesperson_id=6 AND commission_month=? AND stage='completed'", [month]);
    assert.equal(r.length, 0);
    assert.equal(queryRow("SELECT commission_toman c FROM goods_purchases WHERE id=?", [pA]).c, "6000000");
  });
  ok("no staff notifications from commission bookkeeping (ledger/wallet/events are silent)", () => {
    // the payment-order row update itself is the existing pay flow; only count rows beyond it
    const extra = queryRows("SELECT * FROM site_notification_events WHERE id>? AND resource_type<>'payment'", [bell0]);
    assert.equal(extra.length, 0, JSON.stringify(extra));
  });

  /* data accuracy */
  ok("card: pending for closer, read-only for Kazemi", () => {
    const s = m.dataAccuracyState(cA, hasani); assert.equal(s.visible, true); assert.equal(s.status, "pending"); assert.equal(s.canReview, true); assert.equal(s.bonusToman, "200000");
    const k = m.dataAccuracyState(cA, kazemi); assert.equal(k.canReview, false); assert.equal(k.viewer, "qualifier");
  });
  ok("only the case's closer may submit first (not the qualifier, another closer or even admin)", () => { throwsStatus(() => m.recordDataAccuracy(cA, ghasemi, { correct: true }), 403); throwsStatus(() => m.recordDataAccuracy(cA, kazemi, { correct: true }), 403); throwsStatus(() => m.recordDataAccuracy(cA, admin, { correct: true }), 403, /فقط کارشناس پیگیری/); });
  ok("«درست بود» → Kazemi +200,000 (independent of payout), idempotent", () => {
    const w = walletSnap(6);
    const r = m.recordDataAccuracy(cA, hasani, { correct: true });
    assert.equal(r.state.status, "correct"); assert.equal(walletSnap(6) - w, 200_000n);
    assert.equal(m.recordDataAccuracy(cA, hasani, { correct: true }).idempotent, true); assert.equal(walletSnap(6) - w, 200_000n);
    throwsStatus(() => m.recordDataAccuracy(cA, hasani, { correct: false, reason: "unreported_document" }), 409);
    assert.equal(queryRow("SELECT COUNT(*) n FROM call_logs WHERE customer_id=? AND subject='اطلاعات تماس اول درست بود'", [cA]).n, 1);
  });

  /* upgraded from P2 → 0.75% */
  const cB = fakeCustomer(4); history(cB, "promote", 2, 4);
  const pB = fakePurchase(cB, 4, 300_000_000); order(pB, cB, 4, 300_000_000);
  ok("upgrade from P2: Kazemi 2,250,000 (0.75%), exactly one share", () => {
    complete(pB); pay(pB);
    assert.deepEqual(ledgerOf(pB, "p1_referral_share").map((r) => [r.sp, r.a]), [[6, "2250000"]]);
    assert.equal(queryRow("SELECT p1_kind k FROM team_commission_purchases WHERE purchase_id=?", [pB]).k, "upgrade");
  });
  ok("«نبود»: 'other' needs ≥10 chars; no bonus; reason stored in history", () => {
    throwsStatus(() => m.recordDataAccuracy(cB, ghasemi, { correct: false }), 400, /یک دلیل انتخاب کن/);
    throwsStatus(() => m.recordDataAccuracy(cB, ghasemi, { correct: false, reason: "other", note: "کوتاه" }), 400, /حداقل ۱۰ حرف/);
    const w = walletSnap(6);
    const r = m.recordDataAccuracy(cB, ghasemi, { correct: false, reason: "other", note: "شغل اعلامی با سوابق بیمه نمی‌خواند" });
    assert.equal(r.state.status, "incorrect"); assert.equal(r.state.review.reasonLabel, "سایر"); assert.equal(walletSnap(6), w);
    const log = queryRow("SELECT expert_notes n FROM call_logs WHERE customer_id=? AND subject='اطلاعات تماس اول درست نبود'", [cB]);
    assert.match(log.n, /سایر/); assert.match(log.n, /پاداش تعلق نگرفت/);
    throwsStatus(() => m.recordDataAccuracy(cB, ghasemi, { correct: true }), 409);
  });
  ok("admin may change it later (compensating ledger rows, never edits the original)", () => {
    const w = walletSnap(6);
    m.recordDataAccuracy(cB, admin, { correct: true }); assert.equal(walletSnap(6) - w, 200_000n);
    m.recordDataAccuracy(cB, admin, { correct: false, reason: "unreported_bounced_cheque" }); assert.equal(walletSnap(6), w);
    const rows = queryRows("SELECT amount_toman a, idempotency_key k FROM goods_finance_ledger WHERE kind='data_accuracy_bonus' AND customer_id=? ORDER BY id", [cB]);
    assert.deepEqual(rows.map((r) => r.a), ["200000", "-200000"]);
    assert.equal(m.dataAccuracyState(cB, admin).review.revision, 3);
  });

  /* settings change never recomputes posted rows; pending rows keep their snapshot */
  const cC = fakeCustomer(4); history(cC, "qualifier_form", null, 4);
  const pC = fakePurchase(cC, 4, 100_000_000); order(pC, cC, 4, 100_000_000);
  complete(pC); // snapshot v1 (0.5%)
  const postedBefore = JSON.stringify(queryRows("SELECT * FROM goods_finance_ledger WHERE purchase_id IN (?,?) ORDER BY id", [pA, pB]));
  const v2 = m.saveSettings({ ...m.settingsView(m.settingsAt().settings), p1FirstCallPercent: "1", dataAccuracyBonusToman: "300000" }, 1);
  ok("settings change: posted rows untouched", () => assert.equal(JSON.stringify(queryRows("SELECT * FROM goods_finance_ledger WHERE purchase_id IN (?,?) ORDER BY id", [pA, pB])), postedBefore));
  ok("settings change: a case that entered before keeps its snapshot (0.5% not 1%)", () => {
    pay(pC); assert.deepEqual(ledgerOf(pC, "p1_referral_share").map((r) => r.a), ["500000"]);
    assert.equal(queryRow("SELECT settings_version_id v FROM team_commission_purchases WHERE purchase_id=?", [pC]).v, 1);
  });
  ok("settings versions are listed newest first", () => assert.deepEqual(m.listSettingsVersions().slice(0, 2).map((v) => v.versionId), [v2.versionId, 1]));

  /* basis: legacy base */
  m.saveSettings({ ...m.settingsView(m.settingsAt().settings), basis: "legacy_base", p1FirstCallPercent: "0.5" }, 1);
  const cD = fakeCustomer(4); history(cD, "qualifier_form", null, 4);
  const pD = fakePurchase(cD, 4, 300_000_000, 250_000_000); order(pD, cD, 4, 300_000_000);
  ok("basis = legacy base: percentages on base_payout (250m), not deposit", () => {
    complete(pD); pay(pD);
    const st = queryRow("SELECT * FROM team_commission_purchases WHERE purchase_id=?", [pD]);
    assert.equal(st.basis, "legacy_base"); assert.equal(st.basis_amount_toman, "250000000");
    assert.deepEqual(ledgerOf(pD, "p1_referral_share").map((r) => r.a), ["1250000"]);
    assert.equal(BigInt(ledgerOf(pD, "salesperson_commission")[0].a), 250_000_000n * BigInt(st.closer_rate_bps) / 10000n);
  });

  /* posting moment: registrar final approval */
  m.saveSettings({ ...m.settingsView(m.settingsAt().settings), basis: "deposit", postingMoment: "final_approval" }, 1);
  const cE = fakeCustomer(3); history(cE, "promote", 3, 3);
  const pE = fakePurchase(cE, 3, 200_000_000);
  ok("posting moment = final approval: posts at completion, no payment order needed", () => {
    assert.equal(complete(pE), "posted");
    assert.equal(ledgerOf(pE, "p1_referral_share")[0].a, "1500000");
  });
  m.saveSettings({ ...m.settingsView(m.settingsAt().settings), postingMoment: "payment_paid" }, 1);
  ok("payment order already paid before final approval → posts at completion", () => {
    const c = fakeCustomer(3); const p = fakePurchase(c, 3, 50_000_000); order(p, c, 3, 50_000_000);
    executeChanges("UPDATE customer_payment_orders SET stage='paid' WHERE purchase_id=?", [p]);
    assert.equal(complete(p), "posted");
  });

  /* reversal next month */
  ok("cancelled after payout: percentage commissions deducted NEXT month from closer and Kazemi; accuracy bonus kept", () => {
    const k = walletSnap(6), h = walletSnap(3);
    const r = m.reversePurchaseCommission(pA, 1, "مشتری انصراف داد و مبلغ برگشت");
    assert.equal(r.deductionMonth, m.nextPersianMonth(month)); assert.equal(r.entries, 2);
    const d = queryRows("SELECT l.salesperson_id sp,l.amount_toman a,t.commission_month mo FROM goods_finance_ledger l JOIN team_commission_ledger_meta t ON t.ledger_id=l.id WHERE l.purchase_id=? AND l.kind='returned_case_deduction' ORDER BY l.id", [pA]);
    assert.deepEqual(d.map((x) => [x.sp, x.a, x.mo]), [[3, "-6000000", r.deductionMonth], [6, "-1500000", r.deductionMonth]]);
    assert.equal(h - walletSnap(3), 6_000_000n); assert.equal(k - walletSnap(6), 1_500_000n);
    assert.equal(queryRows("SELECT 1 FROM goods_finance_ledger WHERE kind='data_accuracy_bonus' AND customer_id=? AND CAST(amount_toman AS INTEGER)<0", [cA]).length, 0);
    assert.equal(m.reversePurchaseCommission(pA, 1, "مشتری انصراف داد و مبلغ برگشت").alreadyReversed, true);
    throwsStatus(() => m.reversePurchaseCommission(pC, 1, "کو"), 400);
  });
  ok("report: deduction shows in next month's breakdown, not this month's", () => {
    const next = m.salespersonBreakdown(3, m.nextPersianMonth(month), null);
    assert.equal(next.breakdown.find((b) => b.kind === "returned_case_deduction").totalToman, "-6000000");
    const cur = m.salespersonBreakdown(6, month, "p1_referral_share");
    assert.ok(cur.transactions.every((t) => t.kind === "p1_referral_share"));
    assert.equal(cur.breakdown.find((b) => b.kind === "p1_referral_share").totalToman, String(1_500_000 + 2_250_000 + 500_000 + 1_250_000 + 1_500_000));
    assert.equal(cur.stats.p1FirstCall >= 3, true); assert.equal(cur.stats.accuracyCorrect, 1);
  });

  /* trainees + before start */
  ok("trainees (Aslanian/Yunesi/Khordkar) stay on the legacy path", () => {
    for (const sp of [5, 19, 20]) { const c = fakeCustomer(sp); const p = fakePurchase(c, sp, 300_000_000); assert.equal(complete(p), "legacy"); execute("DELETE FROM goods_purchases WHERE id=?", [p]); }
    assert.deepEqual([5, 19, 20].map(walletSnap), traineeWallets);
  });
  ok("before 2 Aban 1405: legacy path; earlier months untouched", () => {
    const c = fakeCustomer(3); const p = fakePurchase(c, 3, 300_000_000);
    assert.equal(runTransaction(() => m.onGoodsPurchaseCompletion(queryRow("SELECT * FROM goods_purchases WHERE id=?", [p]), 1, new Date("2026-10-20T10:00:00+03:30"))), "legacy");
    execute("DELETE FROM goods_purchases WHERE id=?", [p]);
    const old = JSON.parse(ledgerBefore); const now = queryRows("SELECT * FROM goods_finance_ledger WHERE id<=? ORDER BY id", [old.at(-1)?.id ?? 0]);
    assert.equal(JSON.stringify(now), ledgerBefore);
    const legacyNow = JSON.parse(legacySnap()).filter((r) => JSON.parse(legacyBefore).some((b) => b.id === r.id));
    assert.equal(JSON.stringify(legacyNow), legacyBefore);
  });

  /* team bonus */
  const after = new Date(m.monthEnd(month).getTime() + 86400e3);
  ok("team bonus OFF (default): month-end job writes nothing", () => {
    assert.deepEqual(m.runTeamBonus(month, 1, after), { ran: false, reason: "disabled" });
    assert.equal(queryRows("SELECT 1 FROM goods_finance_ledger WHERE kind='team_bonus'").length, 0);
  });
  ok("team bonus: month must be over", () => throwsStatus(() => m.runTeamBonus(month, 1, new Date()), 409));
  m.saveSettings({ ...m.settingsView(m.settingsAt().settings), teamBonusEnabled: true, teamBonusThresholdToman: "1000000000" }, 1);
  ok("team bonus ON: 0.3% of team sales above threshold, 40/40/20, idempotent per month", () => {
    const total = m.teamSalesForMonth(month);
    assert.ok(total > 1_000_000_000n);
    const r = m.runTeamBonus(month, 1, after);
    assert.equal(r.ran, true);
    const bonus = total * 30n / 10000n;
    assert.equal(r.bonusToman, bonus.toString());
    const rows = queryRows("SELECT salesperson_id sp, amount_toman a FROM goods_finance_ledger WHERE kind='team_bonus' ORDER BY salesperson_id");
    assert.deepEqual(rows.map((x) => [x.sp, x.a]), [[3, String(bonus * 4000n / 10000n)], [4, String(bonus * 4000n / 10000n)], [6, String(bonus * 2000n / 10000n)]]);
    assert.equal(m.runTeamBonus(month, 1, after).reason, "already_ran");
    assert.equal(queryRows("SELECT 1 FROM goods_finance_ledger WHERE kind='team_bonus'").length, 3);
  });
  ok("pay-route failure never blocks the payment (savepoint, last_error kept)", () => {
    const c = fakeCustomer(3); const p = fakePurchase(c, 3, 10_000_000); order(p, c, 3, 10_000_000); complete(p);
    execute("UPDATE goods_purchases SET commission_settings_json='{}' WHERE id=?", [p]);
    const r = pay(p);
    assert.equal(r.posted, false);
    assert.equal(queryRow("SELECT stage FROM customer_payment_orders WHERE purchase_id=?", [p]).stage, "paid");
    assert.ok(queryRow("SELECT last_error e FROM team_commission_purchases WHERE purchase_id=?", [p]).e);
  });
  console.log(`\n${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
