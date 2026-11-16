// CT-FASTNOTE fixture: runs the real modules against a (masked) copy of the CRM DB with Simotel + OpenAI mocked (no paid calls).
// usage: CTF_DB=/path/copy.db node scripts/ct-fastnote-fixture.mjs   (the DB file is modified; pass a throwaway copy)
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const DBP = process.env.CTF_DB; assert.ok(DBP, "CTF_DB required");
Object.assign(process.env, { NODE_ENV: "test", SIMOTEL_API_KEY: "synthetic", OPENAI_API_KEY: "synthetic", SESSION_SECRET: "synthetic-fixture-session-secret-0123456789", CRM_DATABASE_PATH: DBP });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ctf-fixture-"));
const wav = path.join(temp, "a.wav");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=8000:duration=4", wav]);
const T0 = Date.now(), HANG = new Date(T0).toISOString();
const avail = { "ctf-1s": 1, "ctf-20s": 20, "ctf-never": Infinity, "ctf-first": 1, "ctf-ctrl": 1, "ctf-first-early": 1 };
const log = []; const ev = (m) => { log.push([((Date.now() - T0) / 1000).toFixed(1), m]); };
let transcribeCalls = 0, summaryCalls = 0, downloads = {};
const seed = new DatabaseSync(DBP);
const cust = seed.prepare("SELECT id FROM customers WHERE merged_into_customer_id IS NULL ORDER BY id LIMIT 6").all().map((r) => r.id);
const rows = Object.keys(avail).map((id) => ({ _id: id, cuid: id, src: "212", dst: "0900" + id.length.toString().padStart(7, "0"), type: "outgoing",
  start: new Date(T0 - 10000).toISOString(), duration: 10, billsec: 10, disposition: "ANSWERED", record: id + ".wav",
  endtime: { $date: { $numberLong: String(T0) } } }));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin === "https://panel.hostedpbx.ir") {
    if (url.pathname.endsWith("/cdr/search")) { const q = JSON.parse(options.body); return Response.json({ success: 1, data: { pagination: { total: rows.length }, data: rows.slice(q.pagination.start, q.pagination.start + q.pagination.count) } }); }
    if (url.pathname.endsWith("/audio/download")) {
      const id = JSON.parse(options.body).file.replace(/\.wav$/, ""); downloads[id] = (downloads[id] ?? 0) + 1;
      const ok = Date.now() - T0 >= avail[id] * 1000; ev(`download ${id} -> ${ok ? "available" : "missing"}`);
      return ok ? Response.json({ success: 1, data: { audioLink: `https://storage.hostedpbx.ir/x/${id}.wav` } }) : Response.json({ success: 0, message: "not found" });
    }
  }
  if (url.origin === "https://storage.hostedpbx.ir") return new Response(await fs.readFile(wav), { headers: { "Content-Type": "audio/wav" } });
  if (url.href === "https://api.openai.com/v1/audio/transcriptions") {
    transcribeCalls++; const text = "سلام، این یک گفتگوی آزمایشی است.";
    return Response.json(options.body.get("model") === "gpt-4o-transcribe-diarize" ? { text, segments: [{ speaker: "A", start: 0, end: 3, text }] } : { text });
  }
  if (url.href === "https://api.openai.com/v1/chat/completions") {
    summaryCalls++;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ subject: "پیگیری مدارک", customerRequestSummary: "مشتری زمان ارسال مدارک را پرسید." }) } }] });
  }
  throw new Error("unexpected network call " + url.origin);
};

