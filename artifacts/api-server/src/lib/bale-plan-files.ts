/**
 * «فایل طرح برای بله» — one sendable file per loan plan (PDF / JPG / PNG / WebP, ≤ 10 MB), uploaded by an admin in the
 * plan settings. Stored on disk under <data dir>/bale-plan-files with a generated safe name (never the uploaded
 * name) + sha256; the DB keeps only metadata. A new upload replaces the plan's active file (the old row and bytes stay
 * for the outbox history). Nothing here sends anything: sending a plan file is an outbox row (bale_outbox.attachment_id)
 * that is ALWAYS an expert-approved draft and only exists while bale_settings.bale_attachments_enabled = "1"
 * (default "0"). Contracts / contract templates are never read or touched.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const BALE_PLAN_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const BALE_PLAN_FILE_TYPES = [
  { mime: "application/pdf", ext: "pdf", label: "PDF" },
  { mime: "image/jpeg", ext: "jpg", label: "JPG" },
  { mime: "image/png", ext: "png", label: "PNG" },
  { mime: "image/webp", ext: "webp", label: "WebP" },
] as const;

export type PlanFileRow = { id: number; plan_id: number; display_name: string; stored_name: string; mime: string; size: number; sha256: string;
  status: "active" | "replaced" | "removed"; uploaded_by: number | null; uploaded_at: string; removed_at: string | null; removed_by: number | null };

export function ensureBalePlanFilesSchema(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS bale_plan_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, display_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL CHECK(mime IN ('application/pdf','image/jpeg','image/png','image/webp')), size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','replaced','removed')), uploaded_by INTEGER, uploaded_at TEXT NOT NULL,
    removed_at TEXT, removed_by INTEGER);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_bale_plan_files_active ON bale_plan_files(plan_id) WHERE status='active';`);
}

/** The real type comes from the bytes (magic numbers), never from the browser's mime or the file name. */
export function sniffPlanFile(buf: Buffer): typeof BALE_PLAN_FILE_TYPES[number] | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return BALE_PLAN_FILE_TYPES[0];
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return BALE_PLAN_FILE_TYPES[1];
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return BALE_PLAN_FILE_TYPES[2];
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return BALE_PLAN_FILE_TYPES[3];
  return null;
}

