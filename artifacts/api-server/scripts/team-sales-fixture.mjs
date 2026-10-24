// Team-sales fixture: pure rules + DB flows on a throwaway DB copy. Never touches live; sends nothing.
// Usage: TEAM_SALES_FIXTURE_DB=/path/to/copy-source.db node scripts/run-bundled-fixture.mjs scripts/team-sales-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;
import {
  addWorkingHours, shiftIntoWorkingHours, computeLeadPriority, matchPlans, plansFromRows, validateAnswers,
  DEFAULT_TEAM_SALES_CONFIG as CFG, mergeTeamSalesConfig,
} from "../src/lib/team-sales-rules.ts";

const T = (s) => new Date(s); // ISO with +03:30
const iso = (d) => d.toISOString();
let passed = 0; const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };

/* ---------- working hours (Asia/Tehran, 9–18, Sat–Thu) ---------- */
ok("inside hours stays", () => assert.equal(iso(shiftIntoWorkingHours(T("2026-10-24T10:00:00+03:30"))), iso(T("2026-10-24T10:00:00+03:30"))));
ok("before 9 -> 9", () => assert.equal(iso(shiftIntoWorkingHours(T("2026-10-24T07:10:00+03:30"))), iso(T("2026-10-24T09:00:00+03:30"))));
ok("after 18 -> next day 9", () => assert.equal(iso(shiftIntoWorkingHours(T("2026-10-24T19:00:00+03:30"))), iso(T("2026-10-25T09:00:00+03:30"))));
ok("Friday -> Saturday 9", () => assert.equal(iso(shiftIntoWorkingHours(T("2026-10-30T11:00:00+03:30"))), iso(T("2026-10-31T09:00:00+03:30"))));
ok("Thursday 18:30 -> Saturday 9", () => assert.equal(iso(shiftIntoWorkingHours(T("2026-10-29T18:30:00+03:30"))), iso(T("2026-10-31T09:00:00+03:30"))));
ok("3 working hours same day", () => assert.equal(iso(addWorkingHours(T("2026-10-24T10:00:00+03:30"), 3)), iso(T("2026-10-24T13:00:00+03:30"))));
ok("3 working hours spill to next day", () => assert.equal(iso(addWorkingHours(T("2026-10-24T17:00:00+03:30"), 3)), iso(T("2026-10-25T11:00:00+03:30"))));
ok("3 working hours over Friday", () => assert.equal(iso(addWorkingHours(T("2026-10-29T17:30:00+03:30"), 3)), iso(T("2026-10-31T11:30:00+03:30"))));
ok("3 working hours from 01:30 night", () => assert.equal(iso(addWorkingHours(T("2026-10-24T01:30:00+03:30"), 3)), iso(T("2026-10-24T12:00:00+03:30"))));
ok("config merge ignores junk", () => {
  const c = mergeTeamSalesConfig({ enabled: true, closerSalespersonIds: ["x"], workHours: { start: 20, end: 9 } });
  assert.equal(c.enabled, true); assert.deepEqual(c.closerSalespersonIds, [3, 4]); assert.deepEqual(c.workHours, { start: 9, end: 18 });
});

/* ---------- priority rules ---------- */
const now = T("2026-10-24T10:00:00+03:30");
const base = { callResult: "answered", urgency: "now", amountMillion: 100, loanPref: "both", jobType: "employee_with_insurance",
  creditRank: "A", checkStatus: "physical", canPromissory: "yes", salaryDeduct: "no", bouncedCheque: "no",
  guarantorCount: 0, docsReady: "all" };
const fakeMatch = [{ planId: 1, planName: "x", conditionId: 1, max: 300e6, assumptions: [], amountFits: true }];
ok("validate: answered needs urgency", () => assert.ok(validateAnswers({ callResult: "answered" })));
ok("validate: bad call result", () => assert.ok(validateAnswers({ callResult: "nope" })));
ok("validate: no_answer needs nothing else", () => assert.equal(validateAnswers({ callResult: "no_answer" }), null));
ok("H1 wrong number", () => assert.equal(computeLeadPriority({ callResult: "wrong_number" }, [], 0, now).outcome, "invalid"));
ok("H2 no answer 1 -> +4h", () => { const r = computeLeadPriority({ callResult: "no_answer" }, [], 0, now);
  assert.equal(r.priority, 3); assert.equal(r.outcome, "no_answer"); assert.equal(r.nextActionAt, iso(T("2026-10-24T14:00:00+03:30"))); });
