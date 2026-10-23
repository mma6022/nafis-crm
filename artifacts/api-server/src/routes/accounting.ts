import { Router, type RequestHandler } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { executeChanges, queryRow, queryRows, runTransaction } from "../lib/crm-db";
import {
  ensureAccountingSchema, AccountingError, accountingFileRoot, amount, validDate, tehranDate,
  accountingScope, documentRow, documentView, postDocument, fingerprint, attachmentPath, counterpartyAccount,
} from "../lib/accounting";

ensureAccountingSchema();
const router = Router();
const actor = (res: import("express").Response) => res.locals.authUser as AuthUser;
const id = (value: unknown) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new AccountingError(400,"شناسه معتبر نیست.");
  return n;
};
const handler = (fn: RequestHandler): RequestHandler => (req,res,next) => {
  try { return fn(req,res,next); }
  catch(error) {
    if (!(error instanceof AccountingError)) return next(error);
    return res.status(error.status).json({error:error.message});
  }
};
router.use("/accounting", (_req,res,next) => { res.setHeader("Cache-Control","private, no-store"); next(); });
router.get("/accounting/funds", requirePermission("accounting.view"), handler((_req,res) => {
  const items = queryRows<any>(`SELECT b.*,COALESCE(f.balance_toman,'0') balance,COALESCE(f.initialized,0) initialized
    FROM finance_bank_accounts b LEFT JOIN accounting_funds f ON f.fund_id=b.id ORDER BY b.id DESC`);
  res.json({items:items.map(b=>({id:b.id,bankName:b.bank_name,ownerName:b.owner_name,fundName:b.fund_name,
    iban:b.iban,balanceToman:b.balance,initialized:!!b.initialized}))});
}));
router.post("/accounting/funds/:id/opening", requirePermission("accounting.opening"), handler((req,res) => {
  const fundId = id(req.params.id), value = amount(req.body?.amountToman,true), u = actor(res);
  const key = `opening:${fundId}`;
  const hash = fingerprint({fundId,amount:value.toString()});
  const docId = runTransaction(()=>postDocument({fundId,amount:value,documentDate:tehranDate(),transactionDate:tehranDate(),
    purpose:"موجودی اول دوره صندوق",documentType:"credit",transactionType:"deposit",source:"opening",
    requestKey:key,requestHash:hash,actorId:u.id}));
  res.status(201).json(documentView(documentRow(docId,u)));
}));
router.get("/accounting/documents", requirePermission("accounting.view"), handler((req,res) => {
  const page = id(req.query.page ?? 1);
  if (page > 100000) throw new AccountingError(400,"شماره صفحه معتبر نیست.");
  const scope = accountingScope(actor(res));
  let where = `WHERE 1=1${scope.sql}`;
  const params: Array<string | number> = [...scope.params];
  if (req.query.fundId !== undefined) { where += " AND d.fund_id=?"; params.push(id(req.query.fundId)); }
  for (const key of ["from","to"] as const) {
    const value = req.query[key];
    if (value === undefined) continue;
    if (!validDate(value)) throw new AccountingError(400,"بازه تاریخ معتبر نیست.");
    where += ` AND d.transaction_date${key==="from"?">=":"<="}?`; params.push(value);
  }
  if (req.query.from && req.query.to && String(req.query.from)>String(req.query.to)) throw new AccountingError(400,"شروع بازه باید قبل از پایان باشد.");
  const total = queryRow<{ n: number }>(`SELECT COUNT(*) n FROM accounting_documents d ${where}`,params)!.n;
  const rows = queryRows<any>(`SELECT d.*,b.fund_name,COALESCE(u.full_name,u.username) actor_name FROM accounting_documents d
    JOIN finance_bank_accounts b ON b.id=d.fund_id JOIN users u ON u.id=d.created_by ${where}
    ORDER BY d.id DESC LIMIT 20 OFFSET ?`, [...params,(page-1)*20]);
  res.json({items:rows.map(documentView),total,page,limit:20});
}));
router.get("/accounting/documents/:id", requirePermission("accounting.view"), handler((req,res) => {
  const row = documentRow(id(req.params.id),actor(res));
  if (!row) throw new AccountingError(404,"سند یافت نشد.");
  res.json(documentView(row));
}));
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:10,fields:15,fieldSize:5000}});
const receive: RequestHandler = (req,res,next) => upload.array("files",10)(req,res,error=>{
  if (error) { res.status(400).json({error:"پیوست معتبر نیست؛ حداکثر ۱۰ فایل و هر فایل تا ۸ مگابایت مجاز است."}); return; }
  next();
});
type FileData = { name:string; mime:string; ext:string; size:number; sha256:string; buffer:Buffer };
function filesFor(req: import("express").Request): FileData[] {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.reduce((sum,f)=>sum+f.size,0) > 16*1024*1024) throw new AccountingError(400,"مجموع حجم پیوست‌ها نباید بیش از ۱۶ مگابایت باشد.");
  const unique = new Map<string, FileData>();
  for (const f of files) {
    const b = f.buffer;
    const type = b.subarray(0,5).toString()==="%PDF-" ? ["application/pdf","pdf"]
      : b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? ["image/png","png"]
      : b[0]===255 && b[1]===216 && b[2]===255 ? ["image/jpeg","jpg"]
      : b.length>=12 && b.subarray(0,4).toString()==="RIFF" && b.subarray(8,12).toString()==="WEBP" ? ["image/webp","webp"] : null;
    if (!type) throw new AccountingError(400,"فقط عکس JPEG، PNG، WebP و فایل PDF معتبر پذیرفته می‌شود.");
    const decoded = Buffer.from(f.originalname,"latin1").toString("utf8");
    let name = (decoded.includes("\uFFFD") ? f.originalname : decoded).replace(/[\x00-\x1f\x7f/\\]/g,"_").trim().slice(0,170) || "پیوست";
    if (!name.toLowerCase().endsWith(`.${type[1]}`) && !(type[1]==="jpg" && /\.(jpeg|jfif)$/i.test(name))) name += `.${type[1]}`;
    const sha256 = createHash("sha256").update(b).digest("hex");
    unique.set(`${sha256}:${name}`,{name,mime:type[0],ext:type[1],size:f.size,sha256,buffer:b});
  }
  return [...unique.values()];
}
function storeFiles(documentId:number, files:FileData[], actorId:number, written:string[]) {
  const existing = queryRows<{ name:string; sha256:string }>("SELECT name,sha256 FROM accounting_attachments WHERE document_id=?",[documentId]);
  const fresh = files.filter(f=>!existing.some(x=>x.name===f.name && x.sha256===f.sha256));
  if (existing.length+fresh.length>10) throw new AccountingError(400,"هر سند حداکثر ۱۰ پیوست دارد.");
  if (!fresh.length) return;
  fs.mkdirSync(accountingFileRoot,{recursive:true,mode:0o700});
  if (fs.lstatSync(accountingFileRoot).isSymbolicLink()) throw new Error("Invalid accounting storage directory");
  for (const file of fresh) {
    const name = `${randomUUID()}.${file.ext}`, destination = path.join(accountingFileRoot,name);
    fs.writeFileSync(destination,file.buffer,{flag:"wx",mode:0o600}); written.push(destination);
    executeChanges(`INSERT INTO accounting_attachments(document_id,name,mime,size,sha256,stored_name,storage_kind,created_by,created_at)
      VALUES(?,?,?,?,?,?,'accounting',?,?)`,[documentId,file.name,file.mime,file.size,file.sha256,name,actorId,new Date().toISOString()]);
  }
}
function cleanFiles(written:string[]) { for (const file of written) fs.rmSync(file,{force:true}); }
router.post("/accounting/documents", requirePermission("accounting.manage"), receive, handler((req,res) => {
  const u = actor(res), b = req.body;
  const fundId = id(b?.fundId), value = amount(b?.amountToman);
  if (!validDate(b?.documentDate) || !validDate(b?.transactionDate)) throw new AccountingError(400,"تاریخ سند و تاریخ تراکنش معتبر لازم است.");
  if (b.transactionDate > tehranDate()) throw new AccountingError(400,"تاریخ تراکنش نمی‌تواند در آینده باشد.");
  const purpose = typeof b.purpose==="string" ? b.purpose.trim() : "";
  if (!purpose || purpose.length>1000) throw new AccountingError(400,"بابت سند باید بین ۱ تا ۱۰۰۰ نویسه باشد.");
  if (!["credit","debit"].includes(b.documentType) || !["deposit","withdrawal"].includes(b.transactionType))
    throw new AccountingError(400,"نوع سند و نوع تراکنش معتبر لازم است.");
  if (typeof b.requestKey!=="string" || !/^[A-Za-z0-9-]{16,100}$/.test(b.requestKey)) throw new AccountingError(400,"شناسه درخواست معتبر لازم است.");
  const counterparty = counterpartyAccount(b);
  const files = filesFor(req), written:string[] = [];
  const hash = fingerprint({fundId,documentDate:b.documentDate,transactionDate:b.transactionDate,amount:value.toString(),purpose,
    documentType:b.documentType,transactionType:b.transactionType,files:files.map(f=>({name:f.name,sha256:f.sha256})),
    ...(counterparty ? {counterparty} : {})});
  let documentId:number;
  try {
    documentId = runTransaction(()=>{
      const d = postDocument({fundId,documentDate:b.documentDate,transactionDate:b.transactionDate,amount:value,purpose,
        documentType:b.documentType,transactionType:b.transactionType,source:"manual",
         requestKey:`manual:${u.id}:${b.requestKey}`,requestHash:hash,actorId:u.id,counterparty});
      storeFiles(d,files,u.id,written);
      return d;
    });
  } catch(error) { cleanFiles(written); throw error; }
  res.status(201).json(documentView(documentRow(documentId,u)));
}));
router.post("/accounting/documents/:id/attachments", requirePermission("accounting.manage"), receive, handler((req,res) => {
  const u = actor(res), d = documentRow(id(req.params.id),u);
  if (!d) throw new AccountingError(404,"سند یافت نشد.");
  const files = filesFor(req), written:string[] = [];
  if (!files.length) throw new AccountingError(400,"حداقل یک پیوست انتخاب کنید.");
  try { runTransaction(()=>storeFiles(d.id,files,u.id,written)); }
  catch(error) { cleanFiles(written); throw error; }
  res.json(documentView(documentRow(d.id,u)));
}));
router.get("/accounting/documents/:id/attachments/:attachmentId", requirePermission("accounting.view"), handler((req,res) => {
  const doc = documentRow(id(req.params.id),actor(res));
  if (!doc) throw new AccountingError(404,"سند یافت نشد.");
  const file = queryRow<any>("SELECT * FROM accounting_attachments WHERE id=? AND document_id=?", [id(req.params.attachmentId),doc.id]);
  if (!file) throw new AccountingError(404,"پیوست یافت نشد.");
  const filename = file.name.includes(".") ? file.name : `${file.name}${path.extname(file.stored_name)}`;
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Content-Security-Policy","sandbox");
  res.setHeader("Content-Type",file.mime);
  res.setHeader("Content-Disposition",`attachment; filename="attachment${path.extname(file.stored_name)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.sendFile(attachmentPath(file));
}));
export default router;