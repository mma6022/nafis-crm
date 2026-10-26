/**
 * «حساب شخصی بله» — an expert's own Bale account inside the CRM.
 *
 * Piece 1a: connect (secure wizard), read-only «گفتگوی بله», switches, audit.
 *  - Admin master switch (bale_settings.master_enabled, default OFF) and a per-expert mode off | approve_first | auto
 *    (default off). Connecting needs the master switch ON; switching it OFF never deletes sessions.
 *  - Who may connect: active sales experts only; trainees (salesperson 5/19/20), user 29 and every other role never.
 *  - Login: API ↔ local sidecar (lib/bale-sidecar-client.ts). The sidecar keeps the Bale transaction_hash in memory;
 *    the API keeps only an opaque flowId per user (memory, 5 min). The code / 2FA password are never stored, logged or
 *    audited. The resulting session token is sealed with AES-256-GCM (lib/bale-crypto.ts, BALE_SESSION_KEY_FILE) and
 *    is never returned by any endpoint. Max 3 login starts per expert per hour; max 5 code / password tries per flow.
 *  - Disconnect (expert or admin): sidecar SignOut first, then the sealed session is deleted (also when SignOut fails —
 *    the expert is told to end the session in Bale › دستگاه‌های فعال).
 *  - «گفتگوی بله» tab: admin (not 29) every customer; sales expert only customers whose salesperson_id is theirs;
 *    trainees, user 29 and every other role → 403. Out-of-scope customer → 404 (+ audit).
 * Piece 1b (lib/bale-outbox.ts): messages to customers ONLY on the expert's own command, the expert's reminder «پیام به مشتری»
 *  or the expert's own sales assistant (runner POST /bale/send); «اول تأیید من» drafts; caps / random gaps / quiet hours;
 *  banned-word + «نقد/کالا/امتیاز» filter; auto-stop on Bale errors; inbound listener (own customers only) → tab, bell,
 *  assistant event; sessions re-attached after a sidecar restart. Still no SMS; document intake / auto-reply = piece 2.
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensureSchemaObject } from "./schema-objects";
import { createBaleTest, ensureBaleTestSchema } from "./bale-test";
import { TRAINEE_SALESPERSON_IDS, EXCLUDED_USER_IDS, BANNED_WORDS } from "./assistants";
import { baleHasKey, baleSessionAad, baleSidecarToken, openBaleSession, sealBaleSession, BaleKeyMissing, type KeyEnv } from "./bale-crypto";
import { BaleSidecarError, type BaleSidecar } from "./bale-sidecar-client";
import { createBaleOutbox, ensureBaleOutboxSchema, BLOCK_FA } from "./bale-outbox";
import multer from "multer";
import { ensureCustomerBaleLinks, matchContacts, maskPhone, normMobile, peerTag, type BaleScanContact, type MatchRow } from "./bale-contact-links";
import { createBalePlanFiles, ensureBalePlanFilesSchema, BALE_PLAN_FILE_MAX_BYTES, BALE_PLAN_FILE_TYPES } from "./bale-plan-files";

type Db = DatabaseSync;
export type BaleActor = { id: number } | null;
export type BaleDeps = { db: Db; env: () => KeyEnv; sidecar: BaleSidecar; now?: () => Date; actor: (res: Response) => BaleActor; random?: () => number;
  /** Where plan files live (<data dir>/bale-plan-files). Absent → no plan files at all. */
  planFilesDir?: string };

export const BALE_MODES = ["off", "approve_first", "auto"] as const;
export type BaleMode = typeof BALE_MODES[number];
export const BALE_LOGIN_STARTS_PER_HOUR = 3;
export const BALE_FLOW_TTL_MS = 5 * 60_000;
export const BALE_MAX_TRIES_PER_FLOW = 5;
/** Send limits (read by lib/bale-outbox.ts on every enqueue and send). */
export const BALE_DEFAULT_SETTINGS: Record<string, string> = {
  master_enabled: "0", gap_min_s: "45", gap_max_s: "120", per_hour: "20", per_day: "80", new_chats_per_day: "15",
  quiet_start: "21:30", quiet_end: "08:30", banned_words: JSON.stringify(BANNED_WORDS),
  // PM decision (b): "one customer blocked the expert" is UNVERIFIED on real Bale → default stays the safe whole-account stop.
  // conversation_pause (only that chat pauses) may be switched on by an admin only after the test-SIM check.
  peer_block_mode: "account_stop",
  // «حساب تستی» (system-owned spare SIM): its own switch, default OFF, independent of master_enabled.
  test_enabled: "0",
  // Plan files over Bale (PDF / image of a plan, always an expert-approved draft): its own switch, default OFF.
  bale_attachments_enabled: "0",
};
export const BALE_PEER_BLOCK_MODES = ["account_stop", "conversation_pause"] as const;

export function ensureBaleSchema(db: Db, nowIso = new Date().toISOString()): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS bale_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, salesperson_id INTEGER, phone_masked TEXT,
    bale_user_id TEXT, session_ct TEXT, session_key_id TEXT, device_hash TEXT NOT NULL, device_title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('connected','disconnected','banned','error')),
    mode TEXT NOT NULL DEFAULT 'off' CHECK(mode IN ('off','approve_first','auto')),
    connected_at TEXT, last_seen_at TEXT, last_error TEXT, disconnected_at TEXT, disconnected_by INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bale_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_user_id INTEGER);
  CREATE TABLE IF NOT EXISTS bale_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES bale_accounts(id), customer_id INTEGER NOT NULL,
    peer_id TEXT, first_contact_at TEXT, has_prior_chat INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(account_id, customer_id));
  CREATE TABLE IF NOT EXISTS bale_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES bale_accounts(id), customer_id INTEGER NOT NULL, text TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('expert_command','reminder','assistant','auto_reply')), explicit_expert_command INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending_approval' CHECK(status IN ('pending_approval','queued','sending','sent','failed','blocked','cancelled')),
    block_reason TEXT, approved_by INTEGER, scheduled_at TEXT, sent_at TEXT, bale_msg_id TEXT, error TEXT, created_by INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bale_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES bale_accounts(id), customer_id INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('in','out')), text TEXT, file_ref TEXT, bale_msg_id TEXT, outbox_id INTEGER,
    status TEXT, created_at TEXT NOT NULL, UNIQUE(account_id, bale_msg_id));
  CREATE TABLE IF NOT EXISTS bale_conversation_state (
    customer_id INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES bale_accounts(id),
    mode TEXT NOT NULL DEFAULT 'human' CHECK(mode IN ('assistant','human')), handed_off_reason TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY(customer_id, account_id));
  CREATE TABLE IF NOT EXISTS bale_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, actor_label TEXT, account_id INTEGER, customer_id INTEGER,
    action TEXT NOT NULL, outcome TEXT NOT NULL, ip TEXT, detail_json TEXT);
  `);
  ensureSchemaObject(db, "index", "idx_bale_messages_customer", "CREATE INDEX idx_bale_messages_customer ON bale_messages(customer_id, id)");
  ensureSchemaObject(db, "index", "idx_bale_outbox_account", "CREATE INDEX idx_bale_outbox_account ON bale_outbox(account_id, status, id)");
  ensureSchemaObject(db, "index", "idx_bale_audit_user", "CREATE INDEX idx_bale_audit_user ON bale_audit(user_id, action, id)");
  ensureSchemaObject(db, "index", "idx_bale_contacts_customer", "CREATE INDEX idx_bale_contacts_customer ON bale_contacts(customer_id)");
  ensureBaleOutboxSchema(db);
  ensureBaleTestSchema(db);
  ensureBalePlanFilesSchema(db);
  ensureCustomerBaleLinks(db);
  const ins = db.prepare("INSERT OR IGNORE INTO bale_settings(key,value,updated_at) VALUES(?,?,?)");
  for (const [k, v] of Object.entries(BALE_DEFAULT_SETTINGS)) ins.run(k, v, nowIso);
}

/** Persian/Arabic digits → ASCII; +98 / 0098 / 98 → 0. Returns 09xxxxxxxxx or null. */
export function normalizeIranMobile(raw: unknown): string | null {
  let s = String(raw ?? "").replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[\s\-()]/g, "");
  if (s.startsWith("+98")) s = "0" + s.slice(3); else if (s.startsWith("0098")) s = "0" + s.slice(4); else if (/^98\d{10}$/.test(s)) s = "0" + s.slice(2);
  return /^09\d{9}$/.test(s) ? s : null;
}
export const maskMobile = (p: string) => `${p.slice(0, 4)}•••${p.slice(-2)}`;
const asciiDigits = (raw: unknown) => String(raw ?? "").replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\s/g, "");

/** Who may connect a personal Bale account: active, non-trainee sales experts; never user 29. */
export function baleEligible(u: { id: number; role: string; salesperson_id: number | null; active?: number } | undefined | null): boolean {
  if (!u || EXCLUDED_USER_IDS.includes(u.id) || u.active === 0) return false;
  return u.role === "salesperson" && Boolean(u.salesperson_id) && !TRAINEE_SALESPERSON_IDS.includes(Number(u.salesperson_id));
}
/** Who may open the «گفتگوی بله» tab at all (customer scope checked separately). */
export function baleChatViewer(u: { id: number; role: string; salesperson_id: number | null; active?: number } | undefined | null): "all" | "own" | null {
  if (!u || EXCLUDED_USER_IDS.includes(u.id) || u.active === 0) return null;
  if (u.role === "admin") return "all";
  return baleEligible(u) ? "own" : null;
}

const ERR_FA: Record<string, string> = {
  bale_disabled: "اتصال بله فعلاً از طرف مدیر خاموش است.",
  not_eligible: "اتصال حساب بله فقط برای کارشناس‌های فروش فعال است.",
  key_missing: "کلید رمزنگاری نشست بله روی سرور تنظیم نشده است. به مدیر خبر بدهید.",
  sidecar_not_configured: "سرویس بله روی سرور راه‌اندازی نشده است. به مدیر خبر بدهید.",
  sidecar_unavailable: "سرویس بله الان در دسترس نیست. چند دقیقه‌ی دیگر دوباره امتحان کنید.",
  sidecar_bad_response: "پاسخ سرویس بله نامعتبر بود. دوباره امتحان کنید.",
  phone_invalid: "شماره‌ی موبایل درست نیست. مثل ۰۹۱۲۱۲۳۴۵۶۷ وارد کنید.",
  rate_limited: "بله فعلاً اجازه‌ی ارسال کد نمی‌دهد. کمی بعد دوباره امتحان کنید.",
  too_many_starts: "در یک ساعت حداکثر ۳ بار می‌شود کد گرفت. کمی بعد دوباره امتحان کنید.",
  number_banned: "این شماره در بله مسدود است.",
  wrong_code: "کد درست نیست. دوباره نگاه کنید و وارد کنید.",
  code_expired: "کد منقضی شده است. از اول شروع کنید.",
  flow_expired: "زمان ورود تمام شد. از اول شروع کنید.",
  no_flow: "ورودی در جریان نیست. از اول شروع کنید.",
  too_many_tries: "تعداد تلاش زیاد شد. از اول شروع کنید.",
  sign_up_needed: "این شماره حساب بله ندارد. اول در اپ بله ثبت‌نام کنید.",
  wrong_password: "رمز دومرحله‌ای درست نیست.",
  bad_code: "کد باید ۴ تا ۶ رقم باشد.",
  bad_password: "رمز دومرحله‌ای را وارد کنید.",
  not_connected: "حساب بله وصل نیست.",
  bad_mode: "حالت نامعتبر است.",
  already_connected: "حساب بله‌ی شما همین الان وصل است.",
  unauthorized: "سرویس بله درخواست را نپذیرفت. به مدیر خبر بدهید.",
  unknown: "خطای ناشناخته از بله. دوباره امتحان کنید.",
  forbidden: "دسترسی ندارید.",
  scan_too_soon: "اسکن بله هر ۵ دقیقه یک بار ممکن است. کمی بعد دوباره امتحان کنید.",
  not_attached: "اتصال بله‌ی این حساب هنوز کامل نشده است. یک دقیقه‌ی دیگر دوباره امتحان کنید.",
  session_invalid: "نشست بله منقضی شده است. حساب بله را دوباره وصل کنید.",
  account_banned: "حساب بله مسدود است.",
  timeout: "بله دیر جواب داد. کمی بعد دوباره امتحان کنید.",
  client_error: "خواندن فهرست مخاطب‌ها از بله ممکن نشد. کمی بعد دوباره امتحان کنید.",
  scan_expired: "نتیجه‌ی اسکن قدیمی شده است. دوباره اسکن کنید.",
  bad_request: "درخواست نامعتبر است.",
  not_found: "پیدا نشد.",
};

export function createBale(deps: BaleDeps) {
  const db = deps.db;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const row = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T | undefined;
  const rows = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const ip = (req: Request) => String((req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "").slice(0, 64);
  const fail = (res: Response, status: number, error: string) => { if (!res.headersSent) res.status(status).json({ error, message: ERR_FA[error] ?? ERR_FA.unknown }); };
  const setting = (k: string) => row<{ value: string }>("SELECT value FROM bale_settings WHERE key=?", k)?.value ?? BALE_DEFAULT_SETTINGS[k];
  const masterOn = () => setting("master_enabled") === "1";
  const userRow = (id: number) => row<any>("SELECT id,role,salesperson_id,active,full_name,username FROM users WHERE id=?", id);
  const nameOf = (u: any) => u ? (u.full_name || u.username || `کاربر ${u.id}`) : null;
  const me = (res: Response) => { const a = deps.actor(res); return a ? userRow(a.id) : undefined; };
  /** Audit detail is whitelisted: never a phone, code, password, token or message text. */
  function audit(o: { req?: Request; u?: any; accountId?: number | null; customerId?: number | null; action: string; outcome: string; detail?: Record<string, string | number | boolean | null> }) {
    run("INSERT INTO bale_audit(at,user_id,actor_label,account_id,customer_id,action,outcome,ip,detail_json) VALUES(?,?,?,?,?,?,?,?,?)",
      iso(), o.u?.id ?? null, nameOf(o.u), o.accountId ?? null, o.customerId ?? null, o.action, o.outcome, o.req ? ip(o.req) : null,
      o.detail ? JSON.stringify(o.detail) : null);
  }
  const accountOf = (userId: number) => row<any>("SELECT * FROM bale_accounts WHERE user_id=? AND kind<>'system_test'", userId);
  const testOn = () => setting("test_enabled") === "1";
  const attachmentsOn = () => setting("bale_attachments_enabled") === "1";
  const planFiles = deps.planFilesDir ? createBalePlanFiles({ db, dir: deps.planFilesDir, now, nameOf: id => (id == null ? null : nameOf(userRow(id))) }) : undefined;
  let test: ReturnType<typeof createBaleTest>;
  const outbox = createBaleOutbox({ db, now, env: deps.env, sidecar: deps.sidecar, random: deps.random, setting, masterOn, userRow, nameOf, eligible: baleEligible,
    audit: o => audit(o), testOn, testInbound: (a, evs) => test.inbound(a, evs), planFiles, attachmentsOn });
  test = createBaleTest({ db, now, env: deps.env, sidecar: deps.sidecar, random: deps.random, setting, nameOf, userRow, audit: o => audit(o),
    normalize: normalizeIranMobile, mask: maskMobile, asciiDigits, syncSessions: () => outbox.syncSessions(true) });

  /* ------------- login flows: memory only (flowId is opaque; the Bale transaction_hash never leaves the sidecar) ------------- */
  type Flow = { flowId: string; step: "code" | "password"; expiresAt: number; phoneMasked: string; deviceHash: string; deviceTitle: string; tries: number; codeType: string };
  const flows = new Map<number, Flow>();
  const liveFlow = (userId: number) => { const f = flows.get(userId); if (f && f.expiresAt <= now().getTime()) { flows.delete(userId); return undefined; } return f; };
  const startsLastHour = (userId: number) => Number(row<any>("SELECT count(*) n FROM bale_audit WHERE user_id=? AND action='connect.start' AND at>?",
    userId, new Date(now().getTime() - 3600_000).toISOString())?.n ?? 0);

  function accountView(a: any) {
    if (!a) return null;
    const c = (sql: string) => Number(row<any>(sql, a.id)?.n ?? 0);
    return { id: a.id, status: a.status, mode: a.mode, phoneMasked: a.phone_masked, connectedAt: a.connected_at, lastSeenAt: a.last_seen_at,
      lastError: a.last_error, disconnectedAt: a.disconnected_at, hasSession: Boolean(a.session_ct),
      stoppedReason: a.stopped_reason ?? null,
      session: a.status === "connected" ? outbox.liveState(a) : null, // live | down («اتصال ناقص، در حال رفع») | unknown
      pendingApproval: c("SELECT count(*) n FROM bale_outbox WHERE account_id=? AND status='pending_approval'"),
      queued: c("SELECT count(*) n FROM bale_outbox WHERE account_id=? AND status IN ('queued','sending')"),
      sentToday: Number(row<any>("SELECT count(*) n FROM bale_outbox WHERE account_id=? AND status='sent' AND sent_at>?", a.id, new Date(now().getTime() - 86_400_000).toISOString())?.n ?? 0),
      inboundIgnored: Number(a.inbound_ignored ?? 0), unknownOpen: c("SELECT count(*) n FROM bale_unknown_chats WHERE account_id=? AND status='open'") };
  }
  function meView(u: any) {
    const f = liveFlow(u.id);
    return { eligible: baleEligible(u), masterEnabled: masterOn(), ready: baleHasKey(deps.env()) && deps.sidecar.configured(),
      account: accountView(accountOf(u.id)), flow: f ? { step: f.step, expiresAt: new Date(f.expiresAt).toISOString(), phoneMasked: f.phoneMasked, codeType: f.codeType } : null,
      startsLeft: Math.max(0, BALE_LOGIN_STARTS_PER_HOUR - startsLastHour(u.id)) };
  }
  const sidecarFail = (res: Response, e: unknown) => {
    if (e instanceof BaleSidecarError) return fail(res, ["phone_invalid", "wrong_code", "wrong_password", "sign_up_needed"].includes(e.code) ? 422
      : ["rate_limited"].includes(e.code) ? 429 : ["code_expired", "flow_expired"].includes(e.code) ? 410 : 502, e.code);
    if (e instanceof BaleKeyMissing) return fail(res, 503, "key_missing");
    console.error("bale error", (e as Error)?.name); return fail(res, 500, "unknown");
  };

  /** Seal the token onto the expert's row (insert or update) — the token is never returned or logged. */
  function storeConnected(req: Request, u: any, f: Flow, c: { token: string; baleUserId: string | null }) {
    const t = iso(); let a = accountOf(u.id);
    if (!a) {
      run(`INSERT INTO bale_accounts(user_id,salesperson_id,phone_masked,device_hash,device_title,status,mode,created_at,updated_at) VALUES(?,?,?,?,?,'disconnected','off',?,?)`,
        u.id, u.salesperson_id, f.phoneMasked, f.deviceHash, f.deviceTitle, t, t);
      a = accountOf(u.id);
    }
    const sealed = sealBaleSession(deps.env(), c.token, baleSessionAad(a.id, u.id));
    run(`UPDATE bale_accounts SET salesperson_id=?, phone_masked=?, bale_user_id=?, session_ct=?, session_key_id=?, device_hash=?, device_title=?, status='connected',
      connected_at=?, last_seen_at=?, last_error=NULL, disconnected_at=NULL, disconnected_by=NULL, updated_at=? WHERE id=?`,
      u.salesperson_id, f.phoneMasked, c.baleUserId, sealed.value, sealed.keyId, f.deviceHash, f.deviceTitle, t, t, t, a.id);
    flows.delete(u.id);
    audit({ req, u, accountId: a.id, action: "connect.connected", outcome: "ok", detail: { keyId: sealed.keyId } });
    void outbox.syncSessions(true).catch(() => undefined); // start the listener / sender client now
  }

  /** SignOut on Bale first, then delete the sealed session (also when SignOut fails). */
  async function disconnect(req: Request, actorU: any, a: any, by: "expert" | "admin") {
    let remote: "ok" | "failed" | "no_session" = "no_session";
    if (a.session_ct) {
      try {
        const { plaintext } = openBaleSession(deps.env(), a.session_ct, baleSessionAad(a.id, a.user_id));
        await deps.sidecar.signOut({ accountRef: `acc-${a.id}`, token: plaintext, deviceHash: a.device_hash });
        remote = "ok";
      } catch (e) { remote = "failed"; if (!(e instanceof BaleSidecarError) && !(e instanceof BaleKeyMissing)) console.error("bale signout", (e as Error)?.name); }
    }
    const t = iso();
    run(`UPDATE bale_accounts SET session_ct=NULL, session_key_id=NULL, status='disconnected', mode='off', disconnected_at=?, disconnected_by=?,
      last_error=?, updated_at=? WHERE id=?`, t, actorU.id, remote === "failed" ? "signout_failed" : null, t, a.id);
    run("UPDATE bale_outbox SET status='blocked', block_reason='not_connected', updated_at=? WHERE account_id=? AND status IN ('pending_approval','queued')", t, a.id);
    void deps.sidecar.detach({ accountRef: `acc-${a.id}` });
    flows.delete(a.user_id);
    audit({ req, u: actorU, accountId: a.id, action: `disconnect.${by}`, outcome: "ok", detail: { remoteSignOut: remote } });
    return remote;
  }

  /* ================= staff router (session; mounted under /api) ================= */
  const staff = Router();
  staff.use(["/bale", "/admin/bale"], (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const expert = (req: Request, res: Response, next: NextFunction) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    if (!baleEligible(u)) { audit({ req, u, action: `${req.method} ${req.path}`, outcome: "forbidden" }); return fail(res, 403, "not_eligible"); }
    res.locals.baleUser = u; next();
  };

  staff.get("/bale/me", (_req, res) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    res.json(meView(u));
  });

  staff.post("/bale/connect/start", expert, async (req, res) => {
    const u = res.locals.baleUser;
    if (!masterOn()) { audit({ req, u, action: "connect.start", outcome: "disabled" }); return fail(res, 423, "bale_disabled"); }
    if (!baleHasKey(deps.env())) return fail(res, 503, "key_missing");
    if (!deps.sidecar.configured()) return fail(res, 503, "sidecar_not_configured");
    const a = accountOf(u.id);
    if (a?.status === "connected" && a.session_ct) return fail(res, 409, "already_connected");
    const phone = normalizeIranMobile(req.body?.phone);
    if (!phone) return fail(res, 422, "phone_invalid");
    if (startsLastHour(u.id) >= BALE_LOGIN_STARTS_PER_HOUR) { audit({ req, u, action: "connect.start_limited", outcome: "rate_limited" }); return fail(res, 429, "too_many_starts"); }
    const old = liveFlow(u.id); if (old) { flows.delete(u.id); void deps.sidecar.cancel({ flowId: old.flowId }); }
    // Per-expert device id: stable for this expert (reused on reconnect), never the library's shared default.
    const deviceHash = a?.device_hash ?? randomUUID();
    const deviceTitle = "Nafis CRM, Linux";
    const masked = maskMobile(phone);
    try {
      const r = await deps.sidecar.startAuth({ accountRef: `user-${u.id}`, phone, deviceHash, deviceTitle });
      flows.set(u.id, { flowId: r.flowId, step: "code", expiresAt: now().getTime() + Math.min(BALE_FLOW_TTL_MS, r.expiresInS * 1000), phoneMasked: masked, deviceHash, deviceTitle, tries: 0, codeType: r.codeType });
      audit({ req, u, accountId: a?.id ?? null, action: "connect.start", outcome: "ok", detail: { phone: masked, codeType: r.codeType } });
      res.json(meView(u));
    } catch (e) {
      audit({ req, u, accountId: a?.id ?? null, action: "connect.start", outcome: e instanceof BaleSidecarError ? e.code : "error", detail: { phone: masked } });
      sidecarFail(res, e);
    }
  });

  async function step(req: Request, res: Response, kind: "code" | "password") {
    const u = res.locals.baleUser;
    if (!masterOn()) { flows.delete(u.id); return fail(res, 423, "bale_disabled"); }
    const f = liveFlow(u.id);
    if (!f) return fail(res, 410, "no_flow");
    if (f.step !== kind) return fail(res, 409, "no_flow");
    let secret: string;
    if (kind === "code") { secret = asciiDigits(req.body?.code); if (!/^\d{4,6}$/.test(secret)) return fail(res, 422, "bad_code"); }
    else { secret = String(req.body?.password ?? ""); if (!secret || secret.length > 256) return fail(res, 422, "bad_password"); }
    if (f.tries >= BALE_MAX_TRIES_PER_FLOW) { flows.delete(u.id); void deps.sidecar.cancel({ flowId: f.flowId }); return fail(res, 429, "too_many_tries"); }
    f.tries++;
    try {
      const r = kind === "code" ? await deps.sidecar.submitCode({ flowId: f.flowId, code: secret }) : await deps.sidecar.submitPassword({ flowId: f.flowId, password: secret });
      if (r.status === "password_needed") {
        f.step = "password"; f.tries = 0;
        audit({ req, u, action: "connect.code", outcome: "password_needed" });
        return res.json(meView(u));
      }
      storeConnected(req, u, f, r);
      res.json(meView(u));
    } catch (e) {
      const code = e instanceof BaleSidecarError ? e.code : e instanceof BaleKeyMissing ? "key_missing" : "error";
      audit({ req, u, action: `connect.${kind}`, outcome: code, detail: { tries: f.tries } });
      if (code === "code_expired" || code === "flow_expired") flows.delete(u.id);
      sidecarFail(res, e);
    }
  }
  staff.post("/bale/connect/code", expert, (req, res) => step(req, res, "code"));
  staff.post("/bale/connect/password", expert, (req, res) => step(req, res, "password"));
  staff.post("/bale/connect/cancel", expert, (req, res) => {
    const u = res.locals.baleUser; const f = liveFlow(u.id);
    if (f) { flows.delete(u.id); void deps.sidecar.cancel({ flowId: f.flowId }); audit({ req, u, action: "connect.cancel", outcome: "ok" }); }
    res.json(meView(u));
  });
  staff.put("/bale/me/mode", expert, (req, res) => {
    const u = res.locals.baleUser; const mode = String(req.body?.mode ?? "") as BaleMode;
    if (!BALE_MODES.includes(mode)) return fail(res, 422, "bad_mode");
    const a = accountOf(u.id); if (!a || a.status !== "connected") return fail(res, 409, "not_connected");
    run("UPDATE bale_accounts SET mode=?, stopped_reason=NULL, updated_at=? WHERE id=?", mode, iso(), a.id);
    audit({ req, u, accountId: a.id, action: "mode.expert", outcome: "ok", detail: { from: a.mode, to: mode } });
    res.json(meView(u));
  });
  staff.post("/bale/me/disconnect", expert, async (req, res) => {
    const u = res.locals.baleUser; const a = accountOf(u.id);
    if (!a || (!a.session_ct && a.status !== "connected")) return fail(res, 409, "not_connected");
    const remote = await disconnect(req, u, a, "expert");
    res.json({ ...meView(u), remoteSignOut: remote });
  });

  /* ---------------- «گفتگوی بله» (read-only) ---------------- */
  staff.get("/bale/customers/:id/messages", (req, res) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    const scope = baleChatViewer(u); const cid = Number(req.params.id);
    if (!scope) { audit({ req, u, customerId: Number.isSafeInteger(cid) ? cid : null, action: "chat.view", outcome: "forbidden" }); return fail(res, 403, "not_eligible"); }
    const c = Number.isSafeInteger(cid) && cid > 0 ? row<any>("SELECT id,salesperson_id,merged_into_customer_id FROM customers WHERE id=?", cid) : undefined;
    if (!c || (scope === "own" && (c.salesperson_id !== u.salesperson_id || c.merged_into_customer_id != null))) {
      audit({ req, u, customerId: Number.isSafeInteger(cid) ? cid : null, action: "chat.view", outcome: "not_in_scope" });
      return fail(res, 404, "not_found");
    }
    const msgs = rows<any>(`SELECT m.id,m.direction,m.text,m.file_ref,m.status,m.created_at,m.account_id,u.full_name,u.username FROM bale_messages m
      JOIN bale_accounts a ON a.id=m.account_id LEFT JOIN users u ON u.id=a.user_id WHERE m.customer_id=? ORDER BY m.id DESC LIMIT 200`, cid).reverse();
    const owner = c.salesperson_id ? row<any>("SELECT u.id,u.full_name,u.username,a.status,a.mode FROM users u LEFT JOIN bale_accounts a ON a.user_id=u.id WHERE u.salesperson_id=? AND u.role='salesperson' ORDER BY u.id LIMIT 1", c.salesperson_id) : undefined;
    const st = owner ? row<any>("SELECT s.mode, s.paused_reason, s.paused_at FROM bale_conversation_state s JOIN bale_accounts a ON a.id=s.account_id WHERE s.customer_id=? AND a.user_id=?", cid, owner.id) : undefined;
    const ownerAcc = owner ? accountOf(owner.id) : undefined;
    const isOwner = Boolean(owner && owner.id === u.id);
    const notLive = Boolean(ownerAcc && outbox.liveState(ownerAcc) === "down");
    const canSend = isOwner && masterOn() && ownerAcc?.status === "connected" && Boolean(ownerAcc?.session_ct) && ownerAcc?.mode !== "off" && !notLive;
    res.json({
      customerId: cid, masterEnabled: masterOn(), readOnly: !isOwner,
      canSend, sendBlockedMessage: isOwner && !canSend ? BLOCK_FA[!masterOn() ? "bale_disabled" : ownerAcc?.status !== "connected" || !ownerAcc?.session_ct ? "not_connected" : ownerAcc?.mode === "off" ? "mode_off" : "session_not_live"] : null,
      outbox: ownerAcc ? outbox.tabItems(ownerAcc.id, cid).map(o => outbox.itemView(o, isOwner)) : [],
      sendState: ownerAcc && isOwner ? outbox.sendState(ownerAcc, cid) : null,
      expert: owner ? { name: nameOf(owner), connected: owner.status === "connected", session: ownerAcc && ownerAcc.status === "connected" ? outbox.liveState(ownerAcc) : null, mode: owner.mode ?? "off" } : null,
      conversationMode: st?.mode ?? null,
      paused: st?.paused_reason ? { reason: st.paused_reason, at: st.paused_at, message: BLOCK_FA.conversation_paused, unverified: true } : null,
      messages: msgs.map(m => ({ id: m.id, direction: m.direction, text: m.text, hasFile: Boolean(m.file_ref), status: m.status, createdAt: m.created_at,
        expertName: m.full_name || m.username || null })),
    });
  });

  /* ---------------- 1b: sending (the expert, own customers, own account only) ---------------- */
  const ownAccount = (req: Request, res: Response) => {
    const u = res.locals.baleUser; const a = accountOf(u.id);
    if (!a) { fail(res, 409, "not_connected"); return undefined; }
    return a;
  };
  const ownRow = (req: Request, res: Response) => {
    const a = ownAccount(req, res); if (!a) return undefined;
    const o = row<any>("SELECT * FROM bale_outbox WHERE id=? AND account_id=?", Number(req.params.id), a.id);
    if (!o) { audit({ req, u: res.locals.baleUser, accountId: a.id, action: `${req.method} ${req.path}`, outcome: "not_found" }); fail(res, 404, "not_found"); return undefined; }
    // The customer must still be the expert's own (reassigned → no actions on old rows).
    const c = row<any>("SELECT salesperson_id,merged_into_customer_id FROM customers WHERE id=?", o.customer_id);
    if (!c || c.salesperson_id !== res.locals.baleUser.salesperson_id || c.merged_into_customer_id != null) {
      res.status(404).json({ error: "out_of_scope", message: BLOCK_FA.out_of_scope }); return undefined;
    }
    return { a, o };
  };
  const blockedStatus = (reason: string) => ["bale_disabled", "not_connected", "mode_off", "session_not_live", "attachments_disabled"].includes(reason) ? 423 : reason === "out_of_scope" ? 404
    : ["already_pending"].includes(reason) ? 409 : ["cap_hour", "cap_day", "cap_new_chats"].includes(reason) ? 429 : 422;
  const sendOut = (res: Response, r: ReturnType<typeof outbox.enqueue>) => r.status === "blocked"
    ? res.status(blockedStatus(r.reason)).json({ error: r.reason, message: r.message, outboxId: r.outboxId })
    : res.json({ status: r.status, outboxId: r.outboxId, heldUntil: r.heldUntil, message: r.message, text: r.text });
  staff.post("/bale/customers/:id/send", expert, (req, res) => {
    const u = res.locals.baleUser; const a = ownAccount(req, res); if (!a) return;
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    sendOut(res, outbox.enqueue({ accountId: a.id, customerId: Number(req.params.id), text, source: "expert_command", explicit: true, createdBy: u.id, sendNow: req.body?.sendNow === true }));
  });
  staff.post("/bale/outbox/:id/approve", expert, (req, res) => {
    const x = ownRow(req, res); if (!x) return;
    sendOut(res, outbox.approve(x.o.id, res.locals.baleUser, typeof req.body?.text === "string" ? req.body.text : undefined));
  });
  staff.put("/bale/outbox/:id", expert, (req, res) => {
    const x = ownRow(req, res); if (!x) return;
    const r = outbox.editDraft(x.o.id, res.locals.baleUser, typeof req.body?.text === "string" ? req.body.text : "");
    if (!r.ok) { res.status(r.reason === "not_editable" ? 409 : 422).json({ error: r.reason, message: r.message }); return; }
    res.json({ ok: true, text: r.text });
  });
  staff.post("/bale/outbox/:id/cancel", expert, (req, res) => {
    const x = ownRow(req, res); if (!x) return;
    if (!outbox.cancel(x.o.id, res.locals.baleUser)) return void res.status(409).json({ error: "not_cancellable", message: "این پیام دیگر قابل لغو نیست." });
    res.json({ ok: true });
  });
  staff.post("/bale/outbox/:id/send-now", expert, (req, res) => {
    const x = ownRow(req, res); if (!x) return;
    if (!outbox.sendNow(x.o.id, res.locals.baleUser)) return void res.status(409).json({ error: "not_queued", message: "این پیام در صف نیست." });
    res.json({ ok: true });
  });
  /** Decision (b): the expert re-opens a paused conversation (own customer only). */
  staff.post("/bale/customers/:id/resume", expert, (req, res) => {
    const u = res.locals.baleUser; const a = ownAccount(req, res); if (!a) return;
    const cid = Number(req.params.id);
    if (!row<any>("SELECT 1 FROM customers WHERE id=? AND salesperson_id=? AND merged_into_customer_id IS NULL", cid, u.salesperson_id))
      return void res.status(404).json({ error: "out_of_scope", message: BLOCK_FA.out_of_scope });
    if (!outbox.resumeConversation(u, a, cid)) return void res.status(409).json({ error: "not_paused", message: "این گفتگو متوقف نیست." });
    res.json({ ok: true });
  });

  /* ---------------- decision (c): «پیام از شماره‌ی ناشناس» → link to one of MY customers ---------------- */
  staff.get("/bale/unknown", expert, (req, res) => {
    const a = accountOf(res.locals.baleUser.id); res.json({ items: a ? outbox.unknownList(a) : [] });
  });
  staff.get("/bale/my-customers", expert, (req, res) => {
    res.json({ items: outbox.ownCustomerSearch(res.locals.baleUser, typeof req.query.q === "string" ? req.query.q : "") });
  });
  staff.post("/bale/unknown/:id/link", expert, (req, res) => {
    const u = res.locals.baleUser; const a = ownAccount(req, res); if (!a) return;
    if (!masterOn()) return fail(res, 423, "bale_disabled");
    const r = outbox.linkUnknown(u, a, Number(req.params.id), Number(req.body?.customerId));
    if (!r.ok) return void res.status(r.status).json({ error: r.error, message: r.message });
    res.json({ ok: true, items: outbox.unknownList(a) });
  });
  staff.post("/bale/unknown/:id/dismiss", expert, (req, res) => {
    const u = res.locals.baleUser; const a = ownAccount(req, res); if (!a) return;
    if (!outbox.dismissUnknown(u, a, Number(req.params.id))) return fail(res, 404, "not_found");
    res.json({ ok: true, items: outbox.unknownList(a) });
  });

  staff.get("/bale/outbox", expert, (req, res) => {
    const u = res.locals.baleUser; const a = accountOf(u.id); if (!a) return void res.json({ items: [] });
    // Switch OFF → plan-file rows are not shown at all (they can be neither approved nor sent).
    const list = rows<any>(`SELECT o.*, c.name cname, c.salesperson_id csp, c.merged_into_customer_id cm FROM bale_outbox o LEFT JOIN customers c ON c.id=o.customer_id
      WHERE o.account_id=? AND (o.status IN ('pending_approval','queued','sending') OR o.updated_at>?)${attachmentsOn() ? "" : " AND o.attachment_id IS NULL"} ORDER BY o.id DESC LIMIT 100`, a.id, new Date(now().getTime() - 3 * 86_400_000).toISOString());
    res.json({ items: list.map(o => {
      const own = o.csp === u.salesperson_id && o.cm == null;
      // Out-of-scope rows (e.g. the assistant tried a foreign customer, or the customer was reassigned): no name, no text.
      return own ? { ...outbox.itemView(o, true), customerName: o.cname }
        : { ...outbox.itemView({ ...o, text: "" }, false), customerId: null, customerName: null, text: null, attachment: null };
    }) });
  });
  staff.post("/bale/reminder-messages", expert, (req, res) => {
    const u = res.locals.baleUser; const a = ownAccount(req, res); if (!a) return;
    if (!masterOn()) return fail(res, 423, "bale_disabled");
    const r = outbox.linkReminder(u, a, Number(req.body?.reminderId), typeof req.body?.text === "string" ? req.body.text : "");
    if (!r.ok) return void res.status(r.status).json({ error: r.error, message: r.message });
    res.json({ ok: true });
  });
  staff.post("/bale/reminder-messages/:id/cancel", expert, (req, res) => {
    const u = res.locals.baleUser; const a = ownAccount(req, res); if (!a) return;
    if (!outbox.cancelReminder(u, a, Number(req.params.id))) return fail(res, 404, "not_found");
    res.json({ ok: true });
  });

  /* ---------------- «اسکن بله و اتصال مشتری»: read-only contact scan → expert-confirmed links (customer_bale_links) ---------------- */
  const SCAN_COOLDOWN_MS = 5 * 60_000; const SCAN_TTL_MS = 30 * 60_000;
  type Scan = { id: string; userId: number; accountId: number; expertUserId: number; all: boolean; at: number; contacts: Map<string, { method: Map<number, string> }> };
  const scans = new Map<string, Scan>(); const lastScan = new Map<number, number>();
  const scanner = (req: Request, res: Response, next: NextFunction) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    const isAdmin = u.role === "admin" && !EXCLUDED_USER_IDS.includes(u.id) && u.active !== 0;
    if (!isAdmin && !baleEligible(u)) { audit({ req, u, action: `${req.method} ${req.path}`, outcome: "forbidden" }); return fail(res, 403, "forbidden"); }
    res.locals.scanUser = u; res.locals.scanAdmin = isAdmin; next();
  };
  const activeLinks = (expertUserId: number) => rows<any>("SELECT * FROM customer_bale_links WHERE expert_user_id=? AND unlinked_at IS NULL", expertUserId);
  const scopeCustomers = (all: boolean, spId: number | null) => all
    ? rows<any>("SELECT id,name,phone,salesperson_id FROM customers WHERE merged_into_customer_id IS NULL")
    : rows<any>("SELECT id,name,phone,salesperson_id FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL", spId);
  const inScope = (all: boolean, spId: number | null, customerId: number) => {
    const c = Number.isSafeInteger(customerId) && customerId > 0 ? row<any>("SELECT id,name,phone,salesperson_id,merged_into_customer_id FROM customers WHERE id=?", customerId) : undefined;
    return c && c.merged_into_customer_id == null && (all || (spId != null && c.salesperson_id === spId)) ? c : undefined;
  };
  /** Which Bale account a scan reads: the expert's own; admin picks a connected expert account (body.accountId). */
  const scanAccount = (res: Response, accountId: unknown) => {
    const u = res.locals.scanUser;
    if (!res.locals.scanAdmin || (accountId == null && accountOf(u.id))) return accountOf(u.id);
    const a = row<any>("SELECT * FROM bale_accounts WHERE id=? AND kind<>'system_test'", Number(accountId));
    return a && baleEligible(userRow(a.user_id)) ? a : undefined;
  };
  function linkView(l: any) { return l ? { id: l.id, customerId: l.customer_id, baleUserId: l.bale_user_id, method: l.match_method, linkedAt: l.linked_at } : null; }
  staff.get("/bale/contact-scan", scanner, (_req, res) => {
    const u = res.locals.scanUser; const isAdmin = res.locals.scanAdmin;
    const accs = isAdmin ? rows<any>("SELECT * FROM bale_accounts WHERE kind<>'system_test' AND status='connected' ORDER BY id").filter(a => baleEligible(userRow(a.user_id)))
      : [accountOf(u.id)].filter(a => a && a.status === "connected");
    res.json({ admin: isAdmin, masterEnabled: masterOn(), cooldownS: SCAN_COOLDOWN_MS / 1000,
      accounts: accs.map(a => ({ id: a.id, userId: a.user_id, name: nameOf(userRow(a.user_id)), session: outbox.liveState(a),
        nextScanInS: Math.max(0, Math.ceil(((lastScan.get(a.id) ?? 0) + SCAN_COOLDOWN_MS - now().getTime()) / 1000)),
        links: Number(row<any>("SELECT count(*) n FROM customer_bale_links WHERE expert_user_id=? AND unlinked_at IS NULL", a.user_id)?.n ?? 0) })) });
  });
  staff.post("/bale/contact-scan", scanner, async (req, res) => {
    const u = res.locals.scanUser; const all = Boolean(res.locals.scanAdmin);
    if (!masterOn()) return fail(res, 423, "bale_disabled");
    const a = scanAccount(res, req.body?.accountId);
    if (!a || a.status !== "connected" || !a.session_ct) return fail(res, 409, "not_connected");
    const t0 = now().getTime(); const last = lastScan.get(a.id) ?? 0;
    if (t0 - last < SCAN_COOLDOWN_MS) { audit({ req, u, accountId: a.id, action: "contacts.scan", outcome: "rate_limited" }); return void res.status(429).json({ error: "scan_too_soon", message: ERR_FA.scan_too_soon, retryAfterS: Math.ceil((last + SCAN_COOLDOWN_MS - t0) / 1000) }); }
    lastScan.set(a.id, t0);
    let got: { source: "contacts" | "dialogs"; contacts: BaleScanContact[]; truncated: boolean };
    try { got = await deps.sidecar.contacts({ accountRef: `acc-${a.id}` }); }
    catch (e) {
      const code = e instanceof BaleSidecarError ? e.code : "unknown";
      audit({ req, u, accountId: a.id, action: "contacts.scan", outcome: "error", detail: { code } });
      if (e instanceof BaleSidecarError) return fail(res, code === "rate_limited" ? 429 : code === "not_attached" ? 409 : code === "session_invalid" || code === "account_banned" ? 409 : 502, code === "rate_limited" ? "scan_too_soon" : code);
      return sidecarFail(res, e);
    }
    const expert = userRow(a.user_id);
    const customers = scopeCustomers(all, expert?.salesperson_id ?? null);
    const byId = new Map(customers.map(c => [c.id, c]));
    const m = matchContacts(got.contacts, customers);
    const links = activeLinks(a.user_id); const linkByPeer = new Map(links.map(l => [l.bale_user_id, l])); const linkByCustomer = new Map(links.map(l => [l.customer_id, l]));
    const scan: Scan = { id: randomUUID(), userId: u.id, accountId: a.id, expertUserId: a.user_id, all, at: t0, contacts: new Map() };
    for (const [k, v] of scans) if (v.at < t0 - SCAN_TTL_MS || (v.userId === u.id && v.accountId === a.id)) scans.delete(k);
    const view = (r: MatchRow) => {
      scan.contacts.set(r.contact.baleUserId, { method: new Map(r.candidates.map(c => [c.customerId, c.method])) });
      const link = linkByPeer.get(r.contact.baleUserId);
      return { baleUserId: r.contact.baleUserId, contactName: r.label.slice(0, 80), phoneMasked: maskPhone(normMobile(r.contact.phone)), note: r.note, link: linkView(link),
        candidates: r.candidates.slice(0, 8).map(c => { const cu = byId.get(c.customerId); const other = linkByCustomer.get(c.customerId);
          return { customerId: c.customerId, name: cu?.name ?? "", method: c.method, phoneMasked: maskPhone(normMobile(cu?.phone)),
            linkedToOther: Boolean(other && other.bale_user_id !== r.contact.baleUserId) }; }) };
    };
    const out = { scanId: scan.id, source: got.source, truncated: got.truncated, accountId: a.id, expert: nameOf(expert), all,
      counts: { contacts: got.contacts.length, confident: m.confident.length, review: m.review.length, notFound: m.notFound.length },
      confident: m.confident.map(view), review: m.review.map(view), notFound: m.notFound.map(view) };
    scans.set(scan.id, scan);
    audit({ req, u, accountId: a.id, action: "contacts.scan", outcome: "ok", detail: { source: got.source, ...out.counts, admin: all } });
    res.json(out);
  });
  staff.post("/bale/contact-links", scanner, (req, res) => {
    const u = res.locals.scanUser;
    const scan = scans.get(String(req.body?.scanId ?? ""));
    if (!scan || scan.userId !== u.id || scan.at < now().getTime() - SCAN_TTL_MS) return fail(res, 410, "scan_expired");
    const items: any[] = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
    if (!items.length) return fail(res, 400, "bad_request");
    const expert = userRow(scan.expertUserId); const spId = expert?.salesperson_id ?? null;
    if (!baleEligible(expert)) return fail(res, 409, "not_connected");
    const done: { baleUserId: string; customerId: number; linkId: number; method: string }[] = []; const skipped: { baleUserId: string; customerId: number; reason: string }[] = [];
    for (const it of items) {
      const peer = String(it?.baleUserId ?? ""); const cid = Number(it?.customerId);
      const sc = scan.contacts.get(peer);
      if (!sc) { skipped.push({ baleUserId: peer, customerId: cid, reason: "not_in_scan" }); continue; }
      if (!inScope(scan.all, spId, cid)) { skipped.push({ baleUserId: peer, customerId: cid, reason: "out_of_scope" }); continue; }
      const byPeer = row<any>("SELECT * FROM customer_bale_links WHERE expert_user_id=? AND bale_user_id=? AND unlinked_at IS NULL", scan.expertUserId, peer);
      if (byPeer?.customer_id === cid) { done.push({ baleUserId: peer, customerId: cid, linkId: byPeer.id, method: byPeer.match_method }); continue; }
      if (byPeer) { skipped.push({ baleUserId: peer, customerId: cid, reason: "contact_linked" }); continue; }
      if (row("SELECT 1 FROM customer_bale_links WHERE expert_user_id=? AND customer_id=? AND unlinked_at IS NULL", scan.expertUserId, cid)) { skipped.push({ baleUserId: peer, customerId: cid, reason: "customer_linked" }); continue; }
      const method = sc.method.get(cid) ?? "manual";
      const id = Number(run("INSERT INTO customer_bale_links(bale_user_id,customer_id,expert_user_id,account_id,match_method,linked_at,linked_by) VALUES(?,?,?,?,?,?,?)",
        peer, cid, scan.expertUserId, scan.accountId, method, iso(), u.id).lastInsertRowid);
      audit({ req, u, accountId: scan.accountId, customerId: cid, action: "contacts.link", outcome: "ok", detail: { method, linkId: id, peer: peerTag(peer) } });
      done.push({ baleUserId: peer, customerId: cid, linkId: id, method });
    }
    res.json({ ok: true, linked: done, skipped });
  });
  staff.post("/bale/contact-links/:id/unlink", scanner, (req, res) => {
    const u = res.locals.scanUser;
    const l = row<any>("SELECT * FROM customer_bale_links WHERE id=? AND unlinked_at IS NULL", Number(req.params.id));
    if (!l || (!res.locals.scanAdmin && l.expert_user_id !== u.id)) return fail(res, 404, "not_found");
    run("UPDATE customer_bale_links SET unlinked_at=?, unlinked_by=?, unlink_reason=? WHERE id=?", iso(), u.id, res.locals.scanAdmin && l.expert_user_id !== u.id ? "admin" : "expert", l.id);
    audit({ req, u, accountId: l.account_id, customerId: l.customer_id, action: "contacts.unlink", outcome: "ok", detail: { linkId: l.id, peer: peerTag(l.bale_user_id) } });
    res.json({ ok: true });
  });
  /** «متصل به بله» badge on the customer profile: admin sees any customer; an eligible expert only their own. */
  staff.get("/bale/customers/:id/link", (req, res) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    const v = baleChatViewer(u); if (!v) return fail(res, 403, "forbidden");
    const cid = Number(req.params.id);
    const c = inScope(v === "all", u.salesperson_id ?? null, cid); if (!c) return fail(res, 404, "not_found");
    const l = row<any>("SELECT l.*, u.full_name, u.username FROM customer_bale_links l LEFT JOIN users u ON u.id=l.expert_user_id WHERE l.customer_id=? AND l.unlinked_at IS NULL"
      + (v === "all" ? "" : " AND l.expert_user_id=" + Number(u.id)) + " ORDER BY l.id DESC LIMIT 1", cid);
    res.json({ linked: Boolean(l), link: l ? { ...linkView(l), expertName: nameOf({ id: l.expert_user_id, full_name: l.full_name, username: l.username }), canUnlink: v === "all" || l.expert_user_id === u.id } : null });
  });

  /* ---------------- admin ---------------- */
  const admin = (req: Request, res: Response, next: NextFunction) => {
    const u = me(res);
    if (!u || u.role !== "admin" || EXCLUDED_USER_IDS.includes(u.id) || u.active === 0) { if (u) audit({ req, u, action: `${req.method} ${req.path}`, outcome: "forbidden" }); return fail(res, 403, "forbidden"); }
    res.locals.baleAdmin = u; next();
  };
  test.mount(staff, admin); // «حساب تستی»: /admin/bale/test/* — every route behind the same admin gate (never 29)
  const adminAccount = (a: any) => ({ ...accountView(a), user: { id: a.user_id, name: nameOf(userRow(a.user_id)) }, salespersonId: a.salesperson_id });
  staff.get("/admin/bale", admin, async (_req, res) => {
    const eligible = rows<any>("SELECT id,role,salesperson_id,active,full_name,username FROM users WHERE role='salesperson' ORDER BY id").filter(baleEligible);
    const accounts = rows<any>("SELECT * FROM bale_accounts WHERE kind<>'system_test' ORDER BY id");
    const health = deps.sidecar.configured() ? await deps.sidecar.health() : { ok: false };
    res.json({
      masterEnabled: masterOn(), keyReady: baleHasKey(deps.env()), sidecar: { configured: deps.sidecar.configured(), reachable: health.ok },
      attachmentsEnabled: attachmentsOn(), planFilesReady: Boolean(planFiles), sidecarVersion: health.version ?? null,
      limits: { gapMinS: Number(setting("gap_min_s")), gapMaxS: Number(setting("gap_max_s")), perHour: Number(setting("per_hour")), perDay: Number(setting("per_day")),
        newChatsPerDay: Number(setting("new_chats_per_day")), quietStart: setting("quiet_start"), quietEnd: setting("quiet_end") },
      // Decision (b): UNVERIFIED until checked with the test SIM; the default is the safe whole-account stop.
      peerBlock: { mode: setting("peer_block_mode"), verified: false },
      experts: eligible.map(u => { const a = accounts.find(x => x.user_id === u.id); return { userId: u.id, name: nameOf(u), account: a ? adminAccount(a) : null }; }),
    });
  });
  staff.put("/admin/bale/master", admin, (req, res) => {
    const on = req.body?.enabled === true; const u = res.locals.baleAdmin;
    run("INSERT INTO bale_settings(key,value,updated_at,updated_by_user_id) VALUES('master_enabled',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id", on ? "1" : "0", iso(), u.id);
    if (!on) flows.clear();
    audit({ req, u, action: on ? "admin.master_on" : "admin.master_off", outcome: "ok" });
    res.json({ masterEnabled: masterOn() });
  });
  /* ---------------- plan files («فایل طرح برای بله») ---------------- */
  staff.put("/admin/bale/attachments", admin, (req, res) => {
    const on = req.body?.enabled === true; const u = res.locals.baleAdmin;
    run("INSERT INTO bale_settings(key,value,updated_at,updated_by_user_id) VALUES('bale_attachments_enabled',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id", on ? "1" : "0", iso(), u.id);
    audit({ req, u, action: on ? "admin.attachments_on" : "admin.attachments_off", outcome: "ok" });
    res.json({ attachmentsEnabled: attachmentsOn() });
  });
  const planFileLimits = { maxBytes: BALE_PLAN_FILE_MAX_BYTES, types: BALE_PLAN_FILE_TYPES.map(t => t.label) };
  staff.get("/admin/bale/plan-files", admin, (_req, res) => {
    if (!planFiles) return fail(res, 503, "plan_files_unavailable");
    res.json({ attachmentsEnabled: attachmentsOn(), ...planFileLimits, plans: planFiles.list() });
  });
  // Upload works whatever the switch says (the admin prepares files before the PM turns sending on).
  const planUpload = multer({ storage: multer.memoryStorage(), defParamCharset: "utf8", limits: { fileSize: BALE_PLAN_FILE_MAX_BYTES, files: 1, fields: 4 } } as any).single("file");
  staff.post("/admin/bale/plans/:id/file", admin, (req, res) => {
    if (!planFiles) return fail(res, 503, "plan_files_unavailable");
    planUpload(req, res, (e: any) => {
      const u = res.locals.baleAdmin; const planId = Number(req.params.id);
      if (e) {
        const big = e?.code === "LIMIT_FILE_SIZE";
        audit({ req, u, action: "plan_file.upload", outcome: big ? "too_large" : "bad_upload", detail: { planId: Number.isSafeInteger(planId) ? planId : null } });
        return void res.status(big ? 413 : 400).json({ error: big ? "file_too_large" : "bad_upload", message: big ? "حجم فایل بیشتر از ۱۰ مگابایت است." : "فایل درست فرستاده نشد؛ دوباره امتحان کنید." });
      }
      const f = (req as any).file as { buffer: Buffer; originalname?: string } | undefined;
      const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name : f?.originalname;
      const r = planFiles.save(planId, f?.buffer, name, u.id);
      audit({ req, u, action: "plan_file.upload", outcome: r.ok ? "ok" : r.error, detail: r.ok ? { planId, fileId: r.file.id, size: r.file.size, type: r.file.typeLabel } : { planId: Number.isSafeInteger(planId) ? planId : null } });
      if (!r.ok) return void res.status(r.status).json({ error: r.error, message: r.message });
      res.json({ file: r.file, attachmentsEnabled: attachmentsOn() });
    });
  });
  staff.delete("/admin/bale/plans/:id/file", admin, (req, res) => {
    if (!planFiles) return fail(res, 503, "plan_files_unavailable");
    const u = res.locals.baleAdmin; const planId = Number(req.params.id);
    const ok = planFiles.remove(planId, u.id);
    audit({ req, u, action: "plan_file.remove", outcome: ok ? "ok" : "not_found", detail: { planId: Number.isSafeInteger(planId) ? planId : null } });
    if (!ok) return fail(res, 404, "not_found");
    res.json({ ok: true });
  });
  /** Bytes for the draft preview / thumbnail: admins (not 29) and eligible sales experts only; plan files are not customer data. */
  staff.get("/bale/plan-files/:id/content", (req, res) => {
    const u = me(res); if (!u) return fail(res, 401, "unauthorized");
    const isAdmin = u.role === "admin" && !EXCLUDED_USER_IDS.includes(u.id) && u.active !== 0;
    if (!isAdmin && !baleEligible(u)) return fail(res, 403, "not_eligible");
    const f = planFiles?.byId(Number(req.params.id)); const bytes = f ? planFiles!.read(f) : null;
    if (!f || !bytes) return fail(res, 404, "not_found");
    res.setHeader("Content-Type", f.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="plan-${f.plan_id}.${f.stored_name.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(f.display_name)}`);
    if (f.mime !== "application/pdf") res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.end(bytes);
  });
  staff.put("/admin/bale/peer-block-mode", admin, (req, res) => {
    const mode = String(req.body?.mode ?? ""); const u = res.locals.baleAdmin;
    if (!(BALE_PEER_BLOCK_MODES as readonly string[]).includes(mode)) return fail(res, 422, "bad_mode");
    run("INSERT INTO bale_settings(key,value,updated_at,updated_by_user_id) VALUES('peer_block_mode',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id", mode, iso(), u.id);
    audit({ req, u, action: "admin.peer_block_mode", outcome: "ok", detail: { mode, unverified: true } });
    res.json({ peerBlock: { mode: setting("peer_block_mode"), verified: false } });
  });
  const byId = (req: Request, res: Response) => { const a = row<any>("SELECT * FROM bale_accounts WHERE id=? AND kind<>'system_test'", Number(req.params.id)); if (!a) fail(res, 404, "not_found"); return a; };
  staff.put("/admin/bale/accounts/:id/mode", admin, (req, res) => {
    const a = byId(req, res); if (!a) return; const u = res.locals.baleAdmin; const mode = String(req.body?.mode ?? "") as BaleMode;
    if (!BALE_MODES.includes(mode)) return fail(res, 422, "bad_mode");
    if (mode !== "off" && a.status !== "connected") return fail(res, 409, "not_connected");
    run("UPDATE bale_accounts SET mode=?, updated_at=? WHERE id=?", mode, iso(), a.id);
    audit({ req, u, accountId: a.id, action: "mode.admin", outcome: "ok", detail: { from: a.mode, to: mode } });
    res.json(adminAccount(row<any>("SELECT * FROM bale_accounts WHERE id=?", a.id)));
  });
  staff.post("/admin/bale/accounts/:id/disconnect", admin, async (req, res) => {
    const a = byId(req, res); if (!a) return; const u = res.locals.baleAdmin;
    const remote = await disconnect(req, u, a, "admin");
    res.json({ ...adminAccount(row<any>("SELECT * FROM bale_accounts WHERE id=?", a.id)), remoteSignOut: remote });
  });
  staff.get("/admin/bale/audit", admin, (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 100) || 100));
    res.json({ items: rows<any>("SELECT * FROM bale_audit ORDER BY id DESC LIMIT ?", limit).map(x => ({ id: x.id, at: x.at, actor: x.actor_label, accountId: x.account_id,
      customerId: x.customer_id, action: x.action, outcome: x.outcome, detail: x.detail_json ? JSON.parse(x.detail_json) : null })) });
  });

  /* ============ runner hook: the expert's own sales assistant (mounted inside /api/assistant-runner, Bearer already checked) ============ */
  /** POST /bale/send {customerId, text, reason?, explicitExpertCommand?} — or a plan file: {customerId, planId | attachmentId, caption?, reason?}
   *  (only while bale_attachments_enabled = 1; ALWAYS pending_approval; caption always ends with the amount disclaimer). Only a sales assistant bound to an expert; only the
   *  assistant's in-scope customers that are also the expert's own. explicitExpertCommand (first message to a customer with no
   *  prior chat) is honoured only when the expert wrote to the assistant in the last 15 minutes. Never bypasses quiet hours. */
  function runnerSend(req: Request, res: Response, ctx: { inScope: (a: any, cid: number) => boolean }) {
    const asst = res.locals.assistant;
    const cid = Number(req.body?.customerId);
    if (!asst || asst.kind !== "sales" || !asst.bound_user_id) return void res.status(403).json({ error: "forbidden", message: "این کار برای دستیار مجاز نیست." });
    const u = userRow(asst.bound_user_id);
    const a = u ? accountOf(u.id) : undefined;
    if (!u || !baleEligible(u) || !a) return void res.status(423).json({ error: "not_connected", message: BLOCK_FA.not_connected });
    let explicit = false;
    if (req.body?.explicitExpertCommand === true) {
      const since = new Date(now().getTime() - 15 * 60_000).toISOString();
      explicit = Boolean(row(`SELECT 1 FROM assistant_messages m JOIN assistant_threads t ON t.id=m.thread_id WHERE t.assistant_id=? AND t.user_id=? AND m.author='user' AND m.created_at>? LIMIT 1`,
        asst.id, u.id, since));
    }
    const inScope = Number.isSafeInteger(cid) && ctx.inScope(asst, cid);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 300) : null;
    // Plan file: {planId | attachmentId, caption?}. Switch OFF → refused before anything is stored. Always a draft the expert approves.
    const wantsFile = (req.body?.planId != null && req.body.planId !== "") || (req.body?.attachmentId != null && req.body.attachmentId !== "");
    let attachmentId: number | null = null;
    if (wantsFile) {
      const blockedFile = (code: "attachments_disabled" | "attachment_missing" | "out_of_scope") => {
        audit({ accountId: a.id, customerId: Number.isSafeInteger(cid) ? cid : null, action: "outbox.assistant_file", outcome: `blocked:${code}`, detail: { assistantId: asst.id } });
        res.status(blockedStatus(code)).json({ status: "blocked", error: code, message: BLOCK_FA[code] });
      };
      if (!planFiles || !attachmentsOn()) return blockedFile("attachments_disabled");
      if (!inScope) return blockedFile("out_of_scope");
      const f = planFiles.resolve({ planId: req.body?.planId, attachmentId: req.body?.attachmentId });
      if (!f || !planFiles.read(f)) return blockedFile("attachment_missing");
      attachmentId = f.id;
    }
    const text = wantsFile ? (typeof req.body?.caption === "string" ? req.body.caption : typeof req.body?.text === "string" ? req.body.text : "")
      : typeof req.body?.text === "string" ? req.body.text : "";
    const r = outbox.enqueue({ accountId: a.id, customerId: cid, text, source: "assistant", explicit,
      createdBy: null, assistant: { id: asst.id, inScope }, reason, attachmentId });
    if (r.status === "blocked") return void res.status(blockedStatus(r.reason)).json({ status: "blocked", error: r.reason, message: r.message });
    res.json({ status: r.status, outboxId: r.outboxId, heldUntil: r.heldUntil, ...(attachmentId != null ? { attachmentId } : {}) });
  }

  /** GET /bale/plan-files (runner, read-only): which plans have a Bale file, so the assistant can pick planId. Names / type / size only, never bytes or paths. */
  function runnerPlanFiles(_req: Request, res: Response) {
    const asst = res.locals.assistant;
    if (!asst || asst.kind !== "sales" || !asst.bound_user_id) return void res.status(403).json({ error: "forbidden", message: "این کار برای دستیار مجاز نیست." });
    const plans = planFiles ? planFiles.list().filter(p => p.active) : [];
    res.json({ attachmentsEnabled: Boolean(planFiles) && attachmentsOn(),
      plans: plans.map(p => ({ planId: p.planId, name: p.name, file: p.file ? { attachmentId: p.file.id, name: p.file.name, typeLabel: p.file.typeLabel, size: p.file.size } : null })) });
  }

  /* ============ internal router: sidecar → API inbound (mounted OUTSIDE /api, before session auth) ============ */
  const internal = Router();
  internal.post("/internal/bale/inbound", express.json({ limit: "128kb" }), (req, res) => {
    const remote = String(req.socket.remoteAddress ?? "");
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    // Direct sidecar calls only: anything that came through a proxy (nginx sets these) is refused.
    const proxied = req.headers["x-forwarded-for"] !== undefined || req.headers["x-real-ip"] !== undefined || req.headers.forwarded !== undefined;
    const want = baleSidecarToken(deps.env()); const got = String(req.headers["x-bale-internal-token"] ?? "");
    const gb = Buffer.from(got), wb = Buffer.from(want ?? "");
    const tokenOk = wb.length > 0 && gb.length === wb.length && timingSafeEqual(gb, wb);
    if (!loopback || proxied || !tokenOk) { audit({ action: "inbound.auth", outcome: "forbidden", detail: { loopback, proxied } }); return void res.status(403).json({ error: "forbidden" }); }
    res.json(outbox.inbound(req.body));
  });

  /** Worker: every ~5 s (one tick at a time). */
  let timer: ReturnType<typeof setInterval> | null = null;
  const worker = {
    tick: async () => { const r = await outbox.tick(); const t = await test.tick(); return { ...r, test: t }; },
    start(ms = 5000) { if (!timer) { timer = setInterval(() => {
      void outbox.tick().catch(e => console.error("bale worker", (e as Error)?.name)).then(() => test.tick()).catch(e => console.error("bale test worker", (e as Error)?.name));
    }, ms); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };

  return { staff, internal, runnerSend, runnerPlanFiles, worker, _internal: { flows, masterOn, outbox, test } };
}
