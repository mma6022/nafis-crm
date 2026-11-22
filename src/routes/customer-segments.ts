/**
 * t878 customer segments. flag.customer_segments_v1 absent/≠'1' → /me returns enabled:false, other routes 404.
 * View + Excel export: admin and sales_manager only. Read-only customer queries; export is audit-logged.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { requireAuth, getAuthenticatedUser, type AuthUser } from "../lib/auth";
import {
  SEGMENTS_FLAG, segmentsOn, isSegmentsViewer, fieldCatalog, parseQuery, preview, exportXlsx,
} from "../lib/customer-segments";

const router: IRouter = Router();

function fail(res: Response, status: number, error: string, message?: string) {
  res.status(status).json({ error, ...(message ? { message } : {}) });
}

function requireViewer(req: Request, res: Response, next: NextFunction): void {
  const user = (res.locals.authUser as AuthUser | undefined) ?? getAuthenticatedUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!isSegmentsViewer(user)) { res.status(403).json({ error: "Forbidden", message: "این گزارش فقط برای مدیر و مدیر فروش است." }); return; }
  res.locals.authUser = user;
  next();
}

function guarded(_req: Request, res: Response, next: NextFunction): void {
  if (!segmentsOn()) { fail(res, 404, "not_found"); return; }
  next();
}

router.get("/customer-segments/me", requireAuth, (req, res) => {
  const u = res.locals.authUser as AuthUser;
  const enabled = segmentsOn();
  const canView = enabled && isSegmentsViewer(u);
  res.json({
    enabled,
    flag: SEGMENTS_FLAG,
    canView,
    canExport: canView,
  });
});

router.get("/customer-segments/meta", requireAuth, requireViewer, guarded, (_req, res) => {
  const cat = fieldCatalog();
  res.json({
    groups: cat.groups,
    fields: cat.fields,
    owners: cat.owners,
    tags: cat.tags,
  });
});

router.post("/customer-segments/preview", requireAuth, requireViewer, guarded, (req, res) => {
  const q = parseQuery(req.body);
  const page = Number((req.body as { page?: unknown })?.page ?? req.query.page ?? 1);
  const pageSize = Number((req.body as { pageSize?: unknown })?.pageSize ?? req.query.pageSize ?? 20);
  const result = preview(q, page, pageSize);
  res.json(result);
});

router.post("/customer-segments/export", requireAuth, requireViewer, guarded, (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const body = (req.body || {}) as Record<string, unknown>;
  const q = parseQuery(body);
  const includePhones = body.includePhones !== false;
  const { buffer, filename, rowCount } = exportXlsx(q, user, includePhones);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Row-Count", String(rowCount));
  res.send(buffer);
});

export default router;
