import { Router, type Request, type Response } from "express";
import { customerSearchSql } from "../lib/customer-id-search";
import multer from "multer";
import { createHash } from "node:crypto";
import { customerPortalSession, requireCustomerPortal } from "../lib/customer-portal-auth";
import { crmDb,execute,executeChanges,queryRow,queryRows,runImmediateTransaction } from "../lib/crm-db";
import { chatReadMarkerSql, findCustomerChatRetry, markCustomerChatRead } from "../lib/customer-chat-history";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { saveChatObject,readChatObject,deleteChatObject,validateChatFile } from "../lib/chat-storage";
import "../lib/customer-chat-schema";
export const customerChatRouter=Router(),staffChatRouter=Router();
customerChatRouter.use(requireCustomerPortal);
staffChatRouter.use(requirePermission("customers.view"));
for(const router of [customerChatRouter,staffChatRouter])router.use((_req,res,next)=>{
  res.setHeader("Cache-Control","no-store");next();
});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:16*1024*1024,files:1,fields:4}});
type Message={id:number;customer_id:number;origin_customer_id:number;sender_type:string;sender_id:number;sender_name:string;text:string;kind:string;object_path:string|null;file_name:string|null;mime_type:string|null;file_size:number|null;client_id:string;content_hash:string|null;created_at:string};
const uploadsInFlight=new Map<string,number>();let totalUploads=0;
function actor(res:Response,customerMode:boolean) {
  return customerMode ? {type:"customer",id:customerPortalSession(res)?.customerId??0} :
    {type:"staff",id:(res.locals.authUser as AuthUser).id};
}
function customerId(req:Request,res:Response,customerMode:boolean):number|null {
  const id=customerMode?customerPortalSession(res)?.customerId:Number(req.params.customerId);
  const owner=customerMode?{where:"",params:[]}:scope(res.locals.authUser as AuthUser);
  if (!id || !Number.isSafeInteger(id) || !queryRow(`SELECT c.id FROM customers c
    WHERE c.id=? AND c.merged_into_customer_id IS NULL ${owner.where}`,[id,...owner.params])) {
    res.status(404).json({error:"chat_customer_not_found",message:"گفت‌وگو در دسترس نیست."});return null;
  } return id;
}
function messageView(m:Message,customerMode:boolean) {
  return {id:Number(m.id),customerId:Number(m.customer_id),senderType:m.sender_type,...(customerMode?{}:{senderId:Number(m.sender_id)}),senderName:m.sender_name,
    text:m.text,kind:m.kind,fileName:m.file_name,mimeType:m.mime_type,fileSize:m.file_size,
    fileUrl:m.object_path?`${customerMode?"/api/customer-portal/chat":"/api/chat"}/messages/${m.id}/file`:null,
    createdAt:m.created_at,clientId:m.client_id};
}
function unread(id:number,res:Response,mode:boolean) {
  const a=actor(res,mode);
  return Number(queryRow<{n:number}>(`SELECT COUNT(*) n FROM customer_chat_history m WHERE customer_id=?
    AND sender_type<>? AND id>${chatReadMarkerSql}`,
    [id,a.type,a.type,a.id])?.n??0);
}
function online(type:string,id:number|null|undefined) {
  return !!id && !!queryRow("SELECT 1 FROM customer_chat_presence WHERE actor_type=? AND actor_id=? AND last_seen>?",
    [type,id,new Date(Date.now()-45_000).toISOString()]);
}
const scope = (user:AuthUser) => ({where:user.customerScope==="assigned"?"AND c.salesperson_id=?":"",
  params:user.customerScope==="assigned"?[user.salespersonId]:[]});
