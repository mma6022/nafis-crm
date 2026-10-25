// crm-kz-return fixture: when Kazemi (qualifier, sp6) hands a customer to a closer it goes back to the customer's LAST
// previous main expert (Hasani 3 / Ghasemi 4) from the recorded ownership (customer_priority_history incl. nonp1_auto_transfer,
// team_sales_transfer_snapshot batch teamsales-20261024-0126); otherwise the fair split (round-robin cursor). A return never
// advances the cursor (no fair-split quota). Runs on a throwaway copy of a DB; ALL outbound fetch is stubbed and the stored
// SMS relay URL is blanked in the copy: no SMS, no Telegram. Prints customer ids and outcomes only (no phones / names).
// Usage: KZR_FIXTURE_DB=/path/to/copy.db node scripts/run-bundled-fixture.mjs scripts/kz-return-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

const outbound = [];
globalThis.fetch = async (input) => { outbound.push(String(input).replace(/\?.*$/, "").slice(0, 60)); return new Response("{}", { status: 503 }); };
let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const src = process.env.KZR_FIXTURE_DB;
if (!src) { console.log("SKIP (set KZR_FIXTURE_DB to a DB copy)"); process.exit(0); }
const srcHash = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kzr-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY/i.test(k)) delete process.env[k];

const base = { callResult: "answered", urgency: "now", amountMillion: 100, loanPref: "both", jobType: "employee_with_insurance",
  creditRank: "A1", checkStatus: "physical", canPromissory: "yes", salaryDeduct: "no", bouncedCheque: "no", guarantorCount: 0, docsReady: "all" };
