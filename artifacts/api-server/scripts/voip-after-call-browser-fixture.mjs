import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { build } from "esbuild";

const metadata = "/tmp/after-call-ui-fixture.json";
const database = path.resolve("../../attached_assets/customers_1789823100050.db");
const db = new DatabaseSync(database);
const identityBundle = `/tmp/after-call-identity-${process.pid}.mjs`;
await build({entryPoints:["src/lib/customer-integrity.ts"],outfile:identityBundle,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
(await import(pathToFileURL(identityBundle).href)).registerCustomerIdentityFunctions(db);
fs.unlinkSync(identityBundle);
if (process.argv.includes("--cleanup")) {
  const fixture = JSON.parse(fs.readFileSync(metadata, "utf8"));
  const user = db.prepare("SELECT id FROM users WHERE id=? AND username=?").get(fixture.id, fixture.username);
  const customer = db.prepare("SELECT id FROM customers WHERE id=? AND name=?").get(fixture.customerId, fixture.customerName);
  if (!user || !customer) throw Error("Fixture ownership mismatch; refusing cleanup");
  db.exec("BEGIN");
  try {
    const events = db.prepare("SELECT id,external_id,call_log_id,live_cuid FROM voip_after_call_events WHERE external_id GLOB ? OR (expert_user_id=? AND live_cuid GLOB ?)").all(fixture.prefix + "-*",fixture.id,fixture.prefix+"*");
    if (events.some(x => !x.external_id.startsWith(fixture.prefix + "-") && !x.live_cuid?.startsWith(fixture.prefix))) throw Error("Foreign event in cleanup");
    for (const event of events) {
      db.prepare("DELETE FROM call_report_edits WHERE event_id=? OR call_log_id=?").run(event.id,event.call_log_id);
      db.prepare("DELETE FROM voip_after_call_events WHERE id=? AND external_id=?").run(event.id, event.external_id);
      if (event.call_log_id) db.prepare("DELETE FROM call_logs WHERE id=? AND customer_id=?").run(event.call_log_id, fixture.customerId);
    }
    if(fixture.liveCuid){
      db.prepare("DELETE FROM simotel_call_signals WHERE cuid=?").run(fixture.liveCuid);
      db.prepare("DELETE FROM simotel_extension_signals WHERE cuid=?").run(fixture.liveCuid);
      db.prepare("UPDATE voip_call_reporting_state SET live_event_seen_at=? WHERE live_event_seen_at=?").run(fixture.previousLiveSeen??null,fixture.liveSeenAt);
    }
    db.prepare("DELETE FROM voip_extensions WHERE user_id=?").run(fixture.id);
    db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(fixture.id);
    db.prepare("DELETE FROM customers WHERE id=? AND name=?").run(fixture.customerId, fixture.customerName);
    db.prepare("DELETE FROM users WHERE id=? AND username=?").run(fixture.id, fixture.username);
    if (fixture.salespersonId) db.prepare("DELETE FROM salespersons WHERE id=? AND name=?").run(fixture.salespersonId, fixture.salespersonName);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  fs.unlinkSync(metadata);
  console.log("Temporary popup customer, user, events, history and sessions removed.");
} else {
  const prefix = "after_call_fixture_" + randomBytes(6).toString("hex");
  const username = prefix + "_admin", password = randomBytes(24).toString("base64url");
  const salt = randomBytes(16).toString("hex"), hash = scryptSync(password, salt, 64, {
    N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  }).toString("hex");
  const now = new Date(), customerName = "مشتری آزمایشی پاپ‌آپ " + prefix.slice(-6);
  const phone = "09129" + String(Number.parseInt(randomBytes(3).toString("hex"),16) % 1000000).padStart(6,"0");
  if (db.prepare("SELECT id FROM customers WHERE phone=?").get(phone)) throw Error("Synthetic number collides; no customer changed");
  if (db.prepare("SELECT user_id FROM voip_extensions WHERE extension='990907'").get()) throw Error("Synthetic extension collides; no mapping changed");
  let id, customerId, salespersonId;
  const expert = process.argv.includes("--expert");
  const salespersonName = "کارشناس آزمایشی " + prefix;
  db.exec("BEGIN");
  try {
  if (expert) salespersonId = Number(db.prepare("INSERT INTO salespersons(name,mobile,created_at) VALUES(?,?,?)").run(salespersonName,phone,now.toISOString()).lastInsertRowid);
  id = Number(db.prepare("INSERT INTO users(username,password_hash,full_name,role,active,created_at,salesperson_id) VALUES(?,?,?,?,1,?,?)")
    .run(username, `scrypt:32768:8:1$${salt}$${hash}`, "کارشناس آزمایشی پاپ‌آپ", expert ? "salesperson" : "admin", now.toISOString(), salespersonId ?? null).lastInsertRowid);
  customerId = Number(db.prepare("INSERT INTO customers(name,phone,description,created_at,salesperson_id,priority) VALUES(?,?,?,?,?,1)")
    .run(customerName,phone,"داده موقت و مصنوعی آزمون",now.toISOString(),salespersonId ?? null).lastInsertRowid);
  db.prepare("INSERT INTO voip_extensions(user_id,extension,updated_at,updated_by_user_id) VALUES(?,?,?,?)")
    .run(id,"990907",now.toISOString(),id);
  db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  fs.writeFileSync(metadata,JSON.stringify({username,password,id,customerId,customerName,database,prefix,phone,salespersonId,salespersonName}),{mode:0o600});
  const bundle = "/tmp/after-call-ui-ingest.mjs";
  globalThis.afterCallBrowserDb = db;
  await build({
    stdin:{contents:"export*from'./src/lib/voip-after-call.ts';export*from'./src/lib/simotel-call-events.ts';",resolveDir:path.resolve(".")},outfile:bundle,bundle:true,platform:"node",format:"esm",logLevel:"silent",
    plugins:[{name:"temporary-fixture-connection",setup(ctx){
      ctx.onResolve({filter:/\/crm-db$/},()=>({path:"db",namespace:"fixture"}));
      ctx.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:`
        export const crmDb=globalThis.afterCallBrowserDb;
        export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
        export const queryRows=(s,p=[])=>crmDb.prepare(s).all(...p);
        export const execute=(s,p=[])=>Number(crmDb.prepare(s).run(...p).lastInsertRowid);
        export const executeChanges=(s,p=[])=>Number(crmDb.prepare(s).run(...p).changes);
        export function runTransaction(fn){crmDb.exec('BEGIN');try{const v=fn();crmDb.exec('COMMIT');return v}catch(e){crmDb.exec('ROLLBACK');throw e}}
      `}));
    }}],
  });
  const mod = await import(pathToFileURL(bundle).href);
  const start = new Date(Date.now()-30000).toISOString();
  if (start < mod.afterCallState().activated_at) throw Error("Wait 30 seconds after API activation before seeding popup fixtures");
  const row = (suffix, callerPhone, startedAt) => ({
    _id:prefix+"-"+suffix,cuid:prefix,src:callerPhone,dst:"990907",type:"incoming",
    start:startedAt,disposition:"ANSWERED",duration:20,billsec:15,
    endtime:{$date:{$numberLong:String(Date.parse(startedAt)+20000)}},
  });
  const oldStart = new Date(Date.parse(mod.afterCallState().activated_at)-10000).toISOString();
  mod.ingestAfterCalls([row("old",phone,oldStart),row("a",phone,start),row("b",phone,start),
    row("unmatched","anonymous",start)],new Date());
  const events=db.prepare("SELECT id,external_id,call_log_id FROM voip_after_call_events WHERE external_id GLOB ? ORDER BY id").all(prefix+"-*");
  if(events.length!==3||events.some(x=>x.external_id===prefix+"-old"))throw Error("Future-only popup fixture setup failed");
  let liveMeta={};
  if(process.argv.includes("--live")){
    const previousLiveSeen=db.prepare("SELECT live_event_seen_at FROM voip_call_reporting_state WHERE id=1").get().live_event_seen_at;
    const liveCuid=prefix+".live",liveSeenAt=new Date().toISOString();
    mod.receiveSimotelCallEvent({event_name:"IncomingCall",number:phone,unique_id:liveCuid,entry_point:"synthetic-trunk"},new Date(liveSeenAt));
    mod.receiveSimotelCallEvent({event_name:"New State",unique_id:liveCuid,exten:"990907",state:"Ringing",participant:phone,direction:"in"},new Date(liveSeenAt));
    db.prepare("UPDATE voip_after_call_events SET auto_capture=0 WHERE live_cuid=? AND expert_user_id=?").run(liveCuid,id);
    liveMeta={liveCuid,liveSeenAt,previousLiveSeen,liveEventId:db.prepare("SELECT id FROM voip_after_call_events WHERE live_cuid=? AND expert_user_id=?").get(liveCuid,id).id};
  }
  fs.writeFileSync(metadata,JSON.stringify({username,password,id,customerId,customerName,database,prefix,phone,events,salespersonId,salespersonName,...liveMeta}),{mode:0o600});
  fs.unlinkSync(bundle);
  delete globalThis.afterCallBrowserDb;
  console.log("Seeded 3 synthetic NEW popup events; old call excluded; 2 customer history rows automatically created.");
}
db.close();