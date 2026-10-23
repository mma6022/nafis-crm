import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
const require=createRequire(path.resolve("artifacts/api-server/package.json"));
const {build}=require("esbuild"),express=require("express"),multer=require("multer");
const root="/tmp/internal-chat-fixture";fs.mkdirSync(root,{recursive:true});
await build({stdin:{contents:'export {createInternalChatRouter} from "./src/lib/internal-chat"; export {validateInternalChatFile} from "./src/lib/internal-chat-files";',resolveDir:path.resolve("artifacts/api-server"),loader:"ts"},
  bundle:true,format:"esm",platform:"node",packages:"external",outfile:root+"/feature.mjs"});
if(!fs.existsSync(root+"/node_modules"))fs.symlinkSync(path.resolve("artifacts/api-server/node_modules"),root+"/node_modules","dir");
let feature=await import(root+"/feature.mjs");
const db=new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,full_name TEXT,role TEXT,active INTEGER);
INSERT INTO users VALUES(1,'مدیر آزمایشی','admin',1),(2,'فروش آزمایشی الف','salesperson',1),(3,'فروش آزمایشی ب','salesperson',1),(4,'ثبت آزمایشی','registrar',1),(5,'حسابداری آزمایشی','accounting',1),(6,'غیرفعال آزمایشی','salesperson',0);
CREATE TABLE customers(id INTEGER,phone TEXT,created_at TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
CREATE TABLE salespersons(id INTEGER,name TEXT);
CREATE TABLE call_logs(id INTEGER,customer_id INTEGER,created_at TEXT);
CREATE TABLE voip_after_call_events(id INTEGER,customer_id INTEGER,call_log_id INTEGER,started_at TEXT,status TEXT,mobile_answered_at TEXT,is_live INTEGER);
CREATE TABLE loan_applications(id INTEGER,customer_id INTEGER,created_at TEXT,requested_amount TEXT,is_pre_registration INTEGER,deleted_at TEXT);
INSERT INTO salespersons VALUES(2,'فروش آزمایشی الف'),(3,'فروش آزمایشی ب');
INSERT INTO customers VALUES(1,'09100000001','2026-10-14T08:00:00Z',2,NULL),(2,'09100000002','2026-09-01T08:00:00Z',3,NULL);
INSERT INTO loan_applications VALUES(1,1,'2026-10-14T08:00:00Z','100000000',0,NULL);
`);
const files=new Map();let fileNo=0;
const storage={
  saveFile:async(bytes)=>{const key=`synthetic-private:${++fileNo}`;files.set(key,Buffer.from(bytes));return key;},
  readFile:key=>Readable.from(files.get(key)??[]),
  deleteFile:async key=>{files.delete(key);},validateFile:feature.validateInternalChatFile,
};
const auth=(req,res,next)=>{
  const uid=Number(req.headers["x-fixture-user"]??(/(?:^|;\s*)team-actor=(\d+)/.exec(req.headers.cookie??"")?.[1]??(serving?1:0)));
  const u=db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(uid);
  if(!u){res.status(401).json({error:"Unauthorized"});return;}
  res.locals.authUser={id:u.id,role:u.role,fullName:u.full_name,username:`synthetic-${u.id}`,roleName:u.role,customerScope:u.role==="salesperson"?"assigned":"all",salespersonId:u.role==="salesperson"?u.id:null,
    permissions:["internal_chat.use","reports.view","customers.view"],active:true,createdAt:"2026-10-01T00:00:00Z"};next();
};
let serving=false;
const app=express();app.use(express.json());
app.get("/__fixture/user/:id",(req,res)=>{res.cookie("team-actor",req.params.id,{httpOnly:true});res.redirect("/internal-chat");});
app.get("/api/auth/session",auth,(_req,res)=>res.json({user:res.locals.authUser}));
app.get("/api/healthz",(_req,res)=>res.json({status:"ok"}));
app.get("/api/reminders",(_req,res)=>res.json([]));
app.get(["/api/chat/unread","/api/chat/unread-count"],auth,(_req,res)=>res.json({count:2}));
app.post("/api/chat/presence",auth,(_req,res)=>res.json({ok:true}));
app.get("/api/chat/events",(_req,res)=>res.status(204).end());
app.get("/api/site-notifications",(_req,res)=>res.json({items:[],unreadCount:0,pageCounts:{},total:0,scopeVersion:"synthetic"}));
app.get("/api/customer-portal/me",(_req,res)=>res.json({id:1,name:"مشتری آزمایشی",mobile:"09100000001",identityReady:true,verificationStatus:"verified"}));
app.get("/api/customer-portal/chat/thread",(_req,res)=>res.json({customerId:1,expertName:"کارشناس آزمایشی",expertOnline:true,unreadCount:3}));
app.post("/api/customer-portal/chat/presence",(_req,res)=>res.json({ok:true}));
const permission=(_req,_res,next)=>next();
if(process.env.INTERNAL_CHAT_STAGED_FEATURE){
  feature=new Function("__teamApiBindings","require",fs.readFileSync(process.env.INTERNAL_CHAT_STAGED_FEATURE,"utf8")+";return __teamChatFeature;")({
    Router:express.Router,multer,validateChatFile:feature.validateInternalChatFile,requireAuth:auth,requirePermission:()=>permission,
    queryRows:(sql,args=[])=>db.prepare(sql).all(...args),
  },require);
  app.use("/api",auth,feature.salesReportsRouter);
}
app.use("/api/internal-chat",feature.createInternalChatRouter({db,requireAuth:auth,requirePermission:permission,...storage}));
const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
const base="http://127.0.0.1:"+server.address().port+"/api/internal-chat";
async function req(user,url,body,method=body?"POST":"GET"){
 const r=await fetch(base+url,{method,headers:{"x-fixture-user":String(user),...(body instanceof FormData?{}:body?{"Content-Type":"application/json"}:{})},body:body?body instanceof FormData?body:JSON.stringify(body):undefined});
 return{status:r.status,data:r.headers.get("content-type")?.includes("application/json")?await r.json():Buffer.from(await r.arrayBuffer())};
}
let count=0;
const send=(user,room,text,extra={})=>req(user,`/conversations/${encodeURIComponent(room)}/messages`,{text,clientId:"fixture-"+String(++count).padStart(8,"0"),...extra});
try{
 assert.equal((await req(0,"/conversations")).status,401);
 const admin=(await req(1,"/conversations")).data;
 assert.deepEqual(admin.conversations.map(c=>c.id),["sales","sales-followup"]);
 assert.equal(admin.users.length,4,"inactive user excluded");
 assert.deepEqual((await req(4,"/conversations")).data.conversations.map(c=>c.id),["sales-followup"]);
 assert.equal((await req(4,"/conversations/sales/messages")).status,404);
 assert.deepEqual((await req(5,"/conversations")).data.conversations,[]);
 assert.equal((await req(2,"/conversations",{userId:2})).status,400);
 assert.equal((await req(2,"/conversations",{userId:6})).status,400);
 const dm=(await req(2,"/conversations",{userId:3})).data;
 assert.equal(dm.id,"dm:2:3");
 assert.equal((await req(3,"/conversations",{userId:2})).data.id,dm.id);
 const privateMsg=await send(2,dm.id,"پیام خصوصی آزمایشی");
 assert.equal(privateMsg.status,200);assert.equal(privateMsg.data.senderId,2);
 assert.equal((await req(1,`/messages/${privateMsg.data.id}`)).status,404);
 assert.equal((await req(1,`/conversations/${dm.id}/messages`)).status,404,"even admin cannot read other DMs");
 assert.equal((await req(3,"/conversations")).data.unreadCount,1);
 await req(3,`/conversations/${dm.id}/read`,{lastMessageId:privateMsg.data.id});
 assert.equal((await req(3,"/conversations")).data.unreadCount,0);
 const sales=await send(2,"sales","سلام 👋");
 const same=await send(2,"sales","تلاش تکراری",{clientId:"stable-retry-123"});
 const retry=await send(2,"sales","تلاش تکراری",{clientId:"stable-retry-123"});
 assert.equal(same.data.id,retry.data.id);
 assert.equal((await send(2,"sales","متفاوت",{clientId:"stable-retry-123"})).status,409);
 assert.equal((await send(2,"sales","پاسخ",{replyToId:String(sales.data.id)})).data.replyTo.id,sales.data.id);
 assert.equal((await send(2,"sales","پاسخ اشتباه",{replyToId:String(privateMsg.data.id)})).status,400);
 assert.equal((await req(3,`/messages/${sales.data.id}`,{text:"تغییر غیرمجاز"},"PATCH")).status,403);
 assert.equal((await req(2,`/messages/${sales.data.id}`,{text:"سلام ویرایش‌شده"},"PATCH")).data.text,"سلام ویرایش‌شده");
 assert.equal((await req(3,`/messages/${sales.data.id}/reactions`,{emoji:"👍"},"PUT")).data.reactions[0].count,1);
 assert.equal((await req(3,`/messages/${sales.data.id}/reactions`,{emoji:"👍"},"PUT")).data.reactions.length,0);
 assert.equal((await req(3,"/conversations/sales/messages?q="+encodeURIComponent("ویرایش"))).data.messages.length,1);
 assert.equal((await req(3,"/conversations/sales/read",{lastMessageId:privateMsg.data.id})).status,400);
 await req(2,"/conversations/sales/typing",{typing:true});
 assert.equal((await req(3,"/conversations/sales/messages")).data.typingUsers[0].id,2);
 const form=new FormData();form.set("clientId","file-send-1234");form.set("text","فایل خصوصی");
 form.set("file",new Blob(["%PDF-1.4\nsynthetic"],{type:"application/pdf"}),"sample.pdf");
 const file=await req(2,"/conversations/sales/messages",form);
 assert.equal(file.status,200);assert(file.data.fileUrl);
 assert.equal((await req(4,`/messages/${file.data.id}/file`)).status,404);
 assert.equal((await req(3,`/messages/${file.data.id}/file`)).data.toString(),"%PDF-1.4\nsynthetic");
 db.prepare("UPDATE users SET role='registrar' WHERE id=3").run();
 assert.equal((await req(3,`/messages/${file.data.id}/file`)).status,404,"role changes revoke group file access");
 db.prepare("UPDATE users SET role='salesperson' WHERE id=3").run();
 const bad=new FormData();bad.set("clientId","file-bad-12345");bad.set("file",new Blob(["<script>bad</script>"],{type:"image/png"}),"wrong.png");
 assert.equal((await req(2,"/conversations/sales/messages",bad)).status,400);
 const wav=Buffer.alloc(48);wav.write("RIFF");wav.write("WAVE",8);
 const audio=new FormData();audio.set("clientId","voice-send-1234");audio.set("file",new Blob([wav],{type:"audio/wav"}),"voice.wav");
 assert.equal((await req(2,"/conversations/sales/messages",audio)).data.kind,"audio");
 assert.equal((await req(3,`/messages/${file.data.id}`,undefined,"DELETE")).status,403);
 assert.equal((await req(2,`/messages/${file.data.id}`,undefined,"DELETE")).data.kind,"deleted");
 assert.equal((await req(2,`/messages/${file.data.id}/file`)).status,404);assert.equal(files.size,1);
 assert.equal((await req(2,`/messages/${file.data.id}`,undefined,"DELETE")).status,200);
 assert.equal((await req(2,`/messages/${file.data.id}`,{text:"بازگردانی"},"PATCH")).status,400);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM internal_chat_directs").get().n,1);
 console.log("PASS real internal-chat router: role-based groups, private DM isolation including admin, active users, sender identity, stable retry, reply boundaries, search, typing, own edit/delete, reactions, private file bytes, role revocation, MIME validation, audio, unread/read receipts");
}finally{server.close();if(!process.argv.includes("--serve"))db.close();}
if(process.argv.includes("--serve")){
 serving=true;
 // Clear test traffic; create just two unread group messages for the UI run.
 db.exec("DELETE FROM internal_chat_messages; DELETE FROM internal_chat_reads; DELETE FROM internal_chat_directs; DELETE FROM internal_chat_reactions; DELETE FROM internal_chat_typing;");
 const put=db.prepare("INSERT INTO internal_chat_messages(conversation_id,sender_id,sender_name,text,kind,client_id,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)");
 put.run("sales",2,"فروش آزمایشی الف","سلام تیم فروش؛ پیام آزمایشی","text","seed-sales-1","seed",new Date().toISOString());
 put.run("sales-followup",4,"ثبت آزمایشی","پیگیری پرونده آزمایشی آماده است","text","seed-followup-1","seed",new Date().toISOString());
 app.use("/api",(_req,res)=>res.status(404).json({error:"synthetic_route_not_implemented"}));
 const publicDir=path.resolve(process.env.INTERNAL_CHAT_FIXTURE_PUBLIC??"artifacts/crm-dashboard/dist/public");
 app.use(express.static(publicDir));app.use((_req,res)=>res.sendFile(path.join(publicDir,"index.html")));
 app.listen(5605,"0.0.0.0",()=>console.log("Synthetic internal chat ready on 5605"));
}
