/**
 * «ثبت هوشمند» MVP (Mohammad 17:05): jobs that Sarina's runner files in the ازکی‌وام panel, a per-job chat,
 * code requests (ours|customer, no SMS ever sent by the CRM), and a stop before the panel's final submit until
 * the admin approves («تأیید ارسال»). Only NEW tables; cases, contracts, fees and settings are read-only here.
 * Secrets (panel password, codes) are AES-256-GCM sealed with a key file (smart-filing-crypto.ts) and never
 * returned to the UI, logged, audited or put in chat text. Runner tokens are stored as SHA-256 only.
 * DB, env and roots are injected so the fixture runs this on a DB copy.
 */
import express, { Router, type Request, type Response, type NextFunction } from "express";
import { EXPERT_INTRO_TRAINEE_SALESPERSON_IDS } from "./expert-intro-sms-core";
const TRAINEE_SALESPERSON_IDS: readonly number[] = EXPERT_INTRO_TRAINEE_SALESPERSON_IDS; // کارآموزها 5/19/20
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decryptSecret, encryptSecret, hasKey, SmartFilingKeyMissing, type KeyEnv } from "./smart-filing-crypto";

export type Db = { exec(sql: string): void; prepare(sql: string): { run(...p: any[]): any; all(...p: any[]): unknown[]; get(...p: any[]): unknown } };
export type Actor = { id: number; role: string; salespersonId: number | null; name: string };
export type Deps = {
  db: Db; env: () => KeyEnv; filesRoot: string; docRoots: string[];
  actor: (res: Response) => Actor | null; now?: () => Date;
};

export const STATUSES = ["queued", "running", "waiting_human", "ready_for_approval", "submitted", "approved", "rejected", "error", "cancelled"] as const;
export type Status = typeof STATUSES[number];
const OPEN: Status[] = ["queued", "running", "waiting_human", "ready_for_approval"];
const RUNNER_SET: Status[] = ["running", "waiting_human", "ready_for_approval", "submitted", "approved", "rejected", "error"];
export const MAX_SCREENSHOT_BYTES = 1_400_000; // decoded; base64 JSON stays under the 2 MB runner body limit
export const MAX_MESSAGES_PER_JOB = 400;
export const AZKI_SLUG = "azki-vam";
export const AZKI_DEFAULT_PLAN_IDS = [7, 8, 21];

