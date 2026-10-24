import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import express from "express";

// Synthetic in-memory database only. Never copy CRM rows or contact providers.
const temp = await mkdtemp(path.join(os.tmpdir(), "after-call-fixture-"));
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
 INSERT INTO users VALUES(1,'admin','مدیر آزمایشی','admin',1,'2026-10-04',NULL),(2,'first','کارشناس یک','salesperson',1,'2026-10-04',11),(3,'second','کارشناس دو','salesperson',1,'2026-10-04',12);
 INSERT INTO customers(id,name,phone,salesperson_id,merged_into_customer_id,priority) VALUES(1,'مشتری یک','09120000001',11,NULL,1),(2,'مشتری دو','09120000002',12,NULL,1),(3,'ادغام‌شده','09120000004',12,1,1);
 INSERT INTO customers VALUES(4,'آرشیو لغوشده','09120000001',12,NULL,1,'cancelled');
 INSERT INTO voip_extensions VALUES(2,'201'),(3,'202');
`);
const call = (id, extension, phone, start = "2026-10-04T10:00:00Z", type = "outgoing") => ({
  _id: id, cuid: "duplicate-cuid", src: type === "incoming" ? phone : extension,
  dst: type === "incoming" ? extension : phone, type, start, disposition: "ANSWERED",
  duration: 60, billsec: 50, record: "synthetic.mp3",
  endtime: { $date: { $numberLong: String(Date.parse(start) + 60000) } },
});
const rows = [
  call("old-ended-after-activation", "201", "09120000001", "2026-10-03T23:59:30Z"),
  call("new-a", "201", "+989120000001", undefined, "incoming"),
  call("new-b", "202", "09120000002"),
  call("cross-owner", "201", "09120000002"),
  call("unmatched-customer", "201", "09120000003"),
  call("unmatched-expert", "303", "09120000001"),
  call("merged-phone", "201", "00989120000004"),
  call("ambiguous-transfer", "201", "09120000001"),
  call("not-ended", "201", "09120000001", "2099-01-01T10:00:00Z"),
  call("local", "201", "202", undefined, "local"),
];
rows.find(x => x._id === "ambiguous-transfer").details = [{ exten: "201", status: "ANSWERED" }, { exten: "202", status: "ANSWERED" }];
const originalFetch = globalThis.fetch;
let upstreamRows = rows, failUpstream = false, requests = 0, server;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "127.0.0.1") return originalFetch(input, init);
  assert.equal(url.origin, "https://panel.hostedpbx.ir");
  assert.equal(url.pathname, "/api/v4.1/reports/cdr/search");
  requests++;
  if (failUpstream) return new Response("", { status: 403 });
  const body = JSON.parse(init.body);
  return Response.json({ success: 1, data: {
    pagination: { total: upstreamRows.length },
    data: upstreamRows.slice(body.pagination.start, body.pagination.start + body.pagination.count),
  } });
};
Object.assign(process.env, { NODE_ENV: "test", SIMOTEL_API_KEY: "synthetic-not-a-credential" });
try {
  const bundle = path.join(temp, "after-call.mjs");
  await build({
    stdin: { contents: `export{default as router}from'./src/routes/voip-after-call.ts';export{default as recordingsRouter}from'./src/routes/simotel-recordings.ts';export{default as reportsRouter}from'./src/routes/call-reports.ts';export{default as eventsRouter}from'./src/routes/simotel-call-events.ts';export*from'./src/lib/simotel-call-events.ts';export*from'./src/lib/voip-after-call.ts';export*from'./src/lib/call-history-scope.ts';`, resolveDir: path.resolve(".") },
    outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: `import{createRequire}from'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});` },
    plugins: [{ name: "synthetic-only-db", setup(ctx) {
      ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
      ctx.onResolve({ filter: /\/auth$/ }, () => ({ path: "auth", namespace: "fixture-auth" }));
      ctx.onResolve({filter:/\/logger$/},()=>({path:"logger",namespace:"fixture-logger"}));
      ctx.onLoad({filter:/.*/,namespace:"fixture-logger"},()=>({contents:"export const logger={info(){},warn(){},error(){},debug(){}};"}));
      ctx.onLoad({filter: /.*/, namespace: "fixture-auth"}, () => ({contents: "export const getAuthUserById=()=>null;"}));
      ctx.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const crmDb=globalThis.afterCallFixtureDb;
        export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
        export const queryRows=(s,p=[])=>crmDb.prepare(s).all(...p);
        export const execute=(s,p=[])=>Number(crmDb.prepare(s).run(...p).lastInsertRowid);
        export const executeChanges=(s,p=[])=>Number(crmDb.prepare(s).run(...p).changes);
        export function runTransaction(fn){crmDb.exec('BEGIN');try{const v=fn();crmDb.exec('COMMIT');return v}catch(e){crmDb.exec('ROLLBACK');throw e}}
      ` }));
    } }],
  });
  const mod = await import(pathToFileURL(bundle).href);
  db.prepare("UPDATE voip_after_call_state SET activated_at=?").run("2026-10-04T00:00:00.000Z");
  const inserted = mod.ingestAfterCalls(rows, new Date("2026-10-04T13:00:00Z"));
  assert.equal(inserted, 7);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n, 6);
  assert.equal(mod.ingestAfterCalls(rows, new Date("2026-10-04T13:00:00Z")), 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n, 6, "Re-polling never duplicates history");
  assert.equal(db.prepare("SELECT id FROM voip_after_call_events WHERE external_id=?").get(rows[0]._id), undefined, "Old started call stays ignored even if it ended after activation");
  const a = db.prepare("SELECT * FROM voip_after_call_events WHERE external_id='new-a'").get();
  assert.equal(a.expert_user_id, 2);
  assert.equal(a.customer_id, 1);
  assert.equal(db.prepare("SELECT created_at FROM call_logs WHERE id=?").get(a.call_log_id).created_at, "2026-10-04T10:00:00.000Z");
  assert.equal(db.prepare("SELECT salesperson_name_snapshot FROM call_logs WHERE id=?").get(a.call_log_id).salesperson_name_snapshot, "کارشناس یک");
  assert.equal(db.prepare("SELECT customer_id FROM voip_after_call_events WHERE external_id='merged-phone'").get().customer_id, 1);
  assert.equal(db.prepare("SELECT expert_user_id FROM voip_after_call_events WHERE external_id='ambiguous-transfer'").get().expert_user_id, null, "Never guess the expert for multiple answered extensions");
  mod.ensureAfterCallSchema();
  assert.equal(mod.afterCallState().activated_at, "2026-10-04T00:00:00.000Z", "Restart does not reset the cutoff");
  const app = express();
  app.use(express.json());
  app.use("/events",mod.eventsRouter);
  app.use((req, res, next) => {
    const actor = req.headers["x-fixture-user"];
    if (actor) res.locals.authUser = {
      id: actor === "admin" ? 1 : actor === "other" ? 3 : 2,
      role: actor === "admin" ? "admin" : "salesperson",
      customerScope: actor === "admin" || actor === "wide" ? "all" : "assigned",
      salespersonId: actor === "other" ? 12 : 11,
      permissions: actor === "blocked" ? [] : actor === "viewer" ? ["calls.view"] :
        actor === "no-priority" ? ["calls.view", "calls.create"] : ["calls.view", "calls.create", "customers.update"],
    };
    next();
  });
  app.use(mod.router);
  app.use(mod.reportsRouter);
  app.use(mod.recordingsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/voip/after-call`;
  const get = (actor = "admin") => fetch(`${base}/pending`, { headers: actor ? { "x-fixture-user": actor } : {} });
  const save = (id, body, actor = "agent") => fetch(`${base}/${id}`, {
    method: "PATCH", headers: { "x-fixture-user": actor, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await get(null)).status, 401);
  assert.equal((await get("blocked")).status, 403);
  const mine = await (await get("agent")).json();
  assert.deepEqual(mine.items.map(x => x.externalId), ["new-a", "cross-owner", "unmatched-customer", "merged-phone"]);
  const masked = mine.items.find(x => x.externalId === "cross-owner");
  assert.equal(masked.customerId, null);
  assert.equal(masked.customerName, null);
  assert.equal(masked.priority, null);
  assert.equal(masked.callLogId, null, "Own call visibility never exposes another owner's profile metadata");
  assert.equal(mine.items[0].priority, 1);
  const cross = db.prepare("SELECT id FROM voip_after_call_events WHERE external_id='cross-owner'").get().id;
  assert.equal((await save(cross, { expertNotes: "must-not-write", priority: 3 })).status, 403);
  assert.equal((await save(a.id, { expertNotes: "other internal" }, "other")).status, 404);
  const recordings = await originalFetch(`http://127.0.0.1:${server.address().port}/voip/recordings?from=2026-10-04&to=2026-10-04`, {headers: {"x-fixture-user": "agent"}});
  assert.equal(recordings.status, 200);
  const report = await recordings.json();
  assert.ok(report.items.some(x => x.id === "cross-owner"), "Own internal calls are not hidden by customer ownership");
  assert.ok(report.items.every(x => x.extensions.includes("201")));
  assert.ok(!report.items.some(x => x.id === "new-b"));
  assert.equal(report.items.find(x => x.id === "cross-owner").customerId, null);
  const wideReport = await (await originalFetch(`http://127.0.0.1:${server.address().port}/voip/recordings?from=2026-10-04&to=2026-10-04`, {headers: {"x-fixture-user": "wide"}})).json();
  assert.ok(!wideReport.items.some(x => x.id === "new-b"), "All-customer permission is not all-extension permission");
  const deniedAudio = await originalFetch(`http://127.0.0.1:${server.address().port}/voip/recordings/new-b/audio?from=2026-10-04&to=2026-10-04`, {headers: {"x-fixture-user": "wide"}});
  assert.equal(deniedAudio.status, 404);
  const scopedActor = {id:2,role:"salesperson",customerScope:"all",salespersonId:11,permissions:["calls.view","calls.create"]};
  const historyScope = mod.callHistoryScope(scopedActor);
  const ownHistories = db.prepare(`SELECT cl.id FROM call_logs cl JOIN customers c ON c.id=cl.customer_id WHERE ${historyScope.sql}`).all(...historyScope.params).map(x=>x.id);
  assert.ok(ownHistories.includes(a.call_log_id));
  assert.ok(ownHistories.includes(mod.eventFor(cross).call_log_id));
  assert.ok(!ownHistories.includes(db.prepare("SELECT call_log_id FROM voip_after_call_events WHERE external_id='new-b'").get().call_log_id));
  const transferId = db.prepare("SELECT call_log_id FROM voip_after_call_events WHERE external_id='ambiguous-transfer'").get().call_log_id;
  for (const participant of [{...scopedActor,id:2,salespersonId:11},{...scopedActor,id:3,salespersonId:12}]) {
    const scope = mod.callHistoryScope(participant);
    assert.ok(db.prepare(`SELECT cl.id FROM call_logs cl JOIN customers c ON c.id=cl.customer_id WHERE ${scope.sql}`).all(...scope.params).some(x=>x.id===transferId),"A transferred call belongs to each involved internal, without guessing one expert");
  }
  assert.equal((await save(a.id, { expertNotes: "no-permission" }, "viewer")).status, 403);
  assert.equal((await save(a.id, { expertNotes: "no-permission", priority: 3 }, "no-priority")).status, 403);
  assert.equal((await save(a.id, { expertNotes: "invalid", priority: 4 })).status, 400);
  const payload = { expertNotes: "توضیحات کارشناس آزمایشی", priority: 3, subject: "موضوع اصلاح‌شده صف", customerRequest: "خلاصه نهایی درخواست مشتری" };
  const results = await Promise.all([save(a.id, payload), save(a.id, payload)]);
  assert.deepEqual(results.map(x => x.status), [200, 200], "Concurrent identical retries are idempotent");
  assert.equal(db.prepare("SELECT priority FROM customers WHERE id=1").get().priority, 3);
  assert.equal(db.prepare("SELECT expert_notes FROM call_logs WHERE id=?").get(a.call_log_id).expert_notes, payload.expertNotes);
  assert.equal(db.prepare("SELECT subject FROM call_logs WHERE id=?").get(a.call_log_id).subject,payload.subject);
  assert.equal(db.prepare("SELECT customer_request FROM call_logs WHERE id=?").get(a.call_log_id).customer_request,payload.customerRequest);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n, 6);
  assert.equal((await save(a.id, { expertNotes: "overwrite" })).status, 409);
  const unknown = db.prepare("SELECT id FROM voip_after_call_events WHERE external_id='unmatched-customer'").get().id;
  assert.equal((await save(unknown, { expertNotes: "unmatched", priority: 1 })).status, 422);
  assert.equal((await save(unknown, { expertNotes: "unmatched note" })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n, 6, "No invented customer/history for unknown phone");
  const merged = db.prepare("SELECT id FROM voip_after_call_events WHERE external_id='merged-phone'").get().id;
  assert.equal((await save(merged, { expertNotes: "clear priority", priority: null })).status, 200);
  assert.equal(db.prepare("SELECT priority FROM customers WHERE id=1").get().priority, null);
  await mod.syncAfterCalls();
  assert.ok(requests >= 2);
  assert.equal(mod.afterCallState().sync_error, null);
  failUpstream = true;
  await mod.syncAfterCalls();
  assert.match(mod.afterCallState().sync_error, /سیموتل/);
  assert.equal((await get()).status, 200, "Upstream errors remain visible without losing pending events");
  failUpstream = false;
  upstreamRows = [...rows, call("after-restart", "201", "09120000001")];
  await mod.syncAfterCalls();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM voip_after_call_events WHERE external_id='after-restart'").get().n, 1);
  assert.equal(mod.afterCallState().sync_error, null);
  const unbound = db.prepare("SELECT * FROM voip_after_call_events WHERE external_id='unmatched-expert'").get();
  assert.equal(unbound.extension, "303");
  db.prepare("INSERT INTO users VALUES(4,'late','کارشناس تازه','salesperson',1,'2026-10-04',13)").run();
  db.prepare("INSERT INTO voip_extensions VALUES(4,'303')").run();
  mod.ingestAfterCalls([], new Date());
  assert.equal(db.prepare("SELECT expert_user_id FROM voip_after_call_events WHERE id=?").get(unbound.id).expert_user_id, 4);
  assert.equal(db.prepare("SELECT salesperson_name_snapshot FROM call_logs WHERE id=?").get(unbound.call_log_id).salesperson_name_snapshot, "کارشناس تازه");
  db.prepare("INSERT INTO customers VALUES(5,'شماره مبهم','09120000001',12,NULL,1,'in_progress')").run();
  mod.ingestAfterCalls([call("ambiguous-customer", "201", "09120000001")],new Date());
  const ambiguous = db.prepare("SELECT id,customer_id,call_log_id FROM voip_after_call_events WHERE external_id='ambiguous-customer'").get();
  assert.equal(ambiguous.customer_id, null, "Multiple active phone matches never guess a customer");
  assert.equal(ambiguous.call_log_id, null);
  db.prepare("DELETE FROM customers WHERE id=5").run();
  mod.ingestAfterCalls([], new Date());
  assert.equal(db.prepare("SELECT customer_id FROM voip_after_call_events WHERE id=?").get(ambiguous.id).customer_id, 1,
    "Active customer takes precedence over a cancelled duplicate, including after ambiguity is resolved");
  db.prepare("INSERT INTO customers VALUES(6,'ثبت دستی آزمایشی','09120000006',11,NULL,1,'in_progress')").run();
  const manualRows = [
    call("manual-first","201","09120000006","2026-10-04T10:05:00Z"),
    call("manual-second","201","09120000006","2026-10-04T10:10:00Z"),
    call("manual-other-expert","202","09120000006","2026-10-04T10:15:00Z"),
  ];
  mod.ingestAfterCalls(manualRows,new Date("2026-10-04T13:00:00Z"));
  const queued = db.prepare("SELECT * FROM voip_after_call_events WHERE external_id='manual-first'").get();
  const totalHistories = db.prepare("SELECT COUNT(*) n FROM call_logs").get().n;
  const manualActor = {id:2,role:"salesperson",customerScope:"assigned",salespersonId:11,permissions:["calls.view","calls.create"]};
  const manualFields = {subject:"پیگیری دستی",customerRequest:"درخواست آزمایشی",expertNotes:"نتیجه ثبت دستی"};
  assert.throws(()=>{
    db.exec("BEGIN");
    try { mod.savePendingAfterCallHistory(6,manualActor,manualFields); throw Error("simulated reminder failure"); }
    catch(error){db.exec("ROLLBACK");throw error;}
  },/simulated reminder/);
  assert.equal(mod.eventFor(queued.id).completed_at,null,"Failed history transaction leaves the call queued");
  assert.equal(db.prepare("SELECT expert_notes FROM call_logs WHERE id=?").get(queued.call_log_id).expert_notes,"");
  assert.equal(mod.savePendingAfterCallHistory(6,{...manualActor,id:3,salespersonId:12},manualFields),null,"Another expert/customer owner cannot consume this queue");
  db.exec("BEGIN");
  const reused = mod.savePendingAfterCallHistory(6,manualActor,manualFields);
  db.exec("COMMIT");
  assert.equal(reused,queued.call_log_id,"Manual registration updates the SAME automatic history");
  const registered = db.prepare("SELECT * FROM call_logs WHERE id=?").get(reused);
  assert.equal(registered.expert_notes,manualFields.expertNotes);
  assert.equal(registered.customer_request,manualFields.customerRequest);
  assert.equal(registered.subject,manualFields.subject);
  assert.equal(registered.created_at,"2026-10-04T10:05:00.000Z");
  assert.equal(registered.salesperson_name_snapshot,"کارشناس یک");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n,totalHistories,"No duplicated history");
  assert.ok(mod.eventFor(queued.id).completed_at);
  assert.equal(mod.pendingAfterCalls(manualActor).rows.some(e=>e.id===queued.id),false,"Saved history exits the durable queue");
  assert.equal(db.prepare("SELECT completed_at FROM voip_after_call_events WHERE external_id='manual-second'").get().completed_at,null);
  assert.equal(db.prepare("SELECT completed_at FROM voip_after_call_events WHERE external_id='manual-other-expert'").get().completed_at,null);
  mod.ingestAfterCalls(manualRows,new Date("2026-10-04T13:00:00Z"));
  assert.equal(mod.pendingAfterCalls(manualActor).rows.some(e=>e.id===queued.id),false,"Re-polling never requeues the registered history");
  const discardRows = [call("discard-matched", "201", "09120000001"), call("discard-unmatched", "201", "09120000009"), call("discard-cross-owner", "201", "09120000002")];
  mod.ingestAfterCalls(discardRows, new Date("2026-10-04T13:00:00Z"));
  const discardEvent = db.prepare("SELECT * FROM voip_after_call_events WHERE external_id='discard-matched'").get();
  const beforeDiscard = db.prepare("SELECT COUNT(*) n FROM call_logs").get().n;
  assert.equal((await save(discardEvent.id,{expertNotes:"",discardHistory:true},"other")).status,404);
  assert.equal((await save(discardEvent.id,{expertNotes:"",discardHistory:true,priority:3})).status,400);
  assert.equal((await save(a.id,{expertNotes:"",discardHistory:true})).status,409,"Cannot remove already-reviewed history");
  const rejected = await save(discardEvent.id,{expertNotes:"",discardHistory:true});
  assert.equal(rejected.status,200);
  assert.equal((await rejected.json()).callLogId,null);
  assert.equal(db.prepare("SELECT id FROM call_logs WHERE id=?").get(discardEvent.call_log_id),undefined);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n,beforeDiscard-1,"Only the selected provisional history is removed");
  assert.equal((await save(discardEvent.id,{expertNotes:"",discardHistory:true})).status,200,"Discard retry is idempotent");
  assert.equal((await save(discardEvent.id,{expertNotes:"reopen"})).status,409);
  const tombstone = db.prepare("SELECT * FROM voip_after_call_events WHERE id=?").get(discardEvent.id);
  assert.equal(tombstone.completed_by_user_id,2);
  assert.equal(tombstone.completed_payload,JSON.stringify({discardHistory:true}));
  assert.equal(tombstone.call_log_id,null);
  for (const externalId of ["discard-unmatched","discard-cross-owner"]) {
    const event = db.prepare("SELECT * FROM voip_after_call_events WHERE external_id=?").get(externalId);
    assert.equal((await save(event.id,{expertNotes:"",discardHistory:true})).status,200);
  }
  mod.ingestAfterCalls(discardRows,new Date("2026-10-04T13:00:00Z"));
  assert.equal(mod.pendingAfterCalls(scopedActor).rows.some(x=>discardRows.some(r=>r._id===x.external_id)),false);
  assert.equal(db.prepare("SELECT call_log_id FROM voip_after_call_events WHERE id=?").get(discardEvent.id).call_log_id,null,"Polling does not recreate discarded history");
  {
  const origin=base.replace("/voip/after-call","");
  const hook=(body,auth="Basic "+Buffer.from("crm-events:synthetic-not-a-credential").toString("base64"))=>fetch(origin+"/events",{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:auth},body:JSON.stringify(body)});
  assert.equal((await hook({event_name:"IncomingCall",unique_id:"denied",number:"09120000001"},"Basic invalid")).status,401);
  assert.equal((await hook({event_name:"New State",unique_id:"bad",exten:"../",state:"Ringing"})).status,400);
  const liveNow=new Date(),beforeLive=db.prepare("SELECT COUNT(*) n FROM call_logs").get().n;
  mod.receiveSimotelCallEvent({event_name:"IncomingCall",unique_id:"fixture-live.1",number:"09120000001",entry_point:"trunk"},liveNow);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n,beforeLive,"A trunk event never guesses the target expert");
  mod.receiveSimotelCallEvent({event_name:"New State",unique_id:"fixture-live.1",exten:"201",state:"Ringing"},liveNow);
  let live=db.prepare("SELECT * FROM voip_after_call_events WHERE live_cuid='fixture-live.1'").get();
  assert.ok(live?.is_live);
  const reportGet=(id,actor="agent")=>fetch(`${base}/${id}/report`,{headers:{"x-fixture-user":actor}});
  const reportSave=(id,data,actor="agent")=>fetch(`${base}/${id}/report`,{method:"PATCH",headers:{"x-fixture-user":actor,"Content-Type":"application/json"},body:JSON.stringify(data)});
  let report=await (await reportGet(live.id)).json();
  assert.equal(report.subject,null,"Automatic subject is never prefilled into the expert field");
  assert.equal(report.transcript,null);
  assert.equal((await reportGet(live.id,"other")).status,404);
  assert.equal((await reportSave(live.id,{subject:"موضوع کارشناس",expertNotes:"یادداشت کارشناس",expectedRevision:0},"viewer")).status,403);
  report=await (await reportSave(live.id,{subject:"موضوع کارشناس",expertNotes:"یادداشت کارشناس",expectedRevision:0})).json();
  assert.equal(report.revision,1);assert.equal(report.isLive,true);
  assert.equal((await reportSave(live.id,{subject:"نباید جایگزین شود",expertNotes:"متن کهنه",expectedRevision:0})).status,409);
  mod.receiveSimotelCallEvent({event_name:"New State",unique_id:"fixture-live.1",exten:"201",state:"InUse",participant:"09120000001",direction:"in"},liveNow);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n,beforeLive+1,"Duplicate/answer events update the same report");
  mod.receiveSimotelCallEvent({event_name:"New State",unique_id:"fixture-live.1",exten:"201",state:"Idle"},new Date(liveNow.getTime()+60000));
  const ended=call("fixture-recorded-live","201","09120000001",liveNow.toISOString(),"incoming");ended.cuid="fixture-live.1";
  mod.ingestAfterCalls([ended],new Date(liveNow.getTime()+65000));
  report=await (await reportGet(live.id)).json();
  assert.equal(report.subject,"موضوع کارشناس");assert.equal(report.expertNotes,"یادداشت کارشناس");
  assert.equal(report.isLive,false);assert.equal(report.externalId,"fixture-recorded-live");assert.equal(report.call.id,live.call_log_id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n,beforeLive+1,"CDR reconciliation never duplicates the saved live history");
  mod.receiveSimotelCallEvent({event_name:"OutgoingCall",unique_id:"fixture-live.2",number:"09120000002",outgoing_point:"trunk"},liveNow);
  mod.receiveSimotelCallEvent({event_name:"New State",unique_id:"fixture-live.2",exten:"201",state:"InUse",dialer:"yes"},liveNow);
  const outgoing=db.prepare("SELECT id FROM voip_after_call_events WHERE live_cuid='fixture-live.2'").get();
  const redacted=await (await reportGet(outgoing.id)).json();
  assert.equal(redacted.call.customerId,null);assert.equal(redacted.call.customerName,"مخاطب تماس داخلی");
  assert.equal(redacted.status,"RINGING");assert.equal(redacted.canEdit,true);
  const orderUid="fixture-out-of-order";
  mod.receiveSimotelCallEvent({event_name:"New State",unique_id:orderUid,exten:"201",state:"InUse",direction:"out",dialer:"yes"},liveNow);
  mod.receiveSimotelCallEvent({event_name:"OutgoingCall",unique_id:orderUid,number:"09120000001"},liveNow);
  assert.equal(db.prepare("SELECT status FROM voip_after_call_events WHERE live_cuid=?").get(orderUid).status,"RINGING","An out-of-order trunk callback preserves the outgoing dialer state");
  const countBeforeTransfer=db.prepare("SELECT COUNT(*) n FROM call_logs").get().n,transferUid="fixture-live-transfer";
  for(const exten of ["201","202"])mod.receiveSimotelCallEvent({event_name:"New State",unique_id:transferUid,exten,state:"InUse",participant:"09120000001",direction:"in"},liveNow);
  const transferred=call("fixture-recorded-transfer","201","09120000001",liveNow.toISOString(),"incoming");
  transferred.cuid=transferUid;transferred.details=[{exten:"201",status:"ANSWERED"},{exten:"202",status:"ANSWERED"}];
  mod.ingestAfterCalls([transferred],new Date(liveNow.getTime()+65000));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM call_logs").get().n,countBeforeTransfer+2,"Two expert transfer reports never get a third duplicate CDR history");
  const transferEvents=db.prepare("SELECT id,expert_user_id FROM voip_after_call_events WHERE live_cuid=?").all(transferUid);
  assert.equal(transferEvents.length,2);
  for(const e of transferEvents){
    const data=await(await reportGet(e.id,e.expert_user_id===2?"agent":"other")).json();
    assert.equal(data.externalId,"fixture-recorded-transfer");
  }
  console.log("PASS: IncomingCall/OutgoingCall + New State, callback authentication, same-report CDR reconciliation, live draft preservation, optimistic conflicts, own-extension isolation, cross-owner redaction, future-only deduplication and discard tombstones.");
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  globalThis.fetch = originalFetch;
  db.close();
  delete globalThis.afterCallFixtureDb;
  await rm(temp, { recursive: true, force: true });
}