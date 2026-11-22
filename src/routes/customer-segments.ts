/**
 * t878 customer segments. flag.customer_segments_v1 absent/≠'1' → /me returns enabled:false, other routes 404.
 * View + Excel: admin and sales_manager see all; salesperson/trainee see only their current-owner customers.
 * Phone and national ID in Excel only when includePhones === true (default off). Read-only queries; export is audit-logged.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { requireAuth, getAuthenticatedUser, type AuthUser } from "../lib/auth";
import {
  SEGMENTS_FLAG, segmentsOn, isSegmentsViewer, actorScope, fieldCatalog, parseQuery, preview, exportXlsx,
  fieldValues, loadProfiles, SegmentScopeError,
} from "../lib/customer-segments";

const router: IRouter = Router();

function fail(res: Response, status: number, error: string, message?: string) {
  res.status(status).json({ error, ...(message ? { message } : {}) });
}

function requireViewer(req: Request, res: Response, next: NextFunction): void {
  const user = (res.locals.authUser as AuthUser | undefined) ?? getAuthenticatedUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!isSegmentsViewer(user)) { res.status(403).json({ error: "Forbidden", message: "این گزارش فقط برای مدیر، مدیر فروش و کارشناس است." }); return; }
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
  const scope = actorScope(u);
  const canView = enabled && scope != null;
  res.json({
    enabled,
    flag: SEGMENTS_FLAG,
    canView,
    canExport: canView,
    scope: scope?.kind ?? null,
    salespersonId: scope?.kind === "own" ? scope.salespersonId : (u.salespersonId ?? null),
  });
});

router.get("/customer-segments/meta", requireAuth, requireViewer, guarded, (_req, res) => {
  const u = res.locals.authUser as AuthUser;
  const scope = actorScope(u)!;
  const cat = fieldCatalog();
  const fields = scope.kind === "own" ? cat.fields.filter((f) => f.key !== "ownerId") : cat.fields;
  res.json({
    groups: cat.groups,
    fields,
    owners: scope.kind === "all" ? cat.owners : cat.owners.filter((o) => Number(o.value) === scope.salespersonId),
    tags: cat.tags,
    scope: scope.kind,
  });
});


router.post("/customer-segments/values", requireAuth, requireViewer, guarded, (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const q = parseQuery(req.body);
  const scope = actorScope(user)!;
  try {
    res.json({
      source: q.source,
      includeUnlinkedLeads: q.includeUnlinkedLeads !== false && scope.kind === "all",
      fields: fieldValues(loadProfiles(), q, scope),
    });
  } catch (e) {
    if (e instanceof SegmentScopeError) { fail(res, e.status, e.error, e.publicMessage); return; }
    throw e;
  }
});

router.post("/customer-segments/preview", requireAuth, requireViewer, guarded, (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const q = parseQuery(req.body);
  const page = Number((req.body as { page?: unknown })?.page ?? req.query.page ?? 1);
  const pageSize = Number((req.body as { pageSize?: unknown })?.pageSize ?? req.query.pageSize ?? 20);
  try {
    res.json(preview(q, user, page, pageSize));
  } catch (e) {
    if (e instanceof SegmentScopeError) { fail(res, e.status, e.error, e.publicMessage); return; }
    throw e;
  }
});

router.post("/customer-segments/export", requireAuth, requireViewer, guarded, (req, res) => {
  const user = res.locals.authUser as AuthUser;
  const body = (req.body || {}) as Record<string, unknown>;
  const q = parseQuery(body);
  const includePhones = body.includePhones === true;
  try {
    const { buffer, filename, rowCount } = exportXlsx(q, user, includePhones);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Row-Count", String(rowCount));
    res.setHeader("X-Include-Phones", includePhones ? "1" : "0");
    res.send(buffer);
  } catch (e) {
    if (e instanceof SegmentScopeError) { fail(res, e.status, e.error, e.publicMessage); return; }
    throw e;
  }
});

export default router;
