import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";

export function diagnosticWorkerAuth(db: DatabaseSync, secret: () => string | undefined): RequestHandler {
  return (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const key = secret();
    if (!key || key.length < 32) {
      res.status(503).json({ error: "repair_worker_not_configured" }); return;
    }
    const stamp = req.get("X-Repair-Timestamp") ?? "", nonce = req.get("X-Repair-Nonce") ?? "";
    const signature = req.get("X-Repair-Signature") ?? "";
    if (!/^\d{13}$/.test(stamp) || Math.abs(Date.now() - Number(stamp)) > 60_000 ||
        !/^[A-Za-z0-9_-]{20,100}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) {
      res.status(401).json({ error: "invalid_worker_auth" }); return;
    }
    // Signed path is the full API path, with no query or host.
    const canonical = [req.method, req.originalUrl.split("?")[0], stamp, nonce, JSON.stringify(req.body ?? {})].join("\n");
    const expected = createHmac("sha256", key).update(canonical).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
      res.status(401).json({ error: "invalid_worker_auth" }); return;
    }
    db.prepare("DELETE FROM diagnostic_worker_nonces WHERE expires_at<?").run(Date.now());
    const result = db.prepare("INSERT OR IGNORE INTO diagnostic_worker_nonces(nonce_hash,expires_at) VALUES(?,?)")
      .run(createHash("sha256").update(nonce).digest("hex"), Date.now() + 120_000);
    if (Number(result.changes) !== 1) {
      res.status(409).json({ error: "worker_request_replayed" }); return;
    }
    next();
  };
}
