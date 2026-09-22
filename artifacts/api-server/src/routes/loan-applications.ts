import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { crmDb, execute, executeChanges, queryRow, queryRows, runTransaction } from "../lib/crm-db";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";

const router = Router();
const stages = ["draft", "primary_contract_pending_signature", "customer_documents_upload", "customer_documents_review",
  "guarantor_registration", "guarantor_documents_upload", "guarantor_documents_review", "collateral_upload", "collateral_review",
  "expert_approval", "admin_approval", "final_invoice_pending_signature", "completed"] as const;
type Stage = typeof stages[number];
const now = () => new Date().toISOString();
const user = (res: any) => res.locals.authUser as AuthUser;
const uploadRoot = path.join(path.dirname(requireDbPath()), "loan-application-files");
function requireDbPath() { return path.resolve(process.cwd(), "..", "..", "attached_assets", "customers_1789823100050.db"); }
fs.mkdirSync(uploadRoot, { recursive: true, mode: 0o700 });
try { fs.chmodSync(uploadRoot, 0o700); } catch { /* explicit private mode */ }
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 }, storage: multer.memoryStorage() });
let emzameToken: { value: string; expires: number } | undefined;
const fileType = (f: Express.Multer.File) => new Set(["application/pdf", "image/jpeg", "image/png"]).has(f.mimetype) && /\.(pdf|jpe?g|png)$/i.test(f.originalname);
function storeFile(appId: number, f: Express.Multer.File): string {
  const dir = path.join(uploadRoot, String(appId)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${crypto.randomUUID()}.${f.mimetype === "application/pdf" ? "pdf" : f.mimetype === "image/png" ? "png" : "jpg"}`);
  fs.writeFileSync(target, f.buffer, { mode: 0o600 }); return target;
}

function scoped(id: number, u: AuthUser): any {
  const condition = u.role === "admin" || u.customerScope !== "assigned" ? "" : " AND c.salesperson_id = ?";
  const params: any[] = [id]; if (condition) params.push(u.salespersonId);
  return queryRow<any>(`SELECT a.*,c.first_name,c.last_name,c.salesperson_id,p.name plan_name
    FROM loan_applications a JOIN customers c ON c.id=a.customer_id
    LEFT JOIN loan_plans p ON p.id=COALESCE(a.plan_id, CASE WHEN json_valid(a.plan_ids) THEN CAST(json_extract(a.plan_ids,'$[0]') AS INTEGER) ELSE CAST(a.plan_ids AS INTEGER) END)
    WHERE a.id=? AND a.deleted_at IS NULL${condition}`, params);
}
function error(res: any, status: number, code: string) { return res.status(status).json({ error: code, code }); }
function shape(r: any): any {
  if (!r) return r;
  const planIds = parseJson(r.plan_ids);
  return { id: Number(r.id), customerId: Number(r.customer_id), customerName: [r.first_name, r.last_name].filter(Boolean).join(" "),
    planId: Number(r.plan_id ?? (Array.isArray(planIds) ? planIds[0] : r.plan_ids)), planIds: Array.isArray(planIds) ? planIds : [Number(r.plan_id ?? r.plan_ids)],
    planName: r.plan_name ?? null, consultationId: Number(r.consultation_id),
    requestedAmount: r.requested_amount, approvedAmount: r.approved_amount ?? null, netAmount: r.net_amount ?? null,
    durationMonths: r.duration_months, stage: r.stage, status: r.status, planSnapshot: parseJson(r.plan_snapshot_json),
    conditionSnapshot: parseJson(r.condition_snapshot_json), calculation: r.net_amount ? { requestedAmount: r.requested_amount, approvedAmount: r.approved_amount, netAmount: r.net_amount } : null,
    documents: r.documents ?? [], guarantor: r.guarantor ?? null, collateral: r.collateral ?? [], generatedDocuments: (r.generatedDocuments ?? []).map((d: any) => ({ ...d, signed: typeof d.link === "string" && d.link.startsWith("signed:") })),
    history: r.history ?? [], createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at };
}
function parseJson(value: any) { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function transition(id: number, to: Stage, action: string, actor: AuthUser, reason?: string) {
  return runTransaction(() => {
    const current = queryRow<any>("SELECT stage FROM loan_applications WHERE id=? AND deleted_at IS NULL", [id]);
    if (!current || !stages.includes(to)) throw new Error("invalid_transition");
    const allowed: Record<string, string[]> = {
      draft: ["primary_contract_pending_signature"], primary_contract_pending_signature: ["customer_documents_upload"],
      customer_documents_upload: ["customer_documents_review"], customer_documents_review: ["guarantor_registration", "collateral_upload"],
      guarantor_registration: ["guarantor_documents_upload"], guarantor_documents_upload: ["guarantor_documents_review"],
      guarantor_documents_review: ["collateral_upload"], collateral_upload: ["collateral_review"], collateral_review: ["expert_approval"],
      expert_approval: ["admin_approval"], admin_approval: ["final_invoice_pending_signature"],
      final_invoice_pending_signature: ["completed"], completed: [],
    };
    if (!allowed[current.stage]?.includes(to)) throw new Error("invalid_transition");
    if (to === "customer_documents_upload" && !queryRow("SELECT 1 FROM loan_application_generated_documents WHERE application_id=? AND kind='primary' AND link LIKE 'signed:%'", [id])) throw new Error("primary_contract_not_signed");
    if (to === "completed" && queryRows<any>("SELECT kind FROM loan_application_generated_documents WHERE application_id=? AND kind IN ('invoice','acknowledgement') AND link LIKE 'signed:%'", [id]).length < 2) throw new Error("final_documents_not_signed");
    if (to === "customer_documents_review" && !queryRow("SELECT 1 FROM loan_application_documents WHERE application_id=? AND storage_path IS NOT NULL", [id])) throw new Error("documents_missing");
    if (to === "guarantor_documents_review" && queryRow("SELECT 1 FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE g.application_id=? GROUP BY g.application_id HAVING SUM(d.status='approved') < COUNT(*)", [id])) throw new Error("documents_incomplete");
    if (to === "guarantor_documents_upload" && !queryRow("SELECT 1 FROM loan_application_guarantors WHERE application_id=?", [id])) throw new Error("guarantor_required");
    if (to === "collateral_upload" && current.stage === "customer_documents_review" && queryRow("SELECT 1 FROM loan_application_documents WHERE application_id=? AND source='plan' GROUP BY application_id HAVING SUM(status='approved') < COUNT(*)", [id])) throw new Error("documents_incomplete");
    if (to === "collateral_upload" && current.stage === "guarantor_documents_review" && queryRow("SELECT 1 FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE g.application_id=? GROUP BY g.application_id HAVING SUM(d.status='approved') < COUNT(*)", [id])) throw new Error("documents_incomplete");
    if (to === "collateral_review" && !queryRow("SELECT 1 FROM loan_application_collateral WHERE application_id=? AND status='approved'", [id])) throw new Error("collateral_incomplete");
    if (to === "final_invoice_pending_signature") {
      const app = queryRow<any>("SELECT a.*,p.deduct_percents,p.deposit_percents,p.prepayment_percents FROM loan_applications a LEFT JOIN loan_plans p ON p.id=CAST(a.plan_ids AS INTEGER) WHERE a.id=?", [id]);
      const amount = String(app?.approved_amount ?? app?.requested_amount ?? "");
      if (!/^(0|[1-9]\d*)$/.test(amount)) throw new Error("invalid_financial_value");
      const percent = (v: unknown) => { const n = String(v ?? "0").replace(/[^\d]/g, ""); return BigInt(n || "0"); };
      const deductions = percent(app?.deduct_percents), deposit = percent(app?.deposit_percents), prepayment = percent(app?.prepayment_percents);
      const total = deductions + deposit + prepayment; if (total > 100n) throw new Error("invalid_financial_value");
      const net = BigInt(amount) * (100n - total) / 100n;
      executeChanges("UPDATE loan_applications SET approved_amount=COALESCE(approved_amount,requested_amount),net_amount=?,updated_at=? WHERE id=?", [net.toString(), now(), id]);
    }
    executeChanges("UPDATE loan_applications SET stage=?,status=?,updated_at=? WHERE id=?", [to, to, now(), id]);
    if (to === "final_invoice_pending_signature") {
      const app = queryRow<any>("SELECT customer_id,net_amount FROM loan_applications WHERE id=?", [id]);
      const account = queryRow<any>("SELECT id FROM wallet_accounts WHERE customer_id=?", [app.customer_id]) ??
        { id: execute("INSERT INTO wallet_accounts(customer_id,balance,created_at) VALUES(?,?,?)", [app.customer_id, "0", now()]) };
      const key = `loan-application:${id}:credit`;
      if (!queryRow("SELECT id FROM wallet_ledger WHERE idempotency_key=?", [key])) {
        execute("INSERT INTO wallet_ledger(account_id,application_id,amount,kind,idempotency_key,created_at) VALUES(?,?,?,?,?,?)", [account.id, id, app.net_amount, "loan_credit", key, now()]);
        executeChanges("UPDATE wallet_accounts SET balance=CAST(balance AS INTEGER)+CAST(? AS INTEGER) WHERE id=?", [app.net_amount, account.id]);
      }
    }
    execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
      [id, current.stage, to, action, reason ?? null, actor.id, now()]);
  });
}

router.get("/loan-applications", requirePermission("loan_applications.view"), (req, res) => {
  const u = user(res), page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const where = u.role === "admin" || u.customerScope !== "assigned" ? "" : " AND c.salesperson_id = ?";
  const params: any[] = u.role === "admin" || u.customerScope !== "assigned" ? [] : [u.salespersonId];
  const filters: string[] = [];
  const add = (sql: string, value: any) => { filters.push(sql); params.push(value); };
  if (req.query.status) add("a.status=?", String(req.query.status));
  if (req.query.stage) add("a.stage=?", String(req.query.stage));
  if (req.query.customerId) add("a.customer_id=?", Number(req.query.customerId));
  if (req.query.planId) add("COALESCE(a.plan_id,CAST(json_extract(a.plan_ids,'$[0]') AS INTEGER))=?", Number(req.query.planId));
  if (req.query.search) { filters.push("(CAST(a.id AS TEXT) LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR p.name LIKE ?)"); const s = `%${String(req.query.search)}%`; params.push(s,s,s,s); }
  if (req.query.dateFrom) add("a.created_at>=?", String(req.query.dateFrom));
  if (req.query.dateTo) add("a.created_at<=?", String(req.query.dateTo));
  const rows = queryRows<any>(`SELECT a.*,c.first_name,c.last_name,p.name plan_name FROM loan_applications a JOIN customers c ON c.id=a.customer_id LEFT JOIN loan_plans p ON p.id=COALESCE(a.plan_id,CASE WHEN json_valid(a.plan_ids) THEN CAST(json_extract(a.plan_ids,'$[0]') AS INTEGER) ELSE CAST(a.plan_ids AS INTEGER) END) WHERE a.deleted_at IS NULL${where}${filters.length ? ` AND ${filters.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
  res.json({ items: rows.map(shape), page, limit });
});
router.get("/loan-applications/:id", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  r.documents = queryRows("SELECT * FROM loan_application_documents WHERE application_id=? ORDER BY id", [r.id]);
  r.history = queryRows("SELECT * FROM loan_application_stage_history WHERE application_id=? ORDER BY id", [r.id]);
  r.guarantor = queryRow("SELECT * FROM loan_application_guarantors WHERE application_id=?", [r.id]);
  if (r.guarantor) r.guarantor.documents = queryRows("SELECT * FROM loan_application_guarantor_documents WHERE guarantor_id=? ORDER BY id", [r.guarantor.id]);
  r.collateral = queryRows("SELECT * FROM loan_application_collateral WHERE application_id=?", [r.id]);
  r.generatedDocuments = queryRows("SELECT * FROM loan_application_generated_documents WHERE application_id=? ORDER BY id", [r.id]);
  return res.json(shape(r));
});
router.post("/loan-applications", requirePermission("loan_applications.create"), (req, res) => {
  const b = req.body ?? {}, customerId = Number(b.customerId), planId = Number(b.planId);
  const plan = queryRow<any>("SELECT * FROM loan_plans WHERE id=? AND active=1", [planId]);
  const amount = String(b.requestedAmount ?? "").trim();
  const duration = Number(b.durationMonths);
  if (!customerId || !plan || !/^[1-9]\d*$/.test(amount) || !Number.isInteger(duration) || duration < 1) return error(res, 400, "invalid_application_input");
  const u = user(res), customer = queryRow<any>("SELECT * FROM customers WHERE id=?", [customerId]);
  if (!customer || (u.customerScope === "assigned" && customer.salesperson_id !== u.salespersonId)) return error(res, 404, "loan_application_not_found");
  const conditions = queryRows<any>("SELECT * FROM loan_plan_conditions WHERE plan_id=? ORDER BY sort_order,id", [planId]);
  const condition = conditions.find((item) => {
    const max = BigInt(String(item.max_principal ?? "0").replace(/\D/g, "") || "0");
    const options = parseJson(item.installment_options) ?? [];
    return (max === 0n || BigInt(amount) <= max) && (!Array.isArray(options) || !options.length || options.map(Number).includes(duration));
  });
  if (conditions.length && !condition) return error(res, 422, "loan_plan_condition_not_matched");
  const ts = now(), requirements = (() => { try { return JSON.parse(plan.required_documents || "[]"); } catch { return []; } })();
  const id = runTransaction(() => {
    let consultationId = Number(b.consultationId);
    if (!consultationId || !queryRow("SELECT id FROM consultation_forms WHERE id=? AND customer_id=?", [consultationId, customerId])) {
      consultationId = execute("INSERT INTO consultation_forms(customer_id,requested_amount,extra_notes,updated_at) VALUES(?,?,?,?)", [customerId, amount, b.notes ?? null, ts]);
    }
    const appId = execute(`INSERT INTO loan_applications(consultation_id,customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,duration_months,stage,status,plan_snapshot_json,condition_snapshot_json,document_requirements_snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [consultationId, customerId, u.id, JSON.stringify([planId]), planId, amount, duration, "draft", "requested", JSON.stringify(plan), JSON.stringify(condition ?? null), JSON.stringify(requirements), ts, ts]);
    for (const item of requirements) execute("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,created_at) VALUES(?,?,?,?,?)", [appId, String(item), String(item), "plan", ts]);
    execute("INSERT INTO loan_application_stage_history(application_id,to_stage,action,actor_id,created_at) VALUES(?,?,?,?,?)", [appId, "draft", "created", u.id, ts]);
    return appId;
  });
  res.status(201).json(scoped(id, u));
});
router.patch("/loan-applications/:id", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "draft") return error(res, 409, "draft_only");
  const allowed: Record<string, string> = { requestedAmount: "requested_amount", durationMonths: "duration_months" };
  const fields = Object.entries(allowed).filter(([k]) => req.body?.[k] !== undefined);
  if (!fields.length) return error(res, 400, "invalid_application_input");
  executeChanges(`UPDATE loan_applications SET ${fields.map(([, c]) => `${c}=?`).join(",")},updated_at=? WHERE id=?`, [...fields.map(([k]) => req.body[k]), now(), r.id]);
  res.json(scoped(r.id, user(res)));
});
router.delete("/loan-applications/:id", requirePermission("loan_applications.delete"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  executeChanges("UPDATE loan_applications SET deleted_at=?,updated_at=? WHERE id=?", [now(), now(), r.id]); res.status(204).end();
});

