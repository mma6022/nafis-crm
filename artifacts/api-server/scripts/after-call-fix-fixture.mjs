import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import express from "express";

// Synthetic in-memory database only. Never copy CRM rows or contact providers.
const temp = await mkdtemp(path.join(os.tmpdir(), "after-call-fix-"));
const db = new DatabaseSync(":memory:");
globalThis.afterCallFixtureDb = db;
db.exec(`
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,active INTEGER,created_at TEXT,salesperson_id INTEGER);
 CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER,priority INTEGER,status TEXT DEFAULT 'in_progress');
 CREATE TABLE voip_extensions(user_id INTEGER PRIMARY KEY,extension TEXT);
 CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
 INSERT INTO salespersons VALUES(11,'کارشناس یک'),(12,'کارشناس دو');
 CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,salesperson_name_snapshot TEXT,subject TEXT,customer_request TEXT,expert_notes TEXT,created_at TEXT);
 CREATE TABLE team_sales_qualifications(id INTEGER PRIMARY KEY,customer_id INTEGER,actor_user_id INTEGER,call_log_id INTEGER);
 INSERT INTO users VALUES(1,'admin','مدیر آزمایشی','admin',1,'2026-11-10',NULL),(2,'first','کارشناس یک','salesperson',1,'2026-11-10',11),(3,'second','کارشناس دو','salesperson',1,'2026-11-10',12);
 INSERT INTO customers(id,name,phone,salesperson_id,merged_into_customer_id,priority) VALUES(1,'مشتری یک','09120000001',11,NULL,1),(2,'مشتری دو','09120000002',12,NULL,1);
 INSERT INTO voip_extensions VALUES(2,'201'),(3,'202');
 CREATE TABLE call_queue_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
`);
const NOW = Date.parse("2026-11-10T12:00:00.000Z"); // 15:30 Tehran
const hourAgo = new Date(NOW - 60 * 60_000).toISOString();
const twoHoursAgo = new Date(NOW - 2 * 60 * 60_000).toISOString();
const thirtyMinAgo = new Date(NOW - 30 * 60_000).toISOString();
const yesterday = "2026-11-09T12:00:00.000Z";