/** Name shown to the customer in Bale: no path, no control / bidi-override chars, ≤ 100 chars, extension = the real type. */
export function safeDisplayName(raw: unknown, ext: string, fallback: string): string {
  let n = typeof raw === "string" ? raw : "";
  try { if (/%[0-9a-f]{2}/i.test(n)) n = decodeURIComponent(n); } catch { /* keep as is */ }
  n = n.split(/[\\/]/).pop() ?? "";
  n = n.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, " ").replace(/\s+/g, " ").trim();
  n = n.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  if (!n || /^\.+$/.test(n)) n = fallback.replace(/[\\/<>:"|?*]/g, " ").trim() || "plan";
  return `${n.slice(0, 100)}.${ext}`;
}

export type PlanFileView = { id: number; planId: number; name: string; mime: string; typeLabel: string; size: number; sha256: string; isImage: boolean;
  uploadedAt: string; uploadedBy: string | null; url: string };

export function createBalePlanFiles(deps: { db: DatabaseSync; dir: string; now?: () => Date; nameOf?: (userId: number | null) => string | null }) {
  const { db } = deps; const now = deps.now ?? (() => new Date());
  const row = <T>(sql: string, ...a: any[]) => db.prepare(sql).get(...a) as T | undefined;
  const rows = <T>(sql: string, ...a: any[]) => db.prepare(sql).all(...a) as T[];
  const fileAt = (f: PlanFileRow) => path.join(deps.dir, path.basename(f.stored_name));

  function view(f: PlanFileRow): PlanFileView {
    return { id: f.id, planId: f.plan_id, name: f.display_name, mime: f.mime, typeLabel: BALE_PLAN_FILE_TYPES.find(t => t.mime === f.mime)?.label ?? f.mime,
      size: f.size, sha256: f.sha256, isImage: f.mime.startsWith("image/"), uploadedAt: f.uploaded_at, uploadedBy: deps.nameOf?.(f.uploaded_by) ?? null,
      url: `/api/bale/plan-files/${f.id}/content` };
  }
  const byId = (id: number) => (Number.isInteger(id) && id > 0 ? row<PlanFileRow>("SELECT * FROM bale_plan_files WHERE id=?", id) : undefined);
  const activeOf = (planId: number) => row<PlanFileRow>("SELECT * FROM bale_plan_files WHERE plan_id=? AND status='active'", planId);
  const planRow = (planId: number) => (Number.isInteger(planId) && planId > 0 ? row<{ id: number; name: string; active: number | null }>("SELECT id,name,active FROM loan_plans WHERE id=?", planId) : undefined);

  /** Bytes of a stored file, only when it is still on disk and its sha256 matches the DB (else null → «فایل طرح در دسترس نیست»). */
  function read(f: PlanFileRow): Buffer | null {
    try {
      const b = fs.readFileSync(fileAt(f));
      if (b.length !== f.size || createHash("sha256").update(b).digest("hex") !== f.sha256 || !sniffPlanFile(b)) return null;
      return b;
    } catch { return null; }
  }

  type SaveOut = { ok: true; file: PlanFileView } | { ok: false; status: number; error: string; message: string };
  function save(planId: number, buf: Buffer | undefined, originalName: unknown, userId: number | null): SaveOut {
    const plan = planRow(planId);
    if (!plan) return { ok: false, status: 404, error: "plan_not_found", message: "این طرح پیدا نشد." };
    if (!buf || !buf.length) return { ok: false, status: 422, error: "file_missing", message: "فایلی انتخاب نشده است." };
    if (buf.length > BALE_PLAN_FILE_MAX_BYTES) return { ok: false, status: 413, error: "file_too_large", message: "حجم فایل بیشتر از ۱۰ مگابایت است." };
    const t = sniffPlanFile(buf);
    if (!t) return { ok: false, status: 415, error: "file_type", message: "فقط فایل PDF یا عکس JPG / PNG / WebP پذیرفته می‌شود." };
    const sha = createHash("sha256").update(buf).digest("hex");
    const stored = `plan-${planId}-${sha.slice(0, 16)}-${randomBytes(4).toString("hex")}.${t.ext}`;
    fs.mkdirSync(deps.dir, { recursive: true, mode: 0o750 });
    const tmp = path.join(deps.dir, `.${stored}.tmp`);
    fs.writeFileSync(tmp, buf, { mode: 0o640, flag: "wx" });
    fs.renameSync(tmp, path.join(deps.dir, stored));
    const at = now().toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE bale_plan_files SET status='replaced', removed_at=?, removed_by=? WHERE plan_id=? AND status='active'").run(at, userId, planId);
      db.prepare("INSERT INTO bale_plan_files(plan_id,display_name,stored_name,mime,size,sha256,status,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,'active',?,?)")
        .run(planId, safeDisplayName(originalName, t.ext, plan.name), stored, t.mime, buf.length, sha, userId, at);
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none */ } try { fs.unlinkSync(path.join(deps.dir, stored)); } catch { /* none */ } throw e; }
    return { ok: true, file: view(activeOf(planId)!) };
  }

  /** Removes the plan's active file (row kept as history; bytes kept so already-approved history stays explainable). */
  function remove(planId: number, userId: number | null): boolean {
    const r = db.prepare("UPDATE bale_plan_files SET status='removed', removed_at=?, removed_by=? WHERE plan_id=? AND status='active'").run(now().toISOString(), userId, planId);
    return Number(r.changes) > 0;
  }

  function list() {
    let plans: { id: number; name: string; active: number | null }[] = [];
    try { plans = rows("SELECT id,name,active FROM loan_plans ORDER BY COALESCE(active,1) DESC, id"); } catch { plans = []; }
    const files = new Map(rows<PlanFileRow>("SELECT * FROM bale_plan_files WHERE status='active'").map(f => [f.plan_id, f]));
    return plans.map(p => ({ planId: p.id, name: p.name, active: p.active !== 0, file: files.has(p.id) ? view(files.get(p.id)!) : null }));
  }

  /** For the runner: a plan's active file, or an attachment id that is still the active file of its plan. */
  function resolve(p: { planId?: unknown; attachmentId?: unknown }): PlanFileRow | null {
    if (p.attachmentId != null && p.attachmentId !== "") {
      const f = byId(Number(p.attachmentId)); return f && f.status === "active" ? f : null;
    }
    const pid = Number(p.planId); if (!Number.isInteger(pid) || pid <= 0) return null;
    return activeOf(pid) ?? null;
  }

  return { save, remove, list, resolve, read, view, byId, activeOf, planRow };
}
export type BalePlanFiles = ReturnType<typeof createBalePlanFiles>;
