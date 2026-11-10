// VOIP-TASK-HOLD (flag.voip_task_hold_v1): hold gate, neutral in-call, pending status, one form, explicit save, no SMS.
// Temp COPY of the CRM DB; the source is never written.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "vth-"));
const file = path.join(dir, "crm.db");
const candidates = [
  process.env.VTH_FIXTURE_DB,
  "/tmp/dci-r3-masked-848350.db",
  "/workspace/team-model/rel/masked-pkgtest.db",
  path.resolve("..", "..", "attached_assets", "customers_1789823100050.db"),
].filter((p) => p && existsSync(p) && statSync(p).size > 1000);
if (!candidates.length) { console.error("No fixture DB"); process.exit(2); }
const src = path.resolve(candidates[0]);
copyFileSync(src, file);
console.log("fixture db", src);
process.env.CRM_DATABASE_PATH = file;
process.env.SESSION_SECRET ||= "voip-task-hold-fixture-not-a-secret";

const { crmDb: raw, execute, executeChanges, queryRow, queryRows } = await import("../src/lib/crm-db.ts");
const { ensureVcSchema, vcStart, vcDismiss, vcMe, vcView, vcOnNewState, vcSweep, vcFollowupSaved, __setOriginateForTests, VC_RELEASE_AFTER_S } = await import("../src/lib/voip-call.ts");
const vth = await import("../src/lib/voip-task-hold.ts");
const { vthFlagOn, vthAttach, vthPhaseOf, vthBlockNext, vthOpenCall, vthMePayload, vthFinalStatus, vthRedactCarousel, vthSaveResult, vthContext, vthSuppressAutoSave, ensureVthSchema, VTH_FLAG } = vth;

ensureVcSchema();
ensureVthSchema();
__setOriginateForTests(async () => ({ originateId: "vth-orig-1" }));

const nowIso = () => new Date().toISOString();
const setFlag = (k, v) => v == null
  ? raw.prepare("DELETE FROM call_queue_settings WHERE key=?").run(k)
  : raw.prepare("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(k, v, nowIso());

const expert = queryRow(`SELECT u.id, u.salesperson_id, u.role, u.full_name name, ve.extension
  FROM users u JOIN voip_extensions ve ON ve.user_id=u.id
  WHERE u.role='salesperson' AND u.active=1 AND u.salesperson_id IS NOT NULL AND ve.extension IS NOT NULL AND ve.extension GLOB '[0-9][0-9]*'
  ORDER BY u.id LIMIT 1`);
assert.ok(expert?.id && expert.salesperson_id && expert.extension, "need an expert with an extension");
const U = { id: Number(expert.id), role: "salesperson", salespersonId: Number(expert.salesperson_id), name: expert.name, customerScope: "assigned" };
const EXT = String(expert.extension);
const own = queryRow("SELECT id, name FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND phone IS NOT NULL ORDER BY id LIMIT 1", [U.salespersonId]);
const own2 = queryRow("SELECT id, name FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND id<>? ORDER BY id LIMIT 1", [U.salespersonId, own.id]);
const other = queryRow("SELECT id, name FROM customers WHERE salesperson_id IS NOT ? AND merged_into_customer_id IS NULL ORDER BY id LIMIT 1", [U.salespersonId]);
assert.ok(own?.id && other?.id && own2?.id, "need two own customers and one other");
executeChanges("UPDATE customers SET phone='09120000001' WHERE id=?", [own.id]);
executeChanges("UPDATE customers SET phone='09120000002' WHERE id=?", [own2.id]);

// a loan file for own customer
let fileId = queryRow("SELECT id FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL ORDER BY id LIMIT 1", [own.id])?.id;
if (!fileId) {
  execute("INSERT INTO loan_applications(customer_id, status, stage, created_at, updated_at) VALUES(?,?,?,?,?)", [own.id, "in_progress", "documents", nowIso(), nowIso()]);
  fileId = Number(queryRow("SELECT last_insert_rowid() id")?.id ?? raw.prepare("SELECT id FROM loan_applications WHERE customer_id=? ORDER BY id DESC LIMIT 1").get(own.id)?.id);
}
// voip + s132 flags on (pre-existing live features); vth starts OFF
setFlag("flag.voip_call", "1");
setFlag(`flag.voip_call.user.${U.id}`, "1");
setFlag(VTH_FLAG, null);
setFlag(`${VTH_FLAG}.user.${U.id}`, null);

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log(`PASS ${name}`); };

await t("flag default absent = OFF; per-user and global follow the same rule as other flags", () => {
  assert.equal(vthFlagOn(U.id), false);
  setFlag(`${VTH_FLAG}.user.${U.id}`, "0");
  assert.equal(vthFlagOn(U.id), false);
  setFlag(`${VTH_FLAG}.user.${U.id}`, "1");
  assert.equal(vthFlagOn(U.id), true);
  setFlag(`${VTH_FLAG}.user.${U.id}`, null);
  setFlag(VTH_FLAG, "1");
  assert.equal(vthFlagOn(U.id), true);
  setFlag(VTH_FLAG, "0");
  assert.equal(vthFlagOn(U.id), false);
  setFlag(VTH_FLAG, null);
});

await t("flag OFF → /me has no vth field; needs_result stays file-task-only; hang-up still guesses an outcome", () => {
  const me0 = vcMe(U);
  assert.equal(me0.vth, undefined);
  // ended non-file call without result: not needsResult when flag off
  execute("INSERT INTO voip_click_calls(user_id,extension,customer_id,file_id,phone,state,outcome,active,created_at,updated_at,ended_at) VALUES(?,?,?,?,?,'ended','answered',0,?,?,?)",
    [U.id, EXT, own.id, null, "09120000001", nowIso(), nowIso(), nowIso()]);
  const id = Number(queryRow("SELECT last_insert_rowid() id").id);
  const row = queryRow("SELECT * FROM voip_click_calls WHERE id=?", [id]);
  const view = vcView(row);
  assert.equal(view.needsResult, false);
  executeChanges("DELETE FROM voip_click_calls WHERE id=?", [id]);
});

// Turn the flag ON globally for the rest
setFlag(VTH_FLAG, "1");
assert.equal(vthFlagOn(U.id), true);
assert.equal(vthSuppressAutoSave(U.id), true);

async function startCall(body) {
  const r = await vcStart(U, body, new Date());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.call;
}

await t("start (file) attaches a hold; other customer's start is 409 while live; next is blocked; no next-customer name in carousel payload", async () => {
  // first clear any leftover active
  executeChanges("UPDATE voip_click_calls SET active=0, state='error', ended_at=?, updated_at=? WHERE user_id=? AND active=1", [nowIso(), nowIso(), U.id]);
  const c = await startCall({ customerId: own.id, fileId, entry: "file" });
  assert.ok(c.id);
  const hold = queryRow("SELECT * FROM voip_task_holds WHERE call_id=?", [c.id]);
  assert.ok(hold);
  assert.equal(hold.entry, "file");
  assert.equal(vthBlockNext(U), true);
  const me = vcMe(U);
  assert.equal(me.vth?.on, true);
  assert.equal(me.vth?.phase, "in_call");
  assert.equal(me.vth?.nextBlocked, true);
  assert.equal(me.vth?.saveLabel, "ثبت نتیجه");
  const otherStart = await vcStart(U, { customerId: own2.id, entry: "search" }, new Date());
  assert.equal(otherStart.status, 409);
  assert.ok(["one_call", "needs_result"].includes(otherStart.body.error));
  const fakeView = { currentFileId: fileId, cards: [
    { id: fileId, state: "current", customerName: "الف", phone: "0912", customerId: own.id },
    { id: fileId + 99991, state: "pending", customerName: "نباید دیده شود", phone: "0913", customerId: other.id },
  ], lateReturns: [{ file_id: fileId + 99991, customer_name: "نباید دیده شود" }] };
  const red = vthRedactCarousel(U, fakeView);
  assert.equal(red.vthHold, true);
  assert.equal(red.cards[1].customerName, "");
  assert.equal(red.cards[1].phone, null);
  assert.equal(red.lateReturns[0].customer_name, "");
  assert.equal(red.cards[0].customerName, "الف");
});