router.post("/loan-applications/:id/manual-requirements", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  const label = String(req.body?.label || "").trim(); if (!label) return error(res, 400, "invalid_document_requirement");
  const id = execute("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,created_at) VALUES(?,?,?,?,?)", [r.id, crypto.randomUUID(), label, "manual", now()]);
  res.status(201).json(queryRow("SELECT * FROM loan_application_documents WHERE id=?", [id]));
});
router.delete("/loan-applications/:id/manual-requirements/:documentId", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  executeChanges("DELETE FROM loan_application_documents WHERE id=? AND application_id=? AND source='manual'", [Number(req.params.documentId), r.id]); res.status(204).end();
});
router.post("/loan-applications/:id/documents", requirePermission("loan_applications.update"), upload.single("file"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  if (!req.file) return error(res, 400, "file_required");
  const allowed = new Set(["application/pdf", "image/jpeg", "image/png"]);
  if (!allowed.has(req.file.mimetype) || !/\.(pdf|jpe?g|png)$/i.test(req.file.originalname)) return error(res, 400, "file_type_not_allowed");
  if (!fileType(req.file)) return error(res, 400, "file_type_not_allowed");
  const target = storeFile(r.id, req.file);
  const id = execute("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,status,storage_path,original_name,mime_type,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [r.id, String(req.body?.requirementKey || req.body?.label || "document"), String(req.body?.label || "document"), req.body?.source === "manual" ? "manual" : "plan", "uploaded", target, req.file.originalname, req.file.mimetype, req.file.size, now()]);
  res.status(201).json(queryRow("SELECT * FROM loan_application_documents WHERE id=?", [id]));
});
router.post("/loan-applications/:id/guarantor/documents", requirePermission("loan_applications.update"), upload.single("file"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const g = r && queryRow<any>("SELECT id FROM loan_application_guarantors WHERE application_id=?", [r.id]);
  if (!r || !g || !req.file) return error(res, 400, "guarantor_or_file_required"); if (!fileType(req.file)) return error(res, 400, "file_type_not_allowed");
  const target = storeFile(r.id, req.file); const id = execute("INSERT INTO loan_application_guarantor_documents(guarantor_id,requirement_key,status,storage_path,original_name,mime_type,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)", [g.id, String(req.body?.requirementKey || "document"), "uploaded", target, req.file.originalname, req.file.mimetype, req.file.size, now()]);
  res.status(201).json({ id, status: "uploaded" });
});
router.get("/loan-applications/:id/guarantor/documents/:documentId/download", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT d.* FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE d.id=? AND g.application_id=?", [Number(req.params.documentId), r.id]);
  if (!d?.storage_path) return error(res, 404, "document_not_found"); let p: string; try { p = fs.realpathSync(d.storage_path); } catch { return error(res, 404, "document_not_found"); }
  if (!p.startsWith(uploadRoot + path.sep) || !fs.statSync(p).isFile()) return error(res, 404, "document_not_found"); return res.download(p, d.original_name || "document");
});
router.delete("/loan-applications/:id/guarantor/documents/:documentId", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT d.* FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE d.id=? AND g.application_id=?", [Number(req.params.documentId), r.id]);
  if (!d) return error(res, 404, "document_not_found"); if (d.storage_path) try { fs.unlinkSync(d.storage_path); } catch {} executeChanges("DELETE FROM loan_application_guarantor_documents WHERE id=?", [d.id]); res.status(204).end();
});
router.post("/loan-applications/:id/guarantor/documents/:documentId/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const decision = String(req.body?.decision || "");
  if (!r || !["approved", "incomplete", "rejected"].includes(decision) || (decision !== "approved" && !String(req.body?.reason || "").trim())) return error(res, 400, "invalid_document_review");
  executeChanges("UPDATE loan_application_guarantor_documents SET status=? WHERE id IN (SELECT d.id FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE d.id=? AND g.application_id=?)", [decision, Number(req.params.documentId), r.id]); res.json({ ok: true, status: decision });
});
router.post("/loan-applications/:id/collateral", requirePermission("loan_applications.update"), upload.single("file"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r || !req.file || !req.body?.collateralType) return error(res, 400, "invalid_collateral"); if (!fileType(req.file)) return error(res, 400, "file_type_not_allowed");
  const target = storeFile(r.id, req.file); const id = execute("INSERT INTO loan_application_collateral(application_id,collateral_type,status,data_json,storage_path,created_at) VALUES(?,?,?,?,?,?)", [r.id, String(req.body.collateralType), "submitted", JSON.stringify(req.body), target, now()]); res.status(201).json({ id, status: "submitted" });
});
router.get("/loan-applications/:id/collateral/:collateralId/download", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT * FROM loan_application_collateral WHERE id=? AND application_id=?", [Number(req.params.collateralId), r.id]);
  if (!d?.storage_path) return error(res, 404, "collateral_not_found"); let p: string; try { p = fs.realpathSync(d.storage_path); } catch { return error(res, 404, "collateral_not_found"); } if (!p.startsWith(uploadRoot + path.sep) || !fs.statSync(p).isFile()) return error(res, 404, "collateral_not_found"); return res.download(p, "collateral");
});
router.delete("/loan-applications/:id/collateral/:collateralId", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT * FROM loan_application_collateral WHERE id=? AND application_id=?", [Number(req.params.collateralId), r.id]); if (!d) return error(res, 404, "collateral_not_found"); if (d.storage_path) try { fs.unlinkSync(d.storage_path); } catch {} executeChanges("DELETE FROM loan_application_collateral WHERE id=?", [d.id]); res.status(204).end();
});
router.post("/loan-applications/:id/collateral/:collateralId/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const decision = String(req.body?.decision || ""); if (!r || !["approved", "incomplete", "rejected"].includes(decision) || (decision !== "approved" && !String(req.body?.reason || "").trim())) return error(res, 400, "invalid_collateral_review"); executeChanges("UPDATE loan_application_collateral SET status=?,reviewed_at=? WHERE id=? AND application_id=?", [decision, now(), Number(req.params.collateralId), r.id]); res.json({ ok: true, status: decision });
});
router.get("/loan-applications/:id/documents/:documentId/download", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT * FROM loan_application_documents WHERE id=? AND application_id=?", [Number(req.params.documentId), r.id]);
  if (!d?.storage_path) return error(res, 404, "document_not_found");
  let real: string; try { real = fs.realpathSync(d.storage_path); } catch { return error(res, 404, "document_not_found"); }
  if (!real.startsWith(uploadRoot + path.sep) || !fs.statSync(real).isFile()) return error(res, 404, "document_not_found");
  return res.download(real, d.original_name || "document");
});
router.delete("/loan-applications/:id/documents/:documentId", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  const d = queryRow<any>("SELECT storage_path FROM loan_application_documents WHERE id=? AND application_id=?", [Number(req.params.documentId), r.id]);
  if (!d) return error(res, 404, "document_not_found");
  if (d.storage_path) { try { fs.unlinkSync(d.storage_path); } catch { /* cleanup is best effort */ } }
  executeChanges("DELETE FROM loan_application_documents WHERE id=? AND application_id=?", [Number(req.params.documentId), r.id]);
  res.status(204).end();
});
router.post("/loan-applications/:id/documents/:documentId/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const decision = String(req.body?.decision || "");
  if (!r || !["approved", "incomplete", "rejected"].includes(decision)) return error(res, 400, "invalid_document_review");
  if (["incomplete", "rejected"].includes(decision) && !String(req.body?.reason || "").trim()) return error(res, 400, "review_reason_required");
  executeChanges("UPDATE loan_application_documents SET status=?,incomplete_reason=?,reviewed_at=? WHERE id=? AND application_id=?", [decision, req.body.reason ?? null, now(), Number(req.params.documentId), r.id]);
  res.json({ ok: true, status: decision });
});