const longNote = "مشتری جواب داد و گفت برای خرید کالا نیاز فوری دارد، مدارک آماده است.";
const outcomes = [];
try {
  const { queryRow, queryRows, execute } = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const cr = await import("../src/lib/closer-return.ts");
  const tc = await import("../src/lib/team-commission.ts");
  execute("UPDATE notification_settings SET value='' WHERE key='ippanelRelayUrl'");
  const cfg = ts.getTeamSalesConfig();
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi" };
  const admin = { id: 1, role: "admin", salespersonId: null, fullName: "admin" };
  const cursor = () => Number(queryRow("SELECT value v FROM notification_settings WHERE key='team_sales_closer_cursor'")?.v ?? 0);
  const row = (id) => queryRow("SELECT priority p, salesperson_id s, status FROM customers WHERE id=?", [id]);
  const lastHist = (id) => queryRow("SELECT source, old_salesperson_id o, new_salesperson_id n, new_priority np, reason FROM customer_priority_history WHERE customer_id=? ORDER BY id DESC LIMIT 1", [id]);
  const intro = () => ["expert_intro_sms", "expert_intro_sms_log"].map((t) => queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [t]) ? Number(queryRow(`SELECT COUNT(*) n FROM ${t}`).n) : -1).join("/");
  const intro0 = intro();
  const choose = (id) => cr.chooseCloserFor(id, Number(row(id).s), cfg);
  const kz = queryRows(`SELECT id, priority FROM customers WHERE salesperson_id=6 AND status='in_progress' AND merged_into_customer_id IS NULL
    AND (priority IS NULL OR priority IN (2,3)) ORDER BY id`).map((r) => ({ id: Number(r.id), p: r.priority == null ? null : Number(r.priority) }));
  const batchPrev = new Map(queryRows("SELECT customer_id c, previous_salesperson_id p FROM team_sales_transfer_snapshot WHERE rolled_back_at IS NULL").map((r) => [Number(r.c), Number(r.p)]));
  const tally = {}; const byCat = {};
  for (const c of kz) {
    const ch = choose(c.id);
    const k = ch.kind === "previous_expert" ? `previous:${ch.salespersonId}:${ch.evidence.startsWith("batch:") ? "batch" : ch.evidence.split(":")[1]}` : `fair:${ch.why}`;
    tally[k] = (tally[k] ?? 0) + 1; (byCat[k] ??= []).push(c);
  }
  console.log("SURVEY (Kazemi in-progress non-P1)", JSON.stringify(tally), "total", kz.length);
  const byTarget = {}; for (const [k, v] of Object.entries(tally)) { const t = k.startsWith("previous:") ? `expert:${k.split(":")[1]}` : "fair_split"; byTarget[t] = (byTarget[t] ?? 0) + v; }
  console.log("SURVEY BY TARGET", JSON.stringify(byTarget));
  // customers whose most recent non-Kazemi owner was a trainee (PM 17:57: skip the trainee, walk back further)
  const firstOther = (id) => cr.ownershipTimeline(id, Number(row(id).s)).find((o) => o.sp != null && o.sp !== 6);
  const viaTrainee = kz.filter((c) => { const f = firstOther(c.id); return f && [5, 19, 20].includes(f.sp); }).map((c) => c.id);
  console.log("VIA TRAINEE", JSON.stringify(viaTrainee.map((id) => [id, choose(id).kind, choose(id).salespersonId ?? null])));

  await ok("config: team sales enabled, qualifier 6, closers [3,4]", () => {
    assert.equal(cfg.enabled, true); assert.equal(cfg.qualifierSalespersonId, 6); assert.deepEqual(cfg.closerSalespersonIds.map(Number), [3, 4]);
  });
  await ok("survey: every batch-transferred Kazemi customer resolves to its batch expert unless a later move says otherwise", () => {
    for (const c of kz) if (batchPrev.has(c.id)) { const ch = choose(c.id); if (ch.kind === "previous_expert" && ch.evidence.startsWith("batch:")) assert.equal(ch.salespersonId, batchPrev.get(c.id)); }
    assert.ok((tally["previous:3:batch"] ?? 0) > 100 && (tally["previous:4:batch"] ?? 0) > 100 && (tally["fair:never_had_expert"] ?? 0) > 50);
  });

  const pickFrom = (k, n, pref) => (byCat[k] ?? []).filter((c) => pref === undefined || c.p === pref).slice(0, n).map((c) => c.id);
  const hasaniBatch = pickFrom("previous:3:batch", 3, 3), ghasemiBatch = pickFrom("previous:4:batch", 3, 3);
  const nonp1 = pickFrom("previous:3:nonp1_auto_transfer", 3).concat(pickFrom("previous:4:nonp1_auto_transfer", 3));
  const kzOnly = pickFrom("fair:never_had_expert", 5, 3), trainee = viaTrainee.slice(0, 3);
  const hasaniNone = pickFrom("previous:3:batch", 1, null), ghasemiNone = pickFrom("previous:4:batch", 1, null);
  console.log("CASES", JSON.stringify({ hasaniBatch, ghasemiBatch, nonp1, kzOnly, trainee, hasaniNone, ghasemiNone }));
  assert.equal(hasaniBatch.length, 3); assert.equal(ghasemiBatch.length, 3); assert.equal(kzOnly.length, 5);

  const promote = (id, actor = kazemi) => {
    const before = { cur: cursor(), peek: ts.peekCloserFor(id), s: Number(row(id).s), p: row(id).p };
    const r = ts.promoteToPriorityOne(id, actor, null, new Date("2026-10-25T10:00:00+03:30"));
    const h = lastHist(id); const after = cursor();
    outcomes.push({ id, path: "promote", from: before.s, prio: before.p, to: r.closerSalespersonId, assignment: r.assignment, reason: h.reason, cursorDelta: after - before.cur });
    assert.equal(r.closerSalespersonId, before.peek.salespersonId, "peek predicted the closer"); assert.equal(r.assignment, before.peek.assignment);
    return { r, h, cursorDelta: after - before.cur };
  };
  const callLog = (r) => queryRow("SELECT expert_notes FROM call_logs WHERE id=?", [r.callLogId]).expert_notes;

  await ok("peek is per customer and never moves the cursor", () => {
    const c0 = cursor();
    assert.equal(ts.peekCloserFor(hasaniBatch[0]).salespersonId, 3); assert.equal(ts.peekCloserFor(hasaniBatch[0]).assignment, "previous_expert");
    assert.equal(ts.peekCloserFor(ghasemiBatch[0]).salespersonId, 4);
    assert.equal(ts.peekCloserFor(kzOnly[0]).salespersonId, ts.peekNextCloser().salespersonId); assert.equal(ts.peekCloserFor(kzOnly[0]).assignment, "fair_split");
    assert.equal(cursor(), c0);
  });
  for (const id of hasaniBatch) await ok(`batch from Hasani #${id} -> back to Hasani (3), cursor unchanged`, () => {
    const { r, h, cursorDelta } = promote(id);
    assert.equal(r.closerSalespersonId, 3); assert.equal(r.assignment, "previous_expert"); assert.equal(cursorDelta, 0);
    assert.equal(Number(row(id).p), 1); assert.equal(Number(row(id).s), 3);
    assert.equal(h.source, "promote"); assert.equal(Number(h.o), 6); assert.equal(Number(h.n), 3); assert.equal(h.reason, "کارشناس قبلی مشتری");
    assert.match(callLog(r), /^واگذاری به خانم حسنی \(کارشناس قبلی مشتری\) — قبلاً /);
  });
  for (const id of ghasemiBatch) await ok(`batch from Ghasemi #${id} -> back to Ghasemi (4), cursor unchanged`, () => {
    const { r, h, cursorDelta } = promote(id);
    assert.equal(r.closerSalespersonId, 4); assert.equal(cursorDelta, 0); assert.equal(h.reason, "کارشناس قبلی مشتری");
  });
  for (const id of nonp1) await ok(`nonp1-transferred #${id} -> back to the expert it was moved from`, () => {
    const from = Number(queryRow("SELECT old_salesperson_id o FROM customer_priority_history WHERE customer_id=? AND source='nonp1_auto_transfer' ORDER BY id DESC LIMIT 1", [id]).o);
    const { r, cursorDelta } = promote(id);
    assert.equal(r.closerSalespersonId, from); assert.equal(cursorDelta, 0);
  });
  await ok("Kazemi-only customers -> fair split; returns in between do not use a turn (quota)", () => {
    const a = promote(kzOnly[0]);
    assert.equal(a.r.assignment, "fair_split"); assert.equal(a.cursorDelta, 1); assert.equal(a.h.reason, "تقسیم عادلانه");
    assert.match(callLog(a.r), /\(تقسیم عادلانه\) — قبلاً /);
    const ret = promote(hasaniBatch.length ? pickFrom("previous:3:batch", 4, 3)[3] : hasaniBatch[0]); // a return in between
    assert.equal(ret.r.assignment, "previous_expert"); assert.equal(ret.cursorDelta, 0);
    const b = promote(kzOnly[1]);
    assert.equal(b.cursorDelta, 1); assert.notEqual(b.r.closerSalespersonId, a.r.closerSalespersonId, "next fair turn goes to the other closer");
    const c = promote(kzOnly[2]); assert.equal(c.r.closerSalespersonId, a.r.closerSalespersonId);
  });
  await ok("#1623 (Ghasemi -> trainee 20 -> Kazemi) -> back to Ghasemi (4), trainee skipped, cursor unchanged", () => {
    // live already handed #1623 off (history #76, 2026-10-25 14:08Z). Restore its pre-hand-off state ON THE COPY ONLY.
    if (Number(row(1623).s) !== 6) {
      execute("DELETE FROM customer_priority_history WHERE customer_id=1623 AND source='promote' AND old_salesperson_id=6 AND created_at>'2026-10-25'");
      execute("UPDATE customers SET salesperson_id=6, priority=3 WHERE id=1623");
    }
    const f = firstOther(1623); assert.equal(f.sp, 20, "most recent non-Kazemi owner of #1623 is trainee 20");
    const ch = choose(1623); assert.equal(ch.kind, "previous_expert"); assert.equal(ch.salespersonId, 4);
    const { r, h, cursorDelta } = promote(1623); assert.equal(r.closerSalespersonId, 4); assert.equal(r.assignment, "previous_expert");
    assert.equal(cursorDelta, 0); assert.equal(h.reason, "کارشناس قبلی مشتری");
  });
  for (const id of trainee.filter((x) => x !== 1623)) await ok(`previous owner a trainee #${id} -> the active main expert before the trainee, else fair split`, () => {
    const older = cr.ownershipTimeline(id, Number(row(id).s)).find((o) => o.sp === 3 || o.sp === 4);
    const ch = choose(id);
    if (older) { assert.equal(ch.kind, "previous_expert"); assert.equal(ch.salespersonId, older.sp); }
    else { assert.equal(ch.kind, "fair_split"); assert.equal(ch.why, "no_active_expert"); }
  });
  await ok("previous expert inactive -> fair split over the active closers", () => {
    const id = pickFrom("previous:4:batch", 5, 3)[4];
    execute("UPDATE salespersons SET active=0 WHERE id=4");
    try {
      const ch = choose(id); assert.equal(ch.kind, "fair_split"); assert.equal(ch.why, "no_active_expert");
      const { r, cursorDelta } = promote(id); assert.equal(r.closerSalespersonId, 3); assert.equal(cursorDelta, 1);
    } finally { execute("UPDATE salespersons SET active=1 WHERE id=4"); }
  });
  await ok("LAST previous expert wins: Hasani -> promote -> admin moves to Ghasemi -> back to Kazemi => Ghasemi", () => {
    const id = kzOnly[3];
    const at = (m) => `2026-10-25T0${m}:00:00.000Z`;
    execute("INSERT INTO customer_priority_history(customer_id,old_priority,new_priority,old_salesperson_id,new_salesperson_id,actor_user_id,source,reason,created_at) VALUES (?,3,1,6,3,8,'promote',NULL,?)", [id, at(1)]);
    execute("INSERT INTO customer_priority_history(customer_id,old_priority,new_priority,old_salesperson_id,new_salesperson_id,actor_user_id,source,reason,created_at) VALUES (?,1,1,3,4,1,'customer_update',NULL,?)", [id, at(2)]);
    execute("INSERT INTO customer_priority_history(customer_id,old_priority,new_priority,old_salesperson_id,new_salesperson_id,actor_user_id,source,reason,created_at) VALUES (?,1,3,4,6,1,'nonp1_auto_transfer','x',?)", [id, at(3)]);
    const ch = choose(id); assert.equal(ch.kind, "previous_expert"); assert.equal(ch.salespersonId, 4);
  });
  await ok("most recent ACTIVE expert: Hasani -> Ghasemi (inactive now) -> trainee 19 -> Kazemi => Hasani; Ghasemi active again => Ghasemi", () => {
    const id = kzOnly[4];
    const at = (m) => `2026-10-25T0${m}:00:00.000Z`;
    const ins = (o, n, src, m) => execute("INSERT INTO customer_priority_history(customer_id,old_priority,new_priority,old_salesperson_id,new_salesperson_id,actor_user_id,source,reason,created_at) VALUES (?,3,3,?,?,1,?,NULL,?)", [id, o, n, src, at(m)]);
    ins(6, 3, "customer_update", 1); ins(3, 4, "customer_update", 2); ins(4, 19, "customer_update", 3); ins(19, 6, "customer_update", 4);
    execute("UPDATE salespersons SET active=0 WHERE id=4");
    try { const ch = choose(id); assert.equal(ch.kind, "previous_expert"); assert.equal(ch.salespersonId, 3); }
    finally { execute("UPDATE salespersons SET active=1 WHERE id=4"); }
    const ch2 = choose(id); assert.equal(ch2.kind, "previous_expert"); assert.equal(ch2.salespersonId, 4);
  });
  await ok("first-call form P1 hand-off of a batch-from-Hasani customer (no priority) -> Hasani, source qualifier_form", () => {
    const id = hasaniNone[0]; const c0 = cursor();
    const out = ts.submitQualification(id, kazemi, base, longNote, new Date("2026-10-25T10:00:00+03:30"));
    assert.equal(out.result.priority, 1); assert.equal(out.handoff.closerSalespersonId, 3); assert.equal(out.handoff.assignment, "previous_expert");
    assert.equal(cursor(), c0);
    const h = lastHist(id); assert.equal(h.source, "qualifier_form"); assert.match(h.reason, /^کارشناس قبلی مشتری — /);
    outcomes.push({ id, path: "qualifier_form", from: 6, prio: null, to: 3, assignment: "previous_expert", reason: "کارشناس قبلی مشتری — …", cursorDelta: 0 });
  });
  await ok("admin upgrade of a batch-from-Ghasemi customer (no priority) -> Ghasemi", () => {
    const { r } = promote(ghasemiNone[0], admin); assert.equal(r.closerSalespersonId, 4);
  });
  await ok("Kazemi's upgrade commission event still found, closer = the returned expert", () => {
    const s = tc.settingsAt(new Date()).settings ?? tc.settingsAt(new Date());
    const ev = tc.qualifierP1Event(hasaniBatch[0], s, new Date("2026-12-01T00:00:00Z"));
    if (ev) { assert.equal(ev.kind, "upgrade"); assert.equal(Number(ev.closerSalespersonId), 3); } else console.log("  (commission model not started for this date: no event, unchanged behaviour)");
  });
  await ok("expert-intro SMS: nothing queued (switch OFF), nothing sent", () => { assert.equal(intro(), intro0); assert.deepEqual(outbound, []); });
  await ok("source DB untouched", () => assert.equal(crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex"), srcHash));
  console.log("OUTCOMES"); for (const o of outcomes) console.log(JSON.stringify(o));
  console.log(`${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