export function ensureSmartFilingSchema(db: Db, nowIso = new Date().toISOString()): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS smart_filing_panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, base_url TEXT, username TEXT,
    password_enc TEXT, password_key_id TEXT, password_updated_at TEXT, auto_submit INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_user_id INTEGER);
  CREATE TABLE IF NOT EXISTS smart_filing_panel_plans (
    panel_id INTEGER NOT NULL REFERENCES smart_filing_panels(id) ON DELETE CASCADE, plan_id INTEGER NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(panel_id, plan_id));
  CREATE TABLE IF NOT EXISTS smart_filing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL DEFAULT 'real' CHECK(job_type IN ('training','real')),
    application_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, panel_id INTEGER NOT NULL REFERENCES smart_filing_panels(id),
    plan_id INTEGER, plan_name TEXT, amount_toman TEXT, duration_months INTEGER,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting_human','ready_for_approval','submitted','approved','rejected','error','cancelled')),
    step_label TEXT, progress INTEGER NOT NULL DEFAULT 0, checklist_json TEXT, attempt INTEGER NOT NULL DEFAULT 1,
    claimed_by_token_id INTEGER, claimed_at TEXT, submit_approved_at TEXT, submit_approved_by_user_id INTEGER,
    outcome_by TEXT, panel_reference TEXT, source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT,
    created_by_user_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT, finished_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_sf_jobs_status ON smart_filing_jobs(status, id);
  CREATE INDEX IF NOT EXISTS idx_sf_jobs_app ON smart_filing_jobs(application_id);
  CREATE TABLE IF NOT EXISTS smart_filing_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES smart_filing_jobs(id) ON DELETE CASCADE,
    author TEXT NOT NULL CHECK(author IN ('runner','user','system')), user_id INTEGER, user_name TEXT,
    kind TEXT NOT NULL DEFAULT 'text', body TEXT, data_json TEXT, step_label TEXT,
    screenshot_path TEXT, screenshot_mime TEXT, screenshot_bytes INTEGER, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_sf_messages_job ON smart_filing_messages(job_id, id);
  CREATE TABLE IF NOT EXISTS smart_filing_code_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES smart_filing_jobs(id) ON DELETE CASCADE,
    target TEXT NOT NULL CHECK(target IN ('ours','customer')), prompt TEXT, requested_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','consumed','expired','cancelled')),
    code_enc TEXT, code_masked TEXT, answered_by_user_id INTEGER, answered_at TEXT, consumed_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_sf_codes_job ON smart_filing_code_requests(job_id, id);
  CREATE TABLE IF NOT EXISTS smart_filing_runner_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, last_used_at TEXT, last_used_ip TEXT, revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS smart_filing_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id INTEGER, ip TEXT,
    action TEXT NOT NULL, job_id INTEGER, panel_id INTEGER, detail_json TEXT);
  CREATE INDEX IF NOT EXISTS idx_sf_audit_job ON smart_filing_audit(job_id, id);
  `);
  db.prepare("INSERT OR IGNORE INTO smart_filing_panels(slug,name,base_url,auto_submit,active,created_at,updated_at) VALUES(?,?,?,0,1,?,?)")
    .run(AZKI_SLUG, "ازکی‌وام", null, nowIso, nowIso);
  const panel = db.prepare("SELECT id FROM smart_filing_panels WHERE slug=?").get(AZKI_SLUG) as { id: number };
  const seeded = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
    && db.prepare("SELECT 1 FROM schema_migrations WHERE version='smart_filing_azki_plans_v1'").get();
  if (!seeded) {
    const hasPlans = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='loan_plans'").get();
    for (const pid of AZKI_DEFAULT_PLAN_IDS) {
      if (hasPlans && !db.prepare("SELECT 1 FROM loan_plans WHERE id=?").get(pid)) continue;
      db.prepare("INSERT OR IGNORE INTO smart_filing_panel_plans(panel_id,plan_id,created_at) VALUES(?,?,?)").run(panel.id, pid, nowIso);
    }
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES('smart_filing_azki_plans_v1',?)").run(nowIso);
  }
}

/* ---------- masking ---------- */
const toLatin = (s: string) => s.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
export function maskNationalId(v: string) { const s = toLatin(v).replace(/\D/g, ""); return s.length >= 6 ? `${s.slice(0, 3)}${"•".repeat(s.length - 5)}${s.slice(-2)}` : "•".repeat(s.length); }
export function maskPhone(v: string) { const s = toLatin(v).replace(/\D/g, ""); return s.length >= 8 ? `${s.slice(0, 4)}${"•".repeat(s.length - 7)}${s.slice(-3)}` : "•".repeat(s.length); }
export function maskCode(v: string) { const s = String(v); return s.length <= 2 ? "•".repeat(s.length) : `${s[0]}${"•".repeat(s.length - 2)}${s[s.length - 1]}`; }
/** Masks Iranian mobiles (09xxxxxxxxx / +989…) and 10-digit national IDs anywhere in text, plus any listed secrets. */
export function maskText(input: unknown, secrets: string[] = []): string {
  let s = toLatin(String(input ?? ""));
  for (const sec of secrets) if (sec && sec.length >= 3) s = s.split(sec).join(maskCode(sec));
  s = s.replace(/(?<!\d)(?:\+98|0098|0)?9\d{9}(?!\d)/g, m => maskPhone(m));
  s = s.replace(/(?<!\d)\d{10}(?!\d)/g, m => maskNationalId(m));
  return s;
}
const SENSITIVE_KEY = /(national|nid|melli|code_?melli|mobile|phone|tel|password|pass|otp|code|token|secret)/i;
export function maskData(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map(v => maskData(v, secrets, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      if (/password|pass|otp|token|secret/i.test(k)) { out[k] = "••••"; continue; }
      if (SENSITIVE_KEY.test(k) && (typeof v === "string" || typeof v === "number")) {
        const d = toLatin(String(v)).replace(/\D/g, "");
        out[k] = /mobile|phone|tel/i.test(k) ? maskPhone(String(v)) : /national|nid|melli/i.test(k) ? maskNationalId(String(v)) : d ? maskCode(String(v)) : maskText(v, secrets);
        continue;
      }
      out[k] = maskData(v, secrets, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return maskText(value, secrets).slice(0, 2000);
  return value ?? null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const IMG: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
function sniff(buf: Buffer): string | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export function createSmartFiling(deps: Deps) {
  const { db } = deps;
  const now = () => (deps.now ? deps.now() : new Date());
  const iso = () => now().toISOString();
  const row = <T>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T | undefined;
  const rows = <T>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const ip = (req: Request) => String((req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "").slice(0, 64);
  const audit = (req: Request, actorType: "user" | "runner", actorId: number | null, action: string, jobId: number | null, panelId: number | null, detail?: Record<string, unknown>) =>
    run("INSERT INTO smart_filing_audit(at,actor_type,actor_id,ip,action,job_id,panel_id,detail_json) VALUES(?,?,?,?,?,?,?,?)",
      iso(), actorType, actorId, ip(req), action, jobId, panelId, detail ? JSON.stringify(detail) : null);
  const fail = (res: Response, status: number, error: string, message?: string) => { res.status(status).json({ error, ...(message ? { message } : {}) }); };

  // Never crash the API at startup over the screenshot dir; uploads fail with 500 instead.
  try { fs.mkdirSync(deps.filesRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(deps.filesRoot, 0o700); } catch (e) { console.error("smart-filing: files dir unavailable", (e as Error).message); }

  function expireCodes() {
    const t = iso();
    run("UPDATE smart_filing_code_requests SET status='expired', code_enc=NULL WHERE status IN ('pending','answered') AND expires_at<=?", t);
  }
  function panelFor(planId: number | null) {
    if (!planId) return undefined;
    return row<any>(`SELECT p.* FROM smart_filing_panels p JOIN smart_filing_panel_plans pp ON pp.panel_id=p.id
      WHERE pp.plan_id=? AND p.active=1 ORDER BY p.id LIMIT 1`, planId);
  }
  function appRow(appId: number) {
    return row<any>(`SELECT a.id,a.customer_id,a.status,a.stage,a.requested_amount,a.approved_amount,
      COALESCE(a.duration_months,a.requested_duration_months) duration_months,
      COALESCE(a.plan_id, CASE WHEN json_valid(a.plan_ids) THEN CAST(json_extract(a.plan_ids,'$[0]') AS INTEGER) ELSE CAST(a.plan_ids AS INTEGER) END) plan_id,
      c.name customer_name,c.first_name,c.last_name,c.father_name,c.national_code,c.phone,c.birth_date_jalali,c.postal_code,c.address,c.city,c.email,c.salesperson_id
      FROM loan_applications a JOIN customers c ON c.id=a.customer_id WHERE a.id=? AND a.deleted_at IS NULL`, appId);
  }
  function documentsFor(appId: number, customerId: number) {
    const docs: Array<{ ref: string; label: string; mime: string | null; size: number | null; storage_path: string }> = [];
    for (const d of rows<any>("SELECT id,label,requirement_key,mime_type,size_bytes,storage_path,status FROM loan_application_documents WHERE application_id=? AND storage_path IS NOT NULL ORDER BY id", appId))
      docs.push({ ref: `app-${d.id}`, label: d.label || d.requirement_key, mime: d.mime_type, size: d.size_bytes, storage_path: d.storage_path });
    const idLabels: Record<string, string> = { national_card_front: "روی کارت ملی", national_card_back: "پشت کارت ملی", birth_cert_p1: "شناسنامه صفحه ۱", birth_cert_p2: "شناسنامه صفحه ۲", birth_cert_p3: "شناسنامه صفحه ۳" };
    for (const d of rows<any>("SELECT id,document_type,mime_type,size_bytes,storage_path FROM customer_identity_documents WHERE customer_id=? AND is_latest=1 ORDER BY id", customerId))
      docs.push({ ref: `id-${d.id}`, label: idLabels[d.document_type] ?? d.document_type, mime: d.mime_type, size: d.size_bytes, storage_path: d.storage_path });
    return docs;
  }
  function checklist(a: any) {
    const name = String(a.first_name && a.last_name ? `${a.first_name} ${a.last_name}` : a.customer_name ?? "").trim();
    const nid = toLatin(String(a.national_code ?? "")).replace(/\D/g, "");
    const mobile = toLatin(String(a.phone ?? "")).replace(/\D/g, "");
    const docs = documentsFor(a.id, a.customer_id);
    const has = (t: string) => docs.some(d => d.ref.startsWith("id-") && d.label === t);
    const items = [
      { key: "name", label: "نام و نام خانوادگی", ok: name.length >= 3, blocking: true },
      { key: "national_code", label: "کد ملی", ok: nid.length === 10, blocking: true },
      { key: "mobile", label: "موبایل", ok: /^09\d{9}$/.test(mobile), blocking: true },
      { key: "father_name", label: "نام پدر", ok: Boolean(String(a.father_name ?? "").trim()), blocking: false },
      { key: "birth_date", label: "تاریخ تولد", ok: Boolean(String(a.birth_date_jalali ?? "").trim()), blocking: false },
      { key: "postal_code", label: "کد پستی", ok: toLatin(String(a.postal_code ?? "")).replace(/\D/g, "").length === 10, blocking: false },
      { key: "address", label: "نشانی", ok: Boolean(String(a.address ?? "").trim()), blocking: false },
      { key: "doc_nc_front", label: "روی کارت ملی", ok: has("روی کارت ملی"), blocking: false },
      { key: "doc_nc_back", label: "پشت کارت ملی", ok: has("پشت کارت ملی"), blocking: false },
      { key: "doc_bc1", label: "شناسنامه صفحه ۱", ok: has("شناسنامه صفحه ۱"), blocking: false },
    ];
    return { items, blocked: items.some(i => i.blocking && !i.ok), documents: docs.length };
  }
  /**
   * Who may use ثبت هوشمند (enforced on every admin/expert endpoint):
   *  - admin: everything (panel settings/password, «تأیید ارسال», «ثبت نتیجه», cancel/retry, training jobs);
   *  - registrar («ثبت»): all jobs on plans linked to a panel (ترنم 7/8/21) — create, chat, codes, screenshots;
   *  - salesperson («فروش»): only jobs whose customer is theirs — create, chat, codes, screenshots;
   *  - trainees (salesperson 5/19/20) and any other role: no access.
   */
  function scopeOf(actor: Actor): "admin" | "registrar" | "sales" | null {
    if (actor.role === "admin") return "admin";
    if (actor.role === "registrar") return "registrar";
    if (actor.role === "salesperson" && actor.salespersonId && !TRAINEE_SALESPERSON_IDS.includes(actor.salespersonId)) return "sales";
    return null;
  }
  function planLinked(planId: number | null, panelId?: number | null): boolean {
    if (!planId) return false;
    return Boolean(panelId
      ? row("SELECT 1 FROM smart_filing_panel_plans WHERE plan_id=? AND panel_id=?", planId, panelId)
      : row("SELECT 1 FROM smart_filing_panel_plans WHERE plan_id=?", planId));
  }
  function ownsCustomer(actor: Actor, customerId: number): boolean {
    const c = row<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=?", customerId);
    return Boolean(c && actor.salespersonId && c.salesperson_id === actor.salespersonId);
  }
  function canChat(actor: Actor, job: any): boolean {
    const sc = scopeOf(actor);
    if (sc === "admin") return true;
    if (sc === "registrar") return planLinked(job.plan_id, job.panel_id);
    if (sc === "sales") return ownsCustomer(actor, job.customer_id);
    return false;
  }
  function addMessage(jobId: number, m: { author: "runner" | "user" | "system"; userId?: number | null; userName?: string | null; kind?: string; body?: string | null; data?: unknown; step?: string | null; shot?: { path: string; mime: string; bytes: number } | null }) {
    const t = iso();
    const r = run(`INSERT INTO smart_filing_messages(job_id,author,user_id,user_name,kind,body,data_json,step_label,screenshot_path,screenshot_mime,screenshot_bytes,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, jobId, m.author, m.userId ?? null, m.userName ?? null, m.kind ?? "text", m.body ?? null,
      m.data === undefined || m.data === null ? null : JSON.stringify(m.data), m.step ?? null, m.shot?.path ?? null, m.shot?.mime ?? null, m.shot?.bytes ?? null, t);
    run("UPDATE smart_filing_jobs SET last_message_at=?, updated_at=? WHERE id=?", t, t, jobId);
    return Number(r.lastInsertRowid);
  }
  function setStatus(jobId: number, status: Status, extra: Record<string, unknown> = {}) {
    const sets = ["status=?", "updated_at=?"]; const p: unknown[] = [status, iso()];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); p.push(v); }
    if (["submitted", "approved", "rejected", "cancelled"].includes(status)) { sets.push("finished_at=?"); p.push(iso()); }
    run(`UPDATE smart_filing_jobs SET ${sets.join(",")} WHERE id=?`, ...p, jobId);
  }
  const STATUS_FA: Record<Status, string> = { queued: "در صف", running: "در حال ثبت", waiting_human: "منتظر انسان", ready_for_approval: "آماده‌ی ارسال، منتظر تأیید مدیر", submitted: "ثبت شد", approved: "تأیید شد", rejected: "رد شد", error: "خطا", cancelled: "لغو" };
  function jobView(j: any) {
    const panel = row<any>("SELECT id,name,auto_submit FROM smart_filing_panels WHERE id=?", j.panel_id);
    const cust = row<any>("SELECT id,name,first_name,last_name,salesperson_id FROM customers WHERE id=?", j.customer_id);
    const sp = cust?.salesperson_id ? row<any>("SELECT name FROM salespersons WHERE id=?", cust.salesperson_id) : null;
    return {
      id: j.id, jobType: j.job_type, applicationId: j.application_id, customerId: j.customer_id,
      customerName: cust ? (cust.first_name && cust.last_name ? `${cust.first_name} ${cust.last_name}` : cust.name) : null,
      salespersonName: sp?.name ?? null, panelId: j.panel_id, panelName: panel?.name ?? null, planId: j.plan_id, planName: j.plan_name,
      amountToman: j.amount_toman, durationMonths: j.duration_months, status: j.status as Status, statusLabel: STATUS_FA[j.status as Status],
      stepLabel: j.step_label, progress: j.progress, attempt: j.attempt, submitApprovedAt: j.submit_approved_at,
      finalSubmitAllowed: Boolean(j.submit_approved_at || panel?.auto_submit), panelReference: j.panel_reference,
      createdAt: j.created_at, updatedAt: j.updated_at, lastMessageAt: j.last_message_at, finishedAt: j.finished_at,
      checklist: j.checklist_json ? JSON.parse(j.checklist_json) : null,
    };
  }
  const msgView = (m: any, jobId: number) => ({
    id: m.id, author: m.author, userName: m.user_name, kind: m.kind, body: m.body, data: m.data_json ? JSON.parse(m.data_json) : null,
    stepLabel: m.step_label, createdAt: m.created_at,
    screenshotUrl: m.screenshot_path ? `/api/smart-filing/jobs/${jobId}/messages/${m.id}/screenshot` : null,
  });
  function openCode(jobId: number) {
    expireCodes();
    const c = row<any>("SELECT id,target,prompt,requested_at,expires_at,status,code_masked FROM smart_filing_code_requests WHERE job_id=? AND status='pending' ORDER BY id DESC LIMIT 1", jobId);
    // secondsLeft is computed on the server so the browser countdown does not depend on the device clock.
    return c ? { id: c.id, target: c.target, prompt: c.prompt, requestedAt: c.requested_at, expiresAt: c.expires_at,
      secondsLeft: Math.max(0, Math.floor((new Date(c.expires_at).getTime() - now().getTime()) / 1000)) } : null;
  }

  /* ================= admin / expert router (behind CRM session) ================= */
  const admin = Router();
  const need = (req: Request, res: Response, adminOnly: boolean): Actor | null => {
    const a = deps.actor(res);
    if (!a) { fail(res, 401, "unauthorized"); return null; }
    if (adminOnly && a.role !== "admin") { fail(res, 403, "forbidden"); return null; }
    if (!adminOnly && !scopeOf(a)) { fail(res, 403, "forbidden"); return null; }
    return a;
  };
  const loadJob = (req: Request, res: Response, a: Actor) => {
    const j = row<any>("SELECT * FROM smart_filing_jobs WHERE id=?", Number(req.params.id));
    if (!j || !canChat(a, j)) { fail(res, 404, "job_not_found"); return null; }
    return j;
  };

  admin.get("/smart-filing/panels", (req, res) => {
    const a = need(req, res, true); if (!a) return;
    const list = rows<any>("SELECT * FROM smart_filing_panels ORDER BY id").map(p => ({
      id: p.id, slug: p.slug, name: p.name, baseUrl: p.base_url, username: p.username, hasPassword: Boolean(p.password_enc),
      passwordUpdatedAt: p.password_updated_at, autoSubmit: Boolean(p.auto_submit), active: Boolean(p.active),
      plans: rows<any>("SELECT pp.plan_id id, lp.name FROM smart_filing_panel_plans pp LEFT JOIN loan_plans lp ON lp.id=pp.plan_id WHERE pp.panel_id=? ORDER BY pp.plan_id", p.id),
    }));
    res.json({ panels: list, keyConfigured: hasKey(deps.env()) });
  });
  admin.put("/smart-filing/panels/:id", (req, res) => {
    const a = need(req, res, true); if (!a) return;
    const p = row<any>("SELECT * FROM smart_filing_panels WHERE id=?", Number(req.params.id));
    if (!p) return fail(res, 404, "panel_not_found");
    const b = req.body ?? {};
    const baseUrl = b.baseUrl === undefined ? p.base_url : String(b.baseUrl).trim();
    if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) return fail(res, 422, "bad_url", "آدرس پنل باید با https:// شروع شود.");
    const username = b.username === undefined ? p.username : String(b.username).trim().slice(0, 200);
    const autoSubmit = b.autoSubmit === undefined ? p.auto_submit : (b.autoSubmit ? 1 : 0);
    const changed: string[] = [];
    if (baseUrl !== p.base_url) changed.push("base_url"); if (username !== p.username) changed.push("username"); if (autoSubmit !== p.auto_submit) changed.push("auto_submit");
    let enc: { value: string; keyId: string } | null = null;
    if (typeof b.password === "string" && b.password.length > 0) {
      if (b.password.length > 500) return fail(res, 422, "bad_password");
      try { enc = encryptSecret(deps.env(), b.password, `panel:${p.id}`); }
      catch (e) { if (e instanceof SmartFilingKeyMissing) return fail(res, 503, "smart_filing_key_missing", "کلید رمزنگاری روی سرور تنظیم نشده است."); throw e; }
      changed.push("password");
    }
    run("UPDATE smart_filing_panels SET base_url=?,username=?,auto_submit=?,updated_at=?,updated_by_user_id=? WHERE id=?", baseUrl || null, username || null, autoSubmit, iso(), a.id, p.id);
    if (enc) run("UPDATE smart_filing_panels SET password_enc=?,password_key_id=?,password_updated_at=? WHERE id=?", enc.value, enc.keyId, iso(), p.id);
    audit(req, "user", a.id, "panel.update", null, p.id, { changed });
    res.json({ ok: true, changed });
  });

  admin.get("/smart-filing/eligibility/:applicationId", (req, res) => {
    const a = need(req, res, false); if (!a) return;
    const app = appRow(Number(req.params.applicationId));
    if (!app) return fail(res, 404, "application_not_found");
    const sc = scopeOf(a);
    if (sc === "sales" && !ownsCustomer(a, app.customer_id)) return fail(res, 404, "application_not_found");
    // Temporary (Mohammad, 2026-10-25): available in EVERY case stage/status — no stage gate here or on create.
    const panel = panelFor(app.plan_id);
    const existing = row<any>(`SELECT id,status FROM smart_filing_jobs WHERE application_id=? ORDER BY id DESC LIMIT 1`, app.id);
    const cl = checklist(app);
    res.json({ eligible: Boolean(panel), canCreate: Boolean(sc), canTrain: sc === "admin", panel: panel ? { id: panel.id, name: panel.name } : null,
      reason: panel ? null : "طرح این پرونده به پنل ازکی‌وام وصل نیست.", checklist: cl,
      latestJob: existing ? { id: existing.id, status: existing.status, statusLabel: STATUS_FA[existing.status as Status] } : null });
  });

  admin.post("/smart-filing/jobs", (req, res) => {
    const a = need(req, res, false); if (!a) return;
    const sc = scopeOf(a);
    const appId = Number(req.body?.applicationId);
    const jobType = req.body?.jobType === "training" ? "training" : "real";
    if (jobType === "training" && sc !== "admin") return fail(res, 403, "forbidden", "کار آموزشی فقط برای مدیر است.");
    const app = Number.isSafeInteger(appId) ? appRow(appId) : undefined;
    if (!app) return fail(res, 404, "application_not_found");
    if (sc === "sales" && !ownsCustomer(a, app.customer_id)) return fail(res, 404, "application_not_found");
    const panel = panelFor(app.plan_id);
    if (!panel) return fail(res, 409, "plan_not_linked", "طرح این پرونده به پنل ازکی‌وام وصل نیست.");
    const open = row<any>(`SELECT id FROM smart_filing_jobs WHERE application_id=? AND panel_id=? AND status IN (${OPEN.map(() => "?").join(",")})`, app.id, panel.id, ...OPEN);
    if (open) return void res.status(200).json({ ok: true, id: open.id, existing: true });
    const cl = checklist(app);
    if (jobType === "real" && cl.blocked) return fail(res, 422, "checklist_blocked", "نام، کد ملی یا موبایل مشتری کامل نیست.");
    const plan = row<any>("SELECT name FROM loan_plans WHERE id=?", app.plan_id);
    const amount = String(app.approved_amount || app.requested_amount || "").trim() || null;
    const t = iso();
    const r = run(`INSERT INTO smart_filing_jobs(job_type,application_id,customer_id,panel_id,plan_id,plan_name,amount_toman,duration_months,status,checklist_json,created_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?,?)`, jobType, app.id, app.customer_id, panel.id, app.plan_id, plan?.name ?? null, amount, app.duration_months ?? null, JSON.stringify(cl), a.id, t, t);
    const id = Number(r.lastInsertRowid);
    addMessage(id, { author: "system", kind: "status", body: `کار ثبت هوشمند ساخته شد (${jobType === "training" ? "آموزشی" : "واقعی"}). منتظر سارینا…`, userName: a.name });
    audit(req, "user", a.id, "job.create", id, panel.id, { applicationId: app.id, jobType });
    res.status(201).json({ ok: true, id });
  });

  admin.get("/smart-filing/jobs", (req, res) => {
    const a = need(req, res, false); if (!a) return;
    const status = String(req.query.status ?? "");
    const where: string[] = []; const p: unknown[] = [];
    if ((STATUSES as readonly string[]).includes(status)) { where.push("j.status=?"); p.push(status); }
    const sc = scopeOf(a);
    if (sc === "registrar") where.push("EXISTS (SELECT 1 FROM smart_filing_panel_plans pp WHERE pp.plan_id=j.plan_id AND pp.panel_id=j.panel_id)");
    else if (sc !== "admin") { where.push("c.salesperson_id=?"); p.push(a.salespersonId ?? -1); }
    const list = rows<any>(`SELECT j.* FROM smart_filing_jobs j JOIN customers c ON c.id=j.customer_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(j.last_message_at,j.created_at) DESC, j.id DESC LIMIT 300`, ...p);
    res.json({ jobs: list.map(jobView) });
  });

  admin.get("/smart-filing/jobs/:id", (req, res) => {
    const a = need(req, res, false); if (!a) return;
    const j = loadJob(req, res, a); if (!j) return;
    const after = Math.max(0, Number(req.query.after) || 0);
    const msgs = rows<any>("SELECT * FROM smart_filing_messages WHERE job_id=? AND id>? ORDER BY id LIMIT 500", j.id, after).map(m => msgView(m, j.id));
    res.json({ job: jobView(j), messages: msgs, codeRequest: openCode(j.id), isAdmin: a.role === "admin" });
  });

  admin.post("/smart-filing/jobs/:id/messages", (req, res) => {
    const a = need(req, res, false); if (!a) return;
    const j = loadJob(req, res, a); if (!j) return;
    const text = String(req.body?.text ?? "").trim();
    if (!text || text.length > 2000) return fail(res, 422, "bad_text");
    const id = addMessage(j.id, { author: "user", userId: a.id, userName: a.name, kind: "guidance", body: maskText(text) });
    audit(req, "user", a.id, "job.message", j.id, j.panel_id, { messageId: id });
    res.status(201).json({ ok: true, id });
  });

  admin.post("/smart-filing/jobs/:id/code", (req, res) => {
    const a = need(req, res, false); if (!a) return;
    const j = loadJob(req, res, a); if (!j) return;
    const code = toLatin(String(req.body?.code ?? "")).trim();
    if (!/^[A-Za-z0-9]{3,12}$/.test(code)) return fail(res, 422, "bad_code", "کد باید ۳ تا ۱۲ رقم/حرف باشد.");
    const c = openCode(j.id);
    if (!c) return fail(res, 409, "no_open_code_request", "درخواست کد فعالی نیست یا زمانش تمام شده.");
    let enc; try { enc = encryptSecret(deps.env(), code, `code:${c.id}`); }
    catch (e) { if (e instanceof SmartFilingKeyMissing) return fail(res, 503, "smart_filing_key_missing"); throw e; }
    const masked = maskCode(code);
    run("UPDATE smart_filing_code_requests SET status='answered',code_enc=?,code_masked=?,answered_by_user_id=?,answered_at=? WHERE id=? AND status='pending'", enc.value, masked, a.id, iso(), c.id);
    addMessage(j.id, { author: "user", userId: a.id, userName: a.name, kind: "code_reply", body: `کد وارد شد: ${masked}` });
    if (j.status === "waiting_human") setStatus(j.id, "running");
    audit(req, "user", a.id, "code.answer", j.id, j.panel_id, { codeRequestId: c.id, masked });
    res.json({ ok: true, masked });
  });

  const adminAction = (pathName: string, fn: (req: Request, res: Response, a: Actor, j: any) => void) =>
    admin.post(`/smart-filing/jobs/:id/${pathName}`, (req, res) => { const a = need(req, res, true); if (!a) return; const j = loadJob(req, res, a); if (!j) return; fn(req, res, a, j); });
  adminAction("approve-submit", (req, res, a, j) => {
    if (j.status !== "ready_for_approval") return fail(res, 409, "not_ready_for_approval", "کار در وضعیت «آماده‌ی ارسال» نیست.");
    setStatus(j.id, "running", { submit_approved_at: iso(), submit_approved_by_user_id: a.id });
    addMessage(j.id, { author: "system", kind: "status", userName: a.name, body: `ارسال نهایی را ${a.name} تأیید کرد. سارینا می‌تواند دکمه‌ی ارسال پنل را بزند.` });
    audit(req, "user", a.id, "job.approve_submit", j.id, j.panel_id);
    res.json({ ok: true });
  });
  adminAction("outcome", (req, res, a, j) => {
    const outcome = req.body?.outcome === "approved" ? "approved" : req.body?.outcome === "rejected" ? "rejected" : null;
    if (!outcome) return fail(res, 422, "bad_outcome");
    if (j.status === "cancelled") return fail(res, 409, "job_cancelled");
    const note = maskText(String(req.body?.note ?? "").trim()).slice(0, 1000);
    setStatus(j.id, outcome, { outcome_by: "admin", progress: 100 });
    addMessage(j.id, { author: "user", userId: a.id, userName: a.name, kind: "outcome", body: `نتیجه‌ی پنل به‌دست مدیر ثبت شد: ${outcome === "approved" ? "تأیید شد" : "رد شد"}${note ? ` — ${note}` : ""}` });
    audit(req, "user", a.id, "job.outcome", j.id, j.panel_id, { outcome, from: j.status });
    res.json({ ok: true });
  });
  adminAction("cancel", (req, res, a, j) => {
    if (!OPEN.includes(j.status) && j.status !== "error") return fail(res, 409, "not_cancellable");
    run("UPDATE smart_filing_code_requests SET status='cancelled',code_enc=NULL WHERE job_id=? AND status IN ('pending','answered')", j.id);
    setStatus(j.id, "cancelled");
    addMessage(j.id, { author: "system", kind: "status", userName: a.name, body: `کار را ${a.name} لغو کرد.` });
    audit(req, "user", a.id, "job.cancel", j.id, j.panel_id, { from: j.status });
    res.json({ ok: true });
  });
  adminAction("retry", (req, res, a, j) => {
    if (!["error", "rejected", "cancelled"].includes(j.status)) return fail(res, 409, "not_retryable");
    setStatus(j.id, "queued", { attempt: j.attempt + 1, claimed_by_token_id: null, submit_approved_at: null, submit_approved_by_user_id: null, finished_at: null, progress: 0 });
    addMessage(j.id, { author: "system", kind: "status", userName: a.name, body: `تلاش دوباره (دفعه‌ی ${j.attempt + 1}) — کار دوباره در صف است.` });
    audit(req, "user", a.id, "job.retry", j.id, j.panel_id, { from: j.status });
    res.json({ ok: true });
  });

  admin.get("/smart-filing/jobs/:id/messages/:mid/screenshot", (req, res) => {
    const a = need(req, res, false); if (!a) return;
    const j = loadJob(req, res, a); if (!j) return;
    const m = row<any>("SELECT screenshot_path,screenshot_mime FROM smart_filing_messages WHERE id=? AND job_id=?", Number(req.params.mid), j.id);
    if (!m?.screenshot_path) return fail(res, 404, "not_found");
    let real: string; try { real = fs.realpathSync(m.screenshot_path); } catch { return fail(res, 404, "not_found"); }
    if (!real.startsWith(fs.realpathSync(deps.filesRoot) + path.sep)) return fail(res, 404, "not_found");
    res.setHeader("Cache-Control", "private, max-age=3600"); res.type(m.screenshot_mime); res.sendFile(real);
  });

  /* ================= runner router (own Bearer token; mounted before the global JSON parser) ================= */
  const runner = Router();
  runner.use(express.json({ limit: "2mb" }));
  const failures = new Map<string, { n: number; at: number }>();
  runner.use((req, res, next) => {
    const key = ip(req); const f = failures.get(key);
    if (f && f.n >= 20 && Date.now() - f.at < 60_000) return fail(res, 429, "too_many_attempts");
    const m = /^Bearer\s+([A-Za-z0-9_\-.]{20,200})$/.exec(String(req.headers.authorization ?? ""));
    const tok = m ? row<any>("SELECT id,token_hash FROM smart_filing_runner_tokens WHERE token_hash=? AND revoked_at IS NULL", sha256(m[1])) : undefined;
    if (!tok || !timingSafeEqual(Buffer.from(tok.token_hash), Buffer.from(sha256(m![1])))) {
      failures.set(key, { n: (f && Date.now() - f.at < 60_000 ? f.n : 0) + 1, at: Date.now() });
      audit(req, "runner", null, "runner.auth_fail", null, null);
      return fail(res, 401, "unauthorized");
    }
    run("UPDATE smart_filing_runner_tokens SET last_used_at=?, last_used_ip=? WHERE id=?", iso(), ip(req), tok.id);
    res.locals.runnerTokenId = tok.id; next();
  });
  const rjob = (req: Request, res: Response): any => {
    const j = row<any>("SELECT * FROM smart_filing_jobs WHERE id=?", Number(req.params.id));
    if (!j || j.claimed_by_token_id !== res.locals.runnerTokenId) { fail(res, 404, "job_not_found"); return null; }
    return j;
  };
  const tokenId = (res: Response) => Number(res.locals.runnerTokenId);
  function caseData(j: any) {
    const a = appRow(j.application_id);
    return a ? {
      applicationId: a.id, customerId: a.customer_id, firstName: a.first_name, lastName: a.last_name, fullName: a.customer_name,
      fatherName: a.father_name, nationalCode: a.national_code, mobile: a.phone, birthDateJalali: a.birth_date_jalali,
      postalCode: a.postal_code, address: a.address, city: a.city, email: a.email,
      planId: j.plan_id, planName: j.plan_name, amountToman: j.amount_toman, durationMonths: j.duration_months,
    } : null;
  }

  runner.post("/claim", (req, res) => {
    const j = row<any>("SELECT * FROM smart_filing_jobs WHERE status='queued' ORDER BY id LIMIT 1");
    if (!j) return void res.json({ job: null });
    const r = run("UPDATE smart_filing_jobs SET status='running',claimed_by_token_id=?,claimed_at=?,updated_at=? WHERE id=? AND status='queued'", tokenId(res), iso(), iso(), j.id);
    if (!r.changes) return void res.json({ job: null });
    const fresh = row<any>("SELECT * FROM smart_filing_jobs WHERE id=?", j.id);
    const panel = row<any>("SELECT id,name,base_url,username FROM smart_filing_panels WHERE id=?", j.panel_id);
    const docs = documentsFor(j.application_id, j.customer_id).map(({ storage_path: _s, ...d }) => d);
    addMessage(j.id, { author: "system", kind: "status", body: "سارینا کار را برداشت و شروع کرد." });
    audit(req, "runner", tokenId(res), "runner.claim", j.id, j.panel_id, { documents: docs.length });
    audit(req, "runner", tokenId(res), "runner.case_read", j.id, j.panel_id);
    res.json({ job: jobView(fresh), panel: { id: panel.id, name: panel.name, baseUrl: panel.base_url, username: panel.username }, case: caseData(j), documents: docs });
  });
  runner.get("/jobs/:id", (req, res) => {
    const j = rjob(req, res); if (!j) return;
    res.json({ job: jobView(j), codeRequest: openCode(j.id) });
  });
  runner.get("/jobs/:id/case", (req, res) => {
    const j = rjob(req, res); if (!j) return;
    audit(req, "runner", tokenId(res), "runner.case_read", j.id, j.panel_id);
    res.json({ case: caseData(j), documents: documentsFor(j.application_id, j.customer_id).map(({ storage_path: _s, ...d }) => d) });
  });
  runner.get("/jobs/:id/documents/:ref", (req, res) => {
    const j = rjob(req, res); if (!j) return;
    const d = documentsFor(j.application_id, j.customer_id).find(x => x.ref === String(req.params.ref));
    if (!d) return fail(res, 404, "document_not_found");
    let real: string; try { real = fs.realpathSync(d.storage_path); } catch { return fail(res, 404, "document_not_found"); }
    const roots = deps.docRoots.map(r => { try { return fs.realpathSync(r); } catch { return null; } }).filter(Boolean) as string[];
    if (!roots.some(r => real.startsWith(r + path.sep)) || !fs.statSync(real).isFile()) return fail(res, 404, "document_not_found");
    audit(req, "runner", tokenId(res), "runner.document_read", j.id, j.panel_id, { ref: d.ref });
    if (d.mime) res.type(d.mime);
    res.sendFile(real);
  });
  runner.get("/jobs/:id/credentials", (req, res) => {
    const j = rjob(req, res); if (!j) return;
    if (!["running", "waiting_human"].includes(j.status)) return fail(res, 409, "job_not_running");
    const p = row<any>("SELECT * FROM smart_filing_panels WHERE id=?", j.panel_id);
    if (!p?.password_enc) return fail(res, 409, "panel_password_missing", "رمز پنل هنوز در CRM ثبت نشده است.");
    try {
      const { plaintext, rotated } = decryptSecret(deps.env(), p.password_enc, `panel:${p.id}`);
      if (rotated) run("UPDATE smart_filing_panels SET password_enc=?,password_key_id=? WHERE id=?", rotated.value, rotated.keyId, p.id);
      audit(req, "runner", tokenId(res), "runner.credentials_read", j.id, p.id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ baseUrl: p.base_url, username: p.username, password: plaintext });
    } catch (e) { if (e instanceof SmartFilingKeyMissing) return fail(res, 503, "smart_filing_key_missing"); return fail(res, 500, "decrypt_failed"); }
  });
  runner.post("/jobs/:id/messages", (req, res) => {
    const j = rjob(req, res); if (!j) return;
    if (!OPEN.includes(j.status) && j.status !== "submitted") return fail(res, 409, "job_closed", `کار در وضعیت ${STATUS_FA[j.status as Status]} است.`);
    const b = req.body ?? {};
    const step = b.step ? String(b.step).slice(0, 120) : null;
    const panelRow = row<any>("SELECT auto_submit,password_enc,id FROM smart_filing_panels WHERE id=?", j.panel_id);
    if ((b.finalSubmit === true || step === "final_submit") && !(j.submit_approved_at || panelRow?.auto_submit))
      return fail(res, 409, "final_submit_not_approved", "ارسال نهایی هنوز تأیید مدیر را ندارد.");
    const count = (row<any>("SELECT COUNT(*) n FROM smart_filing_messages WHERE job_id=?", j.id)?.n ?? 0) as number;
    if (count >= MAX_MESSAGES_PER_JOB) return fail(res, 413, "too_many_messages");
    const secrets: string[] = [];
    try { if (panelRow?.password_enc) secrets.push(decryptSecret(deps.env(), panelRow.password_enc, `panel:${panelRow.id}`).plaintext); } catch { /* key missing: nothing to scrub */ }
    let shot: { path: string; mime: string; bytes: number } | null = null;
    if (b.screenshot?.base64) {
      const buf = Buffer.from(String(b.screenshot.base64), "base64");
      const mime = sniff(buf);
      if (!mime) return fail(res, 415, "bad_image", "فقط PNG، JPEG یا WebP.");
      if (buf.length > MAX_SCREENSHOT_BYTES) return fail(res, 413, "image_too_large");
      const dir = path.join(deps.filesRoot, String(j.id)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${randomUUID()}.${IMG[mime]}`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      shot = { path: file, mime, bytes: buf.length };
    }
    const kind = ["text", "step", "data", "panel_response", "error", "question"].includes(b.kind) ? b.kind : shot ? "screenshot" : "text";
    const body = b.text ? maskText(String(b.text), secrets).slice(0, 4000) : null;
    const data = b.data === undefined ? undefined : maskData(b.data, secrets);
    if (!body && data === undefined && !shot) return fail(res, 422, "empty_message");
    const id = addMessage(j.id, { author: "runner", kind, body, data, step, shot });
    const upd: Record<string, unknown> = {};
    if (step) upd.step_label = step;
    if (Number.isFinite(Number(b.progress))) upd.progress = Math.max(0, Math.min(100, Math.round(Number(b.progress))));
    if (b.panelReference) upd.panel_reference = String(b.panelReference).slice(0, 100);
    if (Object.keys(upd).length) run(`UPDATE smart_filing_jobs SET ${Object.keys(upd).map(k => `${k}=?`).join(",")} WHERE id=?`, ...Object.values(upd), j.id);
    if (kind === "question" && j.status === "running") setStatus(j.id, "waiting_human");
    audit(req, "runner", tokenId(res), "runner.message", j.id, j.panel_id, { messageId: id, kind, screenshot: Boolean(shot) });
    res.status(201).json({ ok: true, id });
  });
  runner.get("/jobs/:id/messages", (req, res) => {
    const j = rjob(req, res); if (!j) return;
    const after = Math.max(0, Number(req.query.after) || 0);
    const msgs = rows<any>("SELECT * FROM smart_filing_messages WHERE job_id=? AND id>? AND author IN ('user','system') ORDER BY id LIMIT 200", j.id, after)
      .map(m => ({ id: m.id, author: m.author, userName: m.user_name, kind: m.kind, body: m.body, createdAt: m.created_at }));
    audit(req, "runner", tokenId(res), "runner.messages_read", j.id, j.panel_id, { after, n: msgs.length });
    res.json({ job: { id: j.id, status: j.status, finalSubmitAllowed: jobView(j).finalSubmitAllowed }, messages: msgs, cursor: msgs.length ? msgs[msgs.length - 1].id : after });
  });
  runner.post("/jobs/:id/code-requests", (req, res) => {
    const j = rjob(req, res); if (!j) return;
    if (!["running", "waiting_human"].includes(j.status)) return fail(res, 409, "job_not_running");
    const target = req.body?.target === "customer" ? "customer" : req.body?.target === "ours" ? "ours" : null;
    if (!target) return fail(res, 422, "bad_target", "target باید ours یا customer باشد.");
    const secs = Math.max(30, Math.min(900, Math.round(Number(req.body?.expiresInSeconds) || 120)));
    run("UPDATE smart_filing_code_requests SET status='cancelled',code_enc=NULL WHERE job_id=? AND status='pending'", j.id);
    const prompt = maskText(String(req.body?.prompt ?? "")).slice(0, 300) || null;
    const exp = new Date(now().getTime() + secs * 1000).toISOString();
    const r = run("INSERT INTO smart_filing_code_requests(job_id,target,prompt,requested_at,expires_at,status) VALUES(?,?,?,?,?,'pending')", j.id, target, prompt, iso(), exp);
    const id = Number(r.lastInsertRowid);
    setStatus(j.id, "waiting_human");
    addMessage(j.id, { author: "runner", kind: "code_request", body: `${target === "customer" ? "کد به موبایل مشتری رفته؛ لطفاً تلفنی از مشتری بپرسید و وارد کنید." : "کد به شماره‌ی ما رفته؛ لطفاً وارد کنید."}${prompt ? ` (${prompt})` : ""}`, data: { target, expiresAt: exp, codeRequestId: id } });
    audit(req, "runner", tokenId(res), "runner.code_request", j.id, j.panel_id, { codeRequestId: id, target, secs });
    res.status(201).json({ ok: true, id, expiresAt: exp });
  });
  runner.get("/jobs/:id/code-requests/:cid", (req, res) => {
    const j = rjob(req, res); if (!j) return;
    expireCodes();
    const c = row<any>("SELECT * FROM smart_filing_code_requests WHERE id=? AND job_id=?", Number(req.params.cid), j.id);
    if (!c) return fail(res, 404, "code_request_not_found");
    if (c.status !== "answered" || !c.code_enc) return void res.json({ status: c.status, expiresAt: c.expires_at });
    let code: string;
    try { code = decryptSecret(deps.env(), c.code_enc, `code:${c.id}`).plaintext; }
    catch (e) { if (e instanceof SmartFilingKeyMissing) return fail(res, 503, "smart_filing_key_missing"); return fail(res, 500, "decrypt_failed"); }
    run("UPDATE smart_filing_code_requests SET status='consumed',code_enc=NULL,consumed_at=? WHERE id=?", iso(), c.id);
    audit(req, "runner", tokenId(res), "runner.code_consumed", j.id, j.panel_id, { codeRequestId: c.id, masked: c.code_masked });
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "answered", code });
  });
  const statusHandler = (req: Request, res: Response) => {
    const j = rjob(req, res); if (!j) return;
    const to = String(req.body?.status ?? "") as Status;
    if (!RUNNER_SET.includes(to)) return fail(res, 422, "bad_status");
    if (j.status === "cancelled") return fail(res, 409, "job_cancelled", "این کار لغو شده؛ کار را متوقف کنید.");
    if (["approved", "rejected"].includes(j.status) && j.outcome_by === "admin") return fail(res, 409, "job_closed");
    const panel = row<any>("SELECT auto_submit FROM smart_filing_panels WHERE id=?", j.panel_id);
    if (to === "submitted" && !(j.submit_approved_at || panel?.auto_submit)) return fail(res, 409, "final_submit_not_approved", "ارسال نهایی هنوز تأیید مدیر را ندارد.");
    if ((to === "approved" || to === "rejected") && !["submitted", "running", "waiting_human"].includes(j.status)) return fail(res, 409, "bad_transition");
    if ((to === "approved" || to === "rejected") && j.status !== "submitted" && !(j.submit_approved_at || panel?.auto_submit)) return fail(res, 409, "final_submit_not_approved");
    const extra: Record<string, unknown> = {};
    if (["submitted", "approved", "rejected"].includes(to)) extra.progress = to === "submitted" ? 90 : 100;
    if (to === "approved" || to === "rejected") extra.outcome_by = "runner";
    if (req.body?.panelReference) extra.panel_reference = String(req.body.panelReference).slice(0, 100);
    setStatus(j.id, to, extra);
    const note = req.body?.message ? maskText(String(req.body.message)).slice(0, 2000) : "";
    addMessage(j.id, { author: "runner", kind: "status", body: `وضعیت: ${STATUS_FA[to]}${note ? ` — ${note}` : ""}` });
    audit(req, "runner", tokenId(res), "runner.status", j.id, j.panel_id, { from: j.status, to });
    res.json({ ok: true, status: to });
  };
  runner.post("/jobs/:id/status", statusHandler);
  runner.post("/jobs/:id/finish", statusHandler);
  runner.use((_req, res) => fail(res, 404, "not_found"));
  runner.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === "entity.too.large") fail(res, 413, "body_too_large");
    else if (err?.type === "entity.parse.failed") fail(res, 400, "bad_json");
    else fail(res, 500, "internal_error");
  });

  return { admin, runner };
}

export function hashRunnerToken(token: string): string { return sha256(token); }
