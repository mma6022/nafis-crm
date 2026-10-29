import type { Router, Response } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import { crmDb, execute, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { requirePermission } from "./access-control";
import type { AuthUser } from "./auth";
import { saveChatObject, readChatObject, deleteChatObject, validateChatFile } from "./chat-storage";

type Scope = (id: number, actor: AuthUser) => any;
type Storage = { save: typeof saveChatObject; read: typeof readChatObject; remove: typeof deleteChatObject };
type Note = {
  id: number; application_id: number; author_id: number; author_name: string; text: string;
  client_id: string; content_hash: string; created_at: string; object_path: string | null;
  file_name: string | null; mime_type: string | null; file_size: number | null; kind: string | null;
};
const maximum = 16 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maximum, files: 1, fields: 2, fieldSize: 32000 } });
const defaultStorage: Storage = { save: saveChatObject, read: readChatObject, remove: deleteChatObject };

export function installLoanCaseNotesSchema() {
  crmDb.exec(`CREATE TABLE IF NOT EXISTS loan_application_notes(
    id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL, author_name TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    object_path TEXT, file_name TEXT, mime_type TEXT, file_size INTEGER, kind TEXT,
    UNIQUE(application_id,author_id,client_id));
    CREATE INDEX IF NOT EXISTS idx_loan_case_notes_page ON loan_application_notes(application_id,id DESC);`);
}
function view(note: Note) {
  return {
    id: Number(note.id), applicationId: Number(note.application_id), text: note.text,
    clientId: note.client_id, createdAt: note.created_at,
    author: { id: Number(note.author_id), name: note.author_name, avatarUrl: null },
    attachment: note.object_path ? {
      fileName: note.file_name, mimeType: note.mime_type, fileSize: note.file_size, kind: note.kind,
      fileUrl: `/api/loan-applications/${note.application_id}/notes/${note.id}/file`,
    } : null,
  };
}
const fail = (res: Response, status: number, error: string, message: string) => res.status(status).json({ error, message });
function page(req: { query: Record<string, unknown> }, res: Response) {
  const before = req.query.beforeId === undefined ? null : Number(req.query.beforeId);
  const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);
  if ((before !== null && (!Number.isSafeInteger(before) || before < 1)) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    fail(res, 400, "invalid_cursor", "محدودهٔ دریافت یادداشت‌ها معتبر نیست."); return null;
  }
  return { before, limit };
}
export function registerLoanCaseNotes(router: Router, scoped: Scope, storage: Storage = defaultStorage) {
  installLoanCaseNotesSchema();
  const inFlight = new Map<number, number>(); let active = 0;
  const actor = (res: Response) => res.locals.authUser as AuthUser;
  const access = (raw: unknown, res: Response) => {
    const id = Number(raw);
    const application = Number.isSafeInteger(id) && id > 0 ? scoped(id, actor(res)) : null;
    if (!application) fail(res, 404, "loan_application_not_found", "پرونده در دسترس نیست.");
    return application;
  };
  router.get("/loan-applications/:id/notes", requirePermission("loan_applications.view"), (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const app = access(req.params.id, res); if (!app) return;
    const paging = page(req, res); if (!paging) return;
    const rows = queryRows<Note>(`SELECT * FROM loan_application_notes WHERE application_id=?
      ${paging.before ? "AND id<?" : ""} ORDER BY id DESC LIMIT ?`,
      [app.id, ...(paging.before ? [paging.before] : []), paging.limit + 1]);
    res.json({ items: rows.slice(0, paging.limit).map(view), nextCursor: rows.length > paging.limit ? String(rows[paging.limit - 1].id) : null });
  });
  router.get("/loan-applications/:id/history", requirePermission("loan_applications.view"), (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const app = access(req.params.id, res); if (!app) return;
    const paging = page(req, res); if (!paging) return;
    const rows = queryRows<any>(`SELECT h.*,COALESCE(u.full_name,u.username,'سامانه') actor_name
      FROM loan_application_stage_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.application_id=?
      ${paging.before ? "AND h.id<?" : ""} ORDER BY h.id DESC LIMIT ?`,
      [app.id, ...(paging.before ? [paging.before] : []), paging.limit + 1]);
    res.json({ items: rows.slice(0, paging.limit).map(h => ({
      id: Number(h.id), action: h.action, reason: h.reason, createdAt: h.created_at,
      author: { id: Number(h.actor_id ?? 0), name: h.actor_name, avatarUrl: null },
    })), nextCursor: rows.length > paging.limit ? String(rows[paging.limit - 1].id) : null });
  });
  router.post("/loan-applications/:id/notes", requirePermission("loan_applications.update"), (req, res, next) => {
    if (!access(req.params.id, res)) return;
    const id = actor(res).id, count = inFlight.get(id) ?? 0;
    if (count >= 2 || active >= 8) { fail(res, 429, "notes_busy", "کمی صبر کنید و دوباره ارسال کنید."); return; }
    inFlight.set(id, count + 1); active++;
    let done = false;
    const release = () => { if (done) return; done = true; active--; const n = (inFlight.get(id) ?? 1) - 1; if (n) inFlight.set(id, n); else inFlight.delete(id); };
    res.once("finish", release); res.once("close", release);
    upload.single("file")(req, res, error => {
      if (error) { fail(res, 400, "invalid_note_upload", "فقط یک فایل، حداکثر ۱۶ مگابایت، پیوست کنید."); return; }
      next();
    });
  }, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const app = access(req.params.id, res); if (!app) return;
    const user = actor(res), clientId = req.body?.clientId;
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientId) ||
        (!text && !req.file) ||
        Object.keys(req.body ?? {}).some(key => !["text", "clientId"].includes(key))) {
      fail(res, 400, "invalid_case_note", "متن یا فایل یادداشت معتبر نیست."); return;
    }
    let objectPath: string | null = null;
    try {
      const file = req.file;
      const validated = file ? validateChatFile(file) : null;
      const digest = createHash("sha256").update(text).update("\0").update(validated?.mime ?? "").update(file?.buffer ?? "").digest("hex");
      const find = () => queryRow<Note>("SELECT * FROM loan_application_notes WHERE application_id=? AND author_id=? AND client_id=?", [app.id, user.id, clientId]);
      const checkRetry = (prior: Note) => {
        if (prior.content_hash !== digest) throw new Error("case_note_retry_conflict");
        return view(prior);
      };
      const prior = find(); if (prior) { res.json(checkRetry(prior)); return; }
      const count = queryRow<{ n: number }>("SELECT COUNT(*) n FROM loan_application_notes WHERE author_id=? AND created_at>?", [user.id, new Date(Date.now() - 60000).toISOString()]);
      if (Number(count?.n ?? 0) >= 40) { fail(res, 429, "notes_rate_limit", "تعداد ارسال‌ها زیاد است؛ یک دقیقه صبر کنید."); return; }
      if (file && validated) objectPath = await storage.save(file.buffer, validated.mime);
      let created = false;
      const result = runImmediateTransaction(() => {
        if (!scoped(app.id, user)) throw new Error("case_note_access_changed");
        const repeated = find(); if (repeated) return checkRetry(repeated);
        const timestamp = new Date().toISOString(), name = user.fullName?.trim() || user.username;
        const filename = file ? Buffer.from(file.originalname, "latin1").toString("utf8").replace(/[\r\n\u0000]/g, "").slice(0,240) : null;
        const id = execute(`INSERT INTO loan_application_notes(application_id,author_id,author_name,text,client_id,content_hash,
          created_at,object_path,file_name,mime_type,file_size,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [app.id, user.id, name, text, clientId, digest, timestamp, objectPath, filename, validated?.mime ?? null, file?.size ?? null, validated?.kind ?? null]);
        execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
          [app.id, app.stage, app.stage, "case-note-added", text.slice(0,400) || `پیوست یادداشت: ${filename}`, user.id, timestamp]);
        created = true;
        return view(queryRow<Note>("SELECT * FROM loan_application_notes WHERE id=?", [id])!);
      });
      if (!created && objectPath) await storage.remove(objectPath).catch(() => {});
      objectPath = null; res.status(created ? 201 : 200).json(result);
    } catch (cause) {
      if (objectPath) await storage.remove(objectPath).catch(() => {});
      const code = cause instanceof Error ? cause.message : "";
      if (code === "case_note_retry_conflict") fail(res, 409, code, "محتوای تلاش مجدد تغییر کرده است؛ آن را به‌عنوان یادداشت جدید بفرستید.");
      else if (code === "case_note_access_changed") fail(res, 404, code, "دسترسی به پرونده تغییر کرده است.");
      else if (code === "unsupported_chat_file") fail(res, 400, code, "تصویر، PDF، Word یا فایل صوتی معتبر پیوست کنید.");
      else { req.log?.error({ errorType: cause instanceof Error ? cause.name : "unknown" }, "case note save failed"); fail(res, 502, "case_note_save_failed", "یادداشت ذخیره نشد؛ متن و فایل را نگه دارید و دوباره تلاش کنید."); }
    }
  });
  router.get("/loan-applications/:id/notes/:noteId/file", requirePermission("loan_applications.view"), async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const app = access(req.params.id, res); if (!app) return;
    const note = queryRow<Note>("SELECT * FROM loan_application_notes WHERE id=? AND application_id=?", [Number(req.params.noteId), app.id]);
    if (!note?.object_path) { res.status(404).end(); return; }
    try {
      const chunks: Buffer[] = []; let total = 0;
      for await (const value of storage.read(note.object_path)) {
        const chunk = Buffer.from(value); total += chunk.length;
        if (total > maximum) throw new Error("note_file_too_large");
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", note.mime_type ?? "application/octet-stream");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Disposition", `${note.kind === "file" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(note.file_name ?? "file")}`);
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        let start = range?.[1] ? Number(range[1]) : 0;
        let end = range?.[2] ? Number(range[2]) : data.length - 1;
        if (range && !range[1] && range[2]) { start = Math.max(0, data.length - Number(range[2])); end = data.length - 1; }
        if (!range || (!range[1] && !range[2]) || start > end || start >= data.length) {
          res.setHeader("Content-Range", `bytes */${data.length}`); res.status(416).end(); return;
        }
        end = Math.min(end, data.length - 1);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${data.length}`);
        res.status(206).send(data.subarray(start, end + 1)); return;
      }
      res.send(data);
    } catch (cause) {
      req.log?.error({ errorType: cause instanceof Error ? cause.name : "unknown" }, "case note file read failed");
      if (!res.headersSent) fail(res, 502, "case_note_file_unavailable", "فایل اکنون در دسترس نیست."); else res.destroy();
    }
  });
}