customerChatRouter.get("/chat/thread", (req,res)=>{
  const id=customerId(req,res,true);if(!id)return;
  const expert=queryRow<{name:string;id:number}>(`SELECT s.name,u.id FROM customers c JOIN salespersons s ON s.id=c.salesperson_id
    JOIN users u ON u.salesperson_id=s.id AND u.active=1 WHERE c.id=? AND s.active=1 ORDER BY u.id LIMIT 1`,[id]);
  res.setHeader("Cache-Control","no-store");
  res.json({customerId:id,expertName:expert?.name??"کارشناس فروش",expertOnline:online("staff",expert?.id),unreadCount:unread(id,res,true)});
});
staffChatRouter.get("/threads",(req,res)=>{
  const user=res.locals.authUser as AuthUser,owner=scope(user),q=String(req.query.q??"").trim().slice(0,100);
  const cursor=req.query.cursor?String(req.query.cursor).split(":").map(Number):null;
  if(cursor&&(cursor.length!==2||cursor.some(n=>!Number.isSafeInteger(n)||n<0)||cursor[1]<=0)){res.status(400).json({error:"invalid_cursor"});return;}
  const idSearch=q?customerSearchSql(q):null;
  const escaped=(idSearch?.text??q).replace(/[\\%_]/g,"\\$&");
  const textCond="(crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')";
  const qClause=idSearch?idSearch.where(textCond,[`%${escaped}%`,`%${escaped}%`],"c.id"):null;
  const idRank=idSearch?.orderPrefix("id")??{sql:"",params:[]};
  const list=queryRows<{id:number;name:string;phone:string;last_message_id:number}>(`WITH conversations AS (
    SELECT c.id,c.name,c.phone,COALESCE((SELECT MAX(m.id) FROM customer_chat_history m WHERE m.customer_id=c.id),0) last_message_id FROM customers c
    WHERE c.merged_into_customer_id IS NULL ${owner.where}
    ${qClause?`AND ${qClause.sql}`:""}
    ) SELECT * FROM conversations ${cursor?`WHERE (last_message_id<? OR (last_message_id=? AND id<?))${idSearch?.idQuery?" AND id<>?":""}`:""}
    ORDER BY ${cursor?"":idRank.sql}last_message_id DESC,id DESC LIMIT 51`,[...owner.params,...(qClause?.params??[]),...(cursor?[cursor[0],cursor[0],cursor[1],...(idSearch?.idQuery?[idSearch.idQuery.id]:[])]:[]),...(cursor?[]:idRank.params)]);
  const items=list.slice(0,50).map(c=>{
    const last=queryRow<Message>("SELECT * FROM customer_chat_history WHERE customer_id=? ORDER BY id DESC LIMIT 1",[c.id]);
    return {customerId:Number(c.id),name:c.name,mobile:c.phone,online:online("customer",c.id),
      lastMessage:last?.text||last?.file_name||null,lastMessageAt:last?.created_at??null,unreadCount:unread(c.id,res,false)};
  });
  res.setHeader("Cache-Control","no-store");res.json({items,nextCursor:list.length>50?`${list[49].last_message_id}:${list[49].id}`:null});
});
staffChatRouter.get("/unread-count",(req,res)=>{
  const user=res.locals.authUser as AuthUser,owner=scope(user);
  const row=queryRow<{n:number}>(`SELECT COUNT(*) n FROM customer_chat_history m JOIN customers c ON c.id=m.customer_id
    WHERE c.merged_into_customer_id IS NULL ${owner.where} AND m.sender_type='customer'
    AND m.id>${chatReadMarkerSql}`,
    [...owner.params,"staff",user.id]);res.setHeader("Cache-Control","no-store");res.json({count:Number(row?.n??0)});
});
for(const [router,mode,prefix] of [[customerChatRouter,true,"/chat"],[staffChatRouter,false,""]] as const){
  router.use((_req,res,next)=>{res.setHeader("Cache-Control","no-store");next();});
  // Keep already-open customer pages working while they still use the old URL.
  const presencePaths = mode ? [`${prefix}/presence`, "/presence"] : `${prefix}/presence`;
  router.post(presencePaths,(_req,res)=>{
    const a=actor(res,mode);if(!a.id){res.status(403).json({error:"customer_required"});return;}
    executeChanges("INSERT INTO customer_chat_presence(actor_type,actor_id,last_seen) VALUES(?,?,?) ON CONFLICT(actor_type,actor_id) DO UPDATE SET last_seen=excluded.last_seen",
      [a.type,a.id,new Date().toISOString()]);res.json({ok:true});
  });
  const thread=mode?prefix:`${prefix}/:customerId`;
  router.get(`${thread}/messages`,(req,res)=>{
    const id=customerId(req,res,mode);if(!id)return;
    const before=req.query.beforeId?Number(req.query.beforeId):null;
    if(before!=null&&(!Number.isSafeInteger(before)||before<=0)){res.status(400).json({error:"invalid_cursor"});return;}
    const found=queryRows<Message>(`SELECT * FROM customer_chat_history WHERE customer_id=? ${before?"AND id<?":""} ORDER BY id DESC LIMIT 41`,before?[id,before]:[id]);
    const a=actor(res,mode);
    // The public scalar cursor is conservative: it cannot hide an unread hole
    // from an older merged conversation behind another thread's watermark.
    const firstUnread=queryRow<{id:number}>(`SELECT MIN(m.id) id FROM customer_chat_history m
      WHERE customer_id=? AND sender_type<>? AND id>${chatReadMarkerSql}`,[id,a.type,a.type,a.id]);
    const lastReadId=firstUnread?.id!=null?Number(firstUnread.id)-1:
      Number(queryRow<{id:number}>("SELECT MAX(id) id FROM customer_chat_history WHERE customer_id=?",[id])?.id??0);
    res.json({items:found.slice(0,40).reverse().map(m=>messageView(m,mode)),nextCursor:found.length>40?String(found[39].id):null,
      lastReadId});
  });
  router.post(`${thread}/read`,(req,res)=>{
    const id=customerId(req,res,mode);if(!id)return;
    const last=Number(req.body?.lastMessageId),a=actor(res,mode);
    if(!Number.isSafeInteger(last)||last<=0||!queryRow("SELECT 1 FROM customer_chat_history WHERE id=? AND customer_id=?",[last,id])){res.status(400).json({error:"invalid_read_marker"});return;}
    runImmediateTransaction(()=>markCustomerChatRead(crmDb,id,a.type,a.id,last));
    res.json({ok:true});
  });
  router.post(`${thread}/messages`,(req,res,next)=>{
    if(!customerId(req,res,mode))return;
    const a=actor(res,mode),key=`${a.type}:${a.id}`,current=uploadsInFlight.get(key)??0;
    if(current>=2||totalUploads>=8){res.status(429).json({error:"chat_busy",message:"کمی صبر کنید و دوباره ارسال کنید."});return;}
    uploadsInFlight.set(key,current+1);totalUploads++;
    let released=false;
    const release=()=>{if(released)return;released=true;totalUploads--;const n=(uploadsInFlight.get(key)??1)-1;if(n)uploadsInFlight.set(key,n);else uploadsInFlight.delete(key);};
    res.once("finish",release);res.once("close",release);
    upload.single("file")(req,res,error=>{if(error){res.status(400).json({error:"invalid_chat_upload",message:"فایل مجاز نیست یا بیش از ۱۶ مگابایت است."});return;}next();});
  },async(req,res):Promise<void>=>{
    const id=customerId(req,res,mode);if(!id)return;
    const a=actor(res,mode),clientId=req.body?.clientId,text=typeof req.body?.text==="string"?req.body.text.trim():"";
    if(typeof clientId!=="string"||!/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)||(!text&&!req.file)||
      Object.keys(req.body??{}).some(k=>!["clientId","text"].includes(k))){
      res.status(400).json({error:"invalid_chat_message",message:"متن یا فایل پیام معتبر نیست."});return;
    }
    const hash=createHash("sha256").update(text).update("\0").update(req.file?.mimetype??"").update(req.file?.buffer??"").digest("hex");
    try {
      const prior=findCustomerChatRetry<Message>(crmDb,id,a.type,a.id,clientId,text,hash,!req.file);
      if(prior){res.json(messageView(prior,mode));return;}
    } catch(error) {
      if(!(error instanceof Error)||error.message!=="chat_idempotency_conflict")throw error;
      res.status(409).json({error:"chat_idempotency_conflict"});return;
    }
    const recent=queryRow<{n:number}>("SELECT COUNT(*) n FROM customer_chat_messages WHERE sender_type=? AND sender_id=? AND created_at>?",[a.type,a.id,new Date(Date.now()-60000).toISOString()]);
    if(Number(recent?.n??0)>=40){res.status(429).json({error:"chat_rate_limit",message:"لطفاً کمی صبر کنید."});return;}
    let path:string|null=null;
    try{
      const file=req.file,meta=file?validateChatFile(file):null;
      if(file)path=await saveChatObject(file.buffer,meta!.mime);
      const message=runImmediateTransaction(()=>{
        // Reauthorize after uploading; ownership may change while awaiting GCS.
        if(customerId(req,res,mode)!==id)throw new Error("chat_access_changed");
        const repeated=findCustomerChatRetry<Message>(crmDb,id,a.type,a.id,clientId,text,hash,!req.file);
        if(repeated)return repeated;
        const name=mode?queryRow<{name:string}>("SELECT name FROM customers WHERE id=?",[id])?.name:
          (res.locals.authUser as AuthUser).fullName;
        const messageId=execute(`INSERT INTO customer_chat_messages(customer_id,sender_type,sender_id,sender_name,text,kind,object_path,file_name,mime_type,file_size,client_id,content_hash,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,a.type,a.id,name||"کارشناس",text,meta?.kind??"text",path,
          file?file.originalname.replace(/[\\/\u0000-\u001f]/g,"_").slice(0,200):null,meta?.mime??null,file?.size??null,clientId,hash,new Date().toISOString()]);
        return queryRow<Message>("SELECT * FROM customer_chat_history WHERE id=?",[messageId])!;
      });
      if(path&&message.object_path!==path)await deleteChatObject(path);
      res.status(201).json(messageView(message,mode));
    }catch(error){
      if(path)await deleteChatObject(path).catch(()=>{});
      if(!res.headersSent){
        const code=error instanceof Error?error.message:"";
        res.status(code==="chat_idempotency_conflict"?409:code==="unsupported_chat_file"?400:502)
          .json({error:code==="unsupported_chat_file"?code:"chat_send_failed",message:code==="unsupported_chat_file"?"قالب فایل پشتیبانی نمی‌شود؛ تصویر، PDF، Word یا فایل صوتی معتبر ارسال کنید.":"ارسال انجام نشد؛ با همان پیام دوباره تلاش کنید."});
      }
      req.log.error({errorType:error instanceof Error?error.name:"unknown"},"chat send failed");
    }
  });
  router.get(`${prefix}/messages/:messageId/file`,(req,res)=>{
    const id=Number(req.params.messageId);
    const m=Number.isSafeInteger(id)?queryRow<Message>("SELECT * FROM customer_chat_history WHERE id=?",[id]):null;
    if(!m?.object_path){res.status(404).end();return;}
    (req.params as Record<string,string>).customerId=String(m.customer_id);
    const own=customerId(req,res,mode);if(!own)return;
    if(own!==m.customer_id){res.status(404).end();return;}
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Content-Type",m.mime_type??"application/octet-stream");
    res.setHeader("Content-Disposition",`${["image","audio"].includes(m.kind)?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(m.file_name??"file")}`);
    readChatObject(m.object_path).on("error",error=>{req.log.error({errorType:error.name},"chat attachment read failed");if(!res.headersSent)res.status(502).end();else res.destroy();}).pipe(res);
  });
}