function action(pathSuffix: string, permission: any, to: Stage) {
  router.post(`/loan-applications/:id/${pathSuffix}`, requirePermission(permission), (req, res) => {
    const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
    try { transition(r.id, to, pathSuffix, user(res), req.body?.reason); res.json(scoped(r.id, user(res))); } catch (e) { return error(res, 409, e instanceof Error && e.message === "invalid_transition" ? "invalid_stage_transition" : "workflow_error"); }
  });
}
action("submit-primary-contract", "loan_applications.update", "primary_contract_pending_signature");
action("submit-customer-documents", "loan_applications.update", "customer_documents_review");
action("review-customer-documents", "loan_applications.review", "guarantor_registration");
action("start-guarantor-documents", "loan_applications.update", "guarantor_documents_upload");
action("submit-guarantor-documents", "loan_applications.update", "guarantor_documents_review");
action("review-guarantor-documents", "loan_applications.review", "collateral_upload");
action("submit-collateral", "loan_applications.update", "collateral_review");
action("review-collateral", "loan_applications.review", "expert_approval");
action("expert-approve", "loan_applications.review", "admin_approval");
action("admin-approve", "loan_applications.approve", "final_invoice_pending_signature");
action("complete", "loan_applications.update", "completed");
router.post("/loan-applications/:id/review-customer-documents", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  const condition = parseJson(r.condition_snapshot_json);
  const to: Stage = condition?.needs_guarantor || condition?.needsGuarantor ? "guarantor_registration" : "collateral_upload";
  try { transition(r.id, to, "review-customer-documents", user(res), req.body?.reason); res.json(shape(scoped(r.id, user(res)))); }
  catch (e) { return error(res, 409, e instanceof Error ? e.message : "workflow_error"); }
});
for (const [name, permission] of [["expert-reject", "loan_applications.review"], ["admin-reject", "loan_applications.approve"]] as const) {
  router.post(`/loan-applications/:id/${name}`, requirePermission(permission), (req, res) => {
    const r = scoped(Number(req.params.id), user(res)); const reason = String(req.body?.reason || "").trim();
    if (!r) return error(res, 404, "loan_application_not_found"); if (!reason) return error(res, 400, "review_reason_required");
    executeChanges("UPDATE loan_applications SET status='rejected',updated_at=? WHERE id=?", [now(), r.id]);
    execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)", [r.id, r.stage, r.stage, name, reason, user(res).id, now()]);
    return res.json(shape(scoped(r.id, user(res))));
  });
}

