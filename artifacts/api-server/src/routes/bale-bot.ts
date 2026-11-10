/**
 * «گفتگوی بله داخل پنل کارشناس» routes (lib/bale-bot.ts), behind requireApiAuth under /api.
 * flag.bale_bot OFF → every route falls through with next("router") (404 exactly as before; no schema, no network).
 * Per user: flag.bale_bot.user.<id> must be ON too, else 403 not_enabled (and the menu stays hidden).
 * Scope: an expert sees only chats of their own bot; admin + sales manager see and can write in every chat.
 * Manual link search: only the bot owner's own customers. Admin bot setup: admin + sales manager (masked token, never returned).
 */
import express, { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AuthUser } from "../lib/auth";
import { execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "../lib/crm-db";
import { insertCustomerRecord } from "../lib/customer-create";
import { baleBotAad, baleBotHasKey, sealBotToken } from "../lib/bale-bot-crypto";
import {
  ASK_CONTACT_TEXT, BaleBotWorker, BB_LIMITS, baleCall, bbCanManage, bbLog, bbMasterOn, bbNoSendSp, bbUser, bbUserOn, bbView, botById, botLive, botOfUser, botSends,
  bbNotice, chatName, messageView, redactPhonesInText, ensureBaleBotSchema, fileOwnerUsers, normPhone, filesDir, isBotExpert, BB_EXTRA_EXPERT_USER_IDS, nameOf, redact, tokenShapeOk, type BbUser,
} from "../lib/bale-bot";
import {
  bcApproveTyped, bcCanAct, bcCommitManual, bcFlagOn, bcInboxTitle, bcPreviewManual, bcRejectTyped,
  bcResendAsk, bcSourceLine, bcTypedMatch, ensureBaleContactSchema, runBaleContactBatch,
} from "../lib/bale-contact";

export const baleBotWorker = new BaleBotWorker();
const ERR_FA: Record<string, string> = {
  not_enabled: "گفتگوی بله برای شما روشن نیست.", forbidden: "دسترسی ندارید.", not_found: "پیدا نشد.", bad_text: "متن پیام خالی است یا از ۴۰۹۶ نویسه بیشتر است.",
  bot_off: "ربات قطع است؛ تا وصل شدن دوباره پیامی فرستاده نمی‌شود.", no_send: "فعلاً از این ربات پیامی فرستاده نمی‌شود.",
  photo_too_big: "بله عکس را تا ۱۰ مگابایت می‌فرستد. فایل کوچک‌تری انتخاب کنید.", file_too_big: "بله فایل را تا ۵۰ مگابایت می‌فرستد. فایل کوچک‌تری انتخاب کنید.",
  bad_file: "فایل خالی است.", not_editable: "این پیام قابل ویرایش نیست.", delete_expired: "پیام‌ها فقط تا ۴۸ ساعت بعد از ارسال حذف می‌شوند.",
  bale_error: "بله درخواست را انجام نداد. دوباره تلاش کنید.", no_verified_phone: "اول مشتری باید شماره‌ی خودش را با دکمه‌ی اشتراک بفرستد.",
  phone_other: "این شماره قبلاً برای مشتری کارشناس دیگری ثبت شده است. سرنخ تازه ثبت نمی‌شود؛ با «درخواست شماره» از خود مشتری بخواهید شماره‌اش را بفرستد.",
  bad_phone: "شماره‌ی موبایل را درست بنویسید؛ مثل ۰۹۱۲۰۰۰۰۰۰۰.", no_phone: "شماره‌ی موبایل الزامی است.", already_linked: "این گفتگو به پرونده وصل است.", bad_name: "نام را بنویسید.",
  bad_token: "بله این توکن را نشناخت. توکن را دوباره از @botfather کپی کنید و همین‌جا بچسبانید.", network: "به بله وصل نشد. کمی بعد دوباره تست کنید.",
  key_missing: "کلید رمزنگاری توکن روی سرور نیست؛ توکن ذخیره نشد.", bot_in_use: "این ربات برای کارشناس دیگری وصل است.", not_expert: "این کاربر کارشناس فروش فعال نیست.",
  has_bot: "این کارشناس ربات وصل دارد؛ از فهرست «تعویض توکن» را بزنید.", unknown: "درخواست انجام نشد. دوباره تلاش کنید.",
  flag_off: "این قابلیت فعلاً خاموش است.", no_pending: "شماره‌ی تایپی در انتظار تأیید نیست.",
  rate_limited: "لطفاً کمی صبر کنید و دوباره درخواست شماره را بفرستید.",
  batch_disabled: "ارسال یک‌باره به مشتریان فعلی خاموش است و بدون تأیید محمد اجرا نمی‌شود.",
};
const fail = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => { if (!res.headersSent) res.status(status).json({ error, message: ERR_FA[error] ?? ERR_FA.unknown, ...extra }); };
const me = (res: Response): BbUser | undefined => { const a = res.locals.authUser as AuthUser | undefined; return a ? bbUser(a.id) : undefined; };
const num = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
const t = () => new Date().toISOString();

type ChatRow = { id: number; bot_id: number; chat_id: string; bale_user_id: string | null; first_name: string | null; last_name: string | null; username: string | null; bio: string | null;
  customer_id: number | null; link_method: string | null; linked_at: string | null; linked_by: number | null; verified_phone: string | null; lead_phone_verified: number | null; contact_asked_at: string | null; match_note: string | null;
  pending_typed_phone: string | null; pending_typed_at: string | null; link_source: string | null; first_ask_at: string | null; reminder_sent_at: string | null; welcome_sent_at: string | null; lead_from_bale: number | null;
  unread: number; last_at: string | null; last_preview: string | null; last_out: number; created_at: string };
/** The chat, if this user may see it: "all" → any; "own" → only chats of the user's own bot. */
function chatFor(u: BbUser, id: number): (ChatRow & { owner_id: number }) | undefined {
  const c = queryRow<ChatRow & { owner_id: number }>("SELECT c.*, b.user_id owner_id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id WHERE c.id=?", [id]);
  if (!c) return undefined;
  return bbView(u) === "all" || c.owner_id === u.id ? c : undefined;
}
function customerBrief(cid: number | null) {
  if (!cid) return null;
  const c = queryRow<any>("SELECT c.id,c.name,c.phone,c.status,c.salesperson_id,s.name spn FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=?", [cid]);
  if (!c) return null;
  const owner = queryRow<any>("SELECT id,full_name,username FROM users WHERE salesperson_id=? AND role='salesperson' ORDER BY active DESC, id LIMIT 1", [c.salesperson_id ?? -1]);
  return { id: c.id, name: c.name, phone: c.phone, status: c.status, salespersonId: c.salesperson_id, expert: owner ? nameOf(owner) : c.spn ?? null };
}
/** Q8 default (server-side): an expert whose chat got linked to ANOTHER expert's file sees only name, #id and the file owner —
 * no mobile, no status, no «باز کردن پرونده». Admin/sales manager and the file's own expert see the full brief. */
function customerFor(u: BbUser, cid: number | null) {
  const full = customerBrief(cid); if (!full) return null;
  if (bbView(u) === "all" || (u.salesperson_id != null && full.salespersonId === u.salesperson_id)) return { ...full, restricted: false, canOpen: true };
  return { id: full.id, name: full.name, expert: full.expert, phone: null, status: null, salespersonId: null, restricted: true, canOpen: false };
}
const noticesFor = (u: BbUser, chatRow: number) => queryRows<any>("SELECT id,kind,actor_user_id,customer_id,at FROM bale_bot_notices WHERE user_id=? AND chat_row=? AND seen_at IS NULL ORDER BY id", [u.id, chatRow])
  .map(n => ({ id: n.id, kind: n.kind, at: n.at, actor: n.actor_user_id ? nameOf(bbUser(n.actor_user_id)) : null }));
function chatView(c: ChatRow & { owner_id: number }, u: BbUser) {
  const owner = bbUser(c.owner_id); const bot = botById(c.bot_id)!;
  const full = customerBrief(c.customer_id); const cust = customerFor(u, c.customer_id);
  const lastOutAuthor = c.last_out ? queryRow<{ a: number | null }>("SELECT author_user_id a FROM bale_bot_messages WHERE chat_row=? AND dir='out' ORDER BY id DESC LIMIT 1", [c.id])?.a ?? null : null;
  const feature = bcFlagOn();
  const canAct = feature && bcCanAct(u, c.owner_id);
  const typedPhone = feature && c.pending_typed_phone && canAct ? c.pending_typed_phone : null;
  const typedMatch = typedPhone ? bcTypedMatch(typedPhone, owner?.salesperson_id ?? null) : null;
  const title = feature ? bcInboxTitle(c, cust && !c.pending_typed_phone ? cust.name : null) : chatName(c);
  return { id: c.id, name: title, firstName: c.first_name, lastName: c.last_name, username: c.username, bio: c.bio, unread: c.unread, lastAt: c.last_at, lastPreview: (cust && cust.restricted) ? redactPhonesInText(c.last_preview) : c.last_preview, lastOut: !!c.last_out,
    customer: cust, linkMethod: c.link_method, otherExpert: !!full && owner?.salesperson_id !== full.salespersonId, notices: noticesFor(u, c.id),
    lastByManager: !!lastOutAuthor && lastOutAuthor !== c.owner_id, verifiedPhone: (cust && cust.restricted) ? null : c.verified_phone, phoneVerified: c.customer_id == null ? null : c.link_method === 'contact' || c.link_method === 'contact_other' ? true : c.lead_phone_verified == null ? null : !!c.lead_phone_verified, contactAskedAt: c.contact_asked_at, matchNote: c.match_note,
    expert: { id: c.owner_id, name: nameOf(owner) }, bot: { username: bot.bot_username, status: bot.status }, canWrite: botLive(bot) && botSends(bot), sendBlocked: !botSends(bot) ? "no_send" : !botLive(bot) ? "bot_off" : null,
    mine: c.owner_id === u.id,
    contactFeature: feature,
    pendingTypedPhone: typedPhone,
    pendingTypedAt: typedPhone ? c.pending_typed_at : null,
    linkSource: feature ? (c.link_source ?? null) : null,
    sourceLine: feature && c.customer_id ? bcSourceLine(c) : null,
    leadFromBale: feature && !!c.lead_from_bale,
    canApproveTyped: !!(feature && canAct && c.pending_typed_phone && !c.customer_id),
    canRejectTyped: !!(feature && canAct && c.pending_typed_phone && !c.customer_id),
    canManualEnter: !!(feature && canAct && !c.customer_id && !c.pending_typed_phone),
    canResendAsk: !!(feature && canAct && !c.customer_id && botLive(bot) && botSends(bot)),
    typedMatch: typedMatch && typedMatch.state === "known" ? typedMatch.customer : null,
    waitingNumber: feature && !c.customer_id && !c.pending_typed_phone,
  };
}
function botView(b: ReturnType<typeof botOfUser>) {
  return b ? { id: b.id, username: b.bot_username, name: b.bot_name, status: b.status, connectedAt: b.connected_at, lastOkAt: b.last_ok_at, lastError: b.last_error, hasToken: !!b.token_ct } : null;
}

export function createBaleBotRouter(): IRouter {
  const r: IRouter = Router();
  r.use("/bale-bot", (_req: Request, res: Response, next: NextFunction) => {
    if (!bbMasterOn()) return next("router");
    ensureBaleBotSchema();
    if (bcFlagOn()) ensureBaleContactSchema();
    const u = me(res); if (!u || !bbView(u)) return fail(res, 403, "not_enabled");
    res.locals.bbUser = u; next();
  });
  const U = (res: Response) => res.locals.bbUser as BbUser;
  const kick = () => { setImmediate(() => { void baleBotWorker.flushOutbox(); }); };

  r.get("/bale-bot/me", (_req, res) => {
    const u = U(res); const v = bbView(u)!;
    const unread = v === "all" ? queryRow<{ n: number }>("SELECT COUNT(*) n FROM bale_bot_chats WHERE unread>0")!.n
      : queryRow<{ n: number }>("SELECT COUNT(*) n FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id WHERE b.user_id=? AND c.unread>0", [u.id])!.n;
    res.json({ enabled: true, view: v, canManage: bbCanManage(u), name: nameOf(u), bot: botView(botOfUser(u.id)), unread, limits: BB_LIMITS, contactFeature: bcFlagOn() });
  });

  r.get("/bale-bot/chats", (req, res) => {
    const u = U(res); const v = bbView(u)!; const f = String(req.query.filter ?? "all"); const q = String(req.query.q ?? "").trim().slice(0, 60); const ex = num(req.query.expert);
    const w: string[] = []; const p: any[] = [];
    if (v === "own") { w.push("b.user_id=?"); p.push(u.id); } else if (ex) { w.push("b.user_id=?"); p.push(ex); }
    const base = w.length ? `WHERE ${w.join(" AND ")}` : "";
    const all = queryRows<ChatRow & { owner_id: number }>(`SELECT c.*, b.user_id owner_id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id ${base} ORDER BY COALESCE(c.last_at,c.created_at) DESC LIMIT 500`, p);
    const pending = all.filter(c => !c.customer_id);
    const counts = { all: all.length, unread: all.filter(c => c.unread > 0).length, unlinked: pending.length, pending: pending.length, typedPending: all.filter(c => !c.customer_id && c.pending_typed_phone).length };
    let list = f === "unread" ? all.filter(c => c.unread > 0) : (f === "unlinked" || f === "pending") ? pending : all;
    if (q) {
      const qd = q.replace(/^[#@]/, "");
      const qn = qd.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
      list = list.filter(c => {
        const title = bcFlagOn() ? bcInboxTitle(c, customerBrief(c.customer_id)?.name ?? null) : chatName(c);
        const cust = c.customer_id ? customerBrief(c.customer_id) : null;
        return title.includes(q) || chatName(c).includes(q) || (c.username ?? "").toLowerCase().includes(qd.toLowerCase())
          || (cust?.name ?? "").includes(q) || (c.customer_id != null && String(c.customer_id) === qn);
      });
    }
    const experts = v === "all" ? queryRows<any>("SELECT b.user_id id, u.full_name, u.username FROM bale_bots b JOIN users u ON u.id=b.user_id ORDER BY b.user_id").map(e => ({ id: e.id, name: nameOf(e) })) : [];
    res.json({ counts, chats: list.map(c => chatView(c, u)), experts });
  });

  r.get("/bale-bot/chats/:id", (req, res) => {
    const u = U(res); const c = chatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    const after = num(req.query.after);
    const msgs = queryRows<any>(`SELECT * FROM bale_bot_messages WHERE chat_row=? ${after ? "AND id>?" : ""} ORDER BY id DESC LIMIT 300`, after ? [c.id, after] : [c.id]).reverse();
    if (c.owner_id === u.id && c.unread) executeChanges("UPDATE bale_bot_chats SET unread=0 WHERE id=?", [c.id]); // a manager opening it does not clear the expert's badge
    const view = chatView({ ...c, unread: c.owner_id === u.id ? 0 : c.unread }, u);
    res.json({ chat: view, messages: msgs.map(m => messageView(m, c.owner_id, { hidePhone: !!view.customer?.restricted })) });
  });

  const writable = (u: BbUser, id: number, res: Response) => {
    const c = chatFor(u, id); if (!c) { fail(res, 404, "not_found"); return null; }
    const bot = botById(c.bot_id)!;
    if (!botSends(bot)) { fail(res, 409, "no_send"); return null; }
    if (!botLive(bot)) { fail(res, 409, "bot_off"); return null; }
    return c;
  };
  const queueOut = (c: ChatRow, u: BbUser, o: { kind: string; text: string | null; replyTo?: number | null; keyboard?: string | null; file?: { name: string; mime: string; size: number; rel: string; sendAs: string } }) => {
    const id = execute(`INSERT INTO bale_bot_messages(chat_row,dir,kind,text,reply_to,keyboard,file_name,mime,size,file_path,file_state,send_as,status,author_user_id,created_at)
      VALUES(?,'out',?,?,?,?,?,?,?,?,?,?,'sending',?,?)`, [c.id, o.kind, o.text, o.replyTo ?? null, o.keyboard ?? null, o.file?.name ?? null, o.file?.mime ?? null, o.file?.size ?? null,
      o.file?.rel ?? null, o.file ? "stored" : null, o.file?.sendAs ?? null, u.id, t()]);
    executeChanges("UPDATE bale_bot_chats SET last_at=?, last_preview=?, last_out=1 WHERE id=?", [t(), o.text ? o.text.replace(/\s+/g, " ").slice(0, 80) : o.kind === "photo" ? "عکس" : "فایل", c.id]);
    const ownerId = (c as any).owner_id as number;
    bbLog({ userId: u.id, botId: c.bot_id, chatRow: c.id, customerId: c.customer_id, action: "send.queue", outcome: "ok", detail: { kind: o.kind, byOwner: ownerId === u.id } });
    if (ownerId !== u.id) bbNotice(ownerId, "mgr_wrote", { chatRow: c.id, actor: u.id }); // chat_mgr: the expert is told in-app
    kick();
    return messageView(queryRow<any>("SELECT * FROM bale_bot_messages WHERE id=?", [id]));
  };

  r.post("/bale-bot/chats/:id/messages", express.json({ limit: "64kb" }), (req, res) => {
    const u = U(res); const c = writable(u, num(req.params.id), res); if (!c) return;
    const text = String(req.body?.text ?? ""); if (!text.trim() || [...text].length > BB_LIMITS.textMax) return fail(res, 400, "bad_text");
    const replyTo = num(req.body?.replyTo) && queryRow("SELECT 1 FROM bale_bot_messages WHERE id=? AND chat_row=?", [num(req.body.replyTo), c.id]) ? num(req.body.replyTo) : null;
    res.json({ message: queueOut(c, u, { kind: "text", text, replyTo }) });
  });

  r.post("/bale-bot/chats/:id/request-contact", (req, res) => {
    const u = U(res); const c = writable(u, num(req.params.id), res); if (!c) return;
    if (bcFlagOn()) {
      const bot = botById(c.bot_id)!;
      const r2 = bcResendAsk(c, bot, u);
      if (!r2.ok) return fail(res, r2.error === "rate_limited" ? 429 : r2.error === "forbidden" ? 403 : 409, r2.error);
      kick();
      return res.json({ message: messageView(queryRow<any>("SELECT * FROM bale_bot_messages WHERE id=?", [r2.messageId]), c.owner_id) });
    }
    executeChanges("UPDATE bale_bot_chats SET contact_asked_at=? WHERE id=?", [t(), c.id]);
    res.json({ message: queueOut(c, u, { kind: "text", text: ASK_CONTACT_TEXT, keyboard: "contact" }) });
  });

  r.post("/bale-bot/chats/:id/files", express.raw({ type: () => true, limit: BB_LIMITS.fileBytes + 1024 }), (req, res) => {
    const u = U(res); const c = writable(u, num(req.params.id), res); if (!c) return;
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0); if (!buf.length) return fail(res, 400, "bad_file");
    let name = "file"; try { name = decodeURIComponent(String(req.headers["x-file-name"] ?? "file")).slice(0, 120) || "file"; } catch { /* default */ }
    const mime = String(req.headers["content-type"] ?? "application/octet-stream").slice(0, 100);
    const want = String(req.headers["x-kind"] ?? "document"); const caption = (() => { try { return decodeURIComponent(String(req.headers["x-caption"] ?? "")).slice(0, 1024) || null; } catch { return null; } })();
    let kind = want === "photo" ? "photo" : want === "voice" ? "voice" : want === "video" ? "video" : "document"; let sendAs = kind;
    if (kind === "photo" && buf.length > BB_LIMITS.photoBytes) return fail(res, 413, "photo_too_big");
    if (buf.length > BB_LIMITS.fileBytes) return fail(res, 413, "file_too_big");
    if (kind === "voice" && (buf.length > BB_LIMITS.voiceBytes || !/ogg|opus/i.test(mime + name))) sendAs = "document"; // «بیشتر از آن به‌صورت فایل»
    const rel = path.join(String(c.bot_id), `out-${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-80)}`);
    fs.mkdirSync(path.dirname(path.join(filesDir(), rel)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(filesDir(), rel), buf, { mode: 0o600 });
    res.json({ message: queueOut(c, u, { kind, text: caption, file: { name, mime, size: buf.length, rel, sendAs } }) });
  });

  const ownOut = (u: BbUser, id: number) => {
    const m = queryRow<any>("SELECT * FROM bale_bot_messages WHERE id=? AND dir='out'", [id]); if (!m) return null;
    const c = chatFor(u, m.chat_row); return c ? { m, c } : null;
  };
  r.post("/bale-bot/messages/:id/retry", (req, res) => {
    const u = U(res); const x = ownOut(u, num(req.params.id)); if (!x || x.m.status !== "failed") return fail(res, 404, "not_found");
    if (!writable(u, x.c.id, res)) return;
    executeChanges("UPDATE bale_bot_messages SET status='sending', error_code=NULL, retry_at=NULL WHERE id=?", [x.m.id]);
    bbLog({ userId: u.id, botId: x.c.bot_id, chatRow: x.c.id, action: "send.retry", outcome: "ok" }); kick();
    res.json({ message: messageView(queryRow<any>("SELECT * FROM bale_bot_messages WHERE id=?", [x.m.id])) });
  });
  r.post("/bale-bot/messages/:id/edit", express.json({ limit: "64kb" }), async (req, res) => {
    const u = U(res); const x = ownOut(u, num(req.params.id)); if (!x) return fail(res, 404, "not_found");
    if (!messageView(x.m).canEdit) return fail(res, 409, "not_editable");
    const text = String(req.body?.text ?? ""); if (!text.trim() || [...text].length > BB_LIMITS.textMax) return fail(res, 400, "bad_text");
    if (!writable(u, x.c.id, res)) return;
    const bot = botById(x.c.bot_id)!; const { botToken } = await import("../lib/bale-bot"); const tok = botToken(bot); if (!tok) return fail(res, 409, "bot_off");
    const rr = await baleCall(tok, "editMessageText", { chat_id: x.c.chat_id, message_id: x.m.bale_message_id, text });
    bbLog({ userId: u.id, botId: bot.id, chatRow: x.c.id, action: "edit", outcome: rr.ok ? "ok" : "failed", detail: rr.ok ? undefined : { code: rr.code } });
    if (!rr.ok) return fail(res, 502, rr.network ? "network" : "bale_error");
    executeChanges("UPDATE bale_bot_messages SET text=?, edited_at=? WHERE id=?", [text, t(), x.m.id]);
    res.json({ message: messageView(queryRow<any>("SELECT * FROM bale_bot_messages WHERE id=?", [x.m.id])) });
  });
  r.post("/bale-bot/messages/:id/delete", async (req, res) => {
    const u = U(res); const x = ownOut(u, num(req.params.id)); if (!x) return fail(res, 404, "not_found");
    const v = messageView(x.m); if (v.deleteExpired) return fail(res, 409, "delete_expired"); if (!v.canDelete) return fail(res, 409, "not_editable");
    if (!writable(u, x.c.id, res)) return;
    const bot = botById(x.c.bot_id)!; const { botToken } = await import("../lib/bale-bot"); const tok = botToken(bot); if (!tok) return fail(res, 409, "bot_off");
    const rr = await baleCall(tok, "deleteMessage", { chat_id: x.c.chat_id, message_id: x.m.bale_message_id });
    bbLog({ userId: u.id, botId: bot.id, chatRow: x.c.id, action: "delete", outcome: rr.ok ? "ok" : "failed" });
    if (!rr.ok) return fail(res, 502, rr.network ? "network" : "bale_error");
    executeChanges("UPDATE bale_bot_messages SET deleted_at=? WHERE id=?", [t(), x.m.id]);
    res.json({ message: messageView(queryRow<any>("SELECT * FROM bale_bot_messages WHERE id=?", [x.m.id])) });
  });

  r.get("/bale-bot/files/:id", (req, res) => {
    const u = U(res); const m = queryRow<any>("SELECT * FROM bale_bot_messages WHERE id=? AND file_state='stored'", [num(req.params.id)]);
    if (!m || !chatForAny(u, m.chat_row)) return fail(res, 404, "not_found");
    const full = path.resolve(filesDir(), m.file_path); if (!full.startsWith(path.resolve(filesDir()) + path.sep) || !fs.existsSync(full)) return fail(res, 404, "not_found");
    res.setHeader("Content-Type", bbServeType(full, m.mime));
    res.setHeader("Content-Disposition", `${req.query.dl ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(m.file_name ?? "file")}`);
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "sandbox"); res.setHeader("Cache-Control", "private, max-age=3600");
    fs.createReadStream(full).pipe(res);
  });
  /** Chat visible through its chat scope or through the linked customer's file (own customer of the expert). */
  const chatForAny = (u: BbUser, chatRow: number) => {
    const c = chatFor(u, chatRow); if (c) return c;
    const x = queryRow<any>("SELECT c.customer_id, cu.salesperson_id FROM bale_bot_chats c LEFT JOIN customers cu ON cu.id=c.customer_id WHERE c.id=?", [chatRow]);
    return x?.customer_id && u.salesperson_id && x.salesperson_id === u.salesperson_id ? x : null;
  };

  r.get("/bale-bot/notices", (_req, res) => {
    const u = U(res);
    const rows = queryRows<any>("SELECT * FROM bale_bot_notices WHERE user_id=? AND seen_at IS NULL ORDER BY id DESC LIMIT 50", [u.id]);
    res.json({ notices: rows.map(n => { const cb = n.customer_id ? customerFor(u, n.customer_id) : null;
      return { id: n.id, kind: n.kind, chatId: n.chat_row, at: n.at, actor: n.actor_user_id ? nameOf(bbUser(n.actor_user_id)) : null, customer: cb ? { id: cb.id, name: cb.name, expert: cb.expert } : null }; }) });
  });
  r.post("/bale-bot/notices/:id/seen", (req, res) => {
    const u = U(res); executeChanges("UPDATE bale_bot_notices SET seen_at=? WHERE id=? AND user_id=?", [t(), num(req.params.id), u.id]); res.json({ ok: true });
  });

  /* ---- linking ---- */
  r.get("/bale-bot/chats/:id/search", (req, res) => {
    const u = U(res); const c = chatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    const owner = bbUser(c.owner_id); const q = String(req.query.q ?? "").trim().replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).slice(0, 60);
    if (!q || !owner?.salesperson_id) return res.json({ results: [] });
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const rows = queryRows<any>(`SELECT id,name,phone,status FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND (name LIKE ? OR phone LIKE ? OR CAST(id AS TEXT)=?) ORDER BY id DESC LIMIT 20`,
      [owner.salesperson_id, like, like, q.replace(/^#/, "")]);
    res.json({ results: rows.map(x => ({ id: x.id, name: x.name, phone: x.phone, status: x.status })) });
  });
  r.post("/bale-bot/chats/:id/link", express.json(), (req, res) => {
    const u = U(res); const c = chatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    if (c.customer_id) return fail(res, 409, "already_linked");
    const owner = bbUser(c.owner_id); const cid = num(req.body?.customerId);
    // Own refusal (independent of expert_lockdown): only the bot owner's own customers can be linked by hand.
    // Same 404 for "another expert's file" and "no such file", so nothing about other files leaks (link_search_none).
    if (!queryRow("SELECT 1 FROM customers WHERE id=? AND salesperson_id=? AND merged_into_customer_id IS NULL", [cid, owner?.salesperson_id ?? -1])) {
      bbLog({ userId: u.id, botId: c.bot_id, chatRow: c.id, action: "link.manual", outcome: "refused_not_own" });
      return fail(res, 404, "not_found");
    }
    executeChanges("UPDATE bale_bot_chats SET customer_id=?, link_method='manual', linked_at=?, linked_by=? WHERE id=? AND customer_id IS NULL", [cid, t(), u.id, c.id]);
    bbLog({ userId: u.id, botId: c.bot_id, chatRow: c.id, customerId: cid, action: "link.manual", outcome: "ok" });
    res.json({ chat: chatView(chatFor(u, c.id)!, u) });
  });
  /** Lead wizard step 1 check (lead_1_err / lead_1_dup): never returns the other file's name, id, owner or status. */
  const phoneCheck = (phone: string, ownerSp: number | null) => {
    const ex = queryRows<{ id: number; salesperson_id: number | null }>("SELECT id,salesperson_id FROM customers WHERE phone=? AND merged_into_customer_id IS NULL ORDER BY id", [phone]);
    const own = ex.find(x => ownerSp != null && x.salesperson_id === ownerSp);
    return own ? { state: "own" as const, id: own.id } : ex.length ? { state: "other" as const } : { state: "free" as const };
  };
  r.post("/bale-bot/chats/:id/lead/check", express.json(), (req, res) => {
    const u = U(res); const c = chatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    const raw = String(req.body?.phone ?? "").trim(); if (!raw) return fail(res, 400, "no_phone");
    const phone = normPhone(raw); if (!phone) return fail(res, 400, "bad_phone");
    const k = phoneCheck(phone, bbUser(c.owner_id)?.salesperson_id ?? null);
    if (k.state === "other") return fail(res, 409, "phone_other");
    res.json({ phone, state: k.state, verified: phone === c.verified_phone, ...(k.state === "own" ? { customer: customerFor(u, k.id) } : {}) });
  });
  r.post("/bale-bot/chats/:id/lead", express.json(), (req, res) => {
    const u = U(res); const c = chatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    if (c.customer_id) return fail(res, 409, "already_linked");
    const raw = String(req.body?.phone ?? c.verified_phone ?? "").trim(); if (!raw) return fail(res, 400, "no_phone");
    const phone = normPhone(raw); if (!phone) return fail(res, 400, "bad_phone");
    const first = String(req.body?.firstName ?? "").trim().slice(0, 60), last = String(req.body?.lastName ?? "").trim().slice(0, 60), note = String(req.body?.note ?? "").trim().slice(0, 500);
    const name = [first, last].filter(Boolean).join(" "); if (!name) return fail(res, 400, "bad_name");
    const owner = bbUser(c.owner_id); const bot = botById(c.bot_id)!;
    // Typed mobile is allowed (design v1.1); stored verified=false and labelled «تأییدنشده» internally. request_contact stays the preferred path.
    const verified = !!c.verified_phone && normPhone(c.verified_phone) === phone;
    const out = runImmediateTransaction(() => {
      const k = phoneCheck(phone, owner?.salesperson_id ?? null);
      if (k.state === "other") return { other: true as const };
      if (k.state === "own") {
        executeChanges("UPDATE bale_bot_chats SET customer_id=?, link_method='manual', linked_at=?, linked_by=?, lead_phone_verified=? WHERE id=?", [k.id, t(), u.id, verified ? 1 : 0, c.id]);
        return { existing: k.id };
      }
      const id = insertCustomerRecord({ name, phone, description: [`منبع: بله${bot.bot_username ? ` (ربات @${bot.bot_username})` : ""}`, note].filter(Boolean).join("\n"),
        salespersonId: owner?.salesperson_id ?? null, assignedSalespersonId: owner?.salesperson_id ?? null, registeredByUserId: u.id, registrationSource: "staff_form", skipDefaultOwnerRule: owner?.salesperson_id != null, // no own salesperson (registrar bot) -> normal default-owner rule
        intake: { leadSource: "other", leadSourceOther: "بله", registrarNote: note || null } });
      executeChanges("UPDATE bale_bot_chats SET customer_id=?, link_method='lead', linked_at=?, linked_by=?, lead_phone_verified=? WHERE id=?", [id, t(), u.id, verified ? 1 : 0, c.id]);
      return { created: id };
    });
    if ("other" in out) { bbLog({ userId: u.id, botId: c.bot_id, chatRow: c.id, action: "lead", outcome: "dup_other" }); return fail(res, 409, "phone_other"); }
    bbLog({ userId: u.id, botId: c.bot_id, chatRow: c.id, customerId: out.created ?? out.existing, action: "lead", outcome: out.created ? "created" : "existing", detail: { verified } });
    res.json({ ...out, chat: chatView(chatFor(u, c.id)!, u) });
  });

  /* ---- customer file «بله» tab ---- */
  r.get("/bale-bot/customers/:cid", (req, res) => {
    const u = U(res); const cid = num(req.params.cid); const v = bbView(u);
    const cust = queryRow<any>("SELECT id,salesperson_id FROM customers WHERE id=?", [cid]); if (!cust) return fail(res, 404, "not_found");
    const chats = queryRows<ChatRow & { owner_id: number }>("SELECT c.*, b.user_id owner_id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id WHERE c.customer_id=? ORDER BY c.last_at DESC", [cid])
      .filter(c => v === "all" || c.owner_id === u.id || (u.salesperson_id != null && cust.salesperson_id === u.salesperson_id));
    res.json({ chats: chats.map(c => {
      const view = chatView(c, u);
      return { ...view, canOpen: v === "all" || c.owner_id === u.id,
        timeline: queryRows<any>("SELECT * FROM bale_bot_messages WHERE chat_row=? ORDER BY id DESC LIMIT 30", [c.id]).map(m => messageView(m, c.owner_id, { hidePhone: !!view.customer?.restricted })) };
    }) });
  });

  /* ---- bale-contact v1.1 (flag off → 409 flag_off) ---- */
  r.post("/bale-bot/chats/:id/typed/approve", (req, res) => {
    const u = U(res); const c = chatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    const bot = botById(c.bot_id)!;
    const r2 = bcApproveTyped(c, bot, u);
    if (!r2.ok) return fail(res, r2.error === "forbidden" ? 403 : r2.error === "flag_off" ? 409 : 400, r2.error);
    kick();
    res.json({ result: r2.result, chat: chatView(chatFor(u, c.id)!, u) });
  });
  r.post("/bale-bot/chats/:id/typed/reject", (req, res) => {
    const u = U(res); const c = chatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    const bot = botById(c.bot_id)!;
    const r2 = bcRejectTyped(c, bot, u);
    if (!r2.ok) return fail(res, r2.error === "forbidden" ? 403 : r2.error === "flag_off" ? 409 : 400, r2.error);
    kick();
    res.json({ ok: true, chat: chatView(chatFor(u, c.id)!, u) });
  });
  r.post("/bale-bot/chats/:id/manual/preview", express.json(), (req, res) => {
    const u = U(res); const c = chatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    if (!bcFlagOn()) return fail(res, 409, "flag_off");
    if (!bcCanAct(u, c.owner_id)) return fail(res, 403, "forbidden");
    const owner = bbUser(c.owner_id);
    const r2 = bcPreviewManual(String(req.body?.phone ?? ""), owner?.salesperson_id ?? null);
    if (!r2.ok) return fail(res, 400, r2.error);
    // Lockdown / other-expert: preview shows name, #id and owner; phone of the matched file is not added here (the typed value is the expert's own input).
    const match = r2.match.state === "known" && r2.match.customer
      ? (r2.match.own || bbCanManage(u)
        ? { state: "known", phone: r2.phone, customer: r2.match.customer }
        : { state: "known", phone: r2.phone, customer: { id: r2.match.customer.id, name: r2.match.customer.name, expert: r2.match.customer.expert, status: null, own: false } })
      : { state: r2.match.state, phone: r2.phone, customer: null };
    res.json(match);
  });
  r.post("/bale-bot/chats/:id/manual", express.json(), (req, res) => {
    const u = U(res); const c = chatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    const bot = botById(c.bot_id)!;
    const r2 = bcCommitManual(c, bot, u, String(req.body?.phone ?? ""));
    if (!r2.ok) return fail(res, r2.error === "forbidden" ? 403 : r2.error === "flag_off" ? 409 : 400, r2.error);
    res.json({ result: r2.result, phone: r2.phone, chat: chatView(chatFor(u, c.id)!, u) });
  });
  r.post("/bale-bot/admin/contact-batch", (_req, res) => {
    const u = adm(res); if (!u) return;
    const r2 = runBaleContactBatch();
    if (!r2.ok) return fail(res, 409, r2.error ?? "batch_disabled");
    kick();
    res.json({ ok: true, sent: r2.sent, skipped: r2.skipped });
  });

  /* ---- admin: bots ---- */
  const adm = (res: Response) => { const u = U(res); if (!bbCanManage(u)) { fail(res, 403, "forbidden"); return null; } return u; };
  r.get("/bale-bot/admin/bots", (_req, res) => {
    if (!adm(res)) return;
    const experts = queryRows<BbUser>(`SELECT id,role,role AS base_role,salesperson_id,active,full_name,username FROM users WHERE (role='salesperson' OR id IN (${BB_EXTRA_EXPERT_USER_IDS.map(Number).join(",") || "-1"})) AND active=1 ORDER BY id`).filter(isBotExpert);
    res.json({ hasKey: baleBotHasKey(process.env), noSend: bbNoSendSp(), experts: experts.map(e => ({ id: e.id, name: nameOf(e), salespersonId: e.salesperson_id, flagOn: bbUserOn(e.id), bot: botView(botOfUser(e.id)), noSend: bbNoSendSp().includes(Number(e.salesperson_id)) })) });
  });
  /** getMe with a token typed in the wizard (not stored). The token is only in the body; the answer never echoes it. */
  const getMe = async (token: string) => {
    const r = await baleCall<{ id: number; first_name?: string; username?: string; is_bot?: boolean }>(token, "getMe", {}, 15_000);
    if (r.ok) return { ok: true as const, bot: { id: String(r.result.id), name: r.result.first_name ?? null, username: r.result.username ?? null } };
    return { ok: false as const, error: r.network ? "network" : r.code === 401 || r.code === 404 ? "bad_token" : "bale_error" };
  };
  r.post("/bale-bot/admin/test", express.json({ limit: "4kb" }), async (req, res) => {
    const u = adm(res); if (!u) return;
    const token = String(req.body?.token ?? "").trim();
    if (!tokenShapeOk(token)) { bbLog({ userId: u.id, action: "admin.test", outcome: "bad_shape" }); return fail(res, 400, "bad_token"); }
    const g = await getMe(token); bbLog({ userId: u.id, action: "admin.test", outcome: g.ok ? "ok" : g.error });
    if (!g.ok) return fail(res, g.error === "network" ? 502 : 400, g.error);
    res.json({ ok: true, bot: { name: g.bot.name, username: g.bot.username } });
  });
  r.post("/bale-bot/admin/bots", express.json({ limit: "4kb" }), async (req, res) => {
    const u = adm(res); if (!u) return;
    const userId = num(req.body?.userId); const token = String(req.body?.token ?? "").trim(); const replace = req.body?.replace === true;
    const ex = bbUser(userId); if (!isBotExpert(ex)) return fail(res, 400, "not_expert");
    if (!tokenShapeOk(token)) return fail(res, 400, "bad_token");
    if (!baleBotHasKey(process.env)) return fail(res, 503, "key_missing");
    const cur = botOfUser(userId); if (cur && cur.token_ct && !replace) return fail(res, 409, "has_bot");
    const g = await getMe(token); if (!g.ok) { bbLog({ userId: u.id, action: "admin.save", outcome: g.error }); return fail(res, g.error === "network" ? 502 : 400, g.error); }
    if (queryRow("SELECT 1 FROM bale_bots WHERE bot_user_id=? AND user_id<>? AND token_ct IS NOT NULL", [g.bot.id, userId])) return fail(res, 409, "bot_in_use");
    const at = t();
    runImmediateTransaction(() => {
      let id = cur?.id;
      if (!id) id = execute("INSERT INTO bale_bots(user_id,status,created_by,created_at,updated_at) VALUES(?, 'off', ?, ?, ?)", [userId, u.id, at, at]);
      const sealed = sealBotToken(process.env, token, baleBotAad(id, userId));
      const sameBot = cur?.bot_user_id === g.bot.id;
      executeChanges(`UPDATE bale_bots SET token_ct=?, token_key_id=?, bot_user_id=?, bot_username=?, bot_name=?, status='on', last_error=NULL, updated_at=?,
        connected_at=CASE WHEN ? THEN COALESCE(connected_at,?) ELSE ? END, next_offset=CASE WHEN ? THEN next_offset ELSE 0 END, backlog_skipped=CASE WHEN ? THEN backlog_skipped ELSE 0 END WHERE id=?`,
        [sealed.value, sealed.keyId, g.bot.id, g.bot.username, g.bot.name, at, sameBot ? 1 : 0, at, at, sameBot ? 1 : 0, sameBot ? 1 : 0, id]);
    });
    bbLog({ userId: u.id, botId: botOfUser(userId)!.id, action: cur?.token_ct ? "admin.replace" : "admin.connect", outcome: "ok" });
    setImmediate(() => { void baleBotWorker.tick(); });
    res.json({ bot: botView(botOfUser(userId)) });
  });
  r.post("/bale-bot/admin/bots/:id/test", async (req, res) => {
    const u = adm(res); if (!u) return;
    const b = botById(num(req.params.id)); if (!b || !b.token_ct) return fail(res, 404, "not_found");
    const { botToken } = await import("../lib/bale-bot"); const tok = botToken(b); if (!tok) return fail(res, 503, "key_missing");
    const g = await getMe(tok); bbLog({ userId: u.id, botId: b.id, action: "admin.test_saved", outcome: g.ok ? "ok" : g.error });
    if (!g.ok) { if (g.error === "bad_token") executeChanges("UPDATE bale_bots SET status='err', last_error='token_rejected' WHERE id=?", [b.id]); return fail(res, g.error === "network" ? 502 : 400, g.error); }
    if (b.status === "err") executeChanges("UPDATE bale_bots SET status='on', last_error=NULL WHERE id=?", [b.id]);
    res.json({ ok: true, bot: { name: g.bot.name, username: g.bot.username } });
  });
  r.post("/bale-bot/admin/bots/:id/disconnect", (req, res) => {
    const u = adm(res); if (!u) return;
    const b = botById(num(req.params.id)); if (!b) return fail(res, 404, "not_found");
    executeChanges("UPDATE bale_bots SET status='off', token_ct=NULL, token_key_id=NULL, updated_at=? WHERE id=?", [t(), b.id]);
    bbLog({ userId: u.id, botId: b.id, action: "admin.disconnect", outcome: "ok" });
    setImmediate(() => { void baleBotWorker.tick(); });
    res.json({ ok: true });
  });
  // Last line of defence: no error from this router may carry a token.
  r.use("/bale-bot", (err: any, _req: Request, res: Response, _next: NextFunction) => { bbLog({ action: "route.error", outcome: redact(err?.type ?? err?.message ?? "error").slice(0, 60) }); fail(res, err?.status === 413 ? 413 : 500, err?.status === 413 ? "file_too_big" : "unknown"); });
  return r;
}
export default createBaleBotRouter();
// Supervisor: one settings SELECT per tick while flag.bale_bot is OFF. BALE_BOT_WORKER=0 disables it (tests / maintenance).
if (process.env.BALE_BOT_WORKER !== "0" && process.env.NODE_ENV !== "test") baleBotWorker.start();

/** Content-Type for a stored file: the declared mime only when the file's magic bytes agree (else octet-stream, so a mislabelled file is never rendered inline). */
export function bbServeType(full: string, mime: string | null): string {
  const mt = String(mime ?? "").toLowerCase(); let h = Buffer.alloc(0);
  try { const fd = fs.openSync(full, "r"); const b = Buffer.alloc(16); const n = fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); h = b.subarray(0, n); } catch { return "application/octet-stream"; }
  const at = (o: number, hex: string) => h.subarray(o, o + hex.length / 2).toString("hex") === hex;
  const ok: Record<string, boolean> = {
    "image/jpeg": at(0, "ffd8ff"), "image/png": at(0, "89504e470d0a1a0a"), "image/gif": at(0, "47494638"), "image/webp": at(0, "52494646") && at(8, "57454250"),
    "application/pdf": at(0, "255044462d"), "audio/ogg": at(0, "4f676753"), "audio/mpeg": at(0, "494433") || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0),
    "video/mp4": at(4, "66747970"), "audio/mp4": at(4, "66747970"), "audio/x-m4a": at(4, "66747970"),
  };
  return ok[mt] ? mt : "application/octet-stream";
}
