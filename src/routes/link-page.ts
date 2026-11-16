/**
 * links v1.0 routes. Every route falls through with next() while flag.links_page is OFF, so the API answers exactly as the
 * build before (401 for /api/public/link-page* without a session, 404 for /api/link-page* behind auth).
 *  - public (mounted in app.ts next to mountPublicLeads, before the global cors; own CORS = PUBLIC_LEAD_ORIGINS):
 *      GET  /api/public/link-page            header + visible links (in-memory cache, cleared on every save)
 *      POST /api/public/link-page/click/:id  navigator.sendBeacon from nafisvam.com/links (no cookie, no IP stored)
 *      GET  /api/public/link-page/logo/:id   an uploaded logo (sanitized SVG or PNG), sandboxed
 *  - admin (routes/index.ts, behind requireApiAuth): /api/link-page* — admin + sales_manager; header admin only.
 */
import express, { Router, type IRouter, type Express, type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import type { AuthUser } from "../lib/auth";
import { runImmediateTransaction } from "../lib/crm-db";
import {
  addLink, adminState, canManage, countClick, deleteLink, editLink, linksOn, MAX_UPLOAD, peekPublic, publicLogo, publicPayload, reorder, saveHeader, saveUpload,
} from "../lib/link-page";
import { PUBLIC_LEAD_ORIGINS } from "./public-leads";

const me = (res: Response) => res.locals.authUser as AuthUser & { baseRole?: string };
const send = (res: Response, r: any) => {
  if (r && r.ok === false) { const { ok: _ok, status, ...rest } = r; return void res.status(status).json(rest); }
  res.json(r);
};
const id = (req: Request) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : 0; };

/* ---------------- public ---------------- */
function corsPublic(req: Request, res: Response) {
  const origin = req.headers.origin;
  if (origin && PUBLIC_LEAD_ORIGINS.has(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
}
export function createPublicLinkPageRouter(): IRouter {
  const r: IRouter = Router();
  const gate = (_req: Request, _res: Response, next: NextFunction) => (linksOn() ? next() : next("router"));
  r.use(gate);
  r.options(["/", "/click/:id"], (req, res) => {
    corsPublic(req, res); res.setHeader("Access-Control-Allow-Methods", "GET, POST"); res.setHeader("Access-Control-Max-Age", "600"); res.status(204).end();
  });
  r.get("/", (req, res) => {
    corsPublic(req, res);
    try {
      const c = peekPublic() ?? runImmediateTransaction(() => publicPayload());
      res.setHeader("Cache-Control", "no-cache"); res.setHeader("ETag", c.etag);
      if (req.headers["if-none-match"] === c.etag) return void res.status(304).end();
      res.type("application/json; charset=utf-8").send(c.body);
    } catch { res.status(503).json({ error: "unavailable" }); }
  });
  r.post("/click/:id", (req, res) => {
    corsPublic(req, res);
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    const n = id(req);
    if (n && (!origin || PUBLIC_LEAD_ORIGINS.has(origin))) {
      const ipKey = createHash("sha256").update(String(req.ip ?? "")).digest("base64url").slice(0, 16); // memory only, never stored
      try { runImmediateTransaction(() => countClick(n, String(req.headers["user-agent"] ?? ""), `${req.headers["sec-purpose"] ?? ""} ${req.headers["purpose"] ?? ""} ${req.headers["x-moz"] ?? ""}`, ipKey)); } catch { /* a lost count never blocks the visitor */ }
    }
    res.status(204).end();
  });
  r.get("/logo/:id", (req, res) => {
    const n = id(req); const l = n ? publicLogo(n) : null;
    if (!l) return void res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", l.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("Content-Disposition", "inline");
    res.end(Buffer.from(l.data));
  });
  return r;
}
export function mountPublicLinkPage(app: Express) { app.use("/api/public/link-page", createPublicLinkPageRouter()); }

/* ---------------- admin ---------------- */
const router: IRouter = Router();
/** OFF → fall through (404 as before). ON but not admin/sales_manager → 403 no_access (server side, not only the menu). */
function guard(req: Request, res: Response, next: NextFunction) {
  if (!linksOn()) return next("router");
  res.setHeader("Cache-Control", "private, no-store");
  if (req.path === "/link-page/me") return next();
  if (!canManage(me(res))) return void res.status(403).json({ error: "no_access", message: "این صفحه فقط برای مدیر سیستم و مدیر فروش است." });
  next();
}
const scoped: IRouter = Router();
scoped.use((req, res, next) => (req.path === "/link-page" || req.path.startsWith("/link-page/") ? guard(req, res, next) : next("router")));
scoped.get("/link-page/me", (_req, res) => {
  const u = me(res);
  res.json({ enabled: true, canManage: canManage(u), canEditHeader: canManage(u) && (u.baseRole ?? "admin") === "admin" });
});
scoped.get("/link-page", (_req, res) => { try { res.json(runImmediateTransaction(() => adminState(me(res)))); } catch { res.status(500).json({ error: "load_failed", message: "فهرست لینک‌ها باز نشد." }); } });
scoped.post("/link-page/links", (req, res) => send(res, runImmediateTransaction(() => addLink(me(res), req.body))));
scoped.patch("/link-page/links/:id", (req, res) => send(res, runImmediateTransaction(() => editLink(me(res), id(req), req.body))));
scoped.delete("/link-page/links/:id", (req, res) => send(res, runImmediateTransaction(() => deleteLink(me(res), id(req)))));
scoped.put("/link-page/order", (req, res) => send(res, runImmediateTransaction(() => reorder(me(res), req.body?.ids))));
scoped.put("/link-page/header", (req, res) => send(res, runImmediateTransaction(() => saveHeader(me(res), req.body))));
scoped.post("/link-page/logos",
  (req, res, next) => {
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > MAX_UPLOAD) return void res.status(413).json({ error: "too_large", message: `حجم این فایل ${Math.ceil(len / 1024)} کیلوبایت است؛ حداکثر ۲۰۰ کیلوبایت. فایل کوچک‌تری انتخاب کن.` });
    next();
  },
  express.raw({ type: () => true, limit: MAX_UPLOAD + 1024 }),
  (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
    const name = typeof req.query.name === "string" ? req.query.name : "";
    send(res, runImmediateTransaction(() => saveUpload(me(res), buf, String(req.headers["content-type"] ?? ""), name)));
  });
scoped.get("/link-page/logos/:id", (req, res) => {
  const l = publicLogo(id(req)); if (!l) return void res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", l.mime); res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox"); res.end(Buffer.from(l.data));
});
router.use(scoped);
export default router;