router.post("/loan-applications/:id/generated-documents", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const kind = String(req.body?.kind || "");
  if (!r || !["primary", "invoice", "acknowledgement"].includes(kind) || !Number(req.body?.contractGenerationId)) return error(res, 400, "invalid_generated_document");
  const g = queryRow<any>("SELECT id,customer_id,provider_contract_id,provider_status,deleted_at FROM contract_generations WHERE id=?", [Number(req.body.contractGenerationId)]);
  if (!g || g.deleted_at || g.customer_id !== r.customer_id || !g.provider_contract_id) return error(res, 409, "contract_generation_not_linkable");
  const id = execute("INSERT INTO loan_application_generated_documents(application_id,kind,contract_generation_id,created_at) VALUES(?,?,?,?)", [r.id, kind, g.id, now()]);
  res.status(201).json({ id, applicationId: r.id, kind, contractGenerationId: g.id });
});
async function emzameAuth(): Promise<{ base: string; token: string }> {
  const base = (process.env.EMZAME_BASE_URL || "https://core.emzame.com/api/v1/backoffice").replace(/\/+$/, "");
  if (emzameToken && emzameToken.expires > Date.now() + 30_000) return { base, token: emzameToken.value };
  const nationalCode = process.env.EMZAME_NATIONAL_CODE, password = process.env.EMZAME_PASSWORD;
  if (!nationalCode || !password) throw new Error("provider_configuration");
  const response = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nationalCode, password }), signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({})) as any;
  const token = body.accessToken ?? body.data?.accessToken ?? body.token;
  if (!response.ok || typeof token !== "string") throw new Error("provider_status_failed");
  emzameToken = { value: token, expires: Date.now() + 10 * 60_000 };
  return { base, token };
}
function signatureState(body: any): { status: string | null; signed: boolean } {
  const objects = [body, body?.data, body?.result, body?.contract, body?.data?.contract].filter((value) => value && typeof value === "object");
  let status: string | null = null;
  for (const object of objects) for (const key of ["status", "contractStatus", "state", "statusTitle", "statusText"]) {
    if (typeof object[key] === "string" && object[key].trim()) { status = object[key].trim().slice(0, 120); break; }
  }
  const normalized = String(status ?? "").toLowerCase();
  const negative = ["not_completed", "incomplete", "pending", "waiting", "rejected", "declined", "cancelled", "canceled", "expired", "در انتظار", "رد شده", "لغو شده"].some((value) => normalized.includes(value));
  const signed = !negative && ["signed", "completed", "complete", "finished", "done", "امضا شده", "تکمیل شده"].some((value) => normalized.includes(value));
  return { status, signed };
}
router.post("/loan-applications/:id/generated-documents/:documentId/verify-signature", requirePermission("loan_applications.update"), async (req, res): Promise<void> => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT d.*,g.provider_status,g.provider_contract_id FROM loan_application_generated_documents d JOIN contract_generations g ON g.id=d.contract_generation_id WHERE d.id=? AND d.application_id=?", [Number(req.params.documentId), r.id]);
  if (!d || !d.provider_contract_id) { error(res, 404, "generated_document_not_found"); return; }
  let state: { status: string | null; signed: boolean };
  try {
    const auth = await emzameAuth();
    const response = await fetch(`${auth.base}/contracts/${encodeURIComponent(String(d.provider_contract_id))}`, { headers: { authorization: `Bearer ${auth.token}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("provider_status_failed");
    state = signatureState(body);
    if (!state.status) throw new Error("provider_status_failed");
    executeChanges("UPDATE contract_generations SET provider_status=?,updated_at=? WHERE id=?", [state.status, now(), d.contract_generation_id]);
  } catch { error(res, 502, "provider_status_failed"); return; }
  if (!state.signed) { error(res, 409, "signature_not_confirmed"); return; }
  executeChanges("UPDATE loan_application_generated_documents SET link=? WHERE id=?", [`signed:${d.provider_contract_id}`, d.id]);
  if (d.kind === "primary") {
    const current = queryRow<any>("SELECT stage FROM loan_applications WHERE id=?", [r.id]);
    if (current?.stage === "primary_contract_pending_signature") {
      executeChanges("UPDATE loan_applications SET stage='customer_documents_upload',status='customer_documents_upload',updated_at=? WHERE id=?", [now(), r.id]);
      execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,actor_id,created_at) VALUES(?,?,?,?,?,?)", [r.id, current.stage, "customer_documents_upload", "primary_signature_verified", user(res).id, now()]);
    }
  }
  res.json({ id: d.id, signed: true, kind: d.kind, providerStatus: state.status });
});

router.post("/loan-applications/:id/guarantor", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  const b = req.body ?? {}; if (!b.fullName) return error(res, 400, "invalid_guarantor");
  const id = execute("INSERT INTO loan_application_guarantors(application_id,full_name,national_code,mobile,data_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(application_id) DO UPDATE SET full_name=excluded.full_name,national_code=excluded.national_code,mobile=excluded.mobile,data_json=excluded.data_json",
    [r.id, b.fullName, b.nationalCode ?? null, b.mobile ?? null, JSON.stringify(b), now()]);
  res.status(201).json(queryRow("SELECT * FROM loan_application_guarantors WHERE application_id=?", [r.id]));
});

export default router;