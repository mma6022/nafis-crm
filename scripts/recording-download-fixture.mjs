import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import express from "express";
process.env.NODE_ENV = "production"; // plain JSON logs (pino-pretty cannot be bundled)
process.env.SESSION_SECRET ||= "recording-download-fixture-not-a-secret";


const helperRoot = await mkdtemp(path.join(os.tmpdir(), "rec-dl-helper-"));
const helperOut = path.join(helperRoot, "recording-download.mjs");
await build({ entryPoints: ["src/lib/recording-download.ts"], outfile: helperOut, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { recordingDownloadDisposition, recordingDownloadFilename, tehranCalendarDay } = await import(pathToFileURL(helperOut).href);

// Filename helper: Tehran date, no phone, no customer name.
assert.equal(tehranCalendarDay("2026-10-03T20:30:00.000Z"), "2026-10-04");
assert.equal(recordingDownloadFilename("6afd4573ea34566ba0cb72dd", "2026-10-03T20:30:00.000Z", "x.mp3"),
  "call-6afd4573ea34566ba0cb72dd-2026-10-04.mp3");
assert.equal(recordingDownloadFilename(42, "2026-11-18T08:52:52.993Z", "rec.wav"), "call-42-2026-11-18.wav");
assert.equal(recordingDownloadFilename("ab/../c", "2026-11-18T00:00:00+03:30", "weird.foo.mp3"), "call-abc-2026-11-18.mp3");
const fn = recordingDownloadFilename(7, "2026-11-18T00:00:00+03:30", "a.mp3");
assert.equal(/09\d{8}|مشتری|علی|رضا/.test(fn), false);
assert.equal(recordingDownloadDisposition(fn), 'attachment; filename="call-7-2026-11-18.mp3"');
assert.throws(() => recordingDownloadDisposition("call-09120000001-2026-11-18.mp3"));

// Synthetic schema only: never copy live customers or call a provider.
const root = await mkdtemp(path.join(os.tmpdir(), "rec-dl-fixture-"));
const db = new DatabaseSync(":memory:");
globalThis.recDlFixtureDb = db;
const now = "2026-11-18T08:00:00.000Z";
db.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, role TEXT, active INTEGER, salesperson_id INTEGER);
  CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, phone TEXT, salesperson_id INTEGER, merged_into_customer_id INTEGER);
  CREATE TABLE voip_extensions(user_id INTEGER PRIMARY KEY, extension TEXT UNIQUE);
  CREATE TABLE call_queue_settings(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE voip_after_call_events(
    id INTEGER PRIMARY KEY, external_id TEXT, recording_provider_id TEXT, recording_file TEXT,
    expert_user_id INTEGER, is_live INTEGER, started_at TEXT, ended_at TEXT, customer_id INTEGER, call_log_id INTEGER);
  CREATE TABLE call_logs(id INTEGER PRIMARY KEY, customer_id INTEGER);
  CREATE TABLE voip_click_calls(id INTEGER PRIMARY KEY, event_id INTEGER, user_id INTEGER);
  INSERT INTO users VALUES
    (1,'admin','مدیر','admin',1,NULL),
    (2,'agent','کارشناس','salesperson',1,2),
    (3,'other','دیگر','salesperson',1,3),
    (8,'locked','قفل','salesperson',1,8);
  INSERT INTO customers VALUES (10,'مشتری خود','09120000010',2,NULL),(11,'مشتری دیگر','09120000011',3,NULL),(12,'مشتری قفل','09120000012',8,NULL);
  INSERT INTO voip_extensions VALUES (1,'200'),(2,'201'),(3,'202'),(8,'208');
  INSERT INTO call_queue_settings VALUES ('flag.voip_call','1'),('flag.call_transcripts.ui','1'),('flag.expert_lockdown','1');
  INSERT INTO voip_after_call_events VALUES
    (100,'rec-own', 'rec-own', 'own.mp3', 2, 0, '2026-11-18T08:00:00.000Z', '2026-11-18T08:05:00.000Z', 10, NULL),
    (101,'rec-other','rec-other','other.mp3', 3, 0, '2026-11-18T08:10:00.000Z', '2026-11-18T08:12:00.000Z', 11, NULL),
    (102,'rec-none', 'rec-none', NULL, 2, 0, '2026-11-18T08:20:00.000Z', '2026-11-18T08:21:00.000Z', 10, NULL),
    (103,'rec-live', 'rec-live', 'live.mp3', 2, 1, '2026-11-18T08:30:00.000Z', NULL, 10, NULL),
    (104,'rec-locked','rec-locked','locked.mp3', 8, 0, '2026-11-18T08:40:00.000Z', '2026-11-18T08:41:00.000Z', 12, NULL);
`);

const originalFetch = globalThis.fetch;
const network = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "127.0.0.1") return originalFetch(input, init);
  network.push(url.hostname);
  if (url.pathname.endsWith("/reports/audio/download")) {
    return Response.json({ success: 1, data: { audioLink: "https://storage.hostedpbx.ir/synthetic.mp3" } });
  }
  assert.equal(url.origin, "https://storage.hostedpbx.ir");
  return new Response(Buffer.from([0x49, 0x44, 0x33, 9, 8, 7]), { headers: { "Content-Type": "audio/mpeg" } });
};
Object.assign(process.env, { SIMOTEL_API_KEY: "synthetic-key" }); // keep NODE_ENV=production so pino-pretty is not bundled

const actors = {
  admin: { id: 1, role: "admin", permissions: ["calls.view"], customerScope: "all", salespersonId: null },
  agent: { id: 2, role: "salesperson", permissions: ["calls.view"], customerScope: "assigned", salespersonId: 2 },
  other: { id: 3, role: "salesperson", permissions: ["calls.view"], customerScope: "assigned", salespersonId: 3 },
  locked: { id: 8, role: "salesperson", permissions: ["calls.view"], customerScope: "assigned", salespersonId: 8 },
  blocked: { id: 2, role: "salesperson", permissions: [], customerScope: "assigned", salespersonId: 2 },
};

let server;
try {
  const bundle = path.join(root, "voip-call-routes.mjs");
  await build({
    stdin: {
      contents: `
        export { default as voipCall } from "./src/routes/voip-call.ts";
        export { expertLockdownGuard } from "./src/lib/expert-lockdown.ts";
      `,
      resolveDir: path.resolve("."),
      sourcefile: "rec-dl-entry.ts",
    },
    outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: `import{createRequire}from'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});` },
    plugins: [{ name: "synthetic-db", setup(ctx) {
      ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
      ctx.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const crmDb=globalThis.recDlFixtureDb;
        export const queryRow=(sql,args=[])=>crmDb.prepare(sql).get(...(args||[]));
        export const queryRows=(sql,args=[])=>crmDb.prepare(sql).all(...(args||[]));
        export const execute=(sql,args=[])=>crmDb.prepare(sql).run(...(args||[]));
        export const executeChanges=(sql,args=[])=>crmDb.prepare(sql).run(...(args||[])).changes;
        export const runTransaction=(fn)=>fn();
        export const runImmediateTransaction=(fn)=>fn();
      ` }));
    } }],
  });
  const mod = await import(pathToFileURL(bundle).href);
  const app = express();
  app.use((req, res, next) => {
    const name = req.headers["x-fixture-user"];
    if (name && actors[name]) res.locals.authUser = actors[name];
    next();
  });
  app.use(mod.expertLockdownGuard);
  app.use(mod.voipCall);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, actor) => fetch(`${base}${path}`, { headers: actor ? { "x-fixture-user": actor } : {} });

  assert.equal((await get("/voip-call/calls/100/download", null)).status, 401);
  assert.equal((await get("/voip-call/calls/100/download", "blocked")).status, 403);
  const ok = await get("/voip-call/calls/100/download", "agent");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-disposition"), 'attachment; filename="call-100-2026-11-18.mp3"');
  assert.equal(/09\d{8}|مشتری/.test(ok.headers.get("content-disposition")), false);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(0, 3).toString(), "ID3");

  const other = await get("/voip-call/calls/101/download", "agent");
  assert.equal(other.status, 403);
  const otherBody = await other.json();
  assert.equal(otherBody.error, "recording_forbidden");

  assert.equal((await get("/voip-call/calls/102/download", "agent")).status, 404);
  assert.equal((await get("/voip-call/calls/103/download", "agent")).status, 404, "Live call has no stored download");
  assert.equal((await get("/voip-call/calls/999/download", "agent")).status, 404);

  const adminOther = await get("/voip-call/calls/101/download", "admin");
  assert.equal(adminOther.status, 200, "Admin may download another expert's stored file");
  assert.equal(adminOther.headers.get("content-disposition"), 'attachment; filename="call-101-2026-11-18.mp3"');

  // Lockdown: locked expert (user 8) can download THEIR own stored call; another expert's call stays closed.
  const lockedOwn = await get("/voip-call/calls/104/download", "locked");
  assert.equal(lockedOwn.status, 200, "Locked expert can download their own call (same as play)");
  const lockedOther = await get("/voip-call/calls/100/download", "locked");
  assert.ok([403, 404].includes(lockedOther.status), "Locked expert cannot download another expert's call");
  const lockedOtherBody = await lockedOther.json();
  assert.ok(/lockdown|forbidden|نیست/.test(JSON.stringify(lockedOtherBody)));

  console.log("PASS: recording download filename, voip-call auth/lockdown matrix, headers, missing file.");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = originalFetch;
  db.close();
  delete globalThis.recDlFixtureDb;
  await rm(root, { recursive: true, force: true });
  await rm(helperRoot, { recursive: true, force: true });
}
