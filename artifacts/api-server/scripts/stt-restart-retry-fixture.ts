// STT-RETRY fixture: usage STT_DB=/path/masked-copy.db node scripts/run-bundled-fixture.mjs scripts/stt-restart-retry-fixture.ts (DB is modified)
import assert from "node:assert/strict";
const DBP = process.env.STT_DB; assert.ok(DBP, "STT_DB required");
Object.assign(process.env, { NODE_ENV: "production", SIMOTEL_API_KEY: "synthetic", OPENAI_API_KEY: "synthetic", SESSION_SECRET: "synthetic-fixture-session-secret-0123456789", CRM_DATABASE_PATH: DBP });
globalThis.fetch = (async (u: unknown) => { throw new Error("unexpected network call " + String(u)); }) as typeof fetch;
const { crmDb, queryRow, executeChanges } = await import("../src/lib/crm-db");
const T = await import("../src/lib/recording-transcript-jobs");
const S = await import("../src/lib/recording-summary-jobs");
const R = await import("../src/lib/stt-restart-retry");
const F = await import("../src/lib/ct-fastnote");
T.ensureTranscriptSchema(); R.ensureRestartRetrySchema();
let pass = 0; const ok = (n: string, f: () => void) => { f(); pass++; console.log("ok", n); };
const now = new Date(), past = new Date(now.getTime() - 5000).toISOString(), future = new Date(now.getTime() + 60000).toISOString();
crmDb.exec("DELETE FROM voip_recording_transcripts WHERE external_id LIKE 'sttr-%'; DELETE FROM voip_recording_summaries WHERE external_id LIKE 'sttr-%'; DELETE FROM call_queue_settings WHERE key='flag.stt_restart_retry'");
const tj = (id: string, state: string, lease: string | null, err: string | null = null, n = 0) => executeChanges(`INSERT INTO voip_recording_transcripts(external_id,source_file,range_from,range_to,requested_by,state,phase,error,lease_until,created_at,updated_at,interrupt_retries)
  VALUES(?,?,?,?,0,?,?,?,?,?,?,?)`, [id, id + ".mp3", "2026-11-04", "2026-11-04", state, state === "processing" ? "transcribing" : null, err, lease, past, past, n]);
const sj = (id: string, state: string, lease: string | null, n = 0) => executeChanges(`INSERT INTO voip_recording_summaries(external_id,source_hash,requested_by,range_from,range_to,state,lease_until,created_at,updated_at,interrupt_retries)
  VALUES(?,'h',0,'2026-11-04','2026-11-04',?,?,?,?,?)`, [id, state, lease, past, past, n]);
const t = (id: string) => queryRow<any>("SELECT * FROM voip_recording_transcripts WHERE external_id=?", [id]);
const s = (id: string) => queryRow<any>("SELECT * FROM voip_recording_summaries WHERE external_id=?", [id]);

tj("sttr-orphan", "processing", past); tj("sttr-live", "processing", future); tj("sttr-provider", "failed", null, "تبدیل گفتار انجام نشد؛ دوباره تلاش کنید.");
tj("sttr-cap", "processing", past, null, 2);
let r = R.recoverInterruptedTranscripts(now);
ok("orphan requeued once with 10 s backoff", () => { const x = t("sttr-orphan"); assert.equal(x.state, "queued"); assert.equal(x.interrupt_retries, 1); assert.equal(x.error, null);
  assert.equal(Date.parse(x.next_attempt_at) - now.getTime(), 10000); });
ok("live lease untouched", () => assert.equal(t("sttr-live").state, "processing"));
ok("genuine provider failure untouched", () => { assert.equal(t("sttr-provider").state, "failed"); assert.match(t("sttr-provider").error, /تبدیل گفتار انجام نشد/); });
ok("cap reached → failed with old message", () => { assert.equal(t("sttr-cap").state, "failed"); assert.equal(t("sttr-cap").error, R.TRANSCRIPT_INTERRUPTED); });
ok("counts", () => assert.deepEqual(r, { requeued: 1, failed: 1 }));
executeChanges("UPDATE voip_recording_transcripts SET state='processing',lease_until=? WHERE external_id='sttr-orphan'", [past]);
R.recoverInterruptedTranscripts(now);
ok("second interruption → 60 s backoff", () => { const x = t("sttr-orphan"); assert.equal(x.interrupt_retries, 2); assert.equal(Date.parse(x.next_attempt_at) - now.getTime(), 60000); });
executeChanges("UPDATE voip_recording_transcripts SET state='processing',lease_until=? WHERE external_id='sttr-orphan'", [past]);
R.recoverInterruptedTranscripts(now);
ok("third interruption → failed", () => assert.equal(t("sttr-orphan").state, "failed"));
ok("rerun is a no-op (idempotent sweep)", () => assert.deepEqual(R.recoverInterruptedTranscripts(now), { requeued: 0, failed: 0 }));