ok("H2 no answer 2 -> +24h", () => assert.equal(computeLeadPriority({ callResult: "no_answer" }, [], 1, now).nextActionAt, iso(T("2026-10-25T10:00:00+03:30"))));
ok("H2 no answer 3 -> cold archive", () => assert.equal(computeLeadPriority({ callResult: "no_answer" }, [], 2, now).outcome, "cold_archive"));
ok("H3 callback -> P2", () => assert.equal(computeLeadPriority({ callResult: "callback" }, [], 0, now).priority, 2));
ok("validate: callback needs a future time", () => {
  assert.ok(validateAnswers({ callResult: "callback" }, now));
  assert.ok(validateAnswers({ callResult: "callback", callbackAt: "2026-10-24T09:00:00+03:30" }, now));
  assert.equal(validateAnswers({ callResult: "callback", callbackAt: "2026-10-24T15:00:00+03:30" }, now), null);
});
const simple = { mode: "simple", callResult: "answered", urgency: "now", amountMillion: 100, docsReady: "all",
  creditRank: "A", checkStatus: "any", canPromissory: "yes", bouncedCheque: "no" };
ok("validate: simple form needs no job/guarantor", () => assert.equal(validateAnswers(simple, now), null));
ok("validate: full form still needs job", () => assert.ok(validateAnswers({ ...simple, mode: "full" }, now)));
ok("validate: bounced cheque must be answered", () => assert.ok(validateAnswers({ ...simple, bouncedCheque: null }, now)));
ok("H4 curious -> P3 nurture", () => assert.equal(computeLeadPriority({ ...base, urgency: "curious" }, fakeMatch, 0, now).outcome, "nurture"));
ok("H5 bounced cheque -> not eligible", () => assert.equal(computeLeadPriority({ ...base, bouncedCheque: "yes" }, fakeMatch, 0, now).outcome, "not_eligible"));
ok("H6 no plan -> not eligible", () => assert.equal(computeLeadPriority(base, [], 0, now).outcome, "not_eligible"));
ok("H7 urgent+docs+plan -> P1, due +3 working hours", () => { const r = computeLeadPriority(base, fakeMatch, 0, now);
  assert.equal(r.priority, 1); assert.equal(r.nextActionAt, iso(T("2026-10-24T13:00:00+03:30"))); });
ok("score: month+partial+certain+fits = 70 -> P1", () => assert.equal(computeLeadPriority({ ...base, urgency: "month", docsReady: "partial" }, fakeMatch, 0, now).score, 70));
ok("score: later never P1", () => { const r = computeLeadPriority({ ...base, urgency: "later", docsReady: "all" }, fakeMatch, 0, now);
  assert.equal(r.score, 65); assert.equal(r.priority, 2); });
ok("score <40 -> P3", () => assert.equal(computeLeadPriority({ ...base, urgency: "later", docsReady: "none" },
  [{ ...fakeMatch[0], assumptions: ["a"], amountFits: false }], 0, now).priority, 3));

/* ---------- DB flows on a copy ---------- */
const src = process.env.TEAM_SALES_FIXTURE_DB;
if (!src) { console.log(`SKIP DB section (set TEAM_SALES_FIXTURE_DB). ${passed} passed`); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-sales-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; // plain JSON logs in the bundled fixture (pino-pretty transport cannot be bundled)
process.env.LOG_LEVEL = "warn";
try {
  const db = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const { queryRow, queryRows, execute } = db;

  ok("simple form matches plans on rank + check only", () => {
    const plans = plansFromRows(queryRows("SELECT * FROM loan_plans WHERE active=1"), queryRows("SELECT * FROM loan_plan_conditions"));
    const m = matchPlans(simple, plans);
    assert.ok(m.length > 0 && m[0].amountFits);
    const r = computeLeadPriority(simple, m, 0, now);
    assert.equal(r.priority, 1); assert.match(r.reasons[0], /از روی رتبه و چک/);
    assert.equal(matchPlans({ ...simple, creditRank: "E", checkStatus: "none", canPromissory: "no" }, plans).length, 0);
  });
  ok("plans from live tables match the form", () => {
    const plans = plansFromRows(queryRows("SELECT * FROM loan_plans WHERE active=1"), queryRows("SELECT * FROM loan_plan_conditions"));
    assert.ok(plans.length >= 10);
    const m = matchPlans({ ...base, amountMillion: 100 }, plans);
    assert.ok(m.length > 0 && m[0].amountFits);
    const none = matchPlans({ ...base, jobType: "unemployed", creditRank: "E", checkStatus: "none", canPromissory: "no" }, plans);
    assert.equal(none.length, 0);
  });

  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi" };
  const hasani = { id: 2, role: "salesperson", salespersonId: 3, fullName: "hasani" };
  const pick = (n) => queryRows(`SELECT c.id, c.priority FROM customers c WHERE c.salesperson_id=6 AND c.status='in_progress'
    AND c.merged_into_customer_id IS NULL AND (c.priority IS NULL OR c.priority IN (2,3)) ORDER BY c.id LIMIT ?`, [n]);
  const [a, b, c2, d, e, f] = pick(6).map((r) => Number(r.id));
  const pickNone = (n) => queryRows(`SELECT c.id FROM customers c WHERE c.salesperson_id=6 AND c.status='in_progress'
    AND c.merged_into_customer_id IS NULL AND c.priority IS NULL ORDER BY c.id LIMIT ?`, [n]);

  ok("disabled by default -> 404, nothing written", () => {
    assert.equal(ts.getTeamSalesConfig().enabled, false);
    assert.throws(() => ts.promoteToPriorityOne(a, kazemi), (x) => x.status === 404);
    assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [a]).s), 6);
  });
  execute("INSERT INTO notification_settings(key,value,updated_at) VALUES('team_sales_config','{\"enabled\":true}',datetime('now'))");

  ok("non-qualifier cannot promote", () => assert.throws(() => ts.promoteToPriorityOne(a, hasani), (x) => x.status === 403));
  const promoteNow = T("2026-10-24T17:00:00+03:30");
  const preMaxEvent = Number(queryRow("SELECT MAX(id) m FROM site_notification_events").m);
  ok("next-closer peek does not advance the cursor", () => {
    const p1 = ts.peekNextCloser(), p2 = ts.peekNextCloser();
    assert.deepEqual(p1, p2); assert.equal(p1.salespersonId, 3); assert.equal(p1.name, "خانم حسنی");
  });
  const r1 = ts.promoteToPriorityOne(a, kazemi, "مشتری آماده است", promoteNow);
  const r2 = ts.promoteToPriorityOne(b, kazemi, null, promoteNow);
  const r3 = ts.promoteToPriorityOne(c2, kazemi, null, promoteNow);
  ok("round-robin 3 -> 4 -> 3", () => assert.deepEqual([r1.closerSalespersonId, r2.closerSalespersonId, r3.closerSalespersonId], [3, 4, 3]));
  ok("customer now P1 with closer", () => { const row = queryRow("SELECT priority, salesperson_id FROM customers WHERE id=?", [a]);
    assert.equal(Number(row.priority), 1); assert.equal(Number(row.salesperson_id), 3); });
  ok("result message + deadline label", () => {
    assert.equal(r1.message, "به خانم حسنی واگذار شد"); assert.equal(r2.message, "به خانم قاسمی واگذار شد");
    assert.equal(r1.dueLabel, "فردا ۱۱:۰۰");
  });
  ok("timeline call_log «ارتقا به اولویت ۱ توسط کاظمی»", () => {
    const cl = queryRow("SELECT subject, expert_notes, salesperson_id FROM call_logs WHERE id=?", [r1.callLogId]);
    assert.equal(cl.subject, "ارتقا به اولویت ۱ توسط کاظمی"); assert.equal(Number(cl.salesperson_id), 6);
    assert.match(cl.expert_notes, /^واگذاری به خانم حسنی \(نوبت چرخشی\) — قبلاً /);
    assert.match(cl.expert_notes, /یادداشت: مشتری آماده است/);
  });
  ok("exactly one p1_assigned bell event per promote, for the closer", () => {
    const evs = queryRows("SELECT customer_id, owner_id, kind, title, body FROM site_notification_events WHERE id>? AND customer_id=?", [preMaxEvent, a]);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, "p1_assigned"); assert.equal(Number(evs[0].owner_id), 3);
    assert.equal(evs[0].title, `مشتری اولویت ۱ جدید: ${queryRow("SELECT name FROM customers WHERE id=?", [a]).name}`);
    assert.equal(evs[0].body, "ارتقا توسط آقای کاظمی — مهلت تماس تا فردا ۱۱:۰۰");
  });
  ok("closer's older events of that customer are pre-marked read", () => {
    const unread = Number(queryRow(`SELECT COUNT(*) n FROM site_notification_events e WHERE e.customer_id=? AND e.id<=?
      AND NOT EXISTS (SELECT 1 FROM site_notification_reads r WHERE r.event_id=e.id AND r.user_id=2)`, [a, preMaxEvent]).n);
    assert.equal(unread, 0);
  });
  ok("closer reminder at +3 working hours for closer's user", () => {
    const rem = queryRow("SELECT user_id, salesperson_id, customer_id, remind_at, sent_sms, done FROM reminders WHERE id=?", [r1.reminderId]);
    assert.equal(Number(rem.user_id), 2); assert.equal(Number(rem.customer_id), a);
    assert.equal(rem.remind_at, iso(T("2026-10-25T11:00:00+03:30"))); assert.equal(Number(rem.done), 0);
    const rem2 = queryRow("SELECT user_id FROM reminders WHERE id=?", [r2.reminderId]); assert.equal(Number(rem2.user_id), 3);
    const d1 = queryRow("SELECT status, error_code FROM reminder_sms_deliveries WHERE reminder_id=?", [r1.reminderId]);
    assert.deepEqual({ ...d1 }, { status: "rejected", error_code: "in_app_only" });
  });
  await (async () => {
    // Run the real reminder SMS worker with a fake sender at a time when all promote reminders are due.
    const { createReminderSmsQueue } = await import("../src/lib/reminder-sms-core.ts");
    const wdb = new DatabaseSync(dbPath);
    const sentTo = [];
    const q = createReminderSmsQueue(wdb, async (mobile) => { sentTo.push(mobile); return "fake"; }, () => "2026-12-01T00:00:00.000Z");
    await q.tick();
    wdb.close();
    ok("reminder SMS worker never sends for promote reminders", () => {
      for (const id of [r1.reminderId, r2.reminderId, r3.reminderId]) {
        const row = queryRow("SELECT r.sent_sms, d.status FROM reminders r JOIN reminder_sms_deliveries d ON d.reminder_id=r.id WHERE r.id=?", [id]);
        assert.equal(Number(row.sent_sms), 0); assert.equal(row.status, "rejected");
      }
    });
  })();
  ok("history row written", () => { const h = ts.priorityHistory(a)[0];
    assert.equal(h.source, "promote"); assert.equal(Number(h.newPriority), 1); assert.equal(Number(h.oldSalespersonId), 6); assert.equal(Number(h.newSalespersonId), 3); });
  ok("already P1 cannot be upgraded again (admin)", () =>
    assert.throws(() => ts.promoteToPriorityOne(a, { ...kazemi, role: "admin", salespersonId: null }), (x) => x.status === 409));
  ok("cannot promote a customer no longer Kazemi's", () => assert.throws(() => ts.promoteToPriorityOne(a, kazemi), (x) => x.status === 404));
  ok("closed customer cannot be promoted (admin)", () => {
    execute("UPDATE customers SET status='completed' WHERE id=?", [f]);
    assert.throws(() => ts.promoteToPriorityOne(f, { ...kazemi, role: "admin", salespersonId: null }), (x) => x.status === 409);
  });

  const longNote = "مشتری جواب داد و گفت برای خرید کالا نیاز فوری دارد، مدارک آماده است.";
  // The first-call form is for NO-priority customers only (Mohammad 2026-10-24): d and e start without a priority.
  execute("UPDATE customers SET priority=NULL WHERE id IN (?,?)", [d, e]);
  for (const p of [2, 3, 1]) ok(`P${p} customer: form refused (409), nothing written`, () => {
    const row = queryRow(`SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND merged_into_customer_id IS NULL AND priority=? ORDER BY id LIMIT 1`, [p])
      ?? (() => { const [x] = pickNone(1).map((r) => Number(r.id)); execute("UPDATE customers SET priority=? WHERE id=?", [p, x]); return { id: x }; })();
    const id = Number(row.id);
    const calls = Number(queryRow("SELECT COUNT(*) n FROM call_logs WHERE customer_id=?", [id]).n);
    const quals = Number(queryRow("SELECT COUNT(*) n FROM team_sales_qualifications WHERE customer_id=?", [id]).n);
    assert.throws(() => ts.submitQualification(id, kazemi, base, longNote, now), (x) => x.status === 409);
    assert.throws(() => ts.submitQualification(id, { ...kazemi, role: "admin", salespersonId: null }, { callResult: "no_answer" }, longNote, now), (x) => x.status === 409);
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM call_logs WHERE customer_id=?", [id]).n), calls);
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM team_sales_qualifications WHERE customer_id=?", [id]).n), quals);
    assert.equal(Number(queryRow("SELECT priority p FROM customers WHERE id=?", [id]).p), p);
  });
  ok("note required (>=30 chars)", () => assert.throws(() => ts.submitQualification(d, kazemi, base, "کوتاه"), (x) => x.status === 400));
  ok("invalid answers rejected", () => assert.throws(() => ts.submitQualification(d, kazemi, { callResult: "answered" }, longNote), (x) => x.status === 400));
  ok("no answer -> gets a priority (P3), then the form is refused (old form from now on)", () => {
    const callsBefore = Number(queryRow("SELECT COUNT(*) n FROM call_logs WHERE customer_id=?", [d]).n);
    const n1 = ts.submitQualification(d, kazemi, { callResult: "no_answer" }, longNote, now);
    assert.equal(n1.result.attempts, 1); assert.equal(n1.result.priority, 3);
    assert.equal(Number(queryRow("SELECT priority p FROM customers WHERE id=?", [d]).p), 3);
    assert.equal(queryRow("SELECT status FROM customers WHERE id=?", [d]).status, "in_progress");
    assert.throws(() => ts.submitQualification(d, kazemi, { callResult: "no_answer" }, longNote, now), (x) => x.status === 409);
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM call_logs WHERE customer_id=?", [d]).n), callsBefore + 1);
  });
  ok("answered + good profile -> P1 handoff to next closer (4)", () => {
    const r = ts.submitQualification(e, kazemi, base, longNote, now);
    assert.equal(r.result.priority, 1); assert.equal(r.handoff.closerSalespersonId, 4);
    const ev = queryRow("SELECT kind, body FROM site_notification_events WHERE id=?", [r.handoff.notificationId]);
    assert.equal(ev.kind, "p1_assigned"); assert.match(ev.body, /^از فرم تماس اول آقای کاظمی — مهلت تماس تا /);
    assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [e]).s), 4);
    assert.equal(queryRow("SELECT call_result FROM team_sales_qualifications WHERE customer_id=? ORDER BY id DESC", [e]).call_result, "answered");
  });
  ok("answered, later -> P2 stays with Kazemi", () => {
    const [g] = pickNone(1).map((r) => Number(r.id));
    const r = ts.submitQualification(g, kazemi, { ...base, urgency: "later" }, longNote, now);
    assert.equal(r.result.priority, 2); assert.equal(r.handoff, null);
    const row = queryRow("SELECT priority, salesperson_id FROM customers WHERE id=?", [g]);
    assert.equal(Number(row.priority), 2); assert.equal(Number(row.salesperson_id), 6);
  });
  ok("logPriorityChange skips no-op, logs change", () => {
    const before = queryRows("SELECT id FROM customer_priority_history").length;
    ts.logPriorityChange({ customerId: a, oldPriority: 2, newPriority: 2, oldSalespersonId: 3, newSalespersonId: 3, actorUserId: 1, source: "customer_update" });
    ts.logPriorityChange({ customerId: a, oldPriority: 1, newPriority: 2, oldSalespersonId: 3, newSalespersonId: 3, actorUserId: 1, source: "customer_update" });
    assert.equal(queryRows("SELECT id FROM customer_priority_history").length, before + 1);
  });
  ok("no SMS queued for customers (notification_deliveries untouched)", () => {
    const n = Number(queryRow("SELECT COUNT(*) n FROM notification_deliveries WHERE customer_id IN (?,?,?,?,?)", [a, b, c2, d, e]).n);
    const src0 = new (await_sqlite())(src, { readOnly: true });
    const n0 = Number(src0.prepare("SELECT COUNT(*) n FROM notification_deliveries WHERE customer_id IN (?,?,?,?,?)").get(a, b, c2, d, e).n);
    src0.close(); assert.equal(n, n0);
  });
  ok("simple-form submit (callback) -> P2 with callback time, stays", () => {
    const [g] = pickNone(1).map((r) => Number(r.id));
    const r = ts.submitQualification(g, kazemi, { mode: "simple", callResult: "callback", callbackAt: "2026-10-25T10:00:00+03:30" }, longNote, now);
    assert.equal(r.result.priority, 2); assert.equal(r.result.nextActionAt, iso(T("2026-10-25T10:00:00+03:30")));
  });
  ok("integrity ok", () => assert.equal(queryRow("PRAGMA integrity_check").integrity_check, "ok"));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
function await_sqlite() { return globalThis.__DatabaseSync; }
console.log(`${passed} passed`);
