/**
 * «حساب تستی» — a spare-SIM Bale account owned by the SYSTEM (never by an expert), for checking real Bale behaviour
 * (error mapping, peer-blocked wording, inbound) before experts use it.
 *  - Admin only (role admin, active, never user 29). Experts, registrars, trainees and 29 → 403 (+ audit).
 *  - bale_accounts row with kind='system_test', user_id=0 (no user has id 0), salesperson_id NULL: invisible to every
 *    expert query, the eligible-expert list and the customer outbox.
 *  - Its own switch bale_settings.test_enabled (default OFF), independent of the experts' master switch: with the test
 *    switch OFF nothing connects, sends, listens or stores. The master switch is never read or changed here.
 *  - Recipients: ONLY an admin-entered allowlist of at most 3 numbers (bale_test_allowlist). Numbers are sealed with the
 *    session key (AES-256-GCM) and shown masked; a number that belongs to any customer is refused. No code path takes a
 *    customer id or a free phone number, so the test account can never reach a customer.
 *  - Same rules as the experts: banned-word / «نقد/کالا/امتیاز» filter, amount disclaimer, per-hour / per-day caps,
 *    random gap between messages, quiet hours (held until the window ends).
 *  - Inbound: only from allowlisted numbers (matched by peer id or phone) is stored (bale_test_messages); every other
 *    sender is counted (inbound_ignored) and dropped — no text, no peer id, no phone.
 *  - Login: the code / 2FA password go straight to the sidecar; never stored, logged or audited. Session sealed like the
 *    experts' (AAD bale-session:<id>:0). Audit rows carry only masked numbers and codes of outcomes.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { baleHasKey, baleSessionAad, openBaleSession, sealBaleSession, BaleKeyMissing, type KeyEnv } from "./bale-crypto";
import { BaleSidecarError, type BaleSidecar } from "./bale-sidecar-client";
import { baleTextProblem, inBaleQuiet, quietEndAfter, withAmountDisclaimer, BLOCK_FA, BALE_MAX_ATTEMPTS, BALE_SENDING_STALE_MS } from "./bale-outbox";

type Db = DatabaseSync;
export const BALE_TEST_USER_ID = 0;
export const BALE_TEST_KIND = "system_test";
export const BALE_TEST_ALLOW_MAX = 3;
export const BALE_TEST_STARTS_PER_HOUR = 3;
const ALLOW_AAD = "bale-test-allowlist";
const FLOW_TTL_MS = 5 * 60_000;
const MAX_TRIES = 5;
const AUTO_STOP = new Set(["rate_limited", "account_banned", "session_invalid"]);

export function ensureBaleTestSchema(db: Db): void {
  const cols = new Set((db.prepare("PRAGMA table_info(bale_accounts)").all() as { name: string }[]).map(c => c.name));
  if (!cols.has("kind")) db.exec("ALTER TABLE bale_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'expert'");
  db.exec(`CREATE TABLE IF NOT EXISTS bale_test_allowlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, phone_ct TEXT NOT NULL, phone_key_id TEXT NOT NULL, phone_masked TEXT NOT NULL, peer_id TEXT,
    created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bale_test_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES bale_accounts(id), allow_id INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('in','out')), text TEXT,  has_file INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','failed','blocked','received','external')),
    error TEXT, attempts INTEGER NOT NULL DEFAULT 0, bale_msg_id TEXT, scheduled_at TEXT, sent_at TEXT, created_by INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(account_id, bale_msg_id));`);
}

const TEST_FA: Record<string, string> = {
  forbidden: "این بخش فقط برای مدیر است.",
  test_disabled: "کلید «حساب تستی» خاموش است. اول روشنش کنید.",
  key_missing: "کلید رمزنگاری نشست بله روی سرور تنظیم نشده است.",
  sidecar_not_configured: "سرویس بله روی سرور راه‌اندازی نشده است.",
  sidecar_unavailable: "سرویس بله الان در دسترس نیست. چند دقیقه‌ی دیگر دوباره امتحان کنید.",
  sidecar_bad_response: "پاسخ سرویس بله نامعتبر بود. دوباره امتحان کنید.",
  phone_invalid: "شماره‌ی موبایل درست نیست. مثل ۰۹۱۲۱۲۳۴۵۶۷ وارد کنید.",
  rate_limited: "بله فعلاً اجازه نمی‌دهد. کمی بعد دوباره امتحان کنید.",
  too_many_starts: "در یک ساعت حداکثر ۳ بار می‌شود برای حساب تستی کد گرفت.",
  number_banned: "این شماره در بله مسدود است.",
  wrong_code: "کد درست نیست.",
  code_expired: "کد منقضی شده است. از اول شروع کنید.",
  flow_expired: "زمان ورود تمام شد. از اول شروع کنید.",
  no_flow: "ورودی در جریان نیست. از اول شروع کنید.",
  too_many_tries: "تعداد تلاش زیاد شد. از اول شروع کنید.",
  sign_up_needed: "این شماره حساب بله ندارد. اول در اپ بله ثبت‌نام کنید.",
  wrong_password: "رمز دومرحله‌ای درست نیست.",
  bad_code: "کد باید ۴ تا ۶ رقم باشد.",
  bad_password: "رمز دومرحله‌ای را وارد کنید.",
  already_connected: "حساب تستی همین الان وصل است.",
  not_allowlisted: "این شماره در فهرست شماره‌های تستی نیست؛ پیامی فرستاده نشد.",
  allowlist_full: "حداکثر ۳ شماره‌ی تستی می‌شود ثبت کرد.",
  allowlist_duplicate: "این شماره قبلاً در فهرست هست.",
  customer_number: "این شماره متعلق به یک مشتری است و نمی‌تواند شماره‌ی تستی باشد.",
  own_number: "شماره‌ی خودِ حساب تستی را نمی‌شود گیرنده گذاشت.",
  unauthorized: "سرویس بله درخواست را نپذیرفت.",
  unknown: "خطای ناشناخته از بله. دوباره امتحان کنید.",
  ...BLOCK_FA,
  not_connected: "حساب تستی وصل نیست.",
};
/** What the «ارسال پیام تستی» box shows per Bale error (the point of the test account: check this mapping). */
export const TEST_SEND_ERR_FA: Record<string, string> = {
  no_bale_account: "این شماره در بله حساب ندارد یا پیدا نشد (peer_not_found).",
  peer_blocked: "به نظر می‌رسد این شماره حساب تستی را در بله مسدود کرده است (peer_blocked، تأییدنشده).",
  rate_limited: "بله محدودیت ارسال گذاشت (rate_limited)؛ حساب تستی متوقف و کلید تستی خاموش شد.",
  account_banned: "بله حساب تستی را مسدود کرد (account_banned)؛ نشست پاک و کلید تستی خاموش شد.",
  session_invalid: "نشست حساب تستی از کار افتاد (session_invalid)؛ دوباره وصل کنید.",
  uncertain: "معلوم نشد پیام رسید یا نه (uncertain).",
  sidecar_unavailable: "سرویس بله در دسترس نبود (sidecar_unavailable).",
  not_attached: "نشست روی سرویس بله باز نبود (not_attached).",
  not_allowlisted: "شماره از فهرست تستی حذف شد؛ فرستاده نشد.",
  test_disabled: "کلید حساب تستی خاموش شد؛ فرستاده نشد.",
  not_connected: "حساب تستی وصل نبود؛ فرستاده نشد.",
};

export type BaleTestCtx = {
  db: Db; now: () => Date; env: () => KeyEnv; sidecar: BaleSidecar; random?: () => number;
  setting: (k: string) => string; nameOf: (u: any) => string | null; userRow: (id: number) => any;
  audit: (o: { req?: Request; u?: any; accountId?: number | null; action: string; outcome: string; detail?: Record<string, string | number | boolean | null> }) => void;
  normalize: (raw: unknown) => string | null; mask: (p: string) => string; asciiDigits: (raw: unknown) => string;
  syncSessions: () => Promise<unknown>;
};

export function createBaleTest(ctx: BaleTestCtx) {
  const { db, now } = ctx;
  const rnd = ctx.random ?? Math.random;
  const iso = (d = now()) => d.toISOString();
  const row = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T | undefined;
  const rows = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const since = (ms: number) => new Date(now().getTime() - ms).toISOString();
  const num = (k: string, d: number) => { const v = Number(ctx.setting(k)); return Number.isFinite(v) && v >= 0 ? v : d; };
  const banned = () => { try { const l = JSON.parse(ctx.setting("banned_words")); return Array.isArray(l) ? l.map(String) : []; } catch { return []; } };
  const quietNow = (d = now()) => inBaleQuiet(d, ctx.setting("quiet_start"), ctx.setting("quiet_end"));
  const quietEnd = (d = now()) => quietEndAfter(d, ctx.setting("quiet_end"));
  const gapMs = () => { const lo = num("gap_min_s", 45), hi = Math.max(lo, num("gap_max_s", 120)); return Math.round((lo + rnd() * (hi - lo)) * 1000); };
  const testOn = () => ctx.setting("test_enabled") === "1";
  const account = () => row<any>("SELECT * FROM bale_accounts WHERE kind=? ORDER BY id LIMIT 1", BALE_TEST_KIND);
  const ref = (a: any) => `acc-${a.id}`;
  const fail = (res: Response, status: number, error: string) => { if (!res.headersSent) res.status(status).json({ error, message: TEST_FA[error] ?? TEST_FA.unknown }); };
  const setSetting = (k: string, v: string, by: number | null) => run(`INSERT INTO bale_settings(key,value,updated_at,updated_by_user_id) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id`, k, v, iso(), by);

  /* ---------------- allowlist (sealed numbers; only ever decrypted to send or to match an inbound phone) ---------------- */
  const allowRows = () => rows<any>("SELECT * FROM bale_test_allowlist ORDER BY id");
  const allowPhone = (x: any): string | null => { try { return openBaleSession(ctx.env(), x.phone_ct, ALLOW_AAD).plaintext; } catch { return null; } };
  const isCustomerNumber = (phone: string) =>
    rows<any>("SELECT phone FROM customers WHERE phone IS NOT NULL AND phone<>''").some(c => ctx.normalize(c.phone) === phone);

  /* ---------------- login flow (memory only; one at a time for the whole system test account) ---------------- */
  type Flow = { flowId: string; step: "code" | "password"; expiresAt: number; phoneMasked: string; deviceHash: string; tries: number; codeType: string; by: number };
  let flow: Flow | null = null;
  const liveFlow = () => { if (flow && flow.expiresAt <= now().getTime()) flow = null; return flow; };
  const startsLastHour = () => Number(row<any>("SELECT count(*) n FROM bale_audit WHERE action='test.connect.start' AND at>?", since(3600_000))?.n ?? 0);

  const sentSince = (accountId: number, ms: number) => Number(row<any>(`SELECT count(*) n FROM bale_test_messages WHERE account_id=? AND direction='out'
    AND status IN ('sent','sending') AND COALESCE(sent_at,updated_at)>?`, accountId, since(ms))?.n ?? 0);
  function msgView(m: any, masks: Map<number, string>) {
    const err = m.error ?? null;
    return { id: m.id, allowId: m.allow_id, phoneMasked: masks.get(m.allow_id) ?? null, direction: m.direction, text: m.text, hasFile: Boolean(m.has_file),
      status: m.status, error: err, errorMessage: err ? TEST_SEND_ERR_FA[err] ?? TEST_FA[err] ?? `خطا: ${err}` : null,
      scheduledAt: m.scheduled_at ?? null, sentAt: m.sent_at ?? null, createdAt: m.created_at };
  }
  function view() {
    const a = account(); const f = liveFlow(); const t = now();
    const al = allowRows(); const masks = new Map(al.map(x => [x.id, x.phone_masked] as [number, string]));
    return {
      enabled: testOn(), masterEnabled: ctx.setting("master_enabled") === "1", ready: baleHasKey(ctx.env()) && ctx.sidecar.configured(),
      account: a ? { id: a.id, status: a.status, phoneMasked: a.phone_masked, connectedAt: a.connected_at, lastError: a.last_error, stoppedReason: a.stopped_reason ?? null,
        hasSession: Boolean(a.session_ct), inboundIgnored: Number(a.inbound_ignored ?? 0), nextSendAt: a.next_send_at ?? null } : null,
      flow: f ? { step: f.step, expiresAt: new Date(f.expiresAt).toISOString(), phoneMasked: f.phoneMasked, codeType: f.codeType } : null,
      startsLeft: Math.max(0, BALE_TEST_STARTS_PER_HOUR - startsLastHour()),
      allowlist: al.map(x => ({ id: x.id, phoneMasked: x.phone_masked, peerKnown: Boolean(x.peer_id), createdAt: x.created_at })), allowMax: BALE_TEST_ALLOW_MAX,
      messages: a ? rows<any>("SELECT * FROM bale_test_messages WHERE account_id=? ORDER BY id DESC LIMIT 50", a.id).reverse().map(m => msgView(m, masks)) : [],
      sendState: { quietNow: quietNow(t), quietEnd: quietNow(t) ? iso(quietEnd(t)) : null, sentLastHour: a ? sentSince(a.id, 3_600_000) : 0, perHour: num("per_hour", 20),
        sentToday: a ? sentSince(a.id, 86_400_000) : 0, perDay: num("per_day", 80) },
    };
  }
  const sidecarFail = (res: Response, e: unknown) => {
    if (e instanceof BaleSidecarError) return fail(res, ["phone_invalid", "wrong_code", "wrong_password", "sign_up_needed"].includes(e.code) ? 422
      : e.code === "rate_limited" ? 429 : ["code_expired", "flow_expired"].includes(e.code) ? 410 : 502, e.code);
    if (e instanceof BaleKeyMissing) return fail(res, 503, "key_missing");
    console.error("bale test error", (e as Error)?.name); return fail(res, 500, "unknown");
  };

  function storeConnected(req: Request, u: any, f: Flow, c: { token: string; baleUserId: string | null }) {
    const t = iso(); let a = account();
    if (!a) {
      run(`INSERT INTO bale_accounts(user_id,salesperson_id,kind,phone_masked,device_hash,device_title,status,mode,created_at,updated_at) VALUES(?,NULL,?,?,?,?,'disconnected','off',?,?)`,
        BALE_TEST_USER_ID, BALE_TEST_KIND, f.phoneMasked, f.deviceHash, "Nafis CRM test, Linux", t, t);
      a = account();
    }
    const sealed = sealBaleSession(ctx.env(), c.token, baleSessionAad(a.id, BALE_TEST_USER_ID));
    run(`UPDATE bale_accounts SET phone_masked=?, bale_user_id=?, session_ct=?, session_key_id=?, device_hash=?, status='connected', mode='off', next_send_at=NULL,
      connected_at=?, last_seen_at=?, last_error=NULL, stopped_reason=NULL, disconnected_at=NULL, disconnected_by=NULL, updated_at=? WHERE id=?`,
      f.phoneMasked, c.baleUserId, sealed.value, sealed.keyId, f.deviceHash, t, t, t, a.id);
    flow = null;
    ctx.audit({ req, u, accountId: a.id, action: "test.connect.connected", outcome: "ok", detail: { keyId: sealed.keyId, phone: f.phoneMasked } });
    void ctx.syncSessions().catch(() => undefined);
  }

  async function disconnect(req: Request | undefined, u: any, a: any, why: string) {
    let remote: "ok" | "failed" | "no_session" = "no_session";
    if (a.session_ct) {
      try {
        const { plaintext } = openBaleSession(ctx.env(), a.session_ct, baleSessionAad(a.id, BALE_TEST_USER_ID));
        await ctx.sidecar.signOut({ accountRef: ref(a), token: plaintext, deviceHash: a.device_hash }); remote = "ok";
      } catch (e) { remote = "failed"; if (!(e instanceof BaleSidecarError) && !(e instanceof BaleKeyMissing)) console.error("bale test signout", (e as Error)?.name); }
    }
    const t = iso();
    run(`UPDATE bale_accounts SET session_ct=NULL, session_key_id=NULL, status='disconnected', mode='off', disconnected_at=?, disconnected_by=?, last_error=?, updated_at=? WHERE id=?`,
      t, u?.id ?? null, remote === "failed" ? "signout_failed" : null, t, a.id);
    run("UPDATE bale_test_messages SET status='blocked', error='not_connected', updated_at=? WHERE account_id=? AND status='queued'", t, a.id);
    void ctx.sidecar.detach({ accountRef: ref(a) }).catch(() => undefined);
    ctx.audit({ req, u, accountId: a.id, action: "test.disconnect", outcome: "ok", detail: { remoteSignOut: remote, why } });
    return remote;
  }

  function autoStop(a: any, code: string) {
    const t = iso();
    if (code === "account_banned" || code === "session_invalid") void ctx.sidecar.detach({ accountRef: ref(a) }).catch(() => undefined);
    const status = code === "account_banned" ? "banned" : code === "session_invalid" ? "error" : a.status;
    run(`UPDATE bale_accounts SET status=?, last_error=?, stopped_reason=?, updated_at=?${code === "account_banned" || code === "session_invalid" ? ", session_ct=NULL, session_key_id=NULL" : ""} WHERE id=?`,
      status, code, code, t, a.id);
    setSetting("test_enabled", "0", null);
    const n = run("UPDATE bale_test_messages SET status='blocked', error='test_disabled', updated_at=? WHERE account_id=? AND status='queued'", t, a.id).changes;
    ctx.audit({ accountId: a.id, action: "test.auto_stop", outcome: code, detail: { blockedRows: Number(n) } });
  }

  async function attach(a: any): Promise<boolean> {
    try {
      const { plaintext } = openBaleSession(ctx.env(), a.session_ct, baleSessionAad(a.id, BALE_TEST_USER_ID));
      await ctx.sidecar.attach({ accountRef: ref(a), token: plaintext, deviceHash: a.device_hash });
      return true;
    } catch (e) {
      const code = e instanceof BaleSidecarError ? e.code : "error";
      ctx.audit({ accountId: a.id, action: "test.session.attach", outcome: code });
      if (code === "session_invalid" || code === "account_banned") autoStop(a, code);
      return false;
    }
  }

  /* ---------------- worker: one queued test message at a time, same caps / gap / quiet hours ---------------- */
  let busy = false;
  async function tick(): Promise<string> {
    if (busy) return "busy";
    busy = true;
    try {
      run("UPDATE bale_test_messages SET status='failed', error='uncertain', updated_at=? WHERE status='sending' AND updated_at<?", iso(), since(BALE_SENDING_STALE_MS));
      const a = account(); if (!a) return "idle";
      const nowIso = iso();
      const o = row<any>(`SELECT * FROM bale_test_messages WHERE account_id=? AND status='queued' AND (scheduled_at IS NULL OR scheduled_at<=?) ORDER BY COALESCE(scheduled_at,created_at), id LIMIT 1`, a.id, nowIso);
      if (!o) return "idle";
      const block = (why: string) => { run("UPDATE bale_test_messages SET status='blocked', error=?, updated_at=? WHERE id=?", why, iso(), o.id);
        ctx.audit({ accountId: a.id, action: "test.send", outcome: `blocked:${why}`, detail: { testMessageId: o.id } }); return `blocked:${why}`; };
      const hold = (until: Date, why: string) => { run("UPDATE bale_test_messages SET scheduled_at=?, updated_at=? WHERE id=?", iso(until), iso(), o.id); return `held:${why}`; };
      if (!testOn()) return block("test_disabled");
      if (a.status !== "connected" || !a.session_ct) return block("not_connected");
      const al = row<any>("SELECT * FROM bale_test_allowlist WHERE id=?", o.allow_id); const phone = al ? allowPhone(al) : null;
      if (!al || !phone) return block("not_allowlisted");
      const tp = baleTextProblem(o.text, banned()); if (tp) return block(tp);
      if (a.next_send_at && a.next_send_at > nowIso) return "gap";
      if (sentSince(a.id, 86_400_000) >= num("per_day", 80)) return hold(new Date(now().getTime() + 3_600_000), "cap_day");
      if (sentSince(a.id, 3_600_000) >= num("per_hour", 20)) return hold(new Date(now().getTime() + 600_000), "cap_hour");
      if (quietNow()) return hold(quietEnd(), "quiet");
      if (run("UPDATE bale_test_messages SET status='sending', attempts=attempts+1, updated_at=? WHERE id=? AND status='queued'", iso(), o.id).changes !== 1) return "raced";
      const payload = { accountRef: ref(a), phone, peerId: al.peer_id ?? null, text: o.text, typingMs: Math.min(8000, 1200 + o.text.length * 50) };
      try {
        let out;
        try { out = await ctx.sidecar.send(payload); }
        catch (e) { if (!(e instanceof BaleSidecarError && e.code === "not_attached") || !(await attach(a))) throw e; out = await ctx.sidecar.send(payload); }
        const t = iso();
        run("UPDATE bale_test_messages SET status='sent', sent_at=?, bale_msg_id=?, error=NULL, updated_at=? WHERE id=?", t, out.messageId, t, o.id);
        if (out.peerId) run("UPDATE bale_test_allowlist SET peer_id=? WHERE id=?", String(out.peerId).slice(0, 40), al.id);
        run("UPDATE bale_accounts SET next_send_at=?, last_seen_at=? WHERE id=?", new Date(now().getTime() + gapMs()).toISOString(), t, a.id);
        ctx.audit({ accountId: a.id, action: "test.send", outcome: "sent", detail: { testMessageId: o.id, to: al.phone_masked } });
        return "sent";
      } catch (e) {
        const code = e instanceof BaleSidecarError ? e.code : "error"; const t = iso();
        if (AUTO_STOP.has(code)) { run("UPDATE bale_test_messages SET status='failed', error=?, updated_at=? WHERE id=?", code, t, o.id); autoStop(a, code); }
        else if (code === "peer_not_found") run("UPDATE bale_test_messages SET status='failed', error='no_bale_account', updated_at=? WHERE id=?", t, o.id);
        // UNVERIFIED wording on real Bale — recorded so the admin can compare with what the test phone shows. The test account is not stopped.
        else if (code === "peer_blocked") run("UPDATE bale_test_messages SET status='failed', error='peer_blocked', updated_at=? WHERE id=?", t, o.id);
        else if (["sidecar_unavailable", "sidecar_not_configured", "not_attached"].includes(code) && o.attempts + 1 < BALE_MAX_ATTEMPTS)
          run("UPDATE bale_test_messages SET status='queued', scheduled_at=?, error=?, updated_at=? WHERE id=?", new Date(now().getTime() + 60_000 * (o.attempts + 1)).toISOString(), code, t, o.id);
        else run("UPDATE bale_test_messages SET status='failed', error=?, updated_at=? WHERE id=?", code, t, o.id);
        ctx.audit({ accountId: a.id, action: "test.send", outcome: code, detail: { testMessageId: o.id, to: al.phone_masked, attempt: o.attempts + 1, ...(code === "peer_blocked" ? { unverified: true } : {}) } });
        return `error:${code}`;
      }
    } finally { busy = false; }
  }

  /* ---------------- inbound: only allowlisted senders are stored ---------------- */
  type InEv = { messageId?: unknown; peerId?: unknown; peerPhone?: unknown; text?: unknown; hasFile?: unknown; date?: unknown; fromSelf?: unknown };
  function inbound(a: any, evs: InEv[]): { stored: number; ignored: number } {
    if (!testOn() || a.status !== "connected") return { stored: 0, ignored: evs.length };
    const al = allowRows(); let phones: Map<number, string> | null = null;
    let stored = 0, ignored = 0;
    for (const ev of evs) {
      const peer = ev.peerId == null ? "" : String(ev.peerId).slice(0, 40);
      const mid = ev.messageId == null ? "" : String(ev.messageId).slice(0, 64);
      let hit = peer ? al.find(x => x.peer_id && x.peer_id === peer) : undefined;
      const p = ctx.normalize(ev.peerPhone);
      if (!hit && p) {
        phones ??= new Map(al.map(x => [x.id, allowPhone(x) ?? ""] as [number, string]));
        hit = al.find(x => phones!.get(x.id) === p);
        if (hit && peer && !hit.peer_id) { run("UPDATE bale_test_allowlist SET peer_id=? WHERE id=?", peer, hit.id); hit.peer_id = peer; }
      }
      if (!hit || !mid) { ignored++; continue; }
      const dir = ev.fromSelf === true ? "out" : "in";
      const at = Number.isFinite(Number(ev.date)) && Number(ev.date) > 1e12 ? new Date(Number(ev.date)).toISOString() : iso();
      const ins = run(`INSERT INTO bale_test_messages(account_id,allow_id,direction,text,has_file,status,bale_msg_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,bale_msg_id) DO NOTHING`, a.id, hit.id, dir, typeof ev.text === "string" ? ev.text.slice(0, 4000) : null, ev.hasFile === true ? 1 : 0,
        dir === "in" ? "received" : "external", mid, at, iso());
      if (ins.changes !== 1) continue;
      stored++;
      ctx.audit({ accountId: a.id, action: "test.inbound", outcome: "stored", detail: { from: hit.phone_masked, hasFile: ev.hasFile === true } });
    }
    if (ignored) run("UPDATE bale_accounts SET inbound_ignored=inbound_ignored+? WHERE id=?", ignored, a.id);
    return { stored, ignored };
  }

  /* ---------------- routes (every one behind the admin gate) ---------------- */
  function mount(staff: Router, admin: (req: Request, res: Response, next: NextFunction) => void) {
    const r = Router();
    r.use(admin);
    r.get("/", (_req, res) => res.json(view()));
    r.put("/enabled", (req, res) => {
      const u = res.locals.baleAdmin; const on = req.body?.enabled === true;
      setSetting("test_enabled", on ? "1" : "0", u.id);
      if (!on) { flow = null; const a = account(); if (a) run("UPDATE bale_test_messages SET status='blocked', error='test_disabled', updated_at=? WHERE account_id=? AND status='queued'", iso(), a.id); }
      ctx.audit({ req, u, action: on ? "test.enabled_on" : "test.enabled_off", outcome: "ok" });
      void ctx.syncSessions().catch(() => undefined);
      res.json(view());
    });
    r.post("/allowlist", (req, res) => {
      const u = res.locals.baleAdmin; const phone = ctx.normalize(req.body?.phone);
      if (!phone) return fail(res, 422, "phone_invalid");
      if (!baleHasKey(ctx.env())) return fail(res, 503, "key_missing");
      const al = allowRows();
      if (al.length >= BALE_TEST_ALLOW_MAX) return fail(res, 409, "allowlist_full");
      if (al.some(x => allowPhone(x) === phone)) return fail(res, 409, "allowlist_duplicate");
      if (isCustomerNumber(phone)) { ctx.audit({ req, u, action: "test.allow.add", outcome: "customer_number", detail: { phone: ctx.mask(phone) } }); return fail(res, 409, "customer_number"); }
      const sealed = sealBaleSession(ctx.env(), phone, ALLOW_AAD);
      const id = Number(run("INSERT INTO bale_test_allowlist(phone_ct,phone_key_id,phone_masked,created_by,created_at) VALUES(?,?,?,?,?)", sealed.value, sealed.keyId, ctx.mask(phone), u.id, iso()).lastInsertRowid);
      ctx.audit({ req, u, action: "test.allow.add", outcome: "ok", detail: { allowId: id, phone: ctx.mask(phone) } });
      res.json(view());
    });
    r.delete("/allowlist/:id", (req, res) => {
      const u = res.locals.baleAdmin; const x = row<any>("SELECT * FROM bale_test_allowlist WHERE id=?", Number(req.params.id));
      if (!x) return fail(res, 404, "not_allowlisted");
      run("DELETE FROM bale_test_allowlist WHERE id=?", x.id);
      run("UPDATE bale_test_messages SET status='blocked', error='not_allowlisted', updated_at=? WHERE allow_id=? AND status='queued'", iso(), x.id);
      ctx.audit({ req, u, action: "test.allow.remove", outcome: "ok", detail: { allowId: x.id, phone: x.phone_masked } });
      res.json(view());
    });
    r.post("/connect/start", async (req, res) => {
      const u = res.locals.baleAdmin;
      if (!testOn()) { ctx.audit({ req, u, action: "test.connect.start_refused", outcome: "disabled" }); return fail(res, 423, "test_disabled"); }
      if (!baleHasKey(ctx.env())) return fail(res, 503, "key_missing");
      if (!ctx.sidecar.configured()) return fail(res, 503, "sidecar_not_configured");
      const a = account();
      if (a?.status === "connected" && a.session_ct) return fail(res, 409, "already_connected");
      const phone = ctx.normalize(req.body?.phone);
      if (!phone) return fail(res, 422, "phone_invalid");
      if (startsLastHour() >= BALE_TEST_STARTS_PER_HOUR) { ctx.audit({ req, u, action: "test.connect.start_limited", outcome: "rate_limited" }); return fail(res, 429, "too_many_starts"); }
      const old = liveFlow(); if (old) { flow = null; void ctx.sidecar.cancel({ flowId: old.flowId }); }
      const deviceHash = a?.device_hash ?? randomUUID(); const masked = ctx.mask(phone);
      try {
        const s = await ctx.sidecar.startAuth({ accountRef: "system-test", phone, deviceHash, deviceTitle: "Nafis CRM test, Linux" });
        flow = { flowId: s.flowId, step: "code", expiresAt: now().getTime() + Math.min(FLOW_TTL_MS, s.expiresInS * 1000), phoneMasked: masked, deviceHash, tries: 0, codeType: s.codeType, by: u.id };
        ctx.audit({ req, u, accountId: a?.id ?? null, action: "test.connect.start", outcome: "ok", detail: { phone: masked, codeType: s.codeType } });
        res.json(view());
      } catch (e) {
        ctx.audit({ req, u, accountId: a?.id ?? null, action: "test.connect.start", outcome: e instanceof BaleSidecarError ? e.code : "error", detail: { phone: masked } });
        sidecarFail(res, e);
      }
    });
    const step = async (req: Request, res: Response, kind: "code" | "password") => {
      const u = res.locals.baleAdmin;
      if (!testOn()) { flow = null; return fail(res, 423, "test_disabled"); }
      const f = liveFlow(); if (!f) return fail(res, 410, "no_flow"); if (f.step !== kind) return fail(res, 409, "no_flow");
      let secret: string;
      if (kind === "code") { secret = ctx.asciiDigits(req.body?.code); if (!/^\d{4,6}$/.test(secret)) return fail(res, 422, "bad_code"); }
      else { secret = String(req.body?.password ?? ""); if (!secret || secret.length > 256) return fail(res, 422, "bad_password"); }
      if (f.tries >= MAX_TRIES) { flow = null; void ctx.sidecar.cancel({ flowId: f.flowId }); return fail(res, 429, "too_many_tries"); }
      f.tries++;
      try {
        const s = kind === "code" ? await ctx.sidecar.submitCode({ flowId: f.flowId, code: secret }) : await ctx.sidecar.submitPassword({ flowId: f.flowId, password: secret });
        if (s.status === "password_needed") { f.step = "password"; f.tries = 0; ctx.audit({ req, u, action: "test.connect.code", outcome: "password_needed" }); return res.json(view()); }
        storeConnected(req, u, f, s); res.json(view());
      } catch (e) {
        const code = e instanceof BaleSidecarError ? e.code : e instanceof BaleKeyMissing ? "key_missing" : "error";
        ctx.audit({ req, u, action: `test.connect.${kind}`, outcome: code, detail: { tries: f.tries } });
        if (code === "code_expired" || code === "flow_expired") flow = null;
        sidecarFail(res, e);
      }
    };
    r.post("/connect/code", (req, res) => step(req, res, "code"));
    r.post("/connect/password", (req, res) => step(req, res, "password"));
    r.post("/connect/cancel", (req, res) => {
      const f = liveFlow(); if (f) { flow = null; void ctx.sidecar.cancel({ flowId: f.flowId }); ctx.audit({ req, u: res.locals.baleAdmin, action: "test.connect.cancel", outcome: "ok" }); }
      res.json(view());
    });
    r.post("/disconnect", async (req, res) => {
      const a = account(); if (!a || (!a.session_ct && a.status !== "connected")) return fail(res, 409, "not_connected");
      const remote = await disconnect(req, res.locals.baleAdmin, a, "admin");
      res.json({ ...view(), remoteSignOut: remote });
    });
    r.post("/send", (req, res) => {
      const u = res.locals.baleAdmin; const a = account();
      const deny = (status: number, error: string) => { ctx.audit({ req, u, accountId: a?.id ?? null, action: "test.send_request", outcome: error }); fail(res, status, error); };
      if (!testOn()) return deny(423, "test_disabled");
      if (!a || a.status !== "connected" || !a.session_ct) return deny(409, "not_connected");
      // Only an allowlist entry, by id — or a typed number that IS on the allowlist. Anything else is refused.
      const al = allowRows(); let hit: any;
      if (req.body?.allowId != null) hit = al.find(x => x.id === Number(req.body.allowId));
      else { const p = ctx.normalize(req.body?.phone); hit = p ? al.find(x => allowPhone(x) === p) : undefined; }
      if (!hit) return deny(403, "not_allowlisted");
      const text = withAmountDisclaimer(typeof req.body?.text === "string" ? req.body.text : "");
      const tp = baleTextProblem(text, banned()); if (tp) return deny(422, tp);
      if (row("SELECT 1 FROM bale_test_messages WHERE account_id=? AND allow_id=? AND status IN ('queued','sending')", a.id, hit.id)) return deny(409, "already_pending");
      if (sentSince(a.id, 86_400_000) >= num("per_day", 80)) return deny(429, "cap_day");
      if (sentSince(a.id, 3_600_000) >= num("per_hour", 20)) return deny(429, "cap_hour");
      const held = quietNow() ? iso(quietEnd()) : null; const t = iso();
      const id = Number(run(`INSERT INTO bale_test_messages(account_id,allow_id,direction,text,status,scheduled_at,created_by,created_at,updated_at) VALUES(?,?,'out',?,'queued',?,?,?,?)`,
        a.id, hit.id, text, held, u.id, t, t).lastInsertRowid);
      ctx.audit({ req, u, accountId: a.id, action: "test.send_request", outcome: "queued", detail: { testMessageId: id, to: hit.phone_masked, held: Boolean(held) } });
      void tick().catch(() => undefined);
      res.json({ ...view(), queued: { id, heldUntil: held, message: held ? BLOCK_FA.quiet_hours : null, text } });
    });
    staff.use("/admin/bale/test", r);
  }

  return { mount, tick, inbound, testOn, account, view, disconnect, _flow: () => flow };
}