function seedEvent(row) {
  const cols = {
    external_id: null, phone: "09120000001", direction: "incoming", status: "RINGING",
    started_at: twoHoursAgo, ended_at: twoHoursAgo, extension: "201", extensions_json: '["201"]',
    expert_user_id: 2, expert_name: "کارشناس یک", salesperson_id: 11, customer_id: 1,
    call_log_id: null, has_recording: 0, expert_notes: "", completed_at: null,
    is_live: 0, live_cuid: null, recording_file: null, ...row,
  };
  const keys = Object.keys(cols);
  const info = db.prepare(`INSERT INTO voip_after_call_events(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map((k) => cols[k]));
  return Number(info.lastInsertRowid);
}

const flag = (key, value) => {
  if (value == null) { db.prepare("DELETE FROM call_queue_settings WHERE key=?").run(key); return; }
  db.prepare("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(key, value, "2026-11-10T12:00:00.000Z");
};

Object.assign(process.env, { NODE_ENV: "test", SIMOTEL_API_KEY: "synthetic-not-a-credential" });
let server;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "127.0.0.1") return originalFetch(input, init);
  throw new Error(`unexpected fetch ${url.origin}${url.pathname}`);
};
try {
  const bundle = path.join(temp, "after-call-fix.mjs");
  await build({
    stdin: { contents: `export{default as router}from'./src/routes/voip-after-call.ts';export*from'./src/lib/voip-after-call.ts';`, resolveDir: path.resolve(".") },
    outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: `import{createRequire}from'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});` },
    plugins: [{ name: "synthetic-only-db", setup(ctx) {
      ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
      ctx.onResolve({ filter: /\/auth$/ }, () => ({ path: "auth", namespace: "fixture-auth" }));
      ctx.onResolve({ filter: /\/logger$/ }, () => ({ path: "logger", namespace: "fixture-logger" }));
      ctx.onLoad({ filter: /.*/, namespace: "fixture-logger" }, () => ({ contents: "export const logger={info(){},warn(){},error(){},debug(){}};" }));
      ctx.onLoad({ filter: /.*/, namespace: "fixture-auth" }, () => ({ contents: "export const getAuthUserById=()=>null;" }));
      ctx.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const crmDb=globalThis.afterCallFixtureDb;
        export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
        export const queryRows=(s,p=[])=>crmDb.prepare(s).all(...p);
        export const execute=(s,p=[])=>Number(crmDb.prepare(s).run(...p).lastInsertRowid);
        export const executeChanges=(s,p=[])=>Number(crmDb.prepare(s).run(...p).changes);
        export function runTransaction(fn){crmDb.exec('BEGIN');try{const v=fn();crmDb.exec('COMMIT');return v}catch(e){crmDb.exec('ROLLBACK');throw e}}
        export function runImmediateTransaction(fn){crmDb.exec('BEGIN IMMEDIATE');try{const v=fn();crmDb.exec('COMMIT');return v}catch(e){crmDb.exec('ROLLBACK');throw e}}
      ` }));
    } }],
  });
  const mod = await import(pathToFileURL(bundle).href);
  mod.ensureAfterCallSchema();
  db.prepare("UPDATE voip_after_call_state SET activated_at=?").run("2026-11-01T00:00:00.000Z");
  mod.__setAfterCallFixNow(NOW);

  const expert = { id: 2, role: "salesperson", customerScope: "assigned", salespersonId: 11, permissions: ["calls.view", "calls.create"] };
  const other = { id: 3, role: "salesperson", customerScope: "assigned", salespersonId: 12, permissions: ["calls.view", "calls.create"] };

  const staleLiveId = seedEvent({ external_id: "stale-live", is_live: 1, live_cuid: "cuid-stale", status: "RINGING", started_at: twoHoursAgo, ended_at: twoHoursAgo });
  const freshLiveId = seedEvent({ external_id: "fresh-live", is_live: 1, live_cuid: "cuid-fresh", status: "ACTIVE", started_at: thirtyMinAgo, ended_at: thirtyMinAgo });
  const answeredRecId = seedEvent({ external_id: "ans-rec", status: "ANSWERED", is_live: 0, has_recording: 1, recording_file: "synthetic.mp3", started_at: hourAgo, ended_at: hourAgo });
  const answeredNoRecId = seedEvent({ external_id: "ans-norec", status: "ANSWERED", is_live: 0, has_recording: 0, recording_file: null, started_at: hourAgo, ended_at: hourAgo });
  const missedOwnId = seedEvent({ external_id: "missed-own", status: "NO ANSWER", is_live: 0, started_at: hourAgo, ended_at: hourAgo });
  const missedOtherId = seedEvent({ external_id: "missed-other", status: "NO ANSWER", is_live: 0, phone: "09120000002", expert_user_id: 3, expert_name: "کارشناس دو", salesperson_id: 12, customer_id: 2, extension: "202", extensions_json: '["202"]', started_at: hourAgo, ended_at: hourAgo });
  const missedYesterdayId = seedEvent({ external_id: "missed-yday", status: "NO ANSWER", is_live: 0, started_at: yesterday, ended_at: yesterday });
  const busyOwnId = seedEvent({ external_id: "busy-own", status: "BUSY", is_live: 0, started_at: thirtyMinAgo, ended_at: thirtyMinAgo });
  const outgoingAnsId = seedEvent({ external_id: "out-ans", direction: "outgoing", status: "ANSWERED", is_live: 0, has_recording: 1, recording_file: "out.mp3", started_at: hourAgo, ended_at: hourAgo });

  const pendingIds = (actor) => mod.pendingAfterCalls(actor).rows.map((r) => r.id);
  const has = (actor, id) => pendingIds(actor).includes(id);

  // ---- all flags absent / OFF: identical to previous behaviour ----
  assert.equal(mod.staleLiveFlagOn(), false);
  assert.equal(mod.autocloseAnsweredFlagOn(), false);
  assert.equal(mod.skipMissedFlagOn(), false);
  assert.equal(mod.sweepStaleLive(), 0);
  // sweep returns number; call once already happened — still live:
  assert.equal(db.prepare("SELECT is_live FROM voip_after_call_events WHERE id=?").get(staleLiveId).is_live, 1, "stale live stays live while flag is off");
  assert.equal(db.prepare("SELECT is_live FROM voip_after_call_events WHERE id=?").get(freshLiveId).is_live, 1);
  assert.equal(mod.autocloseAnsweredRecorded(), 0);
  assert.equal(db.prepare("SELECT completed_at FROM voip_after_call_events WHERE id=?").get(answeredRecId).completed_at, null);
  assert.ok(has(expert, staleLiveId), "stale live still in popup queue");
  assert.ok(has(expert, answeredRecId), "answered+recording still in popup queue");
  assert.ok(has(expert, missedOwnId), "missed still in popup queue");
  assert.ok(has(expert, busyOwnId));
  assert.ok(!has(expert, missedOtherId), "other expert's missed is not in this expert's queue");
  assert.ok(!has(expert, outgoingAnsId), "NOOUTPOP: outgoing stays out of the popup");
  const missedOff = mod.listTodayMissedIncoming(expert);
  assert.deepEqual(missedOff, { enabled: false, items: [] });

  // ---- step 1 on only ----
  flag("flag.after_call_stale_live", "1");
  const swept = mod.sweepStaleLive();
  assert.equal(swept, 1, "only the 2-hour-old live row is swept (30 min consult stays live)");
  const stale = db.prepare("SELECT is_live,status FROM voip_after_call_events WHERE id=?").get(staleLiveId);
  assert.equal(stale.is_live, 0);
  assert.equal(stale.status, "NO ANSWER", "ringing leftover becomes NO ANSWER");
  assert.equal(db.prepare("SELECT is_live,status FROM voip_after_call_events WHERE id=?").get(freshLiveId).is_live, 1);
  assert.equal(db.prepare("SELECT completed_at FROM voip_after_call_events WHERE id=?").get(staleLiveId).completed_at, null, "sweep does not complete the row");
  assert.equal(db.prepare("SELECT completed_at FROM voip_after_call_events WHERE id=?").get(answeredRecId).completed_at, null, "step 2 still off");
  assert.ok(has(expert, missedOwnId), "missed still in the popup while step 3 is off");
  flag("flag.after_call_stale_live", "0");
  assert.equal(mod.sweepStaleLive(), 0, "flag off again is a no-op");

  // ---- step 2 on only ----
  flag("flag.after_call_autoclose_answered", "1");
  const closed = mod.autocloseAnsweredRecorded();
  assert.equal(closed, 1, "only incoming answered + recording");
  const rec = db.prepare("SELECT completed_at,completed_payload,completed_by_user_id FROM voip_after_call_events WHERE id=?").get(answeredRecId);
  assert.ok(rec.completed_at);
  assert.equal(rec.completed_payload, JSON.stringify({ source: "auto_answered_recorded" }));
  assert.equal(rec.completed_by_user_id, null);
  assert.equal(db.prepare("SELECT completed_at FROM voip_after_call_events WHERE id=?").get(answeredNoRecId).completed_at, null, "answered without recording stays in the queue");
  assert.equal(db.prepare("SELECT completed_at FROM voip_after_call_events WHERE id=?").get(outgoingAnsId).completed_at, null, "outgoing answered+recording is not auto-closed");
  assert.ok(!has(expert, answeredRecId), "auto-closed event never returns to the popup");
  assert.ok(has(expert, answeredNoRecId));
  // refresh / second pass is idempotent and does not reopen
  assert.equal(mod.autocloseAnsweredRecorded(), 0);
  assert.ok(!has(expert, answeredRecId));
  flag("flag.after_call_autoclose_answered", "0");

  // ---- step 3 on only ----
  flag("flag.after_call_skip_missed", "1");
  assert.ok(!has(expert, missedOwnId), "missed leaves the mandatory popup");
  assert.ok(!has(expert, busyOwnId));
  assert.ok(!has(expert, staleLiveId), "swept ringing→NO ANSWER also leaves the popup");
  assert.ok(has(expert, answeredNoRecId), "answered without recording stays in the popup");
  assert.ok(has(expert, freshLiveId), "a still-live call stays in the popup");
  const missedOn = mod.listTodayMissedIncoming(expert);
  assert.equal(missedOn.enabled, true);
  const missedIds = missedOn.items.map((x) => x.id);
  assert.ok(missedIds.includes(missedOwnId));
  assert.ok(missedIds.includes(busyOwnId));
  assert.ok(missedIds.includes(staleLiveId), "today's swept missed appears in today's list");
  assert.ok(!missedIds.includes(missedOtherId), "other expert's / other owner's customer is hidden");
  assert.ok(!missedIds.includes(missedYesterdayId), "yesterday is not in today's list");
  assert.ok(!missedIds.includes(answeredNoRecId));
  const ownRow = missedOn.items.find((x) => x.id === missedOwnId);
  assert.equal(ownRow.customerId, 1);
  assert.equal(ownRow.customerName, "مشتری یک");
  assert.equal(ownRow.statusLabel, "بی‌پاسخ");
  const otherList = mod.listTodayMissedIncoming(other);
  assert.equal(otherList.enabled, true);
  assert.ok(otherList.items.some((x) => x.id === missedOtherId));
  assert.ok(!otherList.items.some((x) => x.id === missedOwnId), "expert two does not see expert one's customers");

  // HTTP: flag off → enabled false; flag on → own rows only; unauthenticated 401
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const actor = req.headers["x-fixture-user"];
    if (actor) res.locals.authUser = {
      id: actor === "admin" ? 1 : actor === "other" ? 3 : 2,
      role: actor === "admin" ? "admin" : "salesperson",
      customerScope: actor === "admin" ? "all" : "assigned",
      salespersonId: actor === "admin" ? null : actor === "other" ? 12 : 11,
      permissions: actor === "blocked" ? [] : ["calls.view", "calls.create"],
    };
    next();
  });
  app.use(mod.router);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/voip/after-call`;
  const missedGet = (actor) => fetch(`${base}/missed-today`, { headers: actor ? { "x-fixture-user": actor } : {} });
  assert.equal((await missedGet(null)).status, 401);
  let body = await (await missedGet("agent")).json();
  assert.equal(body.enabled, true);
  assert.ok(body.items.some((x) => x.id === missedOwnId));
  assert.ok(!body.items.some((x) => x.id === missedOtherId));
  const pendingOn = await (await fetch(`${base}/pending`, { headers: { "x-fixture-user": "agent" } })).json();
  assert.ok(!pendingOn.items.some((x) => x.id === missedOwnId));
  flag("flag.after_call_skip_missed", "0");
  body = await (await missedGet("agent")).json();
  assert.deepEqual(body, { enabled: false, items: [] });
  const pendingOff = await (await fetch(`${base}/pending`, { headers: { "x-fixture-user": "agent" } })).json();
  assert.ok(pendingOff.items.some((x) => x.id === missedOwnId), "turning step 3 off puts missed back in the popup");

  // notification_settings / team_sales_config were never created — the fixture never touches them
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='notification_settings'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='team_sales_config'").get(), undefined);

  mod.__setAfterCallFixNow(null);
  console.log("PASS: after-call-fix flags default OFF (unchanged queue); stale-live sweeper; autoclose answered+recording (no reopen, outgoing untouched); skip missed from popup + today list is own-customers only.");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = originalFetch;
  db.close();
  delete globalThis.afterCallFixtureDb;
  await rm(temp, { recursive: true, force: true });
}
