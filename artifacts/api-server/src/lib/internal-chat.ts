import { Router, type RequestHandler, type Response } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";

type Dependencies = {
  db: DatabaseSync; requireAuth: RequestHandler; requirePermission: RequestHandler;
  saveFile: (bytes: Buffer, mime: string) => Promise<string>;
  readFile: (path: string) => Readable; deleteFile: (path: string) => Promise<unknown>;
  validateFile: (file: Express.Multer.File) => { mime: string; kind: string };
};
type Actor = { id: number; role: string; name: string };
type Message = {
  id: number; conversation_id: string; sender_id: number; sender_name: string; text: string; kind: string;
  object_path: string | null; file_name: string | null; mime_type: string | null; file_size: number | null;
  client_id: string; content_hash: string; created_at: string; edited_at: string | null; deleted_at: string | null; reply_to_id: number | null;
};
const GROUPS = [
  { id: "sales", name: "گروه فروش", roles: ["admin", "salesperson"] },
  { id: "sales-followup", name: "گروه پیگیری فروش", roles: ["admin", "salesperson", "registrar"] },
];
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const idFrom = (v: unknown) => typeof v === "string" && /^[1-9]\d{0,14}$/.test(v) ? Number(v) : NaN;
export function installInternalChat(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS internal_chat_directs(
      conversation_id TEXT PRIMARY KEY,user_low INTEGER NOT NULL,user_high INTEGER NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(user_low,user_high),CHECK(user_low<user_high));
    CREATE TABLE IF NOT EXISTS internal_chat_messages(
      id INTEGER PRIMARY KEY,conversation_id TEXT NOT NULL,sender_id INTEGER NOT NULL,sender_name TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL,object_path TEXT,file_name TEXT,mime_type TEXT,file_size INTEGER,
      client_id TEXT NOT NULL,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,edited_at TEXT,deleted_at TEXT,reply_to_id INTEGER,
      UNIQUE(conversation_id,sender_id,client_id));
    CREATE INDEX IF NOT EXISTS idx_internal_chat_conversation ON internal_chat_messages(conversation_id,id);
    CREATE TABLE IF NOT EXISTS internal_chat_reads(
      conversation_id TEXT NOT NULL,user_id INTEGER NOT NULL,last_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(conversation_id,user_id));
    CREATE TABLE IF NOT EXISTS internal_chat_presence(
      user_id INTEGER PRIMARY KEY,last_seen TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS internal_chat_typing(
      conversation_id TEXT NOT NULL,user_id INTEGER NOT NULL,last_seen TEXT NOT NULL,
      PRIMARY KEY(conversation_id,user_id));
    CREATE TABLE IF NOT EXISTS internal_chat_reactions(
      message_id INTEGER NOT NULL,user_id INTEGER NOT NULL,emoji TEXT NOT NULL,
      PRIMARY KEY(message_id,user_id,emoji));
  `);
}
export function createInternalChatRouter(deps: Dependencies) {
  const { db } = deps;
  installInternalChat(db);
  const router = Router();
  const row = <T>(sql: string, args: (string | number | null)[] = []) => db.prepare(sql).get(...args) as T | undefined;
  const rows = <T>(sql: string, args: (string | number | null)[] = []) => db.prepare(sql).all(...args) as T[];
  const run = (sql: string, args: (string | number | null)[] = []) => db.prepare(sql).run(...args);
  const activeUser = (id: number) => row<Actor>("SELECT id,role,full_name AS name FROM users WHERE id=? AND active=1", [id]);
  function actor(res: Response) {
    const current = activeUser(Number(res.locals.authUser?.id));
    if (!current) throw fail(401, "حساب کاربری فعال نیست.");
    return current;
  }
  function members(conversationId: string, user: Actor) {
    const group = GROUPS.find(g => g.id === conversationId);
    if (group) {
      if (!group.roles.includes(user.role)) throw fail(404, "گفتگو در دسترس نیست.");
      return rows<Actor>(`SELECT id,role,full_name AS name FROM users WHERE active=1 AND role IN (${group.roles.map(() => "?").join(",")}) ORDER BY full_name,id`, group.roles);
    }
    const direct = row<{user_low:number;user_high:number}>("SELECT user_low,user_high FROM internal_chat_directs WHERE conversation_id=?", [conversationId]);
    if (!direct || ![direct.user_low, direct.user_high].includes(user.id)) throw fail(404, "گفتگو در دسترس نیست.");
    const list = [activeUser(direct.user_low), activeUser(direct.user_high)].filter((x): x is Actor => !!x);
    if (list.length !== 2) throw fail(404, "گفتگو در دسترس نیست.");
    return list;
  }
  function userView(u: Actor) {
    return { id: u.id, name: u.name, role: u.role, online: !!row("SELECT 1 FROM internal_chat_presence WHERE user_id=? AND last_seen>?", [u.id, new Date(Date.now() - 45_000).toISOString()]) };
  }
  function messageView(m: Message, user: Actor) {
    const allowed = members(m.conversation_id, user).map(x => x.id);
    const reply = m.reply_to_id ? row<Message>("SELECT * FROM internal_chat_messages WHERE id=? AND conversation_id=?", [m.reply_to_id, m.conversation_id]) : undefined;
    return {
      id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, senderName: m.sender_name,
      text: m.deleted_at ? "" : m.text, kind: m.deleted_at ? "deleted" : m.kind,
      fileName: m.deleted_at ? null : m.file_name, mimeType: m.deleted_at ? null : m.mime_type, fileSize: m.deleted_at ? null : m.file_size,
      fileUrl: !m.deleted_at && m.object_path ? `/api/internal-chat/messages/${m.id}/file` : null,
      clientId: m.client_id, createdAt: m.created_at, editedAt: m.edited_at, deletedAt: m.deleted_at,
      replyTo: reply ? { id: reply.id, text: reply.deleted_at ? "پیام حذف شده" : reply.text || reply.file_name || "پیوست", senderName: reply.sender_name } : null,
      readBy: rows<{user_id:number}>("SELECT user_id FROM internal_chat_reads WHERE conversation_id=? AND last_message_id>=? AND user_id<>?", [m.conversation_id, m.id, m.sender_id]).map(x => x.user_id).filter(id => allowed.includes(id)),
      reactions: m.deleted_at ? [] : rows<{emoji:string;count:number;mine:number}>("SELECT emoji,COUNT(*) AS count,MAX(user_id=?) AS mine FROM internal_chat_reactions WHERE message_id=? GROUP BY emoji ORDER BY MIN(rowid)", [user.id, m.id]).map(x => ({ ...x, mine: !!x.mine })),
    };
  }
  function unread(id: string, user: Actor) {
    return row<{n:number}>(`SELECT COUNT(*) AS n FROM internal_chat_messages WHERE conversation_id=? AND sender_id<>? AND deleted_at IS NULL
      AND id>COALESCE((SELECT last_message_id FROM internal_chat_reads WHERE conversation_id=? AND user_id=?),0)`, [id, user.id, id, user.id])?.n ?? 0;
  }
  function conversationView(id: string, user: Actor) {
    const list = members(id, user), group = GROUPS.find(g => g.id === id);
    const last = row<Message>("SELECT * FROM internal_chat_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1", [id]);
    return { id, name: group?.name ?? list.find(u => u.id !== user.id)!.name, kind: group ? "group" : "direct",
      members: list.map(userView), unreadCount: unread(id, user), lastMessage: last ? messageView(last, user) : null };
  }
  function getMessage(id: unknown, user: Actor) {
    const m = row<Message>("SELECT * FROM internal_chat_messages WHERE id=?", [idFrom(id)]);
    if (!m) throw fail(404, "پیام در دسترس نیست.");
    members(m.conversation_id, user); return m;
  }
  router.use(deps.requireAuth, deps.requirePermission, (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store"); next();
  });
  router.get("/conversations", (_req, res) => {
    const user = actor(res);
    run("INSERT INTO internal_chat_presence VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen=excluded.last_seen", [user.id, new Date().toISOString()]);
    const ids = GROUPS.filter(g => g.roles.includes(user.role)).map(g => g.id);
    const directs = rows<{conversation_id:string}>("SELECT conversation_id FROM internal_chat_directs WHERE user_low=? OR user_high=?", [user.id, user.id]);
    for (const direct of directs) { try { members(direct.conversation_id, user); ids.push(direct.conversation_id); } catch { /* disabled peers are not available */ } }
    const conversations = ids.map(id => conversationView(id, user)).sort((a,b) => (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0));
    res.json({ myId: user.id, conversations, users: rows<Actor>("SELECT id,role,full_name AS name FROM users WHERE active=1 AND id<>? ORDER BY full_name,id", [user.id]).map(userView),
      unreadCount: conversations.reduce((n, c) => n + c.unreadCount, 0) });
  });
  router.post("/conversations", (req, res) => {
    const user = actor(res), otherId = req.body?.userId;
    if (!positive(otherId) || otherId === user.id || !activeUser(otherId)) throw fail(400, "کاربر مقصد معتبر نیست.");
    const [lo, hi] = [user.id, otherId].sort((a,b) => a-b), id = `dm:${lo}:${hi}`;
    run("INSERT OR IGNORE INTO internal_chat_directs VALUES(?,?,?,?)", [id, lo, hi, new Date().toISOString()]);
    res.json(conversationView(id, user));
  });
  router.get("/conversations/:conversationId/messages", (req, res) => {
    const user = actor(res), id = String(req.params.conversationId); members(id, user);
    if (req.query.beforeId !== undefined && !Number.isSafeInteger(idFrom(req.query.beforeId))) throw fail(400, "نشانگر پیام معتبر نیست.");
    if (req.query.q !== undefined && typeof req.query.q !== "string") throw fail(400, "جستجو معتبر نیست.");
    const q = String(req.query.q ?? "").trim().slice(0, 100), args: (string | number)[] = [id];
    let condition = "";
    if (req.query.beforeId) { condition += " AND id<?"; args.push(idFrom(req.query.beforeId)); }
    if (q) { condition += " AND deleted_at IS NULL AND (text LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\')"; const term = `%${q.replace(/[\\%_]/g, "\\$&")}%`; args.push(term, term); }
    const page = rows<Message>(`SELECT * FROM internal_chat_messages WHERE conversation_id=?${condition} ORDER BY id DESC LIMIT 61`, args);
    const allowed = members(id, user).map(x => x.id);
    const typing = rows<Actor>(`SELECT u.id,u.role,u.full_name AS name FROM internal_chat_typing t JOIN users u ON u.id=t.user_id
      WHERE t.conversation_id=? AND t.user_id<>? AND t.last_seen>? AND u.active=1`, [id, user.id, new Date(Date.now()-6500).toISOString()]).filter(u => allowed.includes(u.id));
    res.json({ messages: page.slice(0,60).reverse().map(m => messageView(m,user)), hasMore: page.length > 60, typingUsers: typing.map(userView) });
  });
  const inFlight = new Map<number, number>(); let totalUploads = 0;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20*1024*1024, files: 1, fields: 3, fieldSize: 40_000 } });
  router.post("/conversations/:conversationId/messages", (req, res, next) => {
    try {
      const user = actor(res); members(String(req.params.conversationId), user);
      if ((inFlight.get(user.id) ?? 0) >= 2 || totalUploads >= 8) throw fail(429, "چند ارسال در حال انجام است؛ کمی صبر کنید.");
      inFlight.set(user.id, (inFlight.get(user.id) ?? 0)+1); totalUploads++;
      let released = false;
      const release = () => { if (released) return; released=true; inFlight.set(user.id, Math.max(0,(inFlight.get(user.id)??1)-1)); totalUploads--; };
      res.once("finish", release); res.once("close", release);
      upload.single("file")(req,res,error => error ? next(fail(400, error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? "حداکثر حجم فایل ۲۰ مگابایت است." : "بارگذاری فایل معتبر نیست.")) : next());
    } catch (error) { next(error); }
  }, async (req,res,next) => {
    let saved: string | undefined;
    try {
      const user = actor(res), id = String(req.params.conversationId); members(id,user);
      const text = req.body?.text ?? "", clientId = req.body?.clientId, replyToId = req.body?.replyToId ? idFrom(req.body.replyToId) : null;
      if (typeof text !== "string" || text.length > 8000 || typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientId) || (!text.trim() && !req.file)) throw fail(400, "متن یا شناسه ارسال معتبر نیست.");
      if (replyToId !== null && (!Number.isSafeInteger(replyToId) || !row("SELECT 1 FROM internal_chat_messages WHERE id=? AND conversation_id=?", [replyToId, id]))) throw fail(400, "پیام پاسخ در این گفتگو نیست.");
      const info = req.file ? deps.validateFile(req.file) : null;
      const hash = createHash("sha256").update(JSON.stringify([text,replyToId,info?.mime,req.file?.originalname])).update(req.file?.buffer ?? "").digest("hex");
      const retry = row<Message>("SELECT * FROM internal_chat_messages WHERE conversation_id=? AND sender_id=? AND client_id=?", [id,user.id,clientId]);
      if (retry) {
        if (retry.content_hash !== hash) throw fail(409, "این شناسه قبلاً برای پیام دیگری استفاده شده است.");
        res.json(messageView(retry,user)); return;
      }
      if (req.file && info) saved = await deps.saveFile(req.file.buffer,info.mime);
      // Recheck role/active membership after asynchronous storage, before committing.
      const liveUser = actor(res); members(id,liveUser);
      const concurrent = row<Message>("SELECT * FROM internal_chat_messages WHERE conversation_id=? AND sender_id=? AND client_id=?", [id,user.id,clientId]);
      if (concurrent) {
        if (concurrent.content_hash !== hash) throw fail(409,"ارسال هم‌زمان با محتوای متفاوت است.");
        if (saved) { await deps.deleteFile(saved); saved = undefined; }
        res.json(messageView(concurrent,liveUser)); return;
      }
      const result = run(`INSERT INTO internal_chat_messages(conversation_id,sender_id,sender_name,text,kind,object_path,file_name,mime_type,file_size,client_id,content_hash,created_at,reply_to_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id,user.id,user.name,text,info?.kind ?? "text",saved??null,req.file?.originalname?.replace(/[\u0000-\u001f\\/]/g,"_").slice(0,200)??null,info?.mime??null,req.file?.size??null,clientId,hash,new Date().toISOString(),replyToId]);
      saved = undefined;
      res.json(messageView(row<Message>("SELECT * FROM internal_chat_messages WHERE id=?", [Number(result.lastInsertRowid)])!,liveUser));
    } catch (error) {
      if (saved) { try { await deps.deleteFile(saved); } catch { /* private orphan is never exposed */ } }
      next(error);
    }
  });
  router.post("/conversations/:conversationId/read", (req,res) => {
    const user=actor(res),id=String(req.params.conversationId), last=req.body?.lastMessageId; members(id,user);
    if (!positive(last) || !row("SELECT 1 FROM internal_chat_messages WHERE id=? AND conversation_id=?", [last,id])) throw fail(400,"پیام خوانده‌شده معتبر نیست.");
    run(`INSERT INTO internal_chat_reads VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE
      SET last_message_id=MAX(last_message_id,excluded.last_message_id)`,[id,user.id,last]);
    res.json({ok:true});
  });
  router.post("/conversations/:conversationId/typing",(req,res)=>{
    const user=actor(res),id=String(req.params.conversationId); members(id,user);
    if (typeof req.body?.typing!=="boolean") throw fail(400,"وضعیت نوشتن معتبر نیست.");
    if (req.body.typing) run("INSERT INTO internal_chat_typing VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_seen=excluded.last_seen",[id,user.id,new Date().toISOString()]);
    else run("DELETE FROM internal_chat_typing WHERE conversation_id=? AND user_id=?",[id,user.id]);
    res.json({ok:true});
  });
  router.patch("/messages/:messageId",(req,res)=>{
    const user=actor(res),m=getMessage(req.params.messageId,user),text=req.body?.text;
    if (m.sender_id!==user.id) throw fail(403,"فقط پیام خودتان قابل ویرایش است.");
    if (m.deleted_at || typeof text!=="string" || text.length>8000 || (!text.trim()&&!m.object_path)) throw fail(400,"متن پیام معتبر نیست.");
    run("UPDATE internal_chat_messages SET text=?,edited_at=? WHERE id=?",[text,new Date().toISOString(),m.id]);
    res.json(messageView(row<Message>("SELECT * FROM internal_chat_messages WHERE id=?",[m.id])!,user));
  });
  router.delete("/messages/:messageId",async(req,res,next)=>{
    try {
      const user=actor(res),m=getMessage(req.params.messageId,user);
      if (m.sender_id!==user.id) throw fail(403,"فقط پیام خودتان قابل حذف است.");
      if (!m.deleted_at) {
        run("UPDATE internal_chat_messages SET text='',deleted_at=?,object_path=NULL,file_name=NULL,mime_type=NULL,file_size=NULL WHERE id=?",[new Date().toISOString(),m.id]);
        run("DELETE FROM internal_chat_reactions WHERE message_id=?",[m.id]);
        if (m.object_path) { try { await deps.deleteFile(m.object_path); } catch { /* access revoked already */ } }
      }
      res.json(messageView(row<Message>("SELECT * FROM internal_chat_messages WHERE id=?",[m.id])!,actor(res)));
    }catch(error){next(error);}
  });
  router.put("/messages/:messageId/reactions",(req,res)=>{
    const user=actor(res),m=getMessage(req.params.messageId,user),emoji=req.body?.emoji;
    if(m.deleted_at || typeof emoji!=="string" || emoji.length>32 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(emoji) || /[\u0000-\u001f<>]/.test(emoji)) throw fail(400,"واکنش معتبر نیست.");
    const old=row("SELECT 1 FROM internal_chat_reactions WHERE message_id=? AND user_id=? AND emoji=?",[m.id,user.id,emoji]);
    if(old)run("DELETE FROM internal_chat_reactions WHERE message_id=? AND user_id=? AND emoji=?",[m.id,user.id,emoji]);
    else {
      if ((row<{n:number}>("SELECT COUNT(*) n FROM internal_chat_reactions WHERE message_id=? AND user_id=?",[m.id,user.id])?.n??0)>=8) throw fail(400,"حداکثر ۸ واکنش برای هر پیام مجاز است.");
      run("INSERT INTO internal_chat_reactions VALUES(?,?,?)",[m.id,user.id,emoji]);
    }
    res.json(messageView(m,user));
  });
  router.get("/messages/:messageId/file",(req,res,next)=>{
    try {
      const user=actor(res),m=getMessage(req.params.messageId,user);
      if(m.deleted_at||!m.object_path)throw fail(404,"فایل در دسترس نیست.");
      res.setHeader("X-Content-Type-Options","nosniff");
      res.setHeader("Content-Security-Policy","default-src 'none'; sandbox");
      res.setHeader("Content-Type",m.mime_type??"application/octet-stream");
      res.setHeader("Content-Disposition",`${["image","audio","video"].includes(m.kind)?"inline":"attachment"}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(m.file_name??"attachment").replace(/'/g,"%27")}`);
      const stream=deps.readFile(m.object_path);
      stream.once("error",()=>{if(!res.headersSent)res.status(503).json({message:"خواندن فایل ممکن نیست."});else res.destroy();});
      res.once("close",()=>stream.destroy()); stream.pipe(res);
    }catch(error){next(error);}
  });
  router.use(((error:Error&{status?:number},_req,res,_next)=>{
    res.status(error.status??500).json({error:error.status?"internal_chat_error":"internal_chat_unavailable",message:error.status?error.message:"سرویس چت در دسترس نیست؛ دوباره تلاش کنید."});
  }) as import("express").ErrorRequestHandler);
  return router;
}