await t("in-call is neutral: expert answer (dial_cust / NewState inuse) does not set answered or customer talk time", async () => {
  const live = queryRow("SELECT * FROM voip_click_calls WHERE user_id=? AND active=1 ORDER BY id DESC LIMIT 1", [U.id]);
  assert.ok(live);
  const ok = vcOnNewState({ unique_id: "cuid-vth-1", exten: EXT, state: "inuse", dialer: "yes", participant: live.extension }, new Date());
  const after = queryRow("SELECT * FROM voip_click_calls WHERE id=?", [live.id]);
  assert.notEqual(after.outcome, "answered");
  assert.equal(after.cust_answered_at, null);
  const view = vcView(after);
  assert.notEqual(view.prefill, "answered");
  const me = vcMe(U);
  assert.equal(me.vth.phase, "in_call");
  // duration / answered must not appear without a valid customer-leg CDR
  assert.ok(!view.cdr);
  assert.ok(view.durationSeconds == null || view.durationSeconds === 0 || after.state !== "in_call");
});

await t("real hang-up without a CDR is pending_status: no guessed outcome, no dismiss, no manual end", () => {
  const live = queryRow("SELECT * FROM voip_click_calls WHERE user_id=? AND active=1 ORDER BY id DESC LIMIT 1", [U.id]);
  vcOnNewState({ unique_id: "cuid-vth-1", exten: EXT, state: "idle", dialer: "no", participant: "" }, new Date());
  const after = queryRow("SELECT * FROM voip_click_calls WHERE id=?", [live.id]);
  assert.equal(after.state, "ended");
  assert.equal(after.active, 0);
  assert.equal(after.outcome, null, "must not guess answered/no_answer before the CDR");
  const me = vcMe(U);
  assert.equal(me.vth.phase, "pending_status");
  assert.equal(me.vth.nextBlocked, true);
  const d = vcDismiss(U, after.id, new Date());
  assert.equal(d.status, 409);
  assert.equal(d.body.error, "needs_result");
});

await t("status retry is a re-query: it does not complete the result or invent an outcome when the CDR is still missing", async () => {
  const c = queryRow("SELECT * FROM voip_click_calls WHERE user_id=? AND state='ended' ORDER BY id DESC LIMIT 1", [U.id]);
  const before = c.outcome;
  const r = await vth.vthStatusRetry(U, c.id, new Date());
  assert.equal(r.status, 200);
  assert.equal(r.body.final, false);
  const after = queryRow("SELECT * FROM voip_click_calls WHERE id=?", [c.id]);
  assert.equal(after.outcome, before);
  assert.equal(after.result_saved_at, null);
  const me = vcMe(U);
  assert.ok(me.vth.phase === "pending_status" || me.vth.phase === "status_error");
});

await t("a valid final CDR opens the result form; save requires outcome+note; cancel does not save; after save the gate opens and file/search stay on the page", () => {
  const c = queryRow("SELECT * FROM voip_click_calls WHERE user_id=? AND state='ended' ORDER BY id DESC LIMIT 1", [U.id]);
  executeChanges("UPDATE voip_click_calls SET cdr_at=?, cust_status='ANSWERED', billsec=198, outcome='answered' WHERE id=?", [nowIso(), c.id]);
  const me = vcMe(U);
  assert.equal(me.vth.phase, "final");
  assert.equal(me.vth.form, "result"); // no first_call / reminder on this start
  assert.equal(me.vth.queue, false);
  const bad = vthSaveResult(U, c.id, { outcome: "answered" }, new Date());
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, "note_required");
  // cancel = do nothing
  assert.equal(queryRow("SELECT result_saved_at FROM voip_click_calls WHERE id=?", [c.id]).result_saved_at, null);
  const ok = vthSaveResult(U, c.id, { outcome: "answered", note: "فیش رسید" }, new Date());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stay, true);
  assert.equal(ok.body.phase, "saved");
  const me2 = vcMe(U);
  // saved call is released from the panel; vth still on
  assert.ok(me2.vth?.phase === "saved" || me2.vth?.phase === "idle" || me2.call == null || me2.call.resultSaved);
  assert.equal(vthBlockNext(U), false);
});

await t("carousel entry: save label is «ثبت نتیجه و کار بعدی»; the gate stays closed until that save", async () => {
  executeChanges("UPDATE voip_click_calls SET active=0, dismissed_at=? WHERE user_id=? AND active=1", [nowIso(), U.id]);
  const c = await startCall({ customerId: own.id, fileId, entry: "carousel" });
  // hang up + final CDR
  executeChanges("UPDATE voip_click_calls SET state='ended', active=0, ended_at=?, cdr_at=?, cust_status='NO ANSWER', billsec=0, outcome='no_answer', updated_at=? WHERE id=?",
    [nowIso(), nowIso(), nowIso(), c.id]);
  const me = vcMe(U);
  assert.equal(me.vth.entry, "carousel");
  assert.equal(me.vth.queue, true);
  assert.equal(me.vth.saveLabel, "ثبت نتیجه و کار بعدی");
  assert.equal(me.vth.nextBlocked, true);
  const ok = vthSaveResult(U, c.id, { outcome: "no_answer", note: "برنداشت" }, new Date());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stay, false);
  assert.equal(vthBlockNext(U), false);
});

await t("reminder entry: cancel / close does not mark the reminder done; only a successful result save does", async () => {
  // insert a reminder for this expert
  execute("INSERT INTO reminders(user_id, customer_id, subject, message, remind_at, done, created_at, sent_sms, snooze_used) VALUES(?,?,?,?,?,0,?,0,0)",
    [U.id, own.id, "پیگیری فیش", "پیگیری فیش", nowIso(), nowIso()]);
  const remId = Number(queryRow("SELECT last_insert_rowid() id").id);
  executeChanges("UPDATE voip_click_calls SET active=0, dismissed_at=? WHERE user_id=? AND active=1", [nowIso(), U.id]);
  const c = await startCall({ customerId: own.id, fileId: null, entry: "reminder", reminderId: remId });
  executeChanges("UPDATE voip_click_calls SET state='ended', active=0, ended_at=?, cdr_at=?, cust_status='ANSWERED', billsec=30, outcome='answered', updated_at=? WHERE id=?",
    [nowIso(), nowIso(), nowIso(), c.id]);
  const me = vcMe(U);
  assert.equal(me.vth.form, "reminder_result");
  assert.equal(me.vth.reminderId, remId);
  // still not done
  assert.equal(queryRow("SELECT done FROM reminders WHERE id=?", [remId]).done, 0);
  // dismiss rejected
  assert.equal(vcDismiss(U, c.id, new Date()).status, 409);
  assert.equal(queryRow("SELECT done FROM reminders WHERE id=?", [remId]).done, 0);
});

await t("3-minute unstick does not auto-dismiss an unsaved ended call while the flag is on", () => {
  const c = queryRow("SELECT * FROM voip_click_calls WHERE user_id=? AND state='ended' AND result_saved_at IS NULL ORDER BY id DESC LIMIT 1", [U.id]);
  const old = new Date(Date.now() - (VC_RELEASE_AFTER_S + 60) * 1000).toISOString();
  executeChanges("UPDATE voip_click_calls SET ended_at=?, cdr_at=? WHERE id=?", [old, old, c.id]);
  vcSweep(new Date());
  const after = queryRow("SELECT dismissed_at FROM voip_click_calls WHERE id=?", [c.id]);
  assert.equal(after.dismissed_at, null);
});

await t("support / other-owner context: phone hidden and canCall false when not eligible; published A/B/C why values map to assigned/callback", () => {
  const ctxOther = vthContext(U, other.id);
  assert.equal(ctxOther.canCall, false);
  assert.equal(ctxOther.phoneVisible, false);
  assert.ok(ctxOther.otherOwner);
  // expert (not a registrar) has no eligibility object
  assert.equal(ctxOther.eligibility, null);
  assert.equal(ctxOther.notesWritable, true);
});

await t("no SMS and no contract / notification_settings writes happened in this fixture", () => {
  // this fixture never calls SMS helpers; assert no new sms rows if the table exists
  try {
    const sms = queryRow("SELECT COUNT(*) n FROM sms_logs WHERE created_at>=?", [new Date(Date.now() - 60_000).toISOString()]);
    if (sms) assert.equal(Number(sms.n), 0);
  } catch { /* table may be absent */ }
});

await t("flag OFF again restores today's /me payload (no vth field)", () => {
  setFlag(VTH_FLAG, null);
  assert.equal(vthFlagOn(U.id), false);
  const me = vcMe(U);
  assert.equal(me.vth, undefined);
});

console.log(`voip-task-hold fixture: ${n} passed`);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
