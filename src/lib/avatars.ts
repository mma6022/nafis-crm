import { Router, type IRouter } from "express";
import { execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { requireAuth, type AuthUser } from "./auth";
import { requirePermission } from "./access-control";

const MAX_BYTES = 64 * 1024;

function ensureSchema(): void {
  execute(`CREATE TABLE IF NOT EXISTS user_avatars (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    data_base64 TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_user_id INTEGER
  )`);
}

function detectMime(bytes: Buffer): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function parseImage(body: unknown): { mime: string; base64: string } | null {
  const image = (body as { image?: unknown } | undefined)?.image;
  if (typeof image !== "string") return null;
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match) return null;
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length || bytes.length > MAX_BYTES) return null;
  const mime = detectMime(bytes);
  return mime ? { mime, base64: bytes.toString("base64") } : null;
}

function storeAvatar(targetId: number, actorId: number, body: unknown): "ok" | "invalid" | "missing_user" {
  if (!queryRow("SELECT id FROM users WHERE id = ?", [targetId])) return "missing_user";
  const image = parseImage(body);
  if (!image) return "invalid";
  execute(
    `INSERT INTO user_avatars(user_id, mime_type, data_base64, updated_at, updated_by_user_id) VALUES(?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET mime_type = excluded.mime_type, data_base64 = excluded.data_base64,
       updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
    [targetId, image.mime, image.base64, new Date().toISOString(), actorId],
  );
  return "ok";
}

export function createAvatarRouter(): IRouter {
  ensureSchema();
  const router = Router();
  // This router is mounted at /api before public wallet routes. Authenticate
  // only avatar paths so unrelated capability-based payment links can pass.
  router.use(["/avatars", "/profile/avatar", "/users/:id/avatar"], requireAuth);

  // Version map lets the UI cache-bust avatars without exposing image bytes in lists.
  router.get("/avatars", (_req, res): void => {
    const rows = queryRows<{ user_id: number; updated_at: string }>("SELECT user_id, updated_at FROM user_avatars");
    const versions: Record<string, number> = {};
    for (const row of rows) versions[String(row.user_id)] = Date.parse(row.updated_at) || 1;
    res.setHeader("Cache-Control", "no-store");
    res.json({ versions });
  });

  router.get("/avatars/:id", (req, res): void => {
    const id = Number(req.params.id);
    const row = Number.isSafeInteger(id)
      ? queryRow<{ mime_type: string; data_base64: string }>("SELECT mime_type, data_base64 FROM user_avatars WHERE user_id = ?", [id])
      : undefined;
    if (!row) {
      res.status(404).json({ error: "avatar_not_found" });
      return;
    }
    res.setHeader("Content-Type", row.mime_type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(Buffer.from(row.data_base64, "base64"));
  });

  router.put("/profile/avatar", (req, res): void => {
    const user = res.locals.authUser as AuthUser;
    const result = storeAvatar(user.id, user.id, req.body);
    if (result !== "ok") {
      res.status(result === "invalid" ? 400 : 404).json({ error: result === "invalid" ? "invalid_avatar_image" : "User not found" });
      return;
    }
    res.json({ ok: true });
  });

  router.delete("/profile/avatar", (_req, res): void => {
    const user = res.locals.authUser as AuthUser;
    executeChanges("DELETE FROM user_avatars WHERE user_id = ?", [user.id]);
    res.status(204).end();
  });

  router.put("/users/:id/avatar", requirePermission("users.manage"), (req, res): void => {
    const user = res.locals.authUser as AuthUser;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const result = storeAvatar(id, user.id, req.body);
    if (result !== "ok") {
      res.status(result === "invalid" ? 400 : 404).json({ error: result === "invalid" ? "invalid_avatar_image" : "User not found" });
      return;
    }
    res.json({ ok: true });
  });

  router.delete("/users/:id/avatar", requirePermission("users.manage"), (req, res): void => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    executeChanges("DELETE FROM user_avatars WHERE user_id = ?", [id]);
    res.status(204).end();
  });

  return router;
}