// ---- seed: user 8 flagged, user 5 control ----
const ins = (sql, p) => Number(seed.prepare(sql).run(...p).lastInsertRowid);
seed.exec("DELETE FROM call_queue_settings WHERE key LIKE 'flag.ct_fastnote%'");
seed.prepare("INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.ct_fastnote.user.8','1',?)").run(HANG);
const S = {};
let i = 0;
for (const id of Object.keys(avail)) {
  const c = cust[i++], user = id === "ctf-ctrl" ? 5 : 8, first = id.startsWith("ctf-first");
  const note = id === "ctf-20s" ? "یادداشت دستی کارشناس" : first ? "یادداشت فرم تماس اول" : "";
  const logId = first ? null : ins("INSERT INTO call_logs(customer_id,subject,expert_notes,created_at) VALUES(?,?,?,?)", [c, "تماس خروجی مرکز تماس (ANSWERED)", note, HANG]);
  // ctf-1s = SIMOTEL-FAST live row finalized in place (external id stays live-*, provider id carries the CDR id)
  const ext = id === "ctf-1s" ? "live-s132-ctf1" : id;
  const evId = ins(`INSERT INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,customer_id,call_log_id,
    has_recording,recording_file,recording_provider_id,auto_capture,auto_queued,is_live) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,1,0,0)`,
    [ext, "09000000000", "outgoing", "ANSWERED", new Date(T0 - 10000).toISOString(), HANG, "212", "[\"212\"]", user, c, logId, id + ".wav", id === "ctf-1s" ? id : null]);
  const callId = ins(`INSERT INTO voip_click_calls(user_id,extension,customer_id,phone,state,outcome,event_id,active,created_at,ended_at,updated_at,cust_status,billsec)
    VALUES(?,?,?,?,'ended','answered',?,0,?,?,?,'ANSWERED',10)`, [user, "212", c, "09000000000", evId, HANG, HANG, HANG]);
  seed.prepare(`INSERT INTO s132_calls(call_id,user_id,customer_id,first_call,sim_status,auto_at,auto_kind,call_log_id,note_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(callId, user, c, first ? 1 : 0, "answered", HANG, first ? (id === "ctf-first" ? "first_done" : "first_form") : "dp", logId, first ? null : "pending", HANG);
  let formLog = null;
  if (id === "ctf-first") formLog = ins("INSERT INTO call_logs(customer_id,subject,expert_notes,call_result,created_at) VALUES(?,?,?,?,?)", [c, "تماس اول", note, "answered", new Date(T0 + 500).toISOString()]);
  S[id] = { evId, callId, logId: logId ?? formLog, user, c };
}
seed.close();

const bundle = path.join(path.resolve("."), ".ctf-fixture-bundle.mjs");
await build({ stdin: { contents: `export*from'./src/lib/voip-after-call.ts';export*from'./src/lib/recording-transcript-jobs.ts';export*from'./src/lib/recording-summary-jobs.ts';export*from'./src/lib/simotel132.ts';export*from'./src/lib/ct-fastnote.ts';export{queueAutomaticCallReports}from'./src/lib/automatic-call-reports.ts';`, resolveDir: path.resolve(".") },
  outfile: bundle, bundle: true, format: "esm", platform: "node", logLevel: "silent",
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});` },
  plugins: [{ name: "logger", setup(b) { b.onResolve({ filter: /\/logger$/ }, () => ({ path: "logger", namespace: "fx" })); b.onLoad({ filter: /.*/, namespace: "fx" }, () => ({ contents: "const n=()=>{};export const logger={error:n,warn:n,info:n,debug:n,child(){return logger}};export default logger;" })); } }] });
