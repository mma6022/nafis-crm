import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import JSZip from "jszip";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { crmDb, databasePath, queryRow } from "./crm-db";
import { emzameRequest } from "./emzame-client";
import { emzameProviderId as providerId } from "./emzame-response";
import { providerContractState } from "./emzame-signature";
import { evaluateFormulaTokens, loanPlanFieldValue, normalizeTemplatePercentDelimiters } from "../routes/contracts";
import { createInvoiceDocx } from "./goods-invoice";
import { reserveGoodsInvoiceNumber } from "./goods-invoice-numbering";
import { isContractMoneyMapping, ungroupContractNumber } from "./contract-number-format";
import { settledAcknowledgementPayout } from "./goods-acknowledgement-payout";
export { createInvoiceDocx } from "./goods-invoice";

export type GoodsDocumentKind = "invoice" | "acknowledgement";
export type GoodsDocumentSource = {
  id: number; customerId: number; planId: number; creditAmountToman: string;
  principalAmountToman: string; payoutAmountToman: string;
  invoiceVersion?: number;
  items: Array<{ title: string; quantity: number; unitPriceToman: string }>;
  acknowledgementTemplateId?: number | null;
};
const root = path.resolve(process.env.CONTRACTS_STORAGE_DIR || path.join(path.dirname(databasePath), "contracts"));
const store = path.join(root, "goods");
const now = () => new Date().toISOString();
const sha = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");
export function ensureGoodsDocumentsSchema() {
  crmDb.exec(`CREATE TABLE IF NOT EXISTS goods_purchase_documents(
    id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER NOT NULL REFERENCES goods_purchases(id),
    kind TEXT NOT NULL CHECK(kind IN ('invoice','acknowledgement')), version INTEGER NOT NULL,
    status TEXT NOT NULL, source_hash TEXT NOT NULL, source_invoice_version INTEGER NOT NULL DEFAULT 0, template_id INTEGER,
    pdf_path TEXT, pdf_sha256 TEXT, provider_file_id TEXT, provider_contract_id TEXT,
    provider_status TEXT, idempotency_key TEXT NOT NULL UNIQUE, error TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(purchase_id,kind,version));
    CREATE INDEX IF NOT EXISTS goods_documents_purchase ON goods_purchase_documents(purchase_id,kind,version);`);
  if (!(crmDb.prepare("PRAGMA table_info(goods_purchase_documents)").all() as Array<{ name: string }>).some(c => c.name === "source_invoice_version")) {
    crmDb.exec("ALTER TABLE goods_purchase_documents ADD COLUMN source_invoice_version INTEGER NOT NULL DEFAULT 0");
  }
  if (!(crmDb.prepare("PRAGMA table_info(goods_purchase_documents)").all() as Array<{ name: string }>).some(c => c.name === "invoice_number")) {
    crmDb.exec("ALTER TABLE goods_purchase_documents ADD COLUMN invoice_number TEXT");
  }
  crmDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS goods_documents_invoice_number
    ON goods_purchase_documents(invoice_number) WHERE invoice_number IS NOT NULL;
    CREATE TABLE IF NOT EXISTS goods_invoice_sequences(
      month TEXT PRIMARY KEY, last_number INTEGER NOT NULL CHECK(last_number BETWEEN 1 AND 999));`);
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
}
ensureGoodsDocumentsSchema();
function latest(purchaseId: number, kind: GoodsDocumentKind): any {
  return queryRow<any>("SELECT * FROM goods_purchase_documents WHERE purchase_id=? AND kind=? ORDER BY version DESC LIMIT 1", [purchaseId, kind]);
}
function publicState(row: any) {
  return row ? {
    id: row.id, kind: row.kind, version: row.version, invoiceVersion: row.source_invoice_version, status: row.status,
    providerStatus: row.provider_status, signed: row.status === "signed",
    pdfUrl: row.pdf_path ? `/api/goods-purchases/${row.purchase_id}/documents/${row.kind}/pdf` : null,
    error: row.error, createdAt: row.created_at,
  } : null;
}
export function goodsDocumentState(purchaseId: number, kind: GoodsDocumentKind) { return publicState(latest(purchaseId, kind)); }
export function assertInvoiceEditable(purchaseId: number) {
  const row = latest(purchaseId, "invoice");
  if (row && ["generating", "sending", "sent", "signed", "delivery_unknown"].includes(row.status)) throw new Error("invoice_document_locked");
}
export function invalidateGoodsInvoice(purchaseId: number) {
  assertInvoiceEditable(purchaseId);
  crmDb.prepare("UPDATE goods_purchase_documents SET status='superseded',updated_at=? WHERE purchase_id=? AND kind='invoice' AND status IN ('generated','failed','rejected')").run(now(), purchaseId);
}
function sourceHash(source: GoodsDocumentSource) { return sha(JSON.stringify(source)); }
function documentSourceHash(source: GoodsDocumentSource, kind: GoodsDocumentKind, layout = "buyer-only-latin-digits") {
  return sha(JSON.stringify({ source, layout: kind === "invoice" ? layout : "settled-payout" }));
}
function compatibleDocumentSource(source: GoodsDocumentSource, kind: GoodsDocumentKind, fingerprint: string) {
  return fingerprint === documentSourceHash(source, kind) ||
    (kind === "invoice" && fingerprint === sourceHash(source)) ||
    (kind === "invoice" && ["buyer-only-grid", "buyer-only-financing-company-receipt", "buyer-only-numbered-delivery-receipt", "buyer-only-readable-metadata"]
      .some(layout => fingerprint === documentSourceHash(source, kind, layout)));
}
function safeFile(file: string, directory = store) {
  const canonicalRoot = fs.realpathSync(directory);
  const resolved = fs.realpathSync(file);
  if (path.dirname(resolved) !== canonicalRoot || !fs.statSync(resolved).isFile()) throw new Error("document_path_invalid");
  return resolved;
}
export async function goodsPdf(purchaseId: number, kind: GoodsDocumentKind) {
  const row = latest(purchaseId, kind);
  if (!row?.pdf_path || row.status === "superseded") throw new Error("document_not_generated");
  const bytes = await fsp.readFile(safeFile(row.pdf_path));
  if (sha(bytes) !== row.pdf_sha256) throw new Error("document_integrity_failed");
  return bytes;
}
async function acknowledgementDocx(source: GoodsDocumentSource, customer: any, plan: any, manual: Record<string, string>) {
  const template = queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [source.acknowledgementTemplateId ?? 0]);
  if (!template) throw new Error("acknowledgement_template_required");
  const templateBytes = await fsp.readFile(safeFile(template.storage_path, path.join(root, "templates")));
  if (sha(templateBytes) !== template.sha256) throw new Error("template_integrity_failed");
  const mappings: any[] = JSON.parse(template.mappings_json || "[]");
  const payoutSnapshot = queryRow<{ payout_bps: number }>(
    "SELECT payout_bps FROM goods_purchases WHERE id=? AND plan_id=?", [source.id, source.planId],
  );
  const formulaPlan = { ...plan, principal_amount: source.principalAmountToman,
    _goods_customer_payout_bps: payoutSnapshot?.payout_bps };
  const values: Record<string, string> = {};
  const snake = (key: string) => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  for (const mapping of mappings) {
    const type = mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual");
    let value: unknown;
    if (type === "customer") value = mapping.customerField === "current.dateJalali"
      ? new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran" }).format(new Date())
      : customer[snake(String(mapping.customerField).replace(/^customer\./, ""))];
    else if (type === "loanPlan") value = mapping.loanPlanField === "loanPlan.customerPayoutPercent"
      ? loanPlanFieldValue(formulaPlan, mapping.loanPlanField)
      : mapping.loanPlanField === "loanPlan.principalAmount" ? source.principalAmountToman : plan[snake(String(mapping.loanPlanField).replace(/^loanPlan\./, ""))];
    else if (type === "constant") value = mapping.constantValue;
    else if (type === "formula") value = settledAcknowledgementPayout(mapping.formula, source.payoutAmountToman)
      ?? evaluateFormulaTokens(mapping.formula, customer, formulaPlan);
    else if (type === "date") {
      const days = mapping.date?.mode === "contract_date_plus_days" ? Number(mapping.date.offsetDays || 0) : 0;
      if (!Number.isInteger(days) || Math.abs(days) > 36500) throw new Error("template_date_invalid");
      value = new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran" }).format(new Date(Date.now() + days * 86400000));
    } else if (type === "contractNumber") value = `GOODS-ACK-${source.id}`;
    else value = manual[mapping.variable];
    if (value === null || value === undefined || !String(value).trim() || String(value).length > 5000) throw new Error(`template_value_required:${mapping.variable}`);
    values[mapping.variable] = isContractMoneyMapping(mapping, formulaPlan)
      ? String(value) : ungroupContractNumber(String(value));
  }
  const zip = await JSZip.loadAsync(templateBytes);
  for (const name of Object.keys(zip.files)) if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) {
    zip.file(name, normalizeTemplatePercentDelimiters(await zip.file(name)!.async("string"), mappings.map(m => m.variable)));
  }
  const renderer = new Docxtemplater(new PizZip(await zip.generateAsync({ type: "nodebuffer" })), { delimiters: { start: "%", end: "%" }, paragraphLoop: true, linebreaks: true });
  renderer.render(values);
  return renderer.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}
let conversions = 0;
async function convertPdf(docx: Buffer): Promise<string> {
  if (conversions >= 2) throw new Error("conversion_busy");
  conversions++;
  const dir = await fsp.mkdtemp(path.join(store, "convert-"));
  try {
    const input = path.join(dir, "document.docx");
    await fsp.writeFile(input, docx, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("soffice", ["--headless", `-env:UserInstallation=file://${path.join(dir, "profile")}`, "--convert-to", "pdf", "--outdir", dir, input],
        { stdio: "ignore", detached: true, env: { ...process.env, ...(process.env.CONTRACT_FONTCONFIG_FILE ? { FONTCONFIG_FILE: process.env.CONTRACT_FONTCONFIG_FILE } : {}) } });
      const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } reject(new Error("pdf_conversion_timeout")); }, 60000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("pdf_converter_unavailable")); });
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("pdf_conversion_failed")); });
    });
    const pdf = await fsp.readFile(path.join(dir, "document.pdf"));
    if (pdf.length > 80 * 1024 * 1024 || pdf.subarray(0, 5).toString() !== "%PDF-" || !/\/Type\s*\/Page\b/.test(pdf.toString("latin1"))) throw new Error("pdf_conversion_invalid");
    const file = path.join(store, `${crypto.randomUUID()}.pdf`);
    await fsp.writeFile(file, pdf, { mode: 0o600 });
    return file;
  } finally { conversions--; await fsp.rm(dir, { recursive: true, force: true }); }
}
export async function generateGoodsDocument(source: GoodsDocumentSource, kind: GoodsDocumentKind, actorId: number, manual: Record<string, string> = {}) {
  let previous = latest(source.id, kind);
  // Only local rendering is reclaimable. A stale external send remains locked
  // because its remote outcome is unknown and replay could send twice.
  if (previous?.status === "generating" && Date.parse(previous.updated_at) < Date.now() - 120000) {
    crmDb.prepare("UPDATE goods_purchase_documents SET status='failed',error='pdf_generation_interrupted',updated_at=? WHERE id=? AND status='generating'").run(now(), previous.id);
    previous = latest(source.id, kind);
  }
  const fingerprint = documentSourceHash(source, kind);
  // Explicit generation renews unsent documents from an older rendering policy.
  // Sent/signed documents and their original bytes stay intact.
  const renewPrevious = previous?.status === "generated" && !previous.provider_contract_id && !previous.provider_file_id &&
    previous.source_hash !== fingerprint && (compatibleDocumentSource(source, kind, previous.source_hash) ||
      (kind === "acknowledgement" && previous.source_hash === sourceHash(source)));
  if (previous && !renewPrevious && !["failed", "rejected", "superseded"].includes(previous.status)) {
    if (!compatibleDocumentSource(source, kind, previous.source_hash)) throw new Error("document_source_changed");
    return publicState(previous);
  }
  const issuedAt = new Date();
  const issuedAtIso = issuedAt.toISOString();
  let id: number;
  let invoiceNumber: string | null = null;
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    if (kind === "invoice") invoiceNumber = reserveGoodsInvoiceNumber(crmDb, issuedAt);
    if (renewPrevious && Number(crmDb.prepare("UPDATE goods_purchase_documents SET status='superseded',updated_at=? WHERE id=? AND status='generated' AND provider_contract_id IS NULL")
      .run(issuedAtIso, previous.id).changes) !== 1) throw new Error("document_delivery_locked");
    id = Number(crmDb.prepare(`INSERT INTO goods_purchase_documents(purchase_id,kind,version,status,source_hash,source_invoice_version,template_id,idempotency_key,created_by,created_at,updated_at,invoice_number) VALUES(?,?,?,'generating',?,?,?,?,?,?,?,?)`)
      .run(source.id, kind, (previous?.version ?? 0) + 1, fingerprint, source.invoiceVersion ?? 0, source.acknowledgementTemplateId ?? null, crypto.randomUUID(), actorId, issuedAtIso, issuedAtIso, invoiceNumber).lastInsertRowid);
    crmDb.exec("COMMIT");
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  }
  try {
    const customer = queryRow<any>("SELECT c.*,s.name salesperson_name FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=?", [source.customerId]);
    const plan = queryRow<any>("SELECT * FROM loan_plans WHERE id=?", [source.planId]);
    if (!customer || !plan) throw new Error("document_parties_missing");
    const bytes = kind === "invoice" ? await createInvoiceDocx({ ...source, invoiceNumber: invoiceNumber! }, customer, String(plan.platform_company_name ?? ""), issuedAt) : await acknowledgementDocx(source, customer, plan, manual);
    const file = await convertPdf(bytes);
    crmDb.prepare("UPDATE goods_purchase_documents SET status='generated',pdf_path=?,pdf_sha256=?,updated_at=? WHERE id=?").run(file, sha(await fsp.readFile(file)), now(), id);
    return goodsDocumentState(source.id, kind);
  } catch (e) {
    crmDb.prepare("UPDATE goods_purchase_documents SET status='failed',error=?,updated_at=? WHERE id=?").run(e instanceof Error ? e.message : "document_generation_failed", now(), id);
    throw e;
  }
}
function certificateActive(body: any): boolean {
  const candidates = [body?.active, body?.isActive, body?.data?.active, body?.data?.isActive, body?.result?.active];
  const explicit = candidates.find(v => typeof v === "boolean");
  if (typeof explicit === "boolean") return explicit;
  const certificate = body?.data && typeof body.data === "object" ? body.data : body;
  return Boolean(certificate && typeof certificate === "object" && String(certificate.nationalCode ?? "").trim()
    && String(certificate.phoneNumber ?? "").trim() && (String(certificate.firstName ?? "").trim() || String(certificate.lastName ?? "").trim()));
}
export async function sendGoodsDocument(source: GoodsDocumentSource, kind: GoodsDocumentKind) {
  const row = latest(source.id, kind);
  if (!row?.pdf_path) throw new Error("document_not_generated");
  if (!compatibleDocumentSource(source, kind, row.source_hash)) throw new Error("document_source_changed");
  if (row.provider_contract_id) return publicState(row);
  if (!process.env.EMZAME_BUSINESS_ID || !process.env.EMZAME_NATIONAL_CODE || !process.env.EMZAME_PASSWORD) throw new Error("provider_configuration");
  const customer = queryRow<any>("SELECT name,national_code,phone FROM customers WHERE id=?", [source.customerId]);
  const latin = (value: unknown) => String(value ?? "").replace(/[۰-۹]/g, c => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c))).replace(/[٠-٩]/g, c => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));
  const nationalCode = latin(customer?.national_code).replace(/[\s-]/g, "");
  const phone = latin(customer?.phone).replace(/[\s().-]/g, "").replace(/^(?:\+98|0098)/, "0").replace(/^98(?=9)/, "0").replace(/^9(?=\d{9}$)/, "09");
  if (!/^\d{10}$/.test(nationalCode) || !/^09\d{9}$/.test(phone)) throw new Error("collaborator_invalid");
  if (Number(crmDb.prepare("UPDATE goods_purchase_documents SET status='sending',error=NULL,updated_at=? WHERE id=? AND status='generated'").run(now(), row.id).changes) !== 1) throw new Error("document_delivery_locked");
  let contractAttempted = false;
  try {
    const certPath = process.env.EMZAME_CERTIFICATE_PATH || "users/checkUserActiveCertificate/";
    const cert = await emzameRequest(`${certPath}${certPath.includes("?") ? "&" : "?"}nationalCode=${encodeURIComponent(nationalCode)}`);
    if (!cert.ok) throw new Error("provider_certificate_check_failed");
    if (!certificateActive(await cert.json())) throw new Error("certificate_inactive");
    let fileId = row.provider_file_id;
    if (!fileId) {
      const pdf = await goodsPdf(source.id, kind);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), `goods-${source.id}-${kind}.pdf`);
      form.append("name", `${kind === "invoice" ? "فاکتور خرید کالا" : "اقرارنامه خرید کالا"} ${source.id}`);
      const uploaded = await emzameRequest("files", { method: "POST", headers: { "X-Idempotency-Key": row.idempotency_key }, body: form }, 60000);
      fileId = providerId(await uploaded.json().catch(() => null), ["fileId", "id", "file_id"]);
      if (!uploaded.ok || !fileId) throw new Error("provider_file_upload_failed");
      crmDb.prepare("UPDATE goods_purchase_documents SET provider_file_id=?,updated_at=? WHERE id=?").run(fileId, now(), row.id);
    }
    contractAttempted = true;
    const response = await emzameRequest("contracts/sendContract", { method: "POST", headers: { "content-type": "application/json", "X-Idempotency-Key": row.idempotency_key }, body: JSON.stringify({
      collaboratorList: [{ status: "checked", fullName: customer.name, nationalCode, phoneNumber: phone, order: 1 }],
      title: `${kind === "invoice" ? "فاکتور خرید کالا" : "اقرارنامه خرید کالا"} ${source.id} - ${customer.name}`,
      provider: process.env.EMZAME_PROVIDER || "gica", signType: process.env.EMZAME_SIGN_TYPE || "e-sign",
      isBlankPageRequired: false, isElectronicSignatureRequired: true, isSignatureDescriptionRequired: true,
      shouldEveryPageHaveSignatureImage: true, staticFileId: fileId, businessId: process.env.EMZAME_BUSINESS_ID,
    }) }, 60000);
    const body = await response.json();
    const contractId = providerId(body, ["contractId", "id", "contract_id"]);
    if (!response.ok || !contractId) throw new Error("provider_contract_send_failed");
    crmDb.prepare("UPDATE goods_purchase_documents SET provider_contract_id=?,provider_status='sent',status='sent',updated_at=? WHERE id=?").run(contractId, now(), row.id);
    return goodsDocumentState(source.id, kind);
  } catch (e) {
    crmDb.prepare("UPDATE goods_purchase_documents SET status=?,error=?,updated_at=? WHERE id=?").run(contractAttempted ? "delivery_unknown" : "generated", contractAttempted ? "provider_delivery_unknown" : (e instanceof Error ? e.message : "provider_delivery_failed"), now(), row.id);
    throw new Error(contractAttempted ? "provider_delivery_unknown" : e instanceof Error ? e.message : "provider_delivery_failed");
  }
}
export async function refreshGoodsDocument(purchaseId: number, kind: GoodsDocumentKind) {
  const row = latest(purchaseId, kind);
  if (!row?.provider_contract_id) throw new Error("document_not_sent");
  if (row.status === "signed") return publicState(row);
  const response = await emzameRequest(`contracts/${encodeURIComponent(row.provider_contract_id)}`);
  if (!response.ok) throw new Error("provider_status_failed");
  const state = providerContractState(await response.json());
  if (!state.status && !state.title && !state.signed) throw new Error("provider_status_failed");
  const rejected = /reject|declin|رد شده|ردشده|عدم پذیرش/i.test(`${state.status ?? ""} ${state.title ?? ""}`);
  crmDb.prepare("UPDATE goods_purchase_documents SET status=?,provider_status=?,error=NULL,updated_at=? WHERE id=? AND status<>'signed'").run(state.signed ? "signed" : rejected ? "rejected" : "sent", state.status ?? state.title, now(), row.id);
  return goodsDocumentState(purchaseId, kind);
}
export async function queryGoodsDocumentSignatureStatus(purchaseId: number, kind: GoodsDocumentKind) {
  const row = latest(purchaseId, kind);
  if (!row?.provider_contract_id) throw new Error("document_not_sent");
  const response = await emzameRequest(`contracts/${encodeURIComponent(row.provider_contract_id)}`);
  if (!response.ok) throw new Error("provider_status_failed");
  const state = providerContractState(await response.json().catch(() => ({})));
  if (!state.status && !state.title && !state.signed) throw new Error("provider_status_failed");
  const rejected = /reject|declin|رد شده|ردشده|عدم پذیرش/i.test(`${state.status ?? ""} ${state.title ?? ""}`);
  return {
    id: Number(row.id),
    kind,
    version: Number(row.version),
    signed: state.signed,
    status: state.signed ? "signed" : rejected ? "rejected" : "sent",
    providerStatus: state.status ?? state.title ?? (state.signed ? "signed" : null),
    checkedAt: now(),
    readOnly: true as const,
  };
}
export function goodsDocumentRequirements(source: GoodsDocumentSource, kind: GoodsDocumentKind) {
  if (kind === "invoice") return { manualFields: [] };
  const template = queryRow<any>("SELECT mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL", [source.acknowledgementTemplateId ?? 0]);
  if (!template) throw new Error("acknowledgement_template_required");
  const mappings: any[] = JSON.parse(template.mappings_json || "[]");
  return { manualFields: mappings.filter(m => (m.sourceType ?? (m.customerField ? "customer" : m.loanPlanField ? "loanPlan" : "manual")) === "manual").map(m => ({ variable: m.variable, label: m.label || m.variable })) };
}