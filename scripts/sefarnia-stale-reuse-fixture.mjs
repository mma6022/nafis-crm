import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(os.tmpdir(), "sefarnia-"));
const db = new DatabaseSync(":memory:");
globalThis.db = db;
db.exec(`
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,active INTEGER,created_at TEXT,salesperson_id INTEGER);
 CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER,priority INTEGER,status TEXT DEFAULT 'in_progress');
 CREATE TABLE voip_extensions(user_id INTEGER PRIMARY KEY,extension TEXT);
 CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
 INSERT INTO salespersons VALUES(11,'کارشناس یک');
 CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,salesperson_name_snapshot TEXT,subject TEXT,customer_request TEXT,expert_notes TEXT,created_at TEXT);
 CREATE TABLE call_queue_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
 INSERT INTO users VALUES(2,'first','کارشناس یک','salesperson',1,'2026-11-05',11);
 INSERT INTO customers VALUES(6,'ثبت دستی','09120000006',11,NULL,1,'in_progress');
 INSERT INTO customers VALUES(7,'کهنه','09120000007',11,NULL,1,'in_progress');
 INSERT INTO voip_extensions VALUES(2,'201');
`);
const root = path.resolve(".");
const bundle = path.join(temp, "vac.mjs");
const stub = (names) => names.map(n => `export const ${n}=()=>null;`).join("") + "export default {};";
await build({
  stdin: { contents: `export * from './src/lib/voip-after-call.ts';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  banner: { js: `import{createRequire}from'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});` },
  plugins: [{ name: "stubs", setup(ctx) {
    const map = [
      [/\/crm-db$/, "db"],
      [/\/auth$/, "auth"],
      [/\/logger$/, "logger"],
      [/\/simotel$/, "simotel"],
      [/\/call-note-rule$/, "cnr"],
      [/\/call-display-exclusions$/, "cde"],
      [/\/call-list-cutoff$/, "clc"],
      [/\/voip-call-notifications$/, "vcn"],
      [/\/voip-call$/, "vc"],
      [/\/simotel132b$/, "s132b"],
      [/\/simotel132$/, "s132"],
      [/\/expert-lockdown$/, "el"],
      [/\/files-carousel$/, "fc"],
      [/\/call-summary-fields$/, "cs"],
      [/\/call-transcripts$/, "ct"],
      [/\/daily-plan$/, "dp"],
      [/\/history-a$/, "ha"],
      [/\/reminder-must$/, "rm"],
      [/\/reminder-voip$/, "rv"],
    ];
    for (const [filter, ns] of map) ctx.onResolve({ filter }, () => ({ path: ns, namespace: ns }));
    ctx.onLoad({ filter: /.*/, namespace: "logger" }, () => ({ contents: "export const logger={info(){},warn(){},error(){},debug(){}};" }));
    ctx.onLoad({ filter: /.*/, namespace: "auth" }, () => ({ contents: "export const getAuthUserById=()=>null;" }));
    ctx.onLoad({ filter: /.*/, namespace: "simotel" }, () => ({ contents: "export class SimotelError extends Error{}; export const callExtensions=()=>[]; export const callStartedAt=()=>new Date(); export const getSimotelCalls=async()=>({data:[]});" }));
    ctx.onLoad({ filter: /.*/, namespace: "cnr" }, () => ({ contents: "export const callNoteError=()=>null;" }));
    ctx.onLoad({ filter: /.*/, namespace: "cde" }, () => ({ contents: "" }));
    ctx.onLoad({ filter: /.*/, namespace: "clc" }, () => ({ contents: "export const CALL_LIST_START='2020-01-01T00:00:00.000Z'; export const callIsInDisplayPeriod=()=>true;" }));
    ctx.onLoad({ filter: /.*/, namespace: "vcn" }, () => ({ contents: "export const notifyCallReport=()=>{};" }));
    ctx.onLoad({ filter: /.*/, namespace: "vc" }, () => ({ contents: "export const vcClickEventFilterSql=()=>'';export const vcFastAny=()=>false;export const vcFinalizeLiveSubject=()=>{};export const vcFlagOn=()=>false;export const vcFollowupCheck=()=>null;export const vcFollowupSaved=()=>{};" }));
    ctx.onLoad({ filter: /.*/, namespace: "s132b" }, () => ({ contents: "export const s132bPendingFilterSql=()=>'';export const s132bFlagOn=()=>false;" }));
    ctx.onLoad({ filter: /.*/, namespace: "s132" }, () => ({ contents: "export const s132CdrTarget=()=>null;export const s132TagCdr=()=>{};export const s132FlagOn=()=>false;" }));
    ctx.onLoad({ filter: /.*/, namespace: "el" }, () => ({ contents: stub(["elOn","elUsers","elGuard","elCheck"]) }));
    ctx.onLoad({ filter: /.*/, namespace: "fc" }, () => ({ contents: stub(["fcOn"]) }));
    ctx.onLoad({ filter: /.*/, namespace: "cs" }, () => ({ contents: stub(["csOn","csExtract"]) }));
    ctx.onLoad({ filter: /.*/, namespace: "ct" }, () => ({ contents: stub(["ctOn"]) }));
    ctx.onLoad({ filter: /.*/, namespace: "dp" }, () => ({ contents: stub(["dpOn"]) }));
    ctx.onLoad({ filter: /.*/, namespace: "ha" }, () => ({ contents: stub(["haOn"]) }));
    ctx.onLoad({ filter: /.*/, namespace: "rm" }, () => ({ contents: stub(["rmOn","rmFlagOn"]) }));
    ctx.onLoad({ filter: /.*/, namespace: "rv" }, () => ({ contents: stub(["rvOn","rvFlagOn"]) }));
    ctx.onLoad({ filter: /.*/, namespace: "db" }, () => ({ contents: `
      export const crmDb=globalThis.db;
      export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
      export const queryRows=(s,p=[])=>crmDb.prepare(s).all(...p);
      export const execute=(s,p=[])=>Number(crmDb.prepare(s).run(...p).lastInsertRowid);
      export const executeChanges=(s,p=[])=>Number(crmDb.prepare(s).run(...p).changes);
      export function runTransaction(fn){crmDb.exec('BEGIN');try{const v=fn();crmDb.exec('COMMIT');return v}catch(e){crmDb.exec('ROLLBACK');throw e}}
      export function runImmediateTransaction(fn){crmDb.exec('BEGIN IMMEDIATE');try{const v=fn();crmDb.exec('COMMIT');return v}catch(e){crmDb.exec('ROLLBACK');throw e}}
    ` }));
  }}],
});
const mod = await import(pathToFileURL(bundle).href);
mod.ensureAfterCallSchema();
const actor = { id: 2, role: "salesperson", customerScope: "assigned", salespersonId: 11, permissions: ["calls.view","calls.create"] };
const fields = { subject: "یادآور", customerRequest: "", expertNotes: "نتیجه" };
const now = Date.parse("2026-11-05T10:30:00.000Z");
mod.__setPendingReuseNow(now);
db.prepare(`INSERT INTO call_logs(id,customer_id,salesperson_id,salesperson_name_snapshot,subject,customer_request,expert_notes,created_at) VALUES(100,6,11,'کارشناس یک','','','','2026-11-05T07:30:00.000Z')`).run();
db.prepare(`INSERT INTO call_logs(id,customer_id,salesperson_id,salesperson_name_snapshot,subject,customer_request,expert_notes,created_at) VALUES(101,6,11,'کارشناس یک','','','','2026-11-05T10:10:00.000Z')`).run();
const ins = (id, ext, cid, clid, start) => db.prepare(`INSERT INTO voip_after_call_events(
  id,external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,
  expert_user_id,expert_name,salesperson_id,customer_id,call_log_id,has_recording,expert_notes,
  completed_at,is_live,auto_capture,auto_queued)
  VALUES(?,?,?,'outgoing','ANSWERED',?,?,?,'[]',2,'کارشناس یک',11,?,?,0,'',NULL,0,0,0)`).run(id, ext, "0912000000"+cid, start, start, "201", cid, clid);
ins(1, "stale", 6, 100, "2026-11-05T07:30:00.000Z");
ins(2, "fresh", 6, 101, "2026-11-05T10:10:00.000Z");
assert.equal(mod.pendingAfterCallLogId(6, actor), 101, "skips stale, reuses fresh");
assert.equal(mod.savePendingAfterCallHistory(6, actor, fields), 101, "consumes fresh");
assert.ok(mod.eventFor(2).completed_at, "fresh completed");
assert.equal(mod.eventFor(1).completed_at, null, "stale left queued");
db.prepare(`INSERT INTO call_logs VALUES(200,7,11,'کارشناس یک','','','','2026-11-05T07:00:00.000Z')`).run();
ins(3, "only-stale", 7, 200, "2026-11-05T07:00:00.000Z");
assert.equal(mod.pendingAfterCallLogId(7, actor), null, "only-stale → null");
assert.equal(mod.savePendingAfterCallHistory(7, actor, fields), null, "only-stale not consumed");
assert.equal(mod.eventFor(3).completed_at, null);
mod.__setPendingReuseNow(Date.parse("2026-11-05T07:30:00.000Z"));
assert.equal(mod.pendingAfterCallLogId(7, actor), 200, "within 1h still reuses");
mod.__setPendingReuseNow(null);
await rm(temp, { recursive: true, force: true });
console.log("PASS sefarnia stale-reuse (4 cases)");
