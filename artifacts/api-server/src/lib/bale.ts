/**
 * «حساب شخصی بله» — piece 1a: connect an expert's own Bale account (secure wizard) + read-only «گفتگوی بله» on the
 * customer page + switches + audit. NOTHING is sent to customers in 1a (no outbox runner, no SMS).
 *
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
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensureSchemaObject } from "./schema-objects";
import { TRAINEE_SALESPERSON_IDS, EXCLUDED_USER_IDS } from "./assistants";
import { baleHasKey, baleSessionAad, openBaleSession, sealBaleSession, BaleKeyMissing, type KeyEnv } from "./bale-crypto";
import { BaleSidecarError, type BaleSidecar } from "./bale-sidecar-client";

type Db = DatabaseSync;
export type BaleActor = { id: number } | null;
export type BaleDeps = { db: Db; env: () => KeyEnv; sidecar: BaleSidecar; now?: () => Date; actor: (res: Response) => BaleActor };

export const BALE_MODES = ["off", "approve_first", "auto"] as const;
export type BaleMode = typeof BALE_MODES[number];
export const BALE_LOGIN_STARTS_PER_HOUR = 3;
export const BALE_FLOW_TTL_MS = 5 * 60_000;
export const BALE_MAX_TRIES_PER_FLOW = 5;
/** Defaults for piece 1b (stored now so the admin can see them; nothing reads them in 1a). */
export const BALE_DEFAULT_SETTINGS: Record<string, string> = {
  master_enabled: "0", gap_min_s: "45", gap_max_s: "120", per_hour: "20", per_day: "80", new_chats_per_day: "15",
  quiet_start: "21:30", quiet_end: "08:30", banned_words: JSON.stringify(["سپرده", "برآورد", "تخمینی"]),
};

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
  const accountOf = (userId: number) => row<any>("SELECT * FROM bale_accounts WHERE user_id=?", userId);

  /* ------------- login flows: memory only (flowId is opaque; the Bale transaction_hash never leaves the sidecar) ------------- */
  type Flow = { flowId: string; step: "code" | "password"; expiresAt: number; phoneMasked: string; deviceHash: string; deviceTitle: string; tries: number; codeType: string };
  const flows = new Map<number, Flow>();
  const liveFlow = (userId: number) => { const f = flows.get(userId); if (f && f.expiresAt <= now().getTime()) { flows.delete(userId); return undefined; } return f; };
  const startsLastHour = (userId: number) => Number(row<any>("SELECT count(*) n FROM bale_audit WHERE user_id=? AND action='connect.start' AND at>?",
    userId, new Date(now().getTime() - 3600_000).toISOString())?.n ?? 0);

  function accountView(a: any) {
    if (!a) return null;
    return { id: a.id, status: a.status, mode: a.mode, phoneMasked: a.phone_masked, connectedAt: a.connected_at, lastSeenAt: a.last_seen_at,
      lastError: a.last_error, disconnectedAt: a.disconnected_at, hasSession: Boolean(a.session_ct) };
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
    run("UPDATE bale_accounts SET mode=?, updated_at=? WHERE id=?", mode, iso(), a.id);
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
    const st = owner ? row<any>("SELECT s.mode FROM bale_conversation_state s JOIN bale_accounts a ON a.id=s.account_id WHERE s.customer_id=? AND a.user_id=?", cid, owner.id) : undefined;
    res.json({
      customerId: cid, masterEnabled: masterOn(), readOnly: true,
      expert: owner ? { name: nameOf(owner), connected: owner.status === "connected", mode: owner.mode ?? "off" } : null,
      conversationMode: st?.mode ?? null,
      messages: msgs.map(m => ({ id: m.id, direction: m.direction, text: m.text, hasFile: Boolean(m.file_ref), status: m.status, createdAt: m.created_at,
        expertName: m.full_name || m.username || null })),
    });
  });

  /* ---------------- admin ---------------- */
  const admin = (req: Request, res: Response, next: NextFunction) => {
    const u = me(res);
    if (!u || u.role !== "admin" || EXCLUDED_USER_IDS.includes(u.id)) { if (u) audit({ req, u, action: `${req.method} ${req.path}`, outcome: "forbidden" }); return fail(res, 403, "forbidden"); }
    res.locals.baleAdmin = u; next();
  };
  const adminAccount = (a: any) => ({ ...accountView(a), user: { id: a.user_id, name: nameOf(userRow(a.user_id)) }, salespersonId: a.salesperson_id });
  staff.get("/admin/bale", admin, async (_req, res) => {
    const eligible = rows<any>("SELECT id,role,salesperson_id,active,full_name,username FROM users WHERE role='salesperson' ORDER BY id").filter(baleEligible);
    const accounts = rows<any>("SELECT * FROM bale_accounts ORDER BY id");
    const health = deps.sidecar.configured() ? await deps.sidecar.health() : { ok: false };
    res.json({
      masterEnabled: masterOn(), keyReady: baleHasKey(deps.env()), sidecar: { configured: deps.sidecar.configured(), reachable: health.ok },
      limits: { gapMinS: Number(setting("gap_min_s")), gapMaxS: Number(setting("gap_max_s")), perHour: Number(setting("per_hour")), perDay: Number(setting("per_day")),
        newChatsPerDay: Number(setting("new_chats_per_day")), quietStart: setting("quiet_start"), quietEnd: setting("quiet_end") },
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
  const byId = (req: Request, res: Response) => { const a = row<any>("SELECT * FROM bale_accounts WHERE id=?", Number(req.params.id)); if (!a) fail(res, 404, "not_found"); return a; };
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

  return { staff, _internal: { flows, masterOn } };
}