const m = await import(pathToFileURL(bundle).href);
const { queryRow, queryRows, executeChanges } = await import(pathToFileURL(bundle).href);
const db = new DatabaseSync(DBP);
const q = (s, p = []) => db.prepare(s).get(...p);
const tr = (id) => q("SELECT state,attempts,error FROM voip_recording_transcripts WHERE external_id=?", [id]);
const notes = (id) => q("SELECT expert_notes n FROM call_logs WHERE id=?", [S[id].logId])?.n;
const seen = {};
const mark = (k, cond) => { if (cond && !seen[k]) { seen[k] = ((Date.now() - T0) / 1000).toFixed(1); ev(k); } };
const status = (id) => m.ctfSummaryStatus(S[id].evId, m.storedCallSummary);
const statusLog = {};
try {
  let tick = 0;
  while (Date.now() - T0 < 260000) {
    await m.processTranscriptQueue(); await m.processCallSummaryQueue();
    if (tick % 3 === 0) await m.ctfFastTick();
    for (const id of Object.keys(avail)) {
      const t = tr(id); mark(`${id} queued`, t); mark(`${id} transcript ${t?.state}`, t && (t.state === "completed" || t.state === "failed"));
      const st = status(id); if (statusLog[id]?.at(-1)?.[1] !== st) (statusLog[id] ??= []).push([((Date.now() - T0) / 1000).toFixed(1), st]);
      mark(`${id} note appended`, (notes(id) ?? "").includes("خلاصه‌ی تماس:"));
    }
    if (Date.now() - T0 > 60000 && Date.now() - T0 < 61500) assert.equal(tr("ctf-ctrl"), undefined, "unflagged expert still waits CT_START_DELAY_SECONDS (150 s)");
    if (seen["ctf-never transcript failed"] && seen["ctf-1s note appended"] && seen["ctf-20s note appended"] && seen["ctf-first note appended"]) break;
    tick++; await new Promise((r) => setTimeout(r, 1000));
  }
  // ---- assertions ----
  for (const id of ["ctf-1s", "ctf-20s", "ctf-first"]) assert.ok(seen[`${id} note appended`], id + " note");
  assert.ok(Number(seen["ctf-1s queued"]) >= 12 && Number(seen["ctf-1s queued"]) <= 16, "queued 12–15 s after hang-up");
  assert.equal(tr("ctf-never").state, "failed"); assert.equal(tr("ctf-never").attempts, 5);
  assert.match(tr("ctf-never").error, /چند بار تلاش/);
  assert.ok(downloads["ctf-never"] >= 1 && downloads["ctf-never"] <= 5, "at most 1 try + 4 retries, then stop");
  assert.ok(!seen["ctf-ctrl queued"] || Number(seen["ctf-ctrl queued"]) >= 150, "control expert not queued before 150 s");
  assert.equal(notes("ctf-1s"), "خلاصه‌ی تماس: پیگیری مدارک: مشتری زمان ارسال مدارک را پرسید.");
  assert.equal(notes("ctf-20s"), "یادداشت دستی کارشناس\n\nخلاصه‌ی تماس: پیگیری مدارک: مشتری زمان ارسال مدارک را پرسید.");
  assert.equal(notes("ctf-first"), "یادداشت فرم تماس اول\n\nخلاصه‌ی تماس: پیگیری مدارک: مشتری زمان ارسال مدارک را پرسید.");
  assert.equal(q("SELECT expert_notes n FROM voip_after_call_events WHERE id=?", [S["ctf-1s"].evId]).n, notes("ctf-1s"), "in-place finalized live row gets the same note");
  // first call whose form is not saved yet: nothing appended, form untouched
  assert.equal(q("SELECT COUNT(*) n FROM ct_fastnote_appends WHERE call_id=?", [S["ctf-first-early"].callId]).n, 0);
  // idempotency: force every path to run again
  const before = { a: notes("ctf-1s"), b: notes("ctf-20s"), c: notes("ctf-first") };
  db.prepare("UPDATE s132_calls SET note_state='pending' WHERE call_id IN (?,?)").run(S["ctf-1s"].callId, S["ctf-20s"].callId);
  db.prepare("DELETE FROM ct_fastnote_appends").run();
  for (let k = 0; k < 3; k++) { await m.ctfFastTick(); m.s132Tick(new Date(), null); }
  assert.deepEqual({ a: notes("ctf-1s"), b: notes("ctf-20s"), c: notes("ctf-first") }, before, "never appended twice");
  // expert later sets the first-call form: then summary appended once below
  // summary status
  assert.equal(status("ctf-1s"), "ready"); assert.equal(status("ctf-never"), "failed");
  const view = m.s132CallView(db.prepare("SELECT * FROM voip_click_calls WHERE id=?").get(S["ctf-1s"].callId));
  assert.equal(view.summaryStatus, "ready");
  assert.equal(m.s132HistoryInfo([S["ctf-20s"].callId]).get(S["ctf-20s"].callId).summaryStatus, "ready");
  assert.equal("summaryStatus" in m.s132CallView(db.prepare("SELECT * FROM voip_click_calls WHERE id=?").get(S["ctf-ctrl"].callId)), false, "unflagged payload unchanged");
  // flag OFF → no payload key, back to 150 s
  db.prepare("UPDATE call_queue_settings SET value='0' WHERE key='flag.ct_fastnote.user.8'").run();
  assert.equal("summaryStatus" in m.s132CallView(db.prepare("SELECT * FROM voip_click_calls WHERE id=?").get(S["ctf-1s"].callId)), false);
  assert.equal(m.ctfAny(), false);
  console.log(JSON.stringify({ log, milestones: seen, statusTimeline: statusLog, transcribeCalls, summaryCalls, downloads }, null, 1));
  console.log("PASS ct-fastnote");
} finally {
  globalThis.fetch = realFetch; db.close(); await fs.rm(temp, { recursive: true, force: true }); await fs.rm(bundle, { force: true });
}
process.exit(0);
