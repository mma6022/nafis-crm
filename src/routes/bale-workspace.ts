/**
 * «فضای کار بله» v1.0 routes (lib/bale-workspace.ts), behind requireApiAuth + expertLockdownGuard under /api.
 * flag.bale_workspace_v1 OFF → every route falls through with next("router") (404 as before; no schema, no tick work).
 * Experts: own chats / own customers only (locked experts additionally pass the lockdown guard's single-customer rule).
 * Sales manager + admin: every chat, plus «مدیریت فروش» automation (bulk / scenarios / no-reply / auto), plan terms, invite text, training files.
 * User 29 is never served. Ghasemi's bot never sends from here.
 */
import express, { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import type { AuthUser } from "../lib/auth";
import { queryRow, queryRows } from "../lib/crm-db";
import { BB_LIMITS, bbUser, nameOf, type BbUser } from "../lib/bale-bot";
import {
  BWS_NEVER_USER_IDS, BWS_NO_BALE_TEXT, K, adminState, audienceChats, bwsBotSendable, bwsCanManage, bwsChatFor, bwsCustomerAccess, bwsInvite, bwsInviteRefresh,
  bwsMe, bwsOn, bwsQueue, bwsSeesCustomer, bwsStageFile, bwsTick, ensureBwsSchema, explainedOf, fill, inviteView, invitesOf, parseAudience, planTermsMessage, plans,
  recordExplained, scenarioById, scenarioConfirm, scenarioSave, scenarioSetStatus, setBwsKick, setSetting, setStars, setTerms, starsOf, termsOf, trainingAdd,
  trainingDir, trainingList, trainingView, inSendHours,
} from "../lib/bale-workspace";
import { sabOn, sabQuickMessages } from "../lib/sales-admin-bale";
import { baleShOn, baleShReady } from "../lib/bale-sh-messages";
import { cpOn, cpView } from "../lib/credit-panel";
import { buildDossier } from "../lib/customer-dossier";
import { baleBotWorker } from "./bale-bot";
import { bfhCanViewWallet, bfhOn, bfhWallet } from "../lib/bale-fullheight";

const ERR_FA: Record<string, string> = {
  not_enabled: "فضای کار بله برای شما روشن نیست.", forbidden: "دسترسی ندارید.", not_found: "پیدا نشد.", not_linked: "این گفتگو هنوز به پرونده‌ی مشتری وصل نیست.",
  no_send: "از این ربات پیامی فرستاده نمی‌شود.", bad_stars: "ستاره باید ۰ تا ۳ باشد.", no_plans: "دست‌کم یک طرح با متن شرایط انتخاب کنید.",
  no_phone: "شماره‌ی موبایل مشتری ثبت نشده است.", rate_limited: "همین الان دعوت فرستاده شد؛ یک دقیقه صبر کنید.", bad_text: "متن خالی است یا از ۴۰۹۶ نویسه بیشتر است.",
  bad_name: "نام را بنویسید.", bad_kind: "نوع را انتخاب کنید.", bad_hours: "ساعت بی‌پاسخ باید ۱ تا ۷۲۰ باشد.", bad_file: "فایل آموزشی باید فعال و برای مشتری باشد.",
  not_draft: "فقط پیش‌نویس قابل تغییر یا تأیید است.", count_changed: "تعداد مخاطب عوض شد؛ دوباره ببینید و تأیید کنید.", bad_title: "عنوان را بنویسید.",
  bad_audience: "مخاطب را انتخاب کنید.", bad_plans: "دست‌کم یک طرح انتخاب کنید.", file_too_big: "فایل تا ۵۰ مگابایت.", bad_type: "فقط PDF، JPG، PNG یا ویدیوی MP4.",
  bad_url: "پیوند باید با https شروع شود.", not_customer_file: "فقط فایل‌های آموزشی با مخاطب مشتری برای مشتری فرستاده می‌شود.", unknown: "درخواست انجام نشد. دوباره تلاش کنید.",
};
const fail = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => { if (!res.headersSent) res.status(status).json({ error, message: ERR_FA[error] ?? ERR_FA.unknown, ...extra }); };
const num = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
const JOB_FA: Record<string, string> = { employee: "کارمند", retired: "بازنشسته", self_employed: "شغل آزاد", no_fixed_income: "بدون درآمد ثابت" };
const PURPOSE_FA: Record<string, string> = { goods: "خرید کالا", wedding: "ازدواج", medical: "درمان", home: "مسکن", business: "کسب‌وکار", other: "سایر" };
const STATUS_FA: Record<string, string> = { in_progress: "در حال انجام", cancelled: "لغو شده", completed: "اتمام", pending: "در انتظار", approved: "تأیید شده", rejected: "رد شده", requested: "درخواست شده", reviewing: "در حال بررسی" };

function context(u: BbUser, customerId: number) {
  const c = queryRow<any>("SELECT id,name,phone,national_code,salesperson_id,credit_grade,credit_rank,registration_source,lead_source,source FROM customers WHERE id=?", [customerId]);
  if (!c) return null;
  const owner = queryRow<any>("SELECT id,full_name,username FROM users WHERE salesperson_id=? AND role='salesperson' ORDER BY active DESC, id LIMIT 1", [c.salesperson_id ?? -1]);
  if (!bwsSeesCustomer(u, customerId)) return { restricted: true, customer: { id: c.id, name: c.name, expert: owner && !BWS_NEVER_USER_IDS.includes(owner.id) ? nameOf(owner) : null } };
  let dossier: Record<string, unknown> | null = null;
  try {
    const d = buildDossier(customerId, {});
    const site = [c.registration_source, c.lead_source, c.source].some((v: unknown) => /site|سایت/i.test(String(v ?? "")));
    dossier = { job: JOB_FA[d.job_status] ?? (d.job_status || null), purpose: PURPOSE_FA[d.loan_purpose] ?? (d.loan_purpose || d.planName || null),
      amountToman: d.amount ? Number(d.amount) : null, guarantor: (d.documents || []).includes("guarantor") ? "ضامن دارد" : (d.documents || []).length ? "بدون ضامن" : null,
      bounced: d.has_bounced_or_overdue === "yes" ? true : d.has_bounced_or_overdue === "no" ? false : null, fromSite: site };
  } catch { dossier = null; }
  let credit: Record<string, unknown> = { grade: c.credit_grade || c.credit_rank || null, panel: false };
  try {
    if (cpOn()) {
      const v = cpView(customerId);
      const col = v.parts.chequeColor.data as any; const un = v.parts.unpaidChequePro.data as any; const lo = (v.parts.activeLoans.data as any)?.info;
      credit = { ...credit, panel: true, lastAt: v.lastAt, valid: v.valid, colour: col?.chequeColor ?? null, colourCode: col?.chequeColorCode ?? null,
        bounced: un ? Number(un.count ?? (Array.isArray(un.chequeList) ? un.chequeList.length : 0)) : null, debtRial: lo?.debtTotalAmount != null ? Number(lo.debtTotalAmount) : null };
    }
  } catch { /* credit panel off or empty */ }
  const planName = new Map(plans().map(p => [p.id, p.name]));
  const cases = queryRows<any>("SELECT id, plan_id, status, stage, requested_amount, approved_amount, created_at FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 5", [customerId])
    .map(a => ({ id: a.id, plan: planName.get(Number(a.plan_id)) ?? null, status: STATUS_FA[a.status] ?? a.status ?? null, stage: a.stage ?? null, amount: a.approved_amount ?? a.requested_amount ?? null, at: a.created_at }));
  const calls = queryRows<any>("SELECT id, created_at, outcome, call_result, one_line_note, subject, salesperson_name_snapshot FROM call_logs WHERE customer_id=? ORDER BY id DESC LIMIT 6", [customerId])
    .map(l => ({ id: l.id, at: l.created_at, result: l.call_result || l.outcome || null, note: l.one_line_note || l.subject || null, by: l.salesperson_name_snapshot || null }));
  return {
    restricted: false,
    customer: { id: c.id, name: c.name, phone: c.phone, nationalCode: c.national_code || null, expert: owner && !BWS_NEVER_USER_IDS.includes(owner.id) ? nameOf(owner) : null },
    stars: starsOf(customerId), dossier, credit, cases, calls, explained: explainedOf(customerId), invites: invitesOf(customerId),
  };
}
function assets(u: BbUser, customerId?: number | null) {
  return {
    quick: sabOn() ? sabQuickMessages().map(q => ({ id: q.id, title: q.title })) : [],
    plans: plans().filter(p => p.active && termsOf(p.id)).map(p => ({ id: p.id, name: p.name })),
    training: trainingList({ audience: "expert" }),
    customerTraining: trainingList({ audience: "customer" }),
    canManage: bwsCanManage(u),
    ...(baleShOn() ? { ready: baleShReady(customerId ?? null) } : {}),
  };
}

export function createBaleWorkspaceRouter(opts: { kick?: () => void } = {}): IRouter {
  setBwsKick(opts.kick ?? (() => { setImmediate(() => { void baleBotWorker.flushOutbox(); }); }));
  const r: IRouter = Router();
  r.use("/bale-workspace", (_req: Request, res: Response, next: NextFunction) => {
    if (!bwsOn()) return next("router");
    ensureBwsSchema();
    const a = res.locals.authUser as AuthUser | undefined; const u = a ? bbUser(a.id) : undefined;
    if (!u || u.active === 0 || BWS_NEVER_USER_IDS.includes(u.id)) return fail(res, 403, "not_enabled");
    res.locals.bwsUser = u; next();
  });
  const U = (res: Response) => res.locals.bwsUser as BbUser;
  const mgr = (res: Response) => { const u = U(res); if (!bwsCanManage(u)) { fail(res, 403, "forbidden"); return null; } return u; };
  /** chat the caller may write in: visible + the bot sends (never Ghasemi's). */
  const writable = (u: BbUser, id: number, res: Response) => {
    const c = bwsChatFor(u, id); if (!c) { fail(res, 404, "not_found"); return null; }
    if (!bwsBotSendable(c.bot_id)) { fail(res, 409, "no_send"); return null; }
    return c;
  };

  r.get("/bale-workspace/me", (_req, res) => { const u = U(res); res.json({ ...bwsMe(u), noBaleText: BWS_NO_BALE_TEXT }); });

  /* الف: context column / tabs */
  r.get("/bale-workspace/chats/:id/context", (req, res) => {
    const u = U(res); const c = bwsChatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    res.json({ chatId: c.id, canSend: bwsBotSendable(c.bot_id), context: c.customer_id ? context(u, c.customer_id) : null, assets: assets(u, c.customer_id) });
  });
  /* t984 «گفتگوهای بله تمام‌قد»: the customer's wallet, read-only (flag.bale_fullheight_v1; OFF = 404 like any unknown route).
     Same visibility as the context column (bwsSeesCustomer) AND as GET /api/customers/:id/wallet (bfhCanViewWallet). Never creates an account, never writes. */
  r.get("/bale-workspace/chats/:id/wallet", (req, res) => {
    if (!bfhOn()) return fail(res, 404, "not_found");
    const u = U(res); const c = bwsChatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    if (!c.customer_id) return fail(res, 409, "not_linked");
    if (!bwsSeesCustomer(u, c.customer_id) || !bfhCanViewWallet(res.locals.authUser as AuthUser | undefined, c.customer_id)) return fail(res, 403, "forbidden");
    res.setHeader("Cache-Control", "no-store");
    res.json({ chatId: c.id, ...bfhWallet(c.customer_id) });
  });
  /* ج: stars (customer, 0 = clear) */
  r.post("/bale-workspace/chats/:id/stars", express.json({ limit: "2kb" }), (req, res) => {
    const u = U(res); const c = bwsChatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    if (!c.customer_id) return fail(res, 409, "not_linked");
    if (!bwsSeesCustomer(u, c.customer_id)) return fail(res, 403, "forbidden");
    const s = Number(req.body?.stars); if (!Number.isInteger(s) || s < 0 || s > 3) return fail(res, 400, "bad_stars");
    setStars(u, c.customer_id, s); res.json({ stars: starsOf(c.customer_id) });
  });
  /* و: plan terms */
  r.get("/bale-workspace/plans", (_req, res) => {
    res.json({ items: plans().filter(p => p.active).map(p => ({ id: p.id, name: p.name, terms: termsOf(p.id) })).filter(p => p.terms) });
  });
  r.post("/bale-workspace/chats/:id/plan-terms", express.json({ limit: "8kb" }), (req, res) => {
    const u = U(res); const c = writable(u, num(req.params.id), res); if (!c) return;
    if (!c.customer_id) return fail(res, 409, "not_linked");
    const ids: number[] = Array.isArray(req.body?.planIds) ? [...new Set<number>(req.body.planIds.map(Number).filter((n: number) => Number.isSafeInteger(n) && n > 0))].slice(0, 10) : [];
    const pm = new Map(plans().filter(p => p.active).map(p => [p.id, p.name]));
    const items = ids.map(id => ({ id, name: pm.get(id) ?? "", body: termsOf(id) ?? "" })).filter(i => i.name && i.body);
    if (!items.length) return fail(res, 400, "no_plans");
    const cust = queryRow<{ name: string }>("SELECT name FROM customers WHERE id=?", [c.customer_id]);
    const text = planTermsMessage(cust?.name ?? "", items);
    if ([...text].length > BB_LIMITS.textMax) return fail(res, 400, "bad_text");
    const mid = bwsQueue(c, u.id, { text });
    // existing rule: a plan's active file goes along only while bale_attachments_enabled = 1
    let files = 0;
    try {
      const on = queryRow<{ value: string }>("SELECT value FROM bale_settings WHERE key='bale_attachments_enabled'")?.value === "1";
      if (on) for (const i of items) {
        const f = queryRow<any>("SELECT * FROM bale_plan_files WHERE plan_id=? AND status='active'", [i.id]); if (!f) continue;
        const dir = process.env.BALE_PLAN_FILES_DIR || path.join(path.dirname(path.resolve(process.env.CRM_DATABASE_PATH || "crm.db")), "bale-plan-files");
        const abs = path.join(dir, f.stored_name); if (!fs.existsSync(abs)) continue;
        bwsQueue(c, u.id, { text: null, file: { name: f.display_name, mime: f.mime, size: f.size, rel: bwsStageFile(c.bot_id, abs, f.display_name), sendAs: f.mime.startsWith("image/") ? "photo" : "document" } }); files++;
      }
    } catch { /* plan files are optional */ }
    recordExplained(u, c.customer_id, c.id, items, mid);
    res.json({ ok: true, messageId: mid, files, explained: explainedOf(c.customer_id) });
  });
  /* ز: training files (staff read; customer files can be sent in a chat) */
  r.get("/bale-workspace/training", (_req, res) => { res.json({ items: trainingList() }); });
  r.get("/bale-workspace/training/:id/file", (req, res) => {
    const f = queryRow<any>("SELECT * FROM bws_training_files WHERE id=? AND active=1 AND kind!='link'", [num(req.params.id)]); if (!f) return fail(res, 404, "not_found");
    const abs = path.join(trainingDir(), path.basename(String(f.stored_name)));
    if (!fs.existsSync(abs)) return fail(res, 404, "not_found");
    res.setHeader("Content-Type", f.mime); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`); res.setHeader("Cache-Control", "private, no-store");
    fs.createReadStream(abs).pipe(res);
  });
  r.post("/bale-workspace/chats/:id/training/:fid", (req, res) => {
    const u = U(res); const c = writable(u, num(req.params.id), res); if (!c) return;
    const f = queryRow<any>("SELECT * FROM bws_training_files WHERE id=? AND active=1", [num(req.params.fid)]); if (!f) return fail(res, 404, "not_found");
    if (f.audience !== "customer") return fail(res, 403, "not_customer_file");
    const id = f.kind === "link" ? bwsQueue(c, u.id, { text: `${f.title}\n${f.url}` })
      : bwsQueue(c, u.id, { text: f.title, file: { name: f.file_name, mime: f.mime, size: f.size, rel: bwsStageFile(c.bot_id, path.join(trainingDir(), f.stored_name), f.file_name), sendAs: f.kind === "video" ? "video" : "document" } });
    res.json({ ok: true, messageId: id });
  });
  /* ه: invite (Bale + SMS). Today card (customer id) or the chat's linked customer. */
  r.get("/bale-workspace/customers/:id/brief", (req, res) => {
    const u = U(res); const cid = num(req.params.id); const c = bwsCustomerAccess(u, cid); if (!c) return fail(res, 403, "forbidden");
    const chat = queryRow<{ id: number }>("SELECT c.id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id WHERE c.customer_id=? AND b.user_id NOT IN (3,29) ORDER BY COALESCE(c.last_at,c.created_at) DESC LIMIT 1", [cid]);
    const visibleChat = chat && bwsChatFor(u, chat.id) ? chat.id : null;
    res.json({ customerId: cid, chatId: visibleChat, invites: invitesOf(cid), stars: starsOf(cid) });
  });
  r.post("/bale-workspace/customers/:id/invite", async (req, res) => {
    const u = U(res); const out = await bwsInvite(u, num(req.params.id));
    if (!out.ok) return fail(res, out.error === "forbidden" ? 403 : out.error === "rate_limited" ? 429 : 400, out.error);
    res.json(out);
  });
  r.post("/bale-workspace/chats/:id/invite", async (req, res) => {
    const u = U(res); const c = bwsChatFor(u, num(req.params.id)); if (!c) return fail(res, 404, "not_found");
    if (!c.customer_id) return fail(res, 409, "not_linked");
    const out = await bwsInvite(u, c.customer_id);
    if (!out.ok) return fail(res, out.error === "forbidden" ? 403 : out.error === "rate_limited" ? 429 : 400, out.error);
    res.json(out);
  });
  r.get("/bale-workspace/invites/:id", (req, res) => {
    const u = U(res); const row = queryRow<any>("SELECT * FROM bws_invites WHERE id=?", [num(req.params.id)]);
    if (!row || !bwsCustomerAccess(u, row.customer_id)) return fail(res, 404, "not_found");
    res.json({ invite: inviteView(bwsInviteRefresh(row.id)) });
  });

  /* د + ز + و: «مدیریت فروش» (sales manager + admin only) */
  r.get("/bale-workspace/admin/state", (_req, res) => { if (!mgr(res)) return; res.json(adminState()); });
  r.put("/bale-workspace/admin/invite", express.json({ limit: "8kb" }), (req, res) => {
    const u = mgr(res); if (!u) return;
    const text = String(req.body?.text ?? "").trim(); if (!text || [...text].length > 1000) return fail(res, 400, "bad_text");
    setSetting(K.inviteText, text, u.id);
    if (typeof req.body?.smsPattern === "string") setSetting(K.smsPattern, req.body.smsPattern.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40), u.id);
    res.json(adminState());
  });
  r.put("/bale-workspace/admin/auto", express.json({ limit: "1kb" }), (req, res) => { const u = mgr(res); if (!u) return; setSetting(K.autoOn, req.body?.on === true ? "1" : "0", u.id); res.json(adminState()); });
  r.put("/bale-workspace/admin/plan-terms/:planId", express.json({ limit: "8kb" }), (req, res) => {
    const u = mgr(res); if (!u) return; const pid = num(req.params.planId);
    if (!plans().some(p => p.id === pid)) return fail(res, 404, "not_found");
    setTerms(u, pid, String(req.body?.body ?? "")); res.json(adminState());
  });
  r.post("/bale-workspace/admin/scenarios/preview", express.json({ limit: "4kb" }), (req, res) => {
    if (!mgr(res)) return; const a = parseAudience(req.body?.audience); const chats = audienceChats(a);
    res.json({ count: chats.length, audience: a, inSendHours: inSendHours() });
  });
  r.post("/bale-workspace/admin/scenarios", express.json({ limit: "16kb" }), (req, res) => {
    const u = mgr(res); if (!u) return; const out = scenarioSave(u, req.body ?? {});
    if (!out.ok) return fail(res, out.error === "not_found" ? 404 : 400, out.error); res.json(out);
  });
  r.post("/bale-workspace/admin/scenarios/:id/confirm", express.json({ limit: "1kb" }), (req, res) => {
    const u = mgr(res); if (!u) return; const out = scenarioConfirm(u, num(req.params.id), Number(req.body?.count));
    if (!out.ok) return fail(res, out.error === "not_found" ? 404 : 409, out.error, out.count != null ? { count: out.count } : {}); res.json(out);
  });
  for (const to of ["pause", "resume"] as const) r.post(`/bale-workspace/admin/scenarios/:id/${to}`, (req, res) => {
    const u = mgr(res); if (!u) return; const ok = scenarioSetStatus(u, num(req.params.id), to === "pause" ? "paused" : "active");
    if (!ok) return fail(res, 409, "not_found"); res.json({ scenario: scenarioById(num(req.params.id)) });
  });
  r.get("/bale-workspace/admin/scenarios/:id", (req, res) => { if (!mgr(res)) return; const s = scenarioById(num(req.params.id)); if (!s) return fail(res, 404, "not_found"); res.json({ scenario: s }); });
  r.post("/bale-workspace/admin/training", express.raw({ type: (rq) => !String(rq.headers["content-type"] ?? "").startsWith("application/json"), limit: 50 * 1024 * 1024 + 1024 }), express.json({ limit: "8kb" }), (req, res) => {
    const u = mgr(res); if (!u) return;
    let meta: any = req.body;
    let buf: Buffer | null = null;
    if (Buffer.isBuffer(req.body)) { buf = req.body; try { meta = JSON.parse(decodeURIComponent(String(req.headers["x-bws-meta"] ?? "{}"))); } catch { meta = {}; } }
    const out = trainingAdd(u, { title: meta?.title, audience: meta?.audience, planScope: meta?.planScope, planIds: Array.isArray(meta?.planIds) ? meta.planIds : [], url: meta?.url ?? null, buf, fileName: meta?.fileName ?? null });
    if (!out.ok) return fail(res, out.error === "file_too_big" ? 413 : 400, out.error);
    res.json({ item: trainingView(queryRow("SELECT * FROM bws_training_files WHERE id=?", [out.id])), state: adminState() });
  });
  r.post("/bale-workspace/admin/training/:id/delete", (req, res) => {
    const u = mgr(res); if (!u) return;
    const n = queryRow("SELECT 1 x FROM bws_training_files WHERE id=? AND active=1", [num(req.params.id)]); if (!n) return fail(res, 404, "not_found");
    queryRows("UPDATE bws_training_files SET active=0, updated_at=? WHERE id=? RETURNING id", [new Date().toISOString(), num(req.params.id)]);
    res.json(adminState());
  });
  r.use("/bale-workspace", (err: any, _req: Request, res: Response, _next: NextFunction) => { fail(res, err?.status === 413 ? 413 : 500, err?.status === 413 ? "file_too_big" : "unknown"); });
  return r;
}

/** Scenario tick: one settings read while OFF; BALE_BOT_WORKER=0 / tests disable it. */
export function startBwsTicker(): void {
  if (process.env.BALE_BOT_WORKER === "0" || process.env.NODE_ENV === "test") return;
  const t = setInterval(() => { try { if (bwsOn()) bwsTick(); } catch { /* next tick */ } }, 60_000); t.unref?.();
}
export default createBaleWorkspaceRouter();
startBwsTicker();