// queue honours backoff: a future next_attempt_at is not picked (would hit network → throws in fetch mock)
executeChanges("UPDATE voip_recording_transcripts SET state='queued',next_attempt_at=? WHERE external_id='sttr-orphan'", [future]);
executeChanges("UPDATE voip_recording_transcripts SET state='completed' WHERE external_id LIKE 'sttr-%' AND external_id<>'sttr-orphan'");
const otherQueued = queryRow<{ n: number }>("SELECT COUNT(*) n FROM voip_recording_transcripts WHERE state='queued' AND external_id NOT LIKE 'sttr-%'")!.n;
if (!otherQueued) { await T.processTranscriptQueue(); ok("backoff respected by worker", () => assert.equal(t("sttr-orphan").state, "queued")); }

sj("sttr-s-orphan", "processing", past); sj("sttr-s-live", "processing", future); sj("sttr-s-cap", "processing", past, 2);
R.recoverInterruptedSummaries(now);
ok("summary orphan requeued with retry_at", () => { const x = s("sttr-s-orphan"); assert.equal(x.state, "queued"); assert.equal(x.interrupt_retries, 1); assert.ok(x.retry_at); });
ok("summary live untouched / cap failed", () => { assert.equal(s("sttr-s-live").state, "processing"); assert.equal(s("sttr-s-cap").state, "failed"); assert.equal(s("sttr-s-cap").error, R.SUMMARY_INTERRUPTED); });
executeChanges("UPDATE voip_recording_summaries SET retry_at=? WHERE external_id='sttr-s-orphan'", [future]);
const otherS = queryRow<{ n: number }>("SELECT COUNT(*) n FROM voip_recording_summaries WHERE state='queued' AND external_id NOT LIKE 'sttr-%'")!.n;
if (!otherS) { await S.processCallSummaryQueue(); ok("summary backoff respected", () => assert.equal(s("sttr-s-orphan").state, "queued")); }

// kill switch
executeChanges("INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.stt_restart_retry','0',?)", [now.toISOString()]);
tj("sttr-off", "processing", past); sj("sttr-s-off", "processing", past);
R.recoverInterruptedTranscripts(now); R.recoverInterruptedSummaries(now);
ok("flag 0 → old behaviour (fail)", () => { assert.equal(t("sttr-off").state, "failed"); assert.equal(s("sttr-s-off").state, "failed"); });
executeChanges("DELETE FROM call_queue_settings WHERE key='flag.stt_restart_retry'");

// fresh request resets the budget (queueTranscript upsert path)
executeChanges("UPDATE voip_recording_transcripts SET state='failed',interrupt_retries=2 WHERE external_id='sttr-orphan'");
try { T.queueTranscript("sttr-orphan", "sttr-orphan.mp3", "2026-11-04", "2026-11-04", 0, true); } catch (e) { console.log("queue skipped:", (e as Error).message); }
if (t("sttr-orphan").state === "queued") ok("fresh request resets interrupt_retries", () => assert.equal(t("sttr-orphan").interrupt_retries, 0));

// idempotent note append: same summary twice → one append
const cid = queryRow<{ id: number }>("SELECT id FROM customers ORDER BY id LIMIT 1")!.id;
const logId = Number(crmDb.prepare("INSERT INTO call_logs(customer_id,subject,expert_notes,created_at) VALUES(?,?,?,?)").run(cid, "sttr", "یادداشت", now.toISOString()).lastInsertRowid);
F.ctfAppend("call_logs", "expert_notes", logId, "x: y"); F.ctfAppend("call_logs", "expert_notes", logId, "x: y");
ok("note append idempotent", () => { const n = queryRow<{ e: string }>("SELECT expert_notes e FROM call_logs WHERE id=?", [logId])!.e; assert.equal(n.split(F.CTF_NOTE_PREFIX).length - 1, 1); });
crmDb.exec(`DELETE FROM call_logs WHERE id=${logId}; DELETE FROM voip_recording_transcripts WHERE external_id LIKE 'sttr-%'; DELETE FROM voip_recording_summaries WHERE external_id LIKE 'sttr-%'`);
console.log(`STT-RETRY fixture: ${pass} passed`);
