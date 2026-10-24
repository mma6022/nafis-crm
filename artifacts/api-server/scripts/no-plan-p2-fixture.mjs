// crm-no-plan-p2 fixture (Mohammad 2026-10-24 15:43): «هیچ طرحی به این مشتری نمی‌خوره» + the customer responded well → EXACTLY P2;
// otherwise the existing scoring (never an automatic P1). Pure rules + DB flows on a throwaway DB copy. Never touches live; sends nothing.
// Usage: NO_PLAN_P2_FIXTURE_DB=/path/to/scrubbed-copy.db node scripts/run-bundled-fixture.mjs scripts/no-plan-p2-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;
import { computeLeadPriority, noPlanRespondedWell, NO_PLAN_GOOD_URGENCIES, CALL_RESULTS, DEFAULT_TEAM_SALES_CONFIG } from "../src/lib/team-sales-rules.ts";

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const now = new Date("2026-10-24T10:00:00+03:30");
const v2 = { mode: "simple", callResult: "answered", urgency: "now", amountMillion: 100, docsReady: "all", creditRank: "B2",
  checkStatus: "any", canPromissory: "yes", bouncedCheque: "no", formVersion: 2, guarantorAvailable: "no" };
const fit = [{ planId: 1, planName: "x", conditionId: 1, max: 300e6, assumptions: [], amountFits: true }];
const weak = [{ planId: 1, planName: "x", conditionId: 1, max: 50e6, assumptions: ["رتبه"], amountFits: false }];
const URG = ["now", "month", "later", "curious"], DOCS = ["all", "partial", "none"];
const strip = (r) => ({ ...r, reasons: r.reasons.filter((x) => !x.includes("هیچ طرحی")) });

/* ---------- pure ---------- */
await ok("criterion: callResult «جواب داد» + urgency now/month/later (not «فقط کنجکاوه») + noPlanFit on the first-call form", () => {
  assert.deepEqual([...NO_PLAN_GOOD_URGENCIES], ["now", "month", "later"]);
  for (const u of ["now", "month", "later"]) assert.equal(noPlanRespondedWell({ ...v2, urgency: u, noPlanFit: true }), true, u);
  assert.equal(noPlanRespondedWell({ ...v2, urgency: "curious", noPlanFit: true }), false);
  assert.equal(noPlanRespondedWell({ ...v2, urgency: null, noPlanFit: true }), false);
  for (const c of CALL_RESULTS.filter((x) => x !== "answered")) assert.equal(noPlanRespondedWell({ ...v2, callResult: c, noPlanFit: true }), false, c);
  assert.equal(noPlanRespondedWell({ ...v2, noPlanFit: false }), false);
  const { formVersion, ...old } = v2; assert.equal(noPlanRespondedWell({ ...old, noPlanFit: true }), false, "old form");
});
await ok("good response → EXACTLY P2 (recall) for every urgency × docs × match quality (high and low score)", () => {
  const seen = new Set();
  for (const u of ["now", "month", "later"]) for (const d of DOCS) for (const m of [fit, weak]) {
    const plain = computeLeadPriority({ ...v2, urgency: u, docsReady: d }, m, 0, now); seen.add(plain.priority);
    const r = computeLeadPriority({ ...v2, urgency: u, docsReady: d, noPlanFit: true }, m, 0, now);
    assert.equal(r.priority, 2, `${u}/${d}/${m === fit ? "fit" : "weak"}`); assert.equal(r.outcome, "recall");
    assert.ok(r.reasons.some((x) => x.includes("هیچ طرحی") && x.includes("اولویت ۲")));
  }
  assert.ok(seen.has(1) && seen.has(3), "the same answers without no-plan span P1 and P3 (score really varies)");
});
await ok("good response → P2 even with no matching plan (H6) or a bounced cheque (H5)", () => {
  assert.equal(computeLeadPriority(v2, [], 0, now).priority, 3);
  assert.equal(computeLeadPriority({ ...v2, noPlanFit: true }, [], 0, now).priority, 2);
  assert.equal(computeLeadPriority({ ...v2, bouncedCheque: "yes" }, fit, 0, now).priority, 3);
  assert.equal(computeLeadPriority({ ...v2, bouncedCheque: "yes", noPlanFit: true }, fit, 0, now).priority, 2);
});
await ok("P2 recall date: recallAt when given, else p2DefaultRecallDays[urgency]", () => {
  const at = "2026-10-27T09:00:00.000Z";
  assert.equal(computeLeadPriority({ ...v2, urgency: "later", docsReady: "none", noPlanFit: true, recallAt: at }, fit, 0, now).nextActionAt, at);
  for (const u of ["now", "month", "later"]) {
    const a = computeLeadPriority({ ...v2, urgency: u, noPlanFit: true }, fit, 0, now).nextActionAt;
    const b = computeLeadPriority({ ...v2, urgency: u, noPlanFit: true }, [], 0, now).nextActionAt;
    assert.ok(a && Date.parse(a) > now.getTime()); assert.equal(a, b);
  }
  assert.ok(DEFAULT_TEAM_SALES_CONFIG.p2DefaultRecallDays);
});
await ok("poor response («فقط کنجکاوه») + no-plan → existing scoring (H4 → P3 nurture), identical to without no-plan", () => {
  for (const d of DOCS) for (const m of [fit, weak, []]) {
    const plain = computeLeadPriority({ ...v2, urgency: "curious", docsReady: d }, m, 0, now);
    const r = computeLeadPriority({ ...v2, urgency: "curious", docsReady: d, noPlanFit: true }, m, 0, now);
    assert.equal(r.priority, 3); assert.deepEqual(r, plain);
  }
});
await ok("no answer / callback / wrong number with a stray noPlanFit flag → existing logic unchanged (null / P2 recall / P3), never P1", () => {
  for (const c of ["no_answer", "callback", "wrong_number"]) for (const prev of [0, 1, 2]) {
    const a = { ...v2, callResult: c, callbackAt: "2026-10-25T08:00:00.000Z" };
    const plain = computeLeadPriority(a, [], prev, now), r = computeLeadPriority({ ...a, noPlanFit: true }, [], prev, now);
    assert.deepEqual(r, plain); assert.notEqual(r.priority, 1);
  }
});
await ok("exhaustive: no-plan never gives P1; without no-plan nothing changed (no new reason)", () => {
  for (const c of CALL_RESULTS) for (const u of URG) for (const d of DOCS) for (const b of ["no", "yes"]) for (const m of [fit, weak, []]) {
    const a = { ...v2, callResult: c, urgency: u, docsReady: d, bouncedCheque: b, callbackAt: "2026-10-25T08:00:00.000Z" };
    const r = computeLeadPriority({ ...a, noPlanFit: true }, m, 0, now);
    assert.notEqual(r.priority, 1);
    if (noPlanRespondedWell({ ...a, noPlanFit: true })) assert.equal(r.priority, 2);
    const plain = computeLeadPriority(a, m, 0, now);
    assert.ok(!plain.reasons.some((x) => x.includes("هیچ طرحی")));
    const { formVersion, ...old } = a; // old form ignores noPlanFit entirely
    assert.deepEqual(computeLeadPriority({ ...old, noPlanFit: true }, m, 0, now), computeLeadPriority(old, m, 0, now));
  }
});

/* ---------- DB flows on a copy ---------- */
const src = process.env.NO_PLAN_P2_FIXTURE_DB;
if (!src) { console.log(`SKIP DB section (set NO_PLAN_P2_FIXTURE_DB). ${passed} passed`); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-plan-p2-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
try {
  const db = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const { queryRow, queryRows, execute } = db;
  execute("DELETE FROM notification_settings WHERE key='team_sales_config'");
  execute("INSERT INTO notification_settings(key,value,updated_at) VALUES('team_sales_config','{\"enabled\":true}',datetime('now'))");
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi" };
  const note = "مشتری جواب داد؛ شرایط هیچ طرحی را ندارد ولی قصد وام دارد، توضیح کامل.";
  const pool = queryRows(`SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND merged_into_customer_id IS NULL ORDER BY id LIMIT 10`).map((r) => Number(r.id));
  assert.ok(pool.length >= 7, "need 7 customers of salesperson 6");
  for (const id of pool) execute("UPDATE customers SET priority=NULL WHERE id=?", [id]);
  const next = (() => { let i = 0; return () => pool[i++]; })();
  const stored = (id) => queryRow("SELECT q.priority qp, q.no_plan_fit f, c.priority cp, c.salesperson_id s FROM team_sales_qualifications q JOIN customers c ON c.id=q.customer_id WHERE q.customer_id=? ORDER BY q.id DESC LIMIT 1", [id]);

  let lowId;
  await ok("[db] good response + low score (later, no docs) + no-plan → P2 stored on qualification and customer, no handoff", () => {
    lowId = next();
    const r = ts.submitQualification(lowId, kazemi, { ...v2, urgency: "later", docsReady: "none", noPlanFit: true }, note, now, [], "درآمد ثابت ندارد");
    assert.equal(r.result.priority, 2); assert.equal(r.handoff, null); assert.equal(r.noPlanFit, true);
    const s = stored(lowId); assert.equal(Number(s.qp), 2); assert.equal(Number(s.cp), 2); assert.equal(Number(s.f), 1); assert.equal(Number(s.s), 6);
    assert.match(queryRow("SELECT expert_notes e FROM call_logs WHERE id=?", [r.callLogId]).e, /اولویت 2|اولویت ۲/);
  });
  await ok("[db] good response + high score (H7 answers) + no-plan → P2, not P1", () => {
    const id = next(); const r = ts.submitQualification(id, kazemi, { ...v2, noPlanFit: true }, note, now, []);
    assert.equal(r.result.priority, 2); assert.equal(r.handoff, null); assert.equal(Number(stored(id).cp), 2);
  });
  await ok("[db] control: same high-score answers without no-plan still P1", () => {
    const id = next(); const r = ts.submitQualification(id, kazemi, v2, note, now);
    assert.equal(r.result.priority, 1); assert.equal(r.noPlanFit, false);
  });
  await ok("[db] poor response («فقط کنجکاوه») + no-plan → existing P3, never 1", () => {
    const id = next(); const r = ts.submitQualification(id, kazemi, { ...v2, urgency: "curious", noPlanFit: true }, note, now, []);
    assert.equal(r.result.priority, 3); assert.equal(Number(stored(id).cp), 3);
  });
  await ok("[db] no answer with a stray noPlanFit → no priority, no_plan_fit not stored", () => {
    const id = next(); const r = ts.submitQualification(id, kazemi, { mode: "simple", formVersion: 2, callResult: "no_answer", noPlanFit: true }, note, now);
    assert.equal(r.result.priority, null); assert.equal(r.noPlanFit, false);
    assert.equal(queryRow("SELECT priority p FROM customers WHERE id=?", [id]).p, null);
  });
  await ok("[db] manual «ارتقا به اولویت ۱» unchanged after the automatic P2", () => {
    ts.promoteToPriorityOne(lowId, { id: 1, role: "admin", salespersonId: null, fullName: "admin" }, "تصمیم مدیر", now);
    assert.equal(Number(queryRow("SELECT priority p FROM customers WHERE id=?", [lowId]).p), 1);
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`${passed} passed`);
process.exit(0);
