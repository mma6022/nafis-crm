// CT-CHAT fixture (flag.call_transcripts.chat): chat payload keys, per-user flag, manager-only speaker-role swap/assign (storage + audit),
// stale/re-transcribed guard, Ahmad feed (maskNames) sees manual roles, flag OFF = payload unchanged + no schema.
// Runs on a temp COPY of a (masked) CRM db; seeds SYNTHETIC events/transcripts only and never prints real data; no network.
// Usage: CT_CHAT_FIXTURE_DB=/path/to/masked-copy.db pnpm run test:ct-chat
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const SRC = process.env.CT_CHAT_FIXTURE_DB;
if (!SRC || !fs.existsSync(SRC)) { console.error("CT_CHAT_FIXTURE_DB=<masked CRM db copy> is required"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-chat-fixture-"));
const DBP = path.join(dir, "crm.db");
fs.copyFileSync(SRC, DBP);
Object.assign(process.env, { NODE_ENV: "test", CRM_DATABASE_PATH: DBP, SESSION_SECRET: "synthetic-fixture-session-secret-0123456789" });
const E = { two: 990001, three: 990002, proc: 990003, sim: 990004, keep: 990005, fresh: 990006, late: 990007 };
const NOW = new Date().toISOString(), T1 = "2026-11-01T10:00:00.000Z", T2 = "2026-11-02T10:00:00.000Z";
{
  const d = new DatabaseSync(DBP);
  d.exec("DROP TABLE IF EXISTS voip_call_speaker_roles; DROP TABLE IF EXISTS voip_call_speaker_role_log; DELETE FROM call_queue_settings WHERE key LIKE 'flag.call_transcripts.chat%';");
  for (const [id, role] of [[5, "sales_manager"], [8, "salesperson"]]) assert.equal(d.prepare("SELECT role FROM users WHERE id=?").get(id)?.role, role, `user ${id} must be ${role}`);
  const cust = d.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get().id;
  const seg = (sp, a, b, t) => ({ speakerId: sp, startSeconds: a, endSeconds: b, text: t });
  const res = (speakers, segments) => JSON.stringify({ audioSeparation: "diarization", durationSeconds: 60, model: "synthetic", notice: null, text: "متن کامل نمونه.",
    speakers: speakers.map((id) => ({ id })), segments });
  const two = res(["speaker-1", "speaker-2"], [seg("speaker-1", 0, 4, "سلام، از نفیس تماس می‌گیرم."), seg("speaker-2", 4, 8, "بله بفرمایید.")]);
  const three = res(["speaker-1", "speaker-2", "speaker-3"], [seg("speaker-1", 0, 3, "الف"), seg("speaker-2", 3, 6, "ب"), seg("speaker-3", 6, 9, "پ")]);
  const ev = d.prepare(`INSERT INTO voip_after_call_events(id,external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,customer_id,has_recording,recording_file,mobile_device_id,duration_seconds,is_live)
    VALUES (?,?,'09120000000','outgoing','ANSWERED','2026-11-01T09:00:00.000Z','2026-11-01T09:01:00.000Z','212','["212"]',8,?,?,?,?,60,0)`);
  const tx = d.prepare("INSERT INTO voip_recording_transcripts(external_id,source_file,range_from,range_to,requested_by,state,result_json,created_at,updated_at,completed_at) VALUES (?,?,'2026-11-01','2026-11-01',5,?,?,?,?,?)");
  ev.run(E.two, "ctchat-two", cust, 1, "ctchat-two.wav", null); tx.run("ctchat-two", "ctchat-two.wav", "completed", two, T1, T1, T1);
  ev.run(E.three, "ctchat-three", cust, 1, "ctchat-three.wav", null); tx.run("ctchat-three", "ctchat-three.wav", "completed", three, T1, T1, T1);
  ev.run(E.proc, "ctchat-proc", cust, 1, "ctchat-proc.wav", null); tx.run("ctchat-proc", "ctchat-proc.wav", "processing", null, T1, T1, null);
  ev.run(E.sim, "ctchat-sim", cust, 0, null, 77);
  for (const k of ["keep", "fresh", "late"]) { ev.run(E[k], `ctchat-${k}`, cust, 1, `ctchat-${k}.wav`, null); tx.run(`ctchat-${k}`, `ctchat-${k}.wav`, "completed", two, T1, T1, T1); }
  d.close();
}
globalThis.fetch = async (u) => { throw new Error(`unexpected network call in ct-chat fixture: ${String(u).slice(0, 40)}`); };
const bundle = path.join(dir, "bundle.mjs");
await build({ stdin: { contents: "export*from'./src/lib/call-transcripts.ts';export{queryRow,queryRows,executeChanges}from'./src/lib/crm-db.ts';export{queueSummaryAfterRoleSwap,storedCallSummary,queueCallSummary}from'./src/lib/recording-summary-jobs.ts';export{appendSummaryEdit,latestSummaryEdit}from'./src/lib/recording-summary-edits.ts';", resolveDir: path.resolve(".") },
  outfile: bundle, bundle: true, format: "esm", platform: "node", logLevel: "silent",
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});` },
  plugins: [{ name: "logger", setup(b) { b.onResolve({ filter: /\/logger$/ }, () => ({ path: "logger", namespace: "fx" })); b.onLoad({ filter: /.*/, namespace: "fx" }, () => ({ contents: "const n=()=>{};export const logger={error:n,warn:n,info:n,debug:n,child(){return logger}};export default logger;" })); } }] });
const L = await import(pathToFileURL(bundle).href);
const { queryRow, queryRows, executeChanges } = L;
const U = (id, role, salesManager = false) => ({ id, username: `u${id}`, fullName: `u${id}`, role, active: true, salesManager, permissions: [] });
const mgr = U(5, "admin", true), expert = U(8, "salesperson"), plainAdmin = U(30, "admin");
const sum = () => null;
const flag = (k, v) => v == null ? executeChanges("DELETE FROM call_queue_settings WHERE key=?", [k]) : executeChanges("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v, NOW]);
const tbl = () => queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'voip_call_speaker_role%' ORDER BY name").map((r) => r.name);
const view = (id, u) => L.callView(L.ctEvent(id), u, sum);
let passed = 0; const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };

ok("isCtManager: only admin+salesManager", () => { assert.equal(L.isCtManager(mgr), true); assert.equal(L.isCtManager(expert), false); assert.equal(L.isCtManager(plainAdmin), false); });
ok("flag OFF: no chat keys, no tables, auto roles", () => {
  assert.equal(L.ctChatOn(mgr), false); assert.equal(L.ctChatOn(expert), false);
  for (const u of [mgr, expert]) { const v = view(E.two, u); for (const k of ["chat", "canAssignRoles", "fullText", "transcriptAt", "simCall"]) assert.ok(!(k in v), k); }
  const t = view(E.two, mgr).transcript; assert.ok(t); assert.notEqual(t.roleSource, "manual"); assert.ok(!("roleByName" in t));
  assert.deepEqual(tbl(), []);
});
ok("per-user flag: only that user", () => {
  flag("flag.call_transcripts.chat.user.8", "1");
  assert.equal(L.ctChatOn(expert), true); assert.equal(L.ctChatOn(mgr), false);
  const v = view(E.two, expert); assert.equal(v.chat, true); assert.equal(v.canAssignRoles, false); assert.equal(v.fullText, "متن کامل نمونه."); assert.equal(v.transcriptAt, T1); assert.equal(v.simCall, false);
  assert.ok(!("chat" in view(E.two, mgr)));
  assert.deepEqual(tbl(), [], "reads never create the schema");
});
ok("global flag: manager can assign on 2 speakers only; sim call flagged", () => {
  flag("flag.call_transcripts.chat", "1");
  assert.equal(view(E.two, mgr).canAssignRoles, true); assert.equal(view(E.three, mgr).canAssignRoles, false); assert.equal(view(E.proc, mgr).canAssignRoles, false);
  assert.equal(view(E.two, plainAdmin).canAssignRoles, false);
  const s = view(E.sim, mgr); assert.equal(s.simCall, true); assert.equal(s.textState, "no_recording"); assert.equal(s.transcriptAt, null);
});
ok("save guards: not_completed / not_two_speakers / bad_speaker / stale_transcript", () => {
  assert.equal(L.saveSpeakerRoles(E.proc, mgr, "speaker-1"), "not_completed");
  assert.equal(L.saveSpeakerRoles(E.sim, mgr, "speaker-1"), "not_completed");
  assert.equal(L.saveSpeakerRoles(999, mgr, "speaker-1"), "not_completed");
  assert.equal(L.saveSpeakerRoles(E.three, mgr, "speaker-1", T1), "not_two_speakers");
  assert.equal(L.saveSpeakerRoles(E.two, mgr, "speaker-9", T1), "bad_speaker");
  assert.equal(L.saveSpeakerRoles(E.two, mgr, "speaker-1", "2020-01-01T00:00:00.000Z"), "stale_transcript");
  assert.deepEqual(tbl(), [], "failed saves create nothing");
});
let autoExpert;
ok("manager swap: saved for everyone, roleSource manual, audited", () => {
  const before = view(E.two, mgr).transcript; autoExpert = before.speakers.find((s) => s.role === "expert")?.id ?? null;
  const target = autoExpert === "speaker-1" ? "speaker-2" : "speaker-1";
  assert.equal(L.saveSpeakerRoles(E.two, mgr, target, T1), null);
  assert.deepEqual(tbl(), ["voip_call_speaker_role_log", "voip_call_speaker_roles"]);
  for (const u of [mgr, expert]) { const t = view(E.two, u).transcript; assert.equal(t.roleSource, "manual"); assert.equal(typeof t.roleByName, "string"); assert.ok(t.roleAt);
    assert.equal(t.speakers.find((s) => s.id === target).role, "expert"); assert.equal(t.segments.find((s) => s.speakerId === target).role, "expert");
    assert.equal(t.speakers.find((s) => s.id !== target).role, "customer"); }
  const log = queryRows(`SELECT * FROM voip_call_speaker_role_log WHERE event_id=${E.two} ORDER BY id`);
  assert.equal(log.length, 1); assert.equal(log[0].actor_id, 5); assert.equal(log[0].transcript_at, T1); assert.equal(JSON.parse(log[0].after_json)[target], "expert"); assert.notEqual(log[0].before_source, "manual");
  // swap back → second audit row, before_source manual
  assert.equal(L.saveSpeakerRoles(E.two, mgr, autoExpert ?? (target === "speaker-1" ? "speaker-2" : "speaker-1"), T1), null);
  const log2 = queryRows(`SELECT before_source FROM voip_call_speaker_role_log WHERE event_id=${E.two} ORDER BY id`);
  assert.equal(log2.length, 2); assert.equal(log2[1].before_source, "manual");
  assert.equal(queryRow("SELECT COUNT(*) n FROM voip_call_speaker_roles").n, 1);
});
ok("Ahmad feed (maskNames) sees manual roles without the manager's name", () => {
  const t = L.transcriptView(L.ctEvent(E.two), { maskNames: true });
  assert.equal(t.roleSource, "manual"); assert.equal(t.roleByName, null); assert.ok(t.speakers.every((s) => s.label === "کارشناس" || s.label === "مشتری"));
});
ok("flag OFF after a swap: chat keys gone, manual roles still apply", () => {
  flag("flag.call_transcripts.chat", null); flag("flag.call_transcripts.chat.user.8", null);
  const v = view(E.two, mgr); assert.ok(!("chat" in v)); assert.equal(v.transcript.roleSource, "manual");
});
ok("re-transcription invalidates the override (falls back to automatic guess)", () => {
  executeChanges("UPDATE voip_recording_transcripts SET completed_at=? WHERE external_id='ctchat-two'", [T2]);
  const t = view(E.two, mgr).transcript; assert.notEqual(t.roleSource, "manual"); assert.ok(!("roleByName" in t));
  flag("flag.call_transcripts.chat", "1");
  assert.equal(L.saveSpeakerRoles(E.two, mgr, "speaker-1", T1), "stale_transcript");
  assert.equal(L.saveSpeakerRoles(E.two, mgr, "speaker-1", T2), null);
  assert.equal(view(E.two, mgr).transcript.roleSource, "manual");
});
ok("migration is additive + idempotent", () => { L.ensureCtChatSchema(); L.ensureCtChatSchema(); assert.deepEqual(tbl(), ["voip_call_speaker_role_log", "voip_call_speaker_roles"]); });
// ---- summary regeneration after a manager swap (Mohammad t851) ----
const notifyTables = queryRows("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%notif%' OR name LIKE '%sms%' OR name LIKE '%push%' OR name LIKE '%outbox%' OR name LIKE '%bale%message%')").map((r) => r.name);
const notifyCounts = () => Object.fromEntries(notifyTables.map((t) => [t, queryRow(`SELECT COUNT(*) n FROM "${t}"`).n]));
const notify0 = notifyCounts();
const job = (id = "ctchat-two") => queryRow("SELECT * FROM voip_recording_summaries WHERE external_id=?", [id]);
const jobs = (id = "ctchat-two") => queryRow("SELECT COUNT(*) n FROM voip_recording_summaries WHERE external_id=?", [id]).n;
ok("summary input = role-labelled dialogue only with a valid manual override (no names)", () => {
  const t = L.manualSummaryText("ctchat-two"); assert.ok(t); const lines = t.split("\n");
  assert.ok(lines.every((l) => l.startsWith("کارشناس: ") || l.startsWith("مشتری: "))); assert.ok(lines[0].startsWith("کارشناس: "), "speaker-1 is expert now");
  assert.equal(L.manualSummaryText("ctchat-three"), null); assert.equal(L.manualSummaryText("ctchat-proc"), null); assert.equal(L.manualSummaryText("nope"), null);
});
let h1;
ok("swap queues ONE regeneration through the summary queue (requested by the manager)", () => {
  const h0 = L.storedCallSummary("ctchat-two").summarySourceHash;
  executeChanges("DELETE FROM voip_recording_summaries WHERE external_id='ctchat-two'");
  executeChanges("INSERT INTO voip_recording_summaries(external_id,source_hash,requested_by,range_from,range_to,state,result_json,created_at,updated_at) VALUES('ctchat-two',?,5,'2026-11-01','2026-11-01','completed',?,?,?)",
    [h0, JSON.stringify({ callSubject: "x", customerRequestSummary: "y" }), NOW, NOW]);
  assert.equal(L.storedCallSummary("ctchat-two").summaryState, "completed");
  assert.equal(L.saveSpeakerRoles(E.two, mgr, "speaker-2", T2), null);
  assert.equal(L.queueSummaryAfterRoleSwap("ctchat-two", mgr.id), true);
  const j = job(); h1 = L.storedCallSummary("ctchat-two").summarySourceHash;
  assert.notEqual(h1, h0); assert.equal(j.source_hash, h1); assert.equal(j.state, "queued"); assert.equal(j.requested_by, 5); assert.equal(j.result_json, null);
  assert.equal(j.range_from, "2026-11-01"); assert.equal(jobs(), 1);
  assert.equal(L.storedCallSummary("ctchat-two").summaryState, "queued");
});
ok("no duplicate job: same roles again → nothing new", () => {
  const before = job(); assert.equal(L.queueSummaryAfterRoleSwap("ctchat-two", mgr.id), true);
  assert.deepEqual(job(), before); assert.equal(jobs(), 1);
});
ok("regen already running: superseded, its late result is dropped by the hash guard", () => {
  executeChanges("UPDATE voip_recording_summaries SET state='processing',lease_until=? WHERE external_id='ctchat-two'", [new Date(Date.now() + 120000).toISOString()]);
  assert.equal(L.saveSpeakerRoles(E.two, mgr, "speaker-1", T2), null);
  assert.equal(L.queueSummaryAfterRoleSwap("ctchat-two", mgr.id), true);
  const j = job(); assert.equal(j.state, "queued"); assert.notEqual(j.source_hash, h1); assert.equal(jobs(), 1);
  // what the worker does when the old (h1) run finishes: guarded by source_hash → 0 rows
  assert.equal(executeChanges("UPDATE voip_recording_summaries SET state='completed',result_json='{}' WHERE external_id='ctchat-two' AND source_hash=? AND state='processing'", [h1]), 0);
  assert.equal(job().state, "queued");
});
ok("queue failure never breaks the role save", () => {
  assert.equal(L.queueSummaryAfterRoleSwap("missing-call", mgr.id), false);
  executeChanges("ALTER TABLE voip_recording_summaries RENAME TO voip_recording_summaries_tmp");
  try {
    assert.equal(L.saveSpeakerRoles(E.two, mgr, "speaker-2", T2), null);
    assert.equal(L.queueSummaryAfterRoleSwap("ctchat-two", mgr.id), false);
    assert.equal(JSON.parse(queryRow(`SELECT roles_json FROM voip_call_speaker_roles WHERE event_id=${E.two}`).roles_json)["speaker-2"], "expert");
  } finally { executeChanges("ALTER TABLE voip_recording_summaries_tmp RENAME TO voip_recording_summaries"); }
});
ok("no staff/customer notification rows written by swaps or regeneration", () => { assert.deepEqual(notifyCounts(), notify0); assert.ok(notifyTables.length >= 0); });
// ---- CT-KEEP (Mohammad t859u): a hand-edited summary is never regenerated by a role swap ----
const seedDone = (pid) => { const h = L.storedCallSummary(pid).summarySourceHash;
  executeChanges("DELETE FROM voip_recording_summaries WHERE external_id=?", [pid]);
  executeChanges("INSERT INTO voip_recording_summaries(external_id,source_hash,requested_by,range_from,range_to,state,result_json,created_at,updated_at) VALUES(?,?,5,'2026-11-01','2026-11-01','completed',?,?,?)",
    [pid, h, JSON.stringify({ callSubject: "خودکار", customerRequestSummary: "خلاصه‌ی خودکار" }), NOW, NOW]); return h; };
const editRows = () => queryRows("SELECT * FROM voip_recording_summary_edits WHERE external_id LIKE 'ctchat-%' ORDER BY external_id,revision");
ok("CT-KEEP: unedited summary + swap → regenerated (queued for the new roles)", () => {
  const h0 = seedDone("ctchat-fresh");
  assert.equal(L.saveSpeakerRoles(E.fresh, mgr, "speaker-2", T1), null);
  assert.equal(L.queueSummaryAfterRoleSwap("ctchat-fresh", mgr.id), true);
  const s = L.storedCallSummary("ctchat-fresh"); assert.equal(s.summaryState, "queued"); assert.notEqual(s.summarySourceHash, h0);
  assert.equal(job("ctchat-fresh").source_hash, s.summarySourceHash); assert.ok(!("summaryKeptOnSwap" in s)); assert.equal(s.summaryEdited, false);
});
let keepJob;
ok("CT-KEEP: hand-edited summary + swap → kept untouched, nothing queued, roles saved, transcript re-renders", () => {
  const h0 = seedDone("ctchat-keep");
  L.appendSummaryEdit("ctchat-keep", h0, 8, 0, "موضوع دستی", "خلاصه‌ی دستی کارشناس");
  const edits0 = editRows(); keepJob = job("ctchat-keep");
  assert.equal(L.saveSpeakerRoles(E.keep, mgr, "speaker-2", T1), null);
  assert.equal(L.queueSummaryAfterRoleSwap("ctchat-keep", mgr.id), "kept_edit");
  assert.deepEqual(job("ctchat-keep"), keepJob, "summary job row untouched"); assert.deepEqual(editRows(), edits0, "edit rows untouched");
  const s = L.storedCallSummary("ctchat-keep");
  assert.equal(s.summaryState, "completed"); assert.equal(s.summaryEdited, true); assert.equal(s.summaryEditStale, false); assert.equal(s.summaryKeptOnSwap, true);
  assert.equal(s.callSubject, "موضوع دستی"); assert.equal(s.customerRequestSummary, "خلاصه‌ی دستی کارشناس"); assert.notEqual(s.summarySourceHash, h0);
  flag("flag.call_transcripts.chat", "1");
  const v = L.callView(L.ctEvent(E.keep), mgr, L.storedCallSummary);
  assert.equal(v.transcript.roleSource, "manual"); assert.equal(v.summary.edited, true); assert.equal(v.summary.keptOnSwap, true); assert.equal(v.summary.subject, "موضوع دستی");
  // the auto/normal queue path is a no-op too
  L.queueCallSummary("ctchat-keep", 5, "2026-11-01", "2026-11-01", true); assert.deepEqual(job("ctchat-keep"), keepJob);
});
ok("CT-KEEP: swapping back (and again) keeps the same hand edit", () => {
  for (const sp of ["speaker-1", "speaker-2", "speaker-1"]) {
    assert.equal(L.saveSpeakerRoles(E.keep, mgr, sp, T1), null); assert.equal(L.queueSummaryAfterRoleSwap("ctchat-keep", mgr.id), "kept_edit");
    const s = L.storedCallSummary("ctchat-keep"); assert.equal(s.callSubject, "موضوع دستی"); assert.equal(s.summaryEdited, true);
  }
  assert.deepEqual(job("ctchat-keep"), keepJob);
});
ok("CT-KEEP: edit saved AFTER a swap is kept on the next swap; no 'kept' note until roles change again", () => {
  seedDone("ctchat-late"); assert.equal(L.saveSpeakerRoles(E.late, mgr, "speaker-2", T1), null);
  executeChanges("UPDATE voip_recording_summaries SET state='completed',result_json=? WHERE external_id='ctchat-late'", [JSON.stringify({ callSubject: "x", customerRequestSummary: "y" })]);
  const h = L.storedCallSummary("ctchat-late").summarySourceHash;
  L.appendSummaryEdit("ctchat-late", h, 8, 0, "دستی بعد از جابه‌جایی", "متن دستی");
  let s = L.storedCallSummary("ctchat-late"); assert.equal(s.summaryEdited, true); assert.ok(!("summaryKeptOnSwap" in s));
  assert.equal(L.saveSpeakerRoles(E.late, mgr, "speaker-1", T1), null); assert.equal(L.queueSummaryAfterRoleSwap("ctchat-late", mgr.id), "kept_edit");
  s = L.storedCallSummary("ctchat-late"); assert.equal(s.callSubject, "دستی بعد از جابه‌جایی"); assert.equal(s.summaryKeptOnSwap, true);
});
ok("CT-KEEP: a re-transcription with NEW words still marks the old edit stale (unchanged behaviour)", () => {
  const T3 = "2026-11-03T10:00:00.000Z";
  const r = JSON.parse(queryRow("SELECT result_json FROM voip_recording_transcripts WHERE external_id='ctchat-keep'").result_json);
  r.text = "متن تازه‌ی دیگر."; r.segments[1].text = "نه، بعداً تماس بگیرید.";
  executeChanges("UPDATE voip_recording_transcripts SET result_json=?,completed_at=? WHERE external_id='ctchat-keep'", [JSON.stringify(r), T3]);
  const s = L.storedCallSummary("ctchat-keep"); assert.equal(s.summaryEdited, false); assert.equal(s.summaryEditStale, true); assert.ok(!("summaryKeptOnSwap" in s));
  assert.equal(L.queueSummaryAfterRoleSwap("ctchat-keep", mgr.id), true); assert.equal(job("ctchat-keep").state, "queued");
  flag("flag.call_transcripts.chat", null);
});
ok("CT-KEEP: never-edited calls: DTO has no new key (payload unchanged)", () => {
  const s = L.storedCallSummary("ctchat-two"); assert.ok(!("summaryKeptOnSwap" in s)); assert.equal(s.summaryEdited, false);
  const v = L.callView(L.ctEvent(E.two), mgr, L.storedCallSummary); assert.ok(!("keptOnSwap" in v.summary));
});
ok("CT-KEEP: still no staff/customer notification rows", () => { assert.deepEqual(notifyCounts(), notify0); });
fs.rmSync(dir, { recursive: true, force: true });
console.log(`ct-chat fixture: ${passed} passed`);
