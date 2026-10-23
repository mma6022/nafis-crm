import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { createReminderSmsQueue } from "../src/lib/reminder-sms-core.ts";
import { sendReminderPattern } from "../src/lib/reminder-sms-transport.ts";
import { callHistoryScope } from "../src/lib/call-history-scope.ts";

const db=new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,mobile TEXT,full_name TEXT,username TEXT,active INTEGER);
 CREATE TABLE reminders(id INTEGER PRIMARY KEY,user_id INTEGER,salesperson_id INTEGER,customer_id INTEGER,
   subject TEXT,message TEXT,remind_at TEXT,notified_at TEXT,sent_sms INTEGER DEFAULT 0,done INTEGER DEFAULT 0,created_at TEXT,call_id INTEGER);
 CREATE TABLE customers(id INTEGER PRIMARY KEY,salesperson_id INTEGER);
 CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
 CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,salesperson_name_snapshot TEXT,subject TEXT,customer_request TEXT,expert_notes TEXT,created_at TEXT);
 CREATE TABLE voip_after_call_events(id INTEGER PRIMARY KEY,call_log_id INTEGER,mobile_device_id INTEGER,expert_user_id INTEGER,extension TEXT,extensions_json TEXT);
 CREATE TABLE voip_extensions(user_id INTEGER,extension TEXT);
 INSERT INTO users VALUES(1,'09120000000','Synthetic Expert','synthetic',1),(2,NULL,'Missing Phone','missing',1);
 INSERT INTO customers VALUES(100,11),(200,22);
 INSERT INTO salespersons VALUES(11,'Synthetic Expert'),(22,'Other Synthetic');
 INSERT INTO call_logs VALUES(10,100,11,'Original Expert','Original Subject','Original Request','Original Notes','2026-10-10T09:00:00Z');
 INSERT INTO call_logs VALUES(20,200,22,'Other','Private Subject',NULL,'Must not leak','2026-10-10T09:00:00Z');`);
let time="2026-10-10T10:00:00Z";
const add=(id:number,user:number,due:string,done=0)=>db.prepare(`INSERT INTO reminders(id,user_id,customer_id,subject,message,remind_at,done,created_at)
 VALUES(?,?,100,'Synthetic reminder','Synthetic message',?,?,?)`).run(id,user,due,done,time);
add(1,1,"2026-10-10T09:00:00Z"); // historical overdue must not send
add(2,1,"2026-10-10T10:01:00Z");
add(3,1,"2026-10-10T10:01:00Z",1);
add(4,2,"2026-10-10T10:01:00Z");
const sends:Array<{mobile:string;name:string}>=[];
let failure:string | null=null;
const send=async(mobile:string,name:string)=>{
 sends.push({mobile,name});
 if(failure)throw new Error(failure);
 return String(1000+sends.length);
};
const queue=createReminderSmsQueue(db,send,()=>time);
await queue.tick();
assert.equal(sends.length,0);
assert.equal(db.prepare("SELECT status FROM reminder_sms_deliveries WHERE reminder_id=1").get()?.status,"legacy_skipped");
time="2026-10-10T10:01:00Z";
await Promise.all([queue.tick(),queue.tick()]);
assert.equal(sends.length,1); assert.equal(sends[0].name,"Synthetic Expert");
assert.equal(db.prepare("SELECT sent_sms FROM reminders WHERE id=2").get()?.sent_sms,1);
assert.equal(db.prepare("SELECT status FROM reminder_sms_deliveries WHERE reminder_id=4").get()?.status,"blocked");
await queue.tick(); assert.equal(sends.length,1);
// Restart uses original cutoff and doesn't resend accepted reminders.
const restarted=createReminderSmsQueue(db,send,()=>time);
await restarted.tick(); assert.equal(sends.length,1);
// A missed future deadline survives downtime.
add(5,1,"2026-10-10T10:02:00Z");
time="2026-10-10T10:03:00Z"; await restarted.tick(); assert.equal(sends.length,2);
add(6,1,time); failure="sms_delivery_unknown";
await restarted.tick(); assert.equal(sends.length,3);
failure=null; time="2026-10-10T10:10:00Z"; await restarted.tick(); assert.equal(sends.length,3);
assert.equal(db.prepare("SELECT status FROM reminder_sms_deliveries WHERE reminder_id=6").get()?.status,"uncertain");
// Missing number is retryable after the expert fixes their account.
db.prepare("UPDATE users SET mobile='09120000001' WHERE id=2").run();
time="2026-10-10T10:16:00Z";
await restarted.tick(); assert.equal(sends.length,4);
add(7,1,time);
await restarted.tick(); assert.equal(sends.length,5);
// A crashed in-flight delivery is quarantined on restart, never silently resent.
add(8,1,time);
db.prepare("INSERT INTO reminder_sms_deliveries(reminder_id,status,attempted_at) VALUES(8,'sending',?)").run("2026-10-10T10:00:00Z");
await restarted.tick(); assert.equal(sends.length,5);
assert.equal(db.prepare("SELECT status FROM reminder_sms_deliveries WHERE reminder_id=8").get()?.status,"uncertain");

// Execute the actual call/reminder INSERT and mapper without importing CRM startup.
const source=readFileSync("src/routes/crm.ts","utf8");
const insert=source.match(/if \(body\.reminder\)\s+execute\(\s*`([\s\S]*?)`,/)!;
db.exec("BEGIN");
db.prepare(insert[1]).run(1,11,100,"Linked Reminder","Linked Message","2026-10-11T10:00:00Z",time,10);
const linked=Number(db.prepare("SELECT last_insert_rowid() AS id").get()?.id);
db.exec("COMMIT");
assert.equal(db.prepare("SELECT call_id FROM reminders WHERE id=?").get(linked)?.call_id,10);
const mapperSource=source.slice(source.indexOf("function reminderFromRow("),source.indexOf("\nconst customerSelect"));
const compiled=transformSync(mapperSource,{loader:"ts"}).code;
const queryRow=(sql:string,args:unknown[]=[])=>db.prepare(sql).get(...args as never[]);
const mapper=new Function("queryRow","callHistoryScope",compiled+"; return reminderFromRow;")(queryRow,callHistoryScope);
const row={...db.prepare("SELECT * FROM reminders WHERE id=?").get(linked),customer_name:"Synthetic",customer_salesperson_name:"Synthetic Expert"};
const actor={id:1,role:"staff",salespersonId:11,customerScope:"assigned",permissions:["reminders.view","calls.view"]};
const mapped=mapper(row,actor);
assert.equal(mapped.sourceCall.id,10); assert.equal(mapped.sourceCall.subject,"Original Subject");
assert.equal(mapped.sourceCall.expertNotes,"Original Notes");
assert.equal(mapper(row,{...actor,permissions:["reminders.view"]}).sourceCall,null);
assert.equal(mapper(row,{...actor,salespersonId:22}).callHistoryStatus,"restricted");
assert.equal(mapper({...row,id:1},actor).callHistoryStatus,"none");
// Neither detail reads nor scheduled SMS acknowledge or complete a reminder.
assert.equal(db.prepare("SELECT done FROM reminders WHERE id=?").get(linked)?.done,0);
assert.equal(db.prepare("SELECT notified_at FROM reminders WHERE id=?").get(linked)?.notified_at,null);
// Verify exact pattern/params and accepted outbox ID using a synthetic transport.
let payload:any;
const transport={enabled:true,relayUrl:"http://127.0.0.1:18787/send",fromNumber:"synthetic",secret:"synthetic-fixture-only",
 fetcher:async (_url:unknown,init:RequestInit)=>{payload=JSON.parse(String(init.body));return new Response(JSON.stringify({ok:true,data:{meta:{status:true},data:{message_outbox_ids:[123]}}}));}};
assert.equal(await sendReminderPattern("+989120000000","Synthetic Expert",transport as never),"123");
assert.equal(payload.code,"2nuz0inzh8ywd36"); assert.deepEqual(payload.params,{name:"Synthetic Expert"});
await assert.rejects(sendReminderPattern("+989120000000","Synthetic", {...transport,relayUrl:"https://example.com/send"} as never),/sms_relay_not_configured/);
await assert.rejects(sendReminderPattern("+989120000000","Synthetic", {...transport,fetcher:async()=>new Response(JSON.stringify({ok:true,data:{meta:{status:true}}}))} as never),/sms_delivery_unknown/);
db.close();
console.log("PASS: deadlines, no historical SMS, ownership, once-only/restarts, recovery, ambiguous delivery quarantine, actual reminder-call link, scoped source notes, read-only details and exact pattern payload.");
