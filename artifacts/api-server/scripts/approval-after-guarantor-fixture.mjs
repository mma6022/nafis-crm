import assert from "node:assert/strict";
import { createHmac, createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import PizZip from "pizzip";
import { checkCreditRankRegistration } from "./credit-rank-registration-checks.mjs";

// All fixture rows, identity files, PDFs, and sessions are synthetic and live
// under this disposable directory. This script never opens attached_assets.
const temp = await mkdtemp(path.join(os.tmpdir(), "crm-approval-after-guarantor-"));
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(temp, "fixture.sqlite");
const bundle = path.join(temp, "fixture-worker.mjs");
const certificateUnavailableMarker = path.join(temp, "certificate-unavailable");
const providerStatusFile = path.join(temp, "provider-status");
const providerSendLog = path.join(temp, "provider-send-log");
const contractsDir = path.join(temp, "contracts");
const templateDir = path.join(contractsDir, "templates");
const generationsDir = path.join(contractsDir, "generations");
const secret = randomBytes(32).toString("hex");
const timestamp = new Date().toISOString();
const identityTypes = ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"];
let child;
let db;

function suppressBackgroundSignatureScheduler(source) {
  const start = source.indexOf("const signatureSyncStartup = setTimeout(");
  const endMarker = "signatureSyncInterval.unref();";
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "fixture can isolate the production signature refresh scheduler");
  return `${source.slice(0, start)}// Background reconciliation timers are disabled only in this isolated harness;\n// guarded refresh remains explicitly exercised through the fixture bridge.\n${source.slice(end + endMarker.length)}`;
}

function schema() {
  return `
    PRAGMA foreign_keys=ON;
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE users(
      id INTEGER PRIMARY KEY,username TEXT NOT NULL,full_name TEXT,mobile TEXT,telegram_id TEXT,
      priority_colors TEXT,role TEXT NOT NULL,salesperson_id INTEGER,active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE customers(
      id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT NOT NULL,national_code TEXT,
      birth_date_jalali TEXT,postal_code TEXT,father_name TEXT,verification_status TEXT,
      verification_checked_at TEXT,identity_changed_at TEXT,verification_version INTEGER DEFAULT 0,
      salesperson_id INTEGER,merged_into_customer_id INTEGER,created_at TEXT NOT NULL,status TEXT,
      credit_score REAL,credit_rank TEXT,credit_checked_at TEXT,first_name TEXT,last_name TEXT,address TEXT,
      official_first_name TEXT,official_last_name TEXT,official_father_name TEXT,official_address TEXT,
      official_postal_code TEXT,shahkar_ok INTEGER,person_info_ok INTEGER,postal_code_info_ok INTEGER,
      sana_ok INTEGER,is_urgent INTEGER DEFAULT 0
    );
    CREATE TABLE customer_merge_audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT,source_customer_id INTEGER NOT NULL,survivor_customer_id INTEGER NOT NULL
    );
    CREATE TABLE auth_sessions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT NOT NULL UNIQUE,user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE customer_portal_sessions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT NOT NULL UNIQUE,mobile TEXT NOT NULL,
      customer_id INTEGER,expires_at TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE app_roles(
      slug TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,customer_scope TEXT NOT NULL DEFAULT 'all',
      is_system INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL
    );
    CREATE TABLE role_permissions(role_slug TEXT NOT NULL,permission TEXT NOT NULL,PRIMARY KEY(role_slug,permission));
    CREATE TABLE consultation_forms(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,requested_amount TEXT,
      extra_notes TEXT,updated_at TEXT NOT NULL
    );
    CREATE TABLE contract_templates(
      id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,original_filename TEXT,storage_path TEXT,
      sha256 TEXT,variables_json TEXT,mappings_json TEXT,deleted_at TEXT,created_by INTEGER,
      created_at TEXT,updated_at TEXT
    );
    CREATE TABLE contract_template_analyses(
      id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT,user_id INTEGER,staged_path TEXT,
      original_filename TEXT,variables_json TEXT,expires_at TEXT,created_at TEXT,consumed_at TEXT
    );
    CREATE TABLE loan_plans(
      id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,contract_template_id INTEGER,
      primary_contract_template_id INTEGER,principal_amount TEXT,installment_terms TEXT,
      filing_fee_toman TEXT,required_documents TEXT,description TEXT,min_principal TEXT,terms TEXT,
      bank_name TEXT,platform_name TEXT,annual_interest TEXT,installments TEXT,deposit_percents TEXT,
      customer_jobs TEXT,needs_guarantor INTEGER,notes TEXT,deduct_percents TEXT
    );
    CREATE TABLE loan_plan_conditions(
      id INTEGER PRIMARY KEY,plan_id INTEGER NOT NULL,name TEXT,description TEXT,min_principal TEXT,
      max_principal TEXT,installment_options TEXT,customer_ranks TEXT,sort_order INTEGER DEFAULT 0,
      customer_jobs TEXT,collateral_type TEXT,needs_guarantor INTEGER,guarantor_ranks TEXT,
      guarantor_jobs TEXT,notes TEXT
    );
    CREATE TABLE customer_identity_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,document_type TEXT NOT NULL,
      storage_path TEXT,original_name TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,
      created_by_user_id INTEGER,created_by_customer_id INTEGER,created_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,is_latest INTEGER NOT NULL DEFAULT 1,approved_at TEXT,
      approved_by_user_id INTEGER,review_reason TEXT
    );
    CREATE TABLE customer_credit_checks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,requested_by_user_id INTEGER,
      requested_by_customer_id INTEGER,provider TEXT NOT NULL DEFAULT 'fixture',national_code TEXT NOT NULL,
      provider_reference TEXT,provider_status TEXT,status TEXT NOT NULL,score REAL,score_label TEXT,
      summary TEXT,error_message TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT
    );
    CREATE TABLE loan_filing_fee_charges(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,plan_id INTEGER NOT NULL,
      amount_toman TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,application_id INTEGER,
      actor_user_id INTEGER,actor_customer_id INTEGER,created_at TEXT NOT NULL
    );
    CREATE TABLE loan_applications(
      id INTEGER PRIMARY KEY AUTOINCREMENT,consultation_id INTEGER,customer_id INTEGER NOT NULL,
      requested_by_user_id INTEGER,requested_by_customer_id INTEGER,plan_ids TEXT,plan_id INTEGER,
      requested_amount TEXT,status TEXT,stage TEXT,is_pre_registration INTEGER DEFAULT 0,
      condition_snapshot_json TEXT,plan_snapshot_json TEXT,duration_months INTEGER,requested_duration_months INTEGER,
      document_requirements_snapshot_json TEXT,primary_manual_values_json TEXT,notes TEXT,
      salesperson_id_snapshot INTEGER,salesperson_name_snapshot TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,
      initial_approval_at TEXT,initial_approval_by_user_id INTEGER,initial_approval_reason TEXT,
      current_primary_generation_id INTEGER,approved_amount TEXT,net_amount TEXT,approved_amount_source TEXT,
      approved_amount_generation_id INTEGER,approved_amount_reconciled_at TEXT,
      approved_amount_reconciled_by_user_id INTEGER,funder_decision TEXT,funder_reason TEXT,
      expert_reviewed_at TEXT,admin_approved_at TEXT,legacy_reopen_prior_stage TEXT,new_case_workflow INTEGER DEFAULT 0,
      initial_contract_retained INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE loan_application_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,requirement_key TEXT,label TEXT,
      source TEXT,status TEXT DEFAULT 'pending',incomplete_reason TEXT,storage_path TEXT,original_name TEXT,
      mime_type TEXT,size_bytes INTEGER,created_by_customer_id INTEGER,created_at TEXT NOT NULL,reviewed_at TEXT
    );
    CREATE TABLE loan_application_guarantors(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL UNIQUE,full_name TEXT NOT NULL,
      national_code TEXT,mobile TEXT,data_json TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE loan_application_guarantor_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,guarantor_id INTEGER NOT NULL,requirement_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',storage_path TEXT,original_name TEXT,mime_type TEXT,
      size_bytes INTEGER,created_at TEXT NOT NULL,rejection_reason TEXT
    );
    CREATE TABLE loan_application_collateral(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,collateral_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',data_json TEXT,storage_path TEXT,created_at TEXT NOT NULL,
      reviewed_at TEXT
    );
    CREATE TABLE contract_generations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,template_id INTEGER NOT NULL,customer_id INTEGER NOT NULL,
      loan_plan_id INTEGER,loan_application_id INTEGER,generation_purpose TEXT DEFAULT 'primary',
      mappings_snapshot_json TEXT,contract_number TEXT,docx_path TEXT,pdf_path TEXT,
      docx_sha256 TEXT,pdf_sha256 TEXT,manual_values_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL,
      provider_file_id TEXT,provider_contract_id TEXT,provider_status TEXT,error_message TEXT,superseded_at TEXT,
      provider_idempotency_key TEXT,send_claim_id TEXT,send_claim_expires_at TEXT,
       deleted_at TEXT,created_by INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,sent_at TEXT
    );
    CREATE TABLE loan_application_generated_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,kind TEXT NOT NULL,
      contract_generation_id INTEGER,link TEXT,status TEXT,review_reason TEXT,created_at TEXT,
      reviewed_at TEXT,reviewed_by_user_id INTEGER
    );
    CREATE TABLE contract_generation_rejected_deliveries(
      id INTEGER PRIMARY KEY AUTOINCREMENT,generation_id INTEGER NOT NULL,
      provider_contract_id TEXT NOT NULL,provider_file_id TEXT,provider_status TEXT NOT NULL,sent_at TEXT,
      recorded_by INTEGER NOT NULL,recorded_at TEXT NOT NULL,UNIQUE(generation_id,provider_contract_id)
    );
    CREATE TABLE loan_application_stage_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,from_stage TEXT,to_stage TEXT NOT NULL,
      action TEXT NOT NULL,reason TEXT,actor_id INTEGER,actor_customer_id INTEGER,created_at TEXT NOT NULL
    );
    CREATE TABLE loan_physical_checks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,source TEXT NOT NULL,
      source_id INTEGER NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reason TEXT
    );
    CREATE TABLE loan_physical_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,storage_path TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,
      uploaded_by_user_id INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    CREATE INDEX idx_loan_physical_documents_app ON loan_physical_documents(application_id);
    CREATE TABLE loan_funder_defects(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,source TEXT NOT NULL,
      source_id INTEGER NOT NULL,reason TEXT NOT NULL,resolved_at TEXT
    );
    CREATE TABLE consult_options(field_key TEXT,option_value TEXT,label_fa TEXT);
    CREATE TABLE wallet_accounts_v2(id INTEGER PRIMARY KEY,customer_id INTEGER,wallet_type TEXT,balance TEXT);
    CREATE TABLE wallet_ledger_v2(
      id INTEGER PRIMARY KEY AUTOINCREMENT,wallet_id INTEGER,application_id INTEGER,amount TEXT,kind TEXT,
      idempotency_key TEXT UNIQUE,actor_user_id INTEGER,created_at TEXT
    );
  `;
}

const dbModule = `
  import { DatabaseSync } from "node:sqlite";
  import path from "node:path";
  export const databasePath=path.resolve(process.env.CRM_DATABASE_PATH);
  export const crmDb=new DatabaseSync(databasePath);
  crmDb.exec("PRAGMA foreign_keys=ON");
  export const queryRow=(sql,params=[])=>crmDb.prepare(sql).get(...params);
  export const queryRows=(sql,params=[])=>crmDb.prepare(sql).all(...params);
  export const execute=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
  export const executeChanges=(sql,params=[])=>crmDb.prepare(sql).run(...params).changes;
  export const runTransaction=fn=>{crmDb.exec("BEGIN");try{const value=fn();crmDb.exec("COMMIT");return value}catch(error){crmDb.exec("ROLLBACK");throw error}};
  export const runImmediateTransaction=fn=>{crmDb.exec("BEGIN IMMEDIATE");try{const value=fn();crmDb.exec("COMMIT");return value}catch(error){crmDb.exec("ROLLBACK");throw error}};
`;

function tokenHash(token, prefix = "") {
  return createHmac("sha256", secret).update(`${prefix}${token}`).digest("hex");
}

function makePdfContent(content) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function makePdf(text) {
  const lines = text.split("\n").map((line, index) => {
    const escaped = line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    return `${index ? "0 -20 Td " : ""}(${escaped}) Tj`;
  }).join(" ");
  return makePdfContent(`BT /F1 14 Tf 72 720 Td ${lines} ET`);
}

function makePdfWithActualText(text) {
  const utf16be = Buffer.from(text, "utf16le").swap16().toString("hex").toUpperCase();
  return makePdfContent(`/Span << /ActualText <FEFF${utf16be}> >> BDC\nBT /F1 14 Tf 72 720 Td () Tj ET\nEMC`);
}

function makeDocx(paragraphs) {
  const zip = new PizZip();
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

try {
  db = new DatabaseSync(databasePath);
  db.exec(schema());
  await mkdir(templateDir, { recursive: true, mode: 0o700 });
  await mkdir(generationsDir, { recursive: true, mode: 0o700 });
  const textHelperBundle = path.join(temp, "contract-evidence-text-fixture.mjs");
  await build({
    entryPoints: [path.join(apiRoot, "src/lib/contract-evidence.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: textHelperBundle,
    logLevel: "silent",
  });
  const { renderedPdfContainsPrincipal, textContainsUnambiguousPrincipal } = await import(pathToFileURL(textHelperBundle).href);
  assert.equal(
    textContainsUnambiguousPrincipal("Loan principal: 9,000; incidental fee example: 10,000.", "10000"),
    false,
    "expected incidental fee/example amount cannot override a contradictory principal clause",
  );
  assert.equal(
    textContainsUnambiguousPrincipal("Loan principal: 10,000; fee: 4,000.", "10000"),
    true,
    "explicit correct principal label is accepted despite a separate fee amount",
  );
  assert.equal(
    textContainsUnambiguousPrincipal("Example loan amount: 10,000.", "10000"),
    false,
    "example-only evidence is not a principal assertion",
  );
  assert.equal(
    textContainsUnambiguousPrincipal("Loan principal: 10,000. Principal loan amount: 9,000.", "10000"),
    false,
    "conflicting principal clauses are ambiguous",
  );
  assert.equal(
    textContainsUnambiguousPrincipal("می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود.", "10000"),
    false,
    "generic anchored template text is not accepted by the legacy-label-only fallback",
  );
  assert.equal(
    textContainsUnambiguousPrincipal("می‌شود مبلغ اعتبار 9,000 تومان به مشتری پرداخت شود؛ کارمزد نمونه 10,000 تومان.", "10000"),
    false,
    "wrong generic anchored amount cannot be rescued by the incidental expected amount",
  );
  assert.equal(
    textContainsUnambiguousPrincipal("می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود؛ می‌شود مبلغ اعتبار 9,000 تومان به مشتری پرداخت شود.", "10000"),
    false,
    "conflicting generic anchored clauses are not accepted by the legacy-label-only fallback",
  );

  // Construct a fully synthetic template/rendered-DOCX/PDF evidence tuple.
  // Template 6's attested source hash is deliberately not recreated here: doing
  // so would require the production template bytes or weakening its SHA gate.
  const sourceParagraph = "می‌شود مبلغ اعتبار %principal% تومان به مشتری پرداخت شود";
  const sourceDocx = makeDocx([sourceParagraph]);
  const sourceHash = createHash("sha256").update(sourceDocx).digest("hex");
  const attestedTemplateHash = "9bf1cd5c8415e4c85910d22f38a30d3578ba8d57bcec702704f6966ebd5b5e7e";
  const syntheticPrincipalMappings = [{ variable: "principal", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" }];
  const writeEvidence = async (extension, bytes, root = generationsDir) => {
    const filePath = path.join(root, `${randomUUID()}.${extension}`);
    await writeFile(filePath, bytes);
    return filePath;
  };
  const evidenceFor = async ({ renderedParagraphs, pdfText, templateBytes = sourceDocx, templateHash = sourceHash,
    renderedBytes = makeDocx(renderedParagraphs), pdfBytes = makePdfWithActualText(pdfText), templateId = 6 } = {}) => {
    const templatePath = await writeEvidence("docx", templateBytes, templateDir);
    const renderedDocxPath = await writeEvidence("docx", renderedBytes);
    const pdfPath = await writeEvidence("pdf", pdfBytes);
    return {
      pdfPath,
      evidence: {
        templateId,
        templatePath,
        templateRoot: templateDir,
        storedTemplateSha256: templateHash,
        mappings: syntheticPrincipalMappings,
        renderedDocxPath,
        renderedDocxRoot: generationsDir,
        renderedDocxSha256: createHash("sha256").update(renderedBytes).digest("hex"),
        renderedValues: { principal: "10000" },
        renderedPdfRoot: generationsDir,
        renderedPdfSha256: createHash("sha256").update(pdfBytes).digest("hex"),
      },
    };
  };
  const syntheticAnchoredCorrect = await evidenceFor({
    renderedParagraphs: ["می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود"],
    pdfText: "می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود",
  });
  assert.equal(
    renderedPdfContainsPrincipal(syntheticAnchoredCorrect.pdfPath, "10000", syntheticAnchoredCorrect.evidence),
    false,
    "a matching synthetic anchor cannot substitute for the exact attested template source hash",
  );
  const syntheticAnchoredWrongWithIncidentalAmount = await evidenceFor({
    renderedParagraphs: ["می‌شود مبلغ اعتبار 9,000 تومان به مشتری پرداخت شود؛ کارمزد نمونه 10,000 تومان"],
    pdfText: "می‌شود مبلغ اعتبار 9,000 تومان به مشتری پرداخت شود؛ کارمزد نمونه 10,000 تومان",
  });
  assert.equal(
    renderedPdfContainsPrincipal(syntheticAnchoredWrongWithIncidentalAmount.pdfPath, "10000", syntheticAnchoredWrongWithIncidentalAmount.evidence),
    false,
    "wrong anchored amount plus incidental expected amount is rejected for synthetic source bytes",
  );
  const syntheticAnchoredConflict = await evidenceFor({
    renderedParagraphs: [
      "می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود",
      "می‌شود مبلغ اعتبار 9,000 تومان به مشتری پرداخت شود",
    ],
    pdfText: "می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود؛ می‌شود مبلغ اعتبار 9,000 تومان به مشتری پرداخت شود",
  });
  assert.equal(
    renderedPdfContainsPrincipal(syntheticAnchoredConflict.pdfPath, "10000", syntheticAnchoredConflict.evidence),
    false,
    "duplicate/conflicting synthetic anchored clauses are rejected",
  );
  const syntheticUnsupportedHash = await evidenceFor({
    renderedParagraphs: ["می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود"],
    pdfText: "می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود",
    templateHash: attestedTemplateHash,
  });
  assert.equal(
    renderedPdfContainsPrincipal(syntheticUnsupportedHash.pdfPath, "10000", syntheticUnsupportedHash.evidence),
    false,
    "an attested hash claim cannot compensate for different synthetic source bytes",
  );
  const syntheticMissingDocx = await evidenceFor({
    renderedParagraphs: ["می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود"],
    pdfText: "می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود",
  });
  await rm(syntheticMissingDocx.evidence.renderedDocxPath);
  assert.equal(
    renderedPdfContainsPrincipal(syntheticMissingDocx.pdfPath, "10000", syntheticMissingDocx.evidence),
    false,
    "missing rendered DOCX cannot pass anchored evidence validation",
  );
  const syntheticCorruptDocx = await evidenceFor({
    renderedParagraphs: ["می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود"],
    pdfText: "می‌شود مبلغ اعتبار 10,000 تومان به مشتری پرداخت شود",
    renderedBytes: Buffer.from("synthetic corrupt DOCX"),
  });
  assert.equal(
    renderedPdfContainsPrincipal(syntheticCorruptDocx.pdfPath, "10000", syntheticCorruptDocx.evidence),
    false,
    "corrupt rendered DOCX cannot pass anchored evidence validation",
  );
  const salespersonId = Number(db.prepare("INSERT INTO salespersons(name) VALUES('Synthetic Sales')").run().lastInsertRowid);
  const staffId = Number(db.prepare(`INSERT INTO users(username,full_name,role,salesperson_id,active,created_at)
    VALUES('fixture-sales','Synthetic Sales Agent','salesperson',?,1,?)`).run(salespersonId, timestamp).lastInsertRowid);
  const registrarId = Number(db.prepare(`INSERT INTO users(username,full_name,role,active,created_at)
    VALUES('fixture-registrar','Synthetic Registrar','registrar',1,?)`).run(timestamp).lastInsertRowid);
  const adminId = Number(db.prepare(`INSERT INTO users(username,full_name,role,active,created_at)
    VALUES('fixture-admin','Synthetic Admin','admin',1,?)`).run(timestamp).lastInsertRowid);
  const customers = [];
  for (const [index, role] of ["staff", "portal", "guard"].entries()) {
    customers.push(Number(db.prepare(`INSERT INTO customers(name,phone,national_code,birth_date_jalali,postal_code,
      father_name,verification_status,verification_checked_at,salesperson_id,created_at,status,identity_changed_at)
      VALUES(?,?,?,?,?,?,'verified',?,?,?,'in_progress',NULL)`)
      .run(`Synthetic ${role} customer`, `0912000000${index + 1}`, `00000000${index + 1}0`,
        "1370/01/01", "1234567890", "Synthetic Parent", timestamp, salespersonId, timestamp).lastInsertRowid));
  }
  // Match the real portal's identity admission policy without bypassing it.
  db.prepare(`UPDATE customers SET first_name='Synthetic',last_name='Fixture',
    shahkar_ok=1,person_info_ok=1`).run();
  const mappings = [{ variable: "principal", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" }];
  const durationMappings = [...mappings, { variable: "installments", sourceType: "loanPlan", loanPlanField: "loanPlan.installments" }];
  const sourceTemplatePath = path.join(templateDir, `${randomUUID()}.docx`);
  const sourceTemplateBytes = makeDocx(["Loan principal: %principal%", "Number of installments: %installments%"]);
  await writeFile(sourceTemplatePath, sourceTemplateBytes);
  const templateId = Number(db.prepare(`INSERT INTO contract_templates
    (name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at)
    VALUES('Synthetic Loan Primary','fixture.docx',?,?, ?,?,?, ?,?)`)
    .run(sourceTemplatePath, createHash("sha256").update(sourceTemplateBytes).digest("hex"),
      JSON.stringify(["principal", "installments"]), JSON.stringify(durationMappings), adminId, timestamp, timestamp).lastInsertRowid);
  db.prepare(`INSERT INTO contract_templates
    (id,name,original_filename,mappings_json,created_by,created_at,updated_at)
    VALUES(4,'Synthetic legacy template 4','fixture-template-4.docx',?,?,?,?)`).run(
    JSON.stringify(durationMappings), adminId, timestamp, timestamp);
  const planId = Number(db.prepare(`INSERT INTO loan_plans
    (name,active,contract_template_id,principal_amount,installment_terms,filing_fee_toman,required_documents,deduct_percents)
    VALUES('Synthetic Plan',1,?,'50000','[12,24]','0','["income_proof"]','10')`)
    .run(templateId).lastInsertRowid);
  const conditionId = Number(db.prepare(`INSERT INTO loan_plan_conditions
    (plan_id,name,min_principal,max_principal,installment_options,customer_ranks,needs_guarantor)
    VALUES(?,'Synthetic guarantor condition','1','50000','[12,18]','["A"]',1)`).run(planId).lastInsertRowid);
  const makeSession = (userId) => {
    const token = randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
      .run(tokenHash(token), userId, new Date(Date.now() + 3600_000).toISOString(), timestamp);
    return `crm_session=${token}`;
  };
  const staffCookie = makeSession(staffId);
  const registrarCookie = makeSession(registrarId);
  const adminCookie = makeSession(adminId);
  const portalToken = randomBytes(24).toString("base64url");
  db.prepare(`INSERT INTO customer_portal_sessions(token_hash,mobile,customer_id,expires_at,created_at)
    VALUES(?,?,?,?,?)`).run(tokenHash(portalToken, "customer-portal-session:"), "09120000002", customers[1],
    new Date(Date.now() + 3600_000).toISOString(), timestamp);

  for (const customerId of customers) {
    for (const [index, type] of identityTypes.entries()) {
      const identityPath = path.join(temp, `identity-${customerId}-${index}.pdf`);
      await writeFile(identityPath, makePdf("Synthetic identity document"));
      db.prepare(`INSERT INTO customer_identity_documents
        (customer_id,document_type,storage_path,original_name,mime_type,size_bytes,sha256,created_at,version,is_latest,approved_at)
        VALUES(?,?,?,?,?,?,?,?,1,1,?)`).run(customerId, type, identityPath, `identity-${index}.pdf`, "application/pdf",
        20, `synthetic-${customerId}-${index}`, timestamp, timestamp);
    }
    db.prepare(`INSERT INTO customer_credit_checks
      (customer_id,national_code,status,score,score_label,created_at,updated_at,completed_at)
      VALUES(?,(SELECT national_code FROM customers WHERE id=?),'report_generated',800,'A',?,?,?)`)
      .run(customerId, customerId, timestamp, timestamp, timestamp);
  }
  for (const customerId of customers) {
    db.prepare(`INSERT INTO loan_filing_fee_charges
      (customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(?,?,'0',?,?)`)
      .run(customerId, planId, `fixture-fee-${customerId}`, timestamp);
  }
  db.prepare(`INSERT INTO loan_filing_fee_charges
    (customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(?,?,'0','fixture-fee-guard-repeat',?)`)
    .run(customers[2], planId, timestamp);
  // Legacy records keep the preapproval-first contract behavior without
  // changing production routes or real customer data.
  const legacyConsultation = Number(db.prepare(
    "INSERT INTO consultation_forms(customer_id,requested_amount,updated_at) VALUES(?,?,?)",
  ).run(customers[2], "10000", timestamp).lastInsertRowid);
  const legacyId = Number(db.prepare(`INSERT INTO loan_applications
    (consultation_id,customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,duration_months,
     requested_duration_months,stage,status,plan_snapshot_json,condition_snapshot_json,created_at,updated_at)
    VALUES(?,?,?,?,?,'10000',12,12,'funder_initial_approval','reviewing',?,?,?,?)`)
    .run(legacyConsultation, customers[2], staffId, JSON.stringify([planId]), planId,
      JSON.stringify({ id: planId, contract_template_id: templateId, principal_amount: "50000", deduct_percents: "10" }),
      JSON.stringify({ max_principal: "50000", installment_options: [12] }), timestamp, timestamp).lastInsertRowid);

  await build({
    stdin: {
      contents: `
        import express from "express";
        import cookieParser from "cookie-parser";
        import { existsSync,appendFileSync } from "node:fs";
        import portalLoans from "./src/routes/customer-portal-loans";
        import staffLoans,{refreshGeneratedDocumentSignature} from "./src/routes/loan-applications";
        import contractRoutes from "./src/routes/contracts";
        import { requireAuth } from "./src/lib/auth";
        import { requirePermission } from "./src/lib/access-control";
        const app=express();
        globalThis.fetch=async(input,init)=>{
          const url=String(input);
          if(url.includes("checkUserActiveCertificate"))
            return existsSync(process.env.FIXTURE_CERTIFICATE_UNAVAILABLE_MARKER)
              ? Response.json({error:"not_found"},{status:404}) : Response.json({active:true});
          if(new URL(url).pathname.endsWith("/files")) return Response.json({fileId:"fixture-provider-file"});
          if(new URL(url).pathname.endsWith("/contracts/sendContract")){
            appendFileSync(process.env.FIXTURE_PROVIDER_SEND_LOG,JSON.stringify({key:init?.headers?.["X-Idempotency-Key"]})+"\\n");
            return Response.json({contractId:"fixture-amendment-contract",status:"sent"});
          }
          throw Error("unexpected_fixture_provider_request");
        };
        app.use(express.json(),cookieParser());
        app.use((req,_res,next)=>{req.log={warn(){},error(){}};next()});
        app.get("/healthz",(_req,res)=>res.json({ok:true}));
        app.post("/__fixture/background-signature-refresh/:applicationId/:documentId",requireAuth,
          requirePermission("loan_applications.update"),async(req,res)=>{
          try {
             res.json(await refreshGeneratedDocumentSignature(Number(req.params.applicationId),Number(req.params.documentId)));
          } catch(error) {
            res.status(409).json({error:String(error?.message??error)});
          }
        });
        app.use("/api/customer-portal",portalLoans);
        app.use("/api",requireAuth,contractRoutes);
        app.use("/api",requireAuth,staffLoans);
        app.use((error,_req,res,_next)=>{process.stderr.write("FIXTURE_ERROR:"+String(error?.stack||error)+"\\n");res.status(500).json({fixtureError:String(error?.message||error)})});
        const server=app.listen(Number(process.env.PORT),"127.0.0.1",()=>process.stdout.write("FIXTURE_PORT:"+server.address().port+"\\n"));
        process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
      `,
      resolveDir: apiRoot,
      sourcefile: "approval-after-guarantor-worker.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` },
    plugins: [{
      name: "synthetic-approval-fixture",
      setup(context) {
        context.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "fixture-db", namespace: "approval-fixture" }));
        context.onLoad({ filter: /^fixture-db$/, namespace: "approval-fixture" }, () => ({ contents: dbModule, loader: "js" }));
        context.onLoad({ filter: /routes\/loan-applications\.ts$/ }, async (args) => ({
          contents: suppressBackgroundSignatureScheduler(await readFile(args.path, "utf8")),
          loader: "ts",
          resolveDir: path.dirname(args.path),
        }));
        context.onResolve({ filter: /\/wallets$/ }, () => ({ path: "fixture-wallets", namespace: "approval-fixture" }));
        context.onLoad({ filter: /^fixture-wallets$/, namespace: "approval-fixture" }, () => ({
          contents: `
            import {execute,queryRow} from "./src/lib/crm-db";
            export const ensureWalletSchema=()=>{};
            export const getWalletSummaryReadOnly=()=>({cash:{balanceToman:"0"},credit:{balanceToman:"0"}});
            export const wallet=${process.env.TEST_CREDIT_RANK_REGISTRATION === "1"
              ? `(customerId,type)=>queryRow("SELECT * FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type=?",[customerId,type])`
              : `()=>({id:1,balance:"0"})`};
            export const creditLoanWallet=(applicationId,customerId,amount,actorId)=>{
              const existing=queryRow("SELECT id FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit'",[customerId]);
              const walletId=existing?.id??execute("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance) VALUES(?,'credit','0')",[customerId]);
              execute("INSERT INTO wallet_ledger_v2(wallet_id,application_id,amount,kind,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,'credit',?,?,?)",
                [walletId,applicationId,amount,"loan-application:"+applicationId+":credit",actorId,new Date().toISOString()]);
            };
          `,
          loader: "js",
          resolveDir: apiRoot,
        }));
        context.onResolve({ filter: /\/emzame-client$/ }, () => ({ path: "fixture-emzame", namespace: "approval-fixture" }));
        context.onLoad({ filter: /^fixture-emzame$/, namespace: "approval-fixture" }, () => ({
          contents: `import{existsSync,readFileSync}from"node:fs";
            export const emzameRequest=async()=>Response.json({status:existsSync(process.env.FIXTURE_PROVIDER_STATUS_FILE)?readFileSync(process.env.FIXTURE_PROVIDER_STATUS_FILE,"utf8").trim():"signed"});
            export const emzameAuth=async()=>"fixture-provider-token";`,
          loader: "js",
        }));
        context.onResolve({ filter: /\/ics24$/ }, () => ({ path: "fixture-ics24", namespace: "approval-fixture" }));
        context.onLoad({ filter: /^fixture-ics24$/, namespace: "approval-fixture" }, () => ({
          contents: `
            export const normalizeDigits=v=>String(v??"").replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
            export const normalizeMobile=v=>String(v??"").replace(/\\D/g,"");
            export const validNationalCode=()=>true;
            export const initiate=async()=>{throw Error("provider_disabled")};
            export const status=async()=>{throw Error("provider_disabled")};
            export const report=async()=>{throw Error("provider_disabled")};
            export const validate=async()=>{throw Error("provider_disabled")};
            export const renew=async()=>{throw Error("provider_disabled")};
          `,
          loader: "js",
        }));
        context.onResolve({ filter: /\/customer-integrity$/ }, () => ({ path: "fixture-integrity", namespace: "approval-fixture" }));
        context.onLoad({ filter: /^fixture-integrity$/, namespace: "approval-fixture" }, () => ({
          contents: `
            export const isAdminRole=role=>role==="admin";
            export const normalizeCustomerMobile=v=>String(v??"").replace(/\\D/g,"");
            export const registerCustomerIdentityFunctions=()=>{};
            export const installCustomerIdentityGuards=()=>{};
          `,
          loader: "js",
        }));
      },
    }],
  });

  const port = 0;
  child = spawn(process.execPath, [bundle], {
    cwd: apiRoot,
    env: {
      ...process.env,
      CRM_DATABASE_PATH: databasePath,
      SESSION_SECRET: secret,
      PORT: String(port),
      CONTRACTS_STORAGE_DIR: contractsDir,
      NODE_ENV: "production",
      EMZAME_BASE_URL: "http://fixture-provider.invalid/api/v1",
      EMZAME_BUSINESS_ID: "fixture-business",
      FIXTURE_CERTIFICATE_UNAVAILABLE_MARKER: certificateUnavailableMarker,
      FIXTURE_PROVIDER_STATUS_FILE: providerStatusFile,
      FIXTURE_PROVIDER_SEND_LOG: providerSendLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  let origin;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`fixture API exited during startup:\n${logs}`);
    const match = logs.match(/FIXTURE_PORT:(\d+)/);
    if (match) {
      origin = `http://127.0.0.1:${match[1]}`;
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `fixture API failed to start:\n${logs}`);
  const request = (route, cookie, body, method = "POST", extraHeaders = {}) => new Promise((resolve, reject) => {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders };
    let payload;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      payload = Buffer.from(JSON.stringify(body));
      headers["Content-Type"] ??= "application/json";
    } else if (Buffer.isBuffer(body)) payload = body;
    if (payload) headers["Content-Length"] = String(payload.length);
    const outgoing = httpRequest(new URL(route, origin), { method, headers, agent: false }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: incoming.statusCode, json: async () => text ? JSON.parse(text) : {} });
      });
    });
    outgoing.on("error", async (error) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      reject(new Error(
        `fixture request failed for ${route}; child exit=${child.exitCode}, signal=${child.signalCode}\n${logs.slice(-4000)}\n${error}`,
      ));
    });
    outgoing.end(payload);
  });
  const expect = async (response, status, label) => {
    const result = await response;
    const body = await result.json().catch(() => ({}));
    assert.equal(result.status, status, `${label}: ${JSON.stringify(body)}${result.status === 500 ? `\n${logs.slice(-2500)}` : ""}`);
    return body;
  };
  const inspect = (sql, ...params) => db.prepare(sql).get(...params);
  const staffCreate = async (customerId, feeChargeId) => expect(request("/api/loan-applications", staffCookie, {
    customerId, planId, conditionId, feeChargeId, requestedAmount: "10000", durationMonths: 12, manualValues: {},
  }), 201, "staff application is created as an editable draft");
  const portalCreate = async (feeChargeId) => expect(request("/api/customer-portal/applications", `customer_portal_session=${portalToken}`, {
    planId, conditionId, feeChargeId, requestedAmount: "10000", durationMonths: 12,
  }), 201, "customer application is created as an editable draft");
  const createPrimaryGeneration = async (applicationId, amount, renderedAmount = amount, pdfMode = "valid", installments = null) => {
    const suffix = randomUUID();
    const pdfPath = path.join(generationsDir, `${suffix}.pdf`);
    const pdfText = installments != null && pdfMode === "valid"
      ? `${renderedAmount}\nNumber of installments: ${installments}` : renderedAmount;
    await writeFile(pdfPath, pdfMode === "invalid" ? Buffer.from("not a readable PDF") : makePdf(pdfText));
    const bytes = await readFile(pdfPath);
    const docxPath = installments == null ? "synthetic.docx" : path.join(generationsDir, `${suffix}.docx`);
    const docxBytes = installments == null ? null : makeDocx([
      `Loan principal: ${amount}`, `Number of installments: ${installments}`,
    ]);
    if (docxBytes) await writeFile(docxPath, docxBytes);
    const generationId = Number(db.prepare(`INSERT INTO contract_generations
      (template_id,customer_id,loan_plan_id,loan_application_id,mappings_snapshot_json,docx_path,pdf_path,
       docx_sha256,pdf_sha256,manual_values_json,status,provider_contract_id,provider_status,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'sent',?,'awaiting_signature',?,?,?)`).run(
      templateId, inspect("SELECT customer_id FROM loan_applications WHERE id=?", applicationId).customer_id,
       planId, applicationId, JSON.stringify(installments == null ? mappings : durationMappings), docxPath, pdfPath,
       docxBytes ? createHash("sha256").update(docxBytes).digest("hex") : "synthetic-docx",
       createHash("sha256").update(bytes).digest("hex"), JSON.stringify(installments == null
         ? { principal: amount } : { principal: amount, installments: String(installments) }),
      `fixture-contract-${suffix}`, staffId, timestamp, timestamp,
    ).lastInsertRowid);
    return generationId;
  };
  const createAmendmentGeneration = async (applicationId, amount) => {
    const suffix = randomUUID();
    const pdfPath = path.join(generationsDir, `${suffix}.pdf`);
    await writeFile(pdfPath, makePdf(`Loan principal: ${amount}`));
    const bytes = await readFile(pdfPath);
    return Number(db.prepare(`INSERT INTO contract_generations
      (template_id,customer_id,loan_plan_id,loan_application_id,generation_purpose,mappings_snapshot_json,
       docx_path,pdf_path,docx_sha256,pdf_sha256,manual_values_json,status,created_by,created_at,updated_at)
      VALUES(?,?,?,?, 'amendment', ?, ?, ?, ?, ?, ?, 'generated', ?, ?, ?)`).run(
      templateId, inspect("SELECT customer_id FROM loan_applications WHERE id=?", applicationId).customer_id,
      planId, applicationId, JSON.stringify(mappings), "synthetic-amendment.docx", pdfPath, "synthetic-docx",
      createHash("sha256").update(bytes).digest("hex"), JSON.stringify({ principal: amount }),
      staffId, timestamp, timestamp,
    ).lastInsertRowid);
  };
  const linkAndSubmitPrimary = async (applicationId, generationId) => {
    const linked = await expect(request(`/api/loan-applications/${applicationId}/generated-documents`, staffCookie, {
      kind: "primary", contractGenerationId: generationId,
    }), 201, "requested-principal primary generation links to the new case");
    const doc = await expect(request(`/api/loan-applications/${applicationId}/submit-primary-contract`, staffCookie, {}), 200,
      "draft submits the requested primary contract for signature");
    assert.equal(doc.stage, "primary_contract_pending_signature");
    return linked.id;
  };
  const verifySignature = async (applicationId, documentId, cookie = adminCookie) =>
    request(`/api/loan-applications/${applicationId}/generated-documents/${documentId}/verify-signature`, cookie, {});
  const guardedBackgroundSignatureRefresh = async (applicationId, documentId) =>
    request(`/__fixture/background-signature-refresh/${applicationId}/${documentId}`, staffCookie, {});
  // A plan edit can remove the condition selected in an already-open wizard.
  // Reject that stale selection without creating a case or consuming its fee.
  if (process.env.TEST_CREDIT_RANK_REGISTRATION === "1") {
    await checkCreditRankRegistration({db,request,expect,inspect,staffCookie,registrarCookie,adminCookie,customers,planId,conditionId,staffId});
  } else {
  const casesBeforeStaleAttempt = inspect("SELECT COUNT(*) AS count FROM loan_applications").count;
  const staleCondition = await expect(request("/api/loan-applications", staffCookie, {
    customerId: customers[0], planId, conditionId: conditionId + 1_000_000,
    feeChargeId: 1, requestedAmount: "10000", durationMonths: 12, manualValues: {},
  }), 422, "an obsolete condition must be rejected explicitly");
  assert.equal(staleCondition.code, "loan_plan_condition_not_found");
  assert.equal(inspect("SELECT COUNT(*) AS count FROM loan_applications").count, casesBeforeStaleAttempt);
  assert.equal(inspect("SELECT application_id FROM loan_filing_fee_charges WHERE id=1").application_id, null);
  const currentEligibility = await expect(request(`/api/customers/${customers[0]}/eligible-plans`, staffCookie, undefined, "GET"),
    200, "current conditions can be recovered without repaying");
  assert.ok(currentEligibility.plans.some(plan => plan.planId === planId && plan.conditionId === conditionId));
  const staffApp = await staffCreate(customers[0], 1);
  const retryStaffApp = await expect(request("/api/loan-applications", staffCookie, {
    customerId: customers[0], planId, conditionId, feeChargeId: 1,
    requestedAmount: "10000", durationMonths: 12, manualValues: {},
  }), 200, "retrying the same fee recovers the existing case");
  assert.equal(retryStaffApp.id, staffApp.id);
  assert.equal(inspect("SELECT COUNT(*) AS count FROM loan_applications").count, casesBeforeStaleAttempt + 1);
  const portalApp = await portalCreate(2);
  for (const application of [staffApp, portalApp]) {
    assert.equal(application.stage, "draft");
    const stored = inspect("SELECT stage,new_case_workflow,requested_amount FROM loan_applications WHERE id=?", application.id);
    assert.equal(stored.stage, "draft");
    assert.equal(Number(stored.new_case_workflow), 1);
    assert.equal(stored.requested_amount, "10000");
  }

  const staffPrimary = await createPrimaryGeneration(
    staffApp.id,
    "10000",
    "Loan principal: 10,000; fee example: 4,000",
  );
  const staffPrimaryDoc = await linkAndSubmitPrimary(staffApp.id, staffPrimary);
  // A matching template snapshot alone is not enough: the customer cannot
  // reach document submission until the provider reports a verified signature.
  await expect(request(`/api/loan-applications/${staffApp.id}/submit-customer-documents`, staffCookie, {}), 409,
    "documents cannot advance while the primary is unsigned");
  const primaryStateBeforeSalesInquiry = {
    application: inspect("SELECT stage,status FROM loan_applications WHERE id=?", staffApp.id),
    generation: inspect("SELECT status,provider_status,updated_at FROM contract_generations WHERE id=?", staffPrimary),
    document: inspect("SELECT status,link FROM loan_application_generated_documents WHERE id=?", staffPrimaryDoc),
  };
  const salesPrimaryInquiry = await expect(request(
    `/api/loan-applications/${staffApp.id}/generated-documents/${staffPrimaryDoc}/signature-status`,
    staffCookie, undefined, "GET",
  ), 200, "sales can query the current primary signature without changing the case");
  assert.equal(salesPrimaryInquiry.readOnly, true);
  assert.equal(salesPrimaryInquiry.signed, true);
  assert.deepEqual({
    application: inspect("SELECT stage,status FROM loan_applications WHERE id=?", staffApp.id),
    generation: inspect("SELECT status,provider_status,updated_at FROM contract_generations WHERE id=?", staffPrimary),
    document: inspect("SELECT status,link FROM loan_application_generated_documents WHERE id=?", staffPrimaryDoc),
  }, primaryStateBeforeSalesInquiry, "sales signature inquiry is read-only");
  await expect(request(`/api/loan-applications/${staffApp.id}/generated-documents/${staffPrimaryDoc}/verify-signature`, staffCookie, {}), 403,
    "sales cannot invoke the workflow-changing signature endpoint");
  const staffSignature = await expect(verifySignature(staffApp.id, staffPrimaryDoc), 200,
    "authorized signature check observes the local provider");
  assert.equal(staffSignature.signed, true);
  assert.equal(staffSignature.workflowAdvanced, true);
  assert.equal(staffSignature.nextStage, "customer_documents_upload");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", staffApp.id).stage,
    "customer_documents_upload", "a positive current-primary observation advances the case");
  assert.equal(inspect("SELECT link FROM loan_application_generated_documents WHERE id=?", staffPrimaryDoc).link,
    `signed:${inspect("SELECT provider_contract_id FROM contract_generations WHERE id=?", staffPrimary).provider_contract_id}`);
  const signatureHistory = inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=?", staffApp.id).count;
  await expect(guardedBackgroundSignatureRefresh(staffApp.id, staffPrimaryDoc), 200,
    "background signature refresh is idempotent after the manual signature transition");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", staffApp.id).stage, "customer_documents_upload");
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=?", staffApp.id).count,
    signatureHistory, "background refresh does not add a duplicate signature history record");
  assert.equal(inspect("SELECT manual_values_json FROM contract_generations WHERE id=?", staffPrimary)
    .manual_values_json, JSON.stringify({ principal: "10000" }), "first primary uses requested principal");
  // Simulate a legacy draft which already has the signed current generation to
  // exercise the customer-confirmation API through the same shared applier.
  db.prepare("UPDATE loan_applications SET stage='draft' WHERE id=?").run(staffApp.id);
  const confirmedSigned = await expect(request(`/api/loan-applications/${staffApp.id}/confirm-signed-primary`, staffCookie, {}), 200,
    "a previously signed current primary advances without generating another contract");
  assert.equal(confirmedSigned.stage, "customer_documents_upload");
  assert.equal(confirmedSigned.workflowAdvanced, true);
  assert.equal(confirmedSigned.nextStage, "customer_documents_upload");
  assert.equal(inspect("SELECT COUNT(*) count FROM contract_generations WHERE loan_application_id=?", staffApp.id).count, 1);
  await expect(request(`/api/loan-applications/${staffApp.id}/confirm-signed-primary`, staffCookie, {}), 403,
    "cannot re-confirm a case after it advanced");

  // Empty loan-specific lists must reach registration without fabricated
  // uploads or financial approval. Legacy identity/collateral placeholders
  // belong to their own sections and must not block this handoff.
  const originalRequirement = inspect("SELECT * FROM loan_application_documents WHERE application_id=?", staffApp.id);
  const originalSnapshot = inspect("SELECT plan_snapshot_json FROM loan_applications WHERE id=?", staffApp.id).plan_snapshot_json;
  const originalPdf = inspect("SELECT pdf_path FROM contract_generations WHERE id=?", staffPrimary).pdf_path;
  db.prepare("DELETE FROM loan_application_documents WHERE application_id=?").run(staffApp.id);
  db.prepare("UPDATE loan_applications SET plan_snapshot_json=? WHERE id=?")
    .run(JSON.stringify({ ...JSON.parse(originalSnapshot), required_documents: "[]" }), staffApp.id);
  db.prepare("UPDATE contract_generations SET pdf_path=NULL WHERE id=?").run(staffPrimary);
  for (const key of ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3",
    "national_card", "birth_certificate_all_pages", "guarantee_check", "guarantee_promissory"]) {
    db.prepare("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,created_at) VALUES(?,?,?,'plan',?)")
      .run(staffApp.id, key, "Synthetic separate-section placeholder", timestamp);
  }
  const emptyDetails = await expect(request(`/api/loan-applications/${staffApp.id}`, staffCookie, {}, "GET"), 200,
    "empty-plan details exclude legacy identity and collateral placeholders");
  assert.equal(emptyDetails.documents.length, 0);
  const emptyHandoff = await expect(request(`/api/loan-applications/${staffApp.id}/submit-customer-documents`, staffCookie, {}), 200,
    "an empty plan reaches registration using the current signature without financial PDF checks");
  assert.equal(emptyHandoff.stage, "customer_documents_review");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", staffApp.id).stage, "customer_documents_review");
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=? AND action='submit-customer-documents'", staffApp.id).count, 1);
  await expect(request(`/api/loan-applications/${staffApp.id}/review-customer-documents`, registrarCookie, {}), 409,
    "empty loan requirements do not bypass identity and contract review");
  await expect(request(`/api/loan-applications/${staffApp.id}/submit-customer-documents`, staffCookie, {}), 409,
    "a repeated empty handoff cannot create a second transition");
  db.prepare("UPDATE loan_applications SET stage='customer_documents_upload' WHERE id=?").run(staffApp.id);
  const nullKeyDocument = Number(db.prepare(
    "INSERT INTO loan_application_documents(application_id,requirement_key,label,source,created_at) VALUES(?,NULL,?,'manual',?)",
  ).run(staffApp.id, "Synthetic real manual requirement", timestamp).lastInsertRowid);
  const manualDetails = await expect(request(`/api/loan-applications/${staffApp.id}`, staffCookie, {}, "GET"), 200,
    "manual requirements with null keys remain visible");
  assert.equal(manualDetails.documents.length, 1);
  assert.equal(manualDetails.documents[0].id, nullKeyDocument);
  await expect(request(`/api/loan-applications/${staffApp.id}/submit-customer-documents`, staffCookie, {}), 409,
    "an actual missing manual upload still blocks handoff");
  db.prepare("DELETE FROM loan_application_documents WHERE application_id=?").run(staffApp.id);
  db.prepare("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,created_at) VALUES(?,?,?,?,?)")
    .run(staffApp.id, originalRequirement.requirement_key, originalRequirement.label, originalRequirement.source, originalRequirement.created_at);
  db.prepare("UPDATE loan_applications SET plan_snapshot_json=? WHERE id=?").run(originalSnapshot, staffApp.id);
  db.prepare("UPDATE contract_generations SET pdf_path=? WHERE id=?").run(originalPdf, staffPrimary);

  const upload = async (applicationId) => {
    const boundary = `fixture-${randomBytes(8).toString("hex")}`;
    const file = Buffer.from("synthetic staff document");
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="requirementKey"\r\n\r\nincome_proof\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="income-proof.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await request(`/api/loan-applications/${applicationId}/documents`, staffCookie, body, "POST", {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });
    return expect(response, 201, "staff uploads a synthetic required document");
  };
  const prepareForProviderApproval = async (application, primaryDoc) => {
    const applicationId = application.id;
    const uploaded = await upload(applicationId);
    await expect(request(`/api/loan-applications/${applicationId}/submit-customer-documents`, staffCookie, {}), 200,
      "staff submits documents for review after signature");
    await expect(request(`/api/loan-applications/${applicationId}/documents/${uploaded.id}/review`, registrarCookie,
      { decision: "approved" }), 200, "registrar approves the uploaded staff document");
    await expect(request(`/api/loan-applications/${applicationId}/generated-documents/${primaryDoc}/review`,
      registrarCookie, { decision: "approved" }), 200, "registrar approves the signed primary");
    assert.equal(inspect("SELECT status FROM loan_application_documents WHERE application_id=?", applicationId).status,
      "approved", "required synthetic document review is persisted");
    assert.equal(inspect("SELECT status FROM loan_application_generated_documents WHERE id=?", primaryDoc).status,
      "approved", "primary contract review is persisted");
    const reviewedDocs = inspect(`SELECT COUNT(*) total,SUM(status='approved') approved
      FROM loan_application_documents WHERE application_id=? AND source IN ('plan','manual')
        AND (requirement_key IS NULL OR requirement_key NOT IN ('guarantee_check','guarantee_promissory'))`, applicationId);
    assert.equal(Number(reviewedDocs.approved), Number(reviewedDocs.total), `all required docs reviewed: ${JSON.stringify(reviewedDocs)}`);
    await expect(request(`/api/loan-applications/${applicationId}/review-customer-documents`, registrarCookie, {}), 200,
      "registrar advances complete documents to guarantor registration");
    assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", applicationId).stage, "guarantor_registration");
    await expect(request(`/api/loan-applications/${applicationId}/guarantor`, staffCookie, {
      fullName: "Synthetic Guarantor", nationalCode: "0012345678", mobile: "09120000123",
    }), 201, "staff registers the synthetic guarantor");
    assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", applicationId).stage, "funder_initial_approval");
  };
  await prepareForProviderApproval(staffApp, staffPrimaryDoc);
  const signaturesBeforeSameAmountApproval = inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=? AND action='primary_signature_verified'", staffApp.id).count;
  const sameAmount = await expect(request(`/api/loan-applications/${staffApp.id}/funder-initial-approve`, registrarCookie, {
    approvedAmount: "10000", approvedDurationMonths: 12, reason: "Synthetic provider approval",
  }), 200, "same approved principal reuses verified requested primary");
  assert.equal(sameAmount.stage, "guarantor_documents_upload");
  assert.equal(Number(sameAmount.currentPrimaryGenerationId), staffPrimary);
  assert.equal(Number(sameAmount.approvedAmountGenerationId), staffPrimary);
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_application_generated_documents WHERE application_id=? AND kind='primary'", staffApp.id).count, 1);
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=? AND action='primary_signature_verified'", staffApp.id).count, signaturesBeforeSameAmountApproval);

  // Keep the already-signed primary current while exercising actual amendment
  // delivery against the local-only provider mock.
  db.prepare("UPDATE customers SET national_code='0013546789',phone='09121234567' WHERE id=?").run(customers[0]);
  db.prepare("UPDATE loan_applications SET stage='funder_amendment_pending_signature' WHERE id=?").run(staffApp.id);
  const amendmentGeneration = await createAmendmentGeneration(staffApp.id, "10000");
  const sentAmendment = await expect(request(`/api/contracts/generations/${amendmentGeneration}/send`, staffCookie, {}),
    200, "amendment generation is sent while its signed primary remains current");
  assert.equal(sentAmendment.status, "sent");
  assert.equal(sentAmendment.providerContractId, "fixture-amendment-contract");
  assert.equal(inspect("SELECT status FROM contract_generations WHERE id=?", amendmentGeneration).status, "sent");
  assert.equal(Number(inspect("SELECT current_primary_generation_id FROM loan_applications WHERE id=?", staffApp.id)
    .current_primary_generation_id), staffPrimary, "sending an amendment preserves the current signed primary");
  const amendmentDocumentId = Number(db.prepare(`INSERT INTO loan_application_generated_documents
    (application_id,kind,contract_generation_id,created_at) VALUES(?,'amendment',?,?)`)
    .run(staffApp.id, amendmentGeneration, timestamp).lastInsertRowid);
  const amendmentStageBeforeManualCheck = inspect("SELECT stage FROM loan_applications WHERE id=?", staffApp.id).stage;
  const amendmentFinancialBeforeManualCheck = inspect(`SELECT requested_amount,approved_amount,net_amount,duration_months,
    current_primary_generation_id,approved_amount_generation_id,approved_amount_reconciled_at,
    approved_amount_reconciled_by_user_id FROM loan_applications WHERE id=?`, staffApp.id);
  const amendmentHistoryBeforeManualCheck = inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=?", staffApp.id).count;
  const amendmentLinkBeforeManualCheck = inspect("SELECT link FROM loan_application_generated_documents WHERE id=?", amendmentDocumentId).link;
  const amendmentGenerationBeforeSalesInquiry = inspect("SELECT status,provider_status,updated_at FROM contract_generations WHERE id=?", amendmentGeneration);
  const salesAmendmentInquiry = await expect(request(`/api/contracts/generations/${amendmentGeneration}/check-status`, staffCookie, undefined, "GET"), 200,
    "sales can query the current amendment signature without changing the case");
  assert.equal(salesAmendmentInquiry.readOnly, true);
  assert.equal(salesAmendmentInquiry.signed, true);
  assert.deepEqual(inspect("SELECT status,provider_status,updated_at FROM contract_generations WHERE id=?", amendmentGeneration),
    amendmentGenerationBeforeSalesInquiry, "Contracts-page read-only inquiry does not persist provider status");
  await expect(request(`/api/contracts/generations/${amendmentGeneration}/check-status`, staffCookie, {}), 403,
    "sales cannot use the workflow-changing Contracts-page check");
  const amendmentStatusCheck = await expect(request(`/api/contracts/generations/${amendmentGeneration}/check-status`, adminCookie, {}), 200,
    "authorized Contracts-page status check applies the positive linked signature");
  assert.equal(amendmentStatusCheck.signed, true);
  assert.equal(amendmentStatusCheck.workflowAdvanced, true);
  assert.equal(amendmentStatusCheck.nextStage, "funder_amendment_review");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", staffApp.id).stage, "funder_amendment_review",
    "Contracts-page status check advances the signed amendment");
  assert.notEqual(inspect("SELECT link FROM loan_application_generated_documents WHERE id=?", amendmentDocumentId).link,
    amendmentLinkBeforeManualCheck, "Contracts-page status check writes the signed-document link");
  assert.deepEqual(inspect(`SELECT requested_amount,approved_amount,net_amount,duration_months,
    current_primary_generation_id,approved_amount_generation_id,approved_amount_reconciled_at,
    approved_amount_reconciled_by_user_id FROM loan_applications WHERE id=?`, staffApp.id), amendmentFinancialBeforeManualCheck,
  "Contracts-page status check must not change financial fields");
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=?", staffApp.id).count,
    amendmentHistoryBeforeManualCheck + 1, "Contracts-page signature transition writes one history record");
  assert.equal(inspect("SELECT status FROM contract_generations WHERE id=?", amendmentGeneration).status, "signed",
    "Contracts-page provider observation persists signed state on the generation");
  const repeatedAmendmentStatus = await expect(request(`/api/contracts/generations/${amendmentGeneration}/check-status`, adminCookie, {}), 200,
    "repeated Contracts-page check is idempotent");
  assert.equal(repeatedAmendmentStatus.workflowAdvanced, false);
  assert.equal(repeatedAmendmentStatus.nextStage, null);
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", staffApp.id).stage, "funder_amendment_review");
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=?", staffApp.id).count,
    amendmentHistoryBeforeManualCheck + 1, "repeated status check cannot duplicate signature history");
  assert.equal(String(inspect("SELECT link FROM loan_application_generated_documents WHERE id=?", amendmentDocumentId).link).startsWith("signed:"), true);

  const portalPrimary = await createPrimaryGeneration(portalApp.id, "10000", "Loan principal: 10,000");
  const portalPrimaryDoc = await linkAndSubmitPrimary(portalApp.id, portalPrimary);
  const portalSignature = await expect(verifySignature(portalApp.id, portalPrimaryDoc), 200,
    "customer-created current primary signature advances immediately");
  assert.equal(portalSignature.workflowAdvanced, true);
  assert.equal(portalSignature.nextStage, "customer_documents_upload");
  await expect(guardedBackgroundSignatureRefresh(portalApp.id, portalPrimaryDoc), 200,
    "background refresh is idempotent after portal signature advancement");
  await prepareForProviderApproval(portalApp, portalPrimaryDoc);
  const changedAmount = await expect(request(`/api/loan-applications/${portalApp.id}/funder-initial-approve`, registrarCookie, {
    approvedAmount: "15000", reason: "Synthetic adjusted principal",
  }), 200, "different provider-approved amount requests a replacement primary");
  assert.equal(changedAmount.stage, "approved_contract_pending_signature");
  assert.equal(changedAmount.approvedAmountGenerationId, null);
  assert.equal(inspect("SELECT superseded_at FROM contract_generations WHERE id=?", portalPrimary).superseded_at != null, true);
  const oldPrimaryLink = await request(`/api/loan-applications/${portalApp.id}/generated-documents`, staffCookie, {
    kind: "primary", contractGenerationId: portalPrimary,
  });
  assert.equal(oldPrimaryLink.status, 409, "old requested-amount generation cannot substitute for approved replacement terms");
  const replacement = await createPrimaryGeneration(portalApp.id, "15000", "Loan principal: 15,000");
  const replacementDoc = await expect(request(`/api/loan-applications/${portalApp.id}/generated-documents`, staffCookie, {
    kind: "primary", contractGenerationId: replacement,
  }), 201, "replacement generation binds to the revised approved amount");
  const replacementSignature = await expect(verifySignature(portalApp.id, replacementDoc.id), 200,
    "customer signature advances the current replacement without financial attestation");
  assert.equal(replacementSignature.workflowAdvanced, true);
  assert.equal(replacementSignature.nextStage, "guarantor_documents_upload");
  await expect(guardedBackgroundSignatureRefresh(portalApp.id, replacementDoc.id), 200,
    "background refresh leaves the already-advanced replacement case unchanged");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", portalApp.id).stage, "guarantor_documents_upload",
    "signature advances the current replacement to guarantor documents");
  assert.equal(inspect("SELECT approved_amount_generation_id FROM loan_applications WHERE id=?", portalApp.id)
    .approved_amount_generation_id, null, "signature must not stamp financial-generation provenance");
  assert.equal(inspect("SELECT approved_amount_reconciled_at FROM loan_applications WHERE id=?", portalApp.id)
    .approved_amount_reconciled_at, null, "signature must not write financial reconciliation metadata");
  db.prepare("UPDATE loan_applications SET stage='expert_approval' WHERE id=?").run(portalApp.id);
  const reconciledReplacement = await expect(request(`/api/loan-applications/${portalApp.id}/expert-approve`, registrarCookie, {}),
    200, "expert approval performs the guarded financial reconciliation for a valid replacement");
  assert.equal(reconciledReplacement.stage, "funder_result_review");
  assert.equal(Number(inspect("SELECT approved_amount_generation_id FROM loan_applications WHERE id=?", portalApp.id)
    .approved_amount_generation_id), replacement);
  assert.equal(inspect("SELECT approved_amount_reconciled_at FROM loan_applications WHERE id=?", portalApp.id)
    .approved_amount_reconciled_at != null, true);

  const durationFeeId = Number(db.prepare(`INSERT INTO loan_filing_fee_charges
    (customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(?,?,'0','fixture-duration-change',?)`)
    .run(customers[2], planId, timestamp).lastInsertRowid);
  const durationApp = await staffCreate(customers[2], durationFeeId);
  const durationPrimary = await createPrimaryGeneration(durationApp.id, "10000", "Loan principal: 10,000", "valid", 12);
  const durationPrimaryDoc = await linkAndSubmitPrimary(durationApp.id, durationPrimary);
  await expect(verifySignature(durationApp.id, durationPrimaryDoc), 200, "requested-duration current primary is signed");
  await expect(guardedBackgroundSignatureRefresh(durationApp.id, durationPrimaryDoc), 200,
    "requested-duration background refresh is idempotent after manual advancement");
  await prepareForProviderApproval(durationApp, durationPrimaryDoc);
  const decideDuration = (duration) => request(`/api/loan-applications/${durationApp.id}/funder-initial-approve`,
    registrarCookie, { approvedAmount: "10000", approvedDurationMonths: duration });
  await expect(decideDuration(24), 422, "condition options override the plan's 24-installment option");
  await expect(decideDuration("18"), 400, "installments must be an integer");
  db.prepare("UPDATE contract_templates SET mappings_json=? WHERE id=?").run(JSON.stringify(mappings), templateId);
  await expect(decideDuration(18), 422, "a template without an installment mapping cannot approve a changed term");
  db.prepare("UPDATE contract_templates SET mappings_json=? WHERE id=?").run(JSON.stringify(durationMappings), templateId);
  const changedDuration = await expect(decideDuration(18), 200, "duration-only approval requires a replacement");
  assert.equal(changedDuration.stage, "approved_contract_pending_signature");
  assert.equal(changedDuration.requestedDurationMonths, 12);
  assert.equal(changedDuration.durationMonths, 18);
  assert.equal(changedDuration.initialContractRetained, false);
  assert.equal(changedDuration.currentPrimaryGenerationId, null);
  assert.equal(inspect("SELECT duration_months FROM loan_applications WHERE id=?", durationApp.id).duration_months, 18);
  assert.equal(JSON.parse(inspect(`SELECT reason FROM loan_application_stage_history
    WHERE application_id=? AND action='funder-initial-approve'`, durationApp.id).reason).approvedDurationMonths, 18);
  assert.equal(inspect("SELECT superseded_at FROM contract_generations WHERE id=?", durationPrimary).superseded_at != null, true);
  await expect(request(`/api/loan-applications/${durationApp.id}/generated-documents`, staffCookie, {
    kind: "primary", contractGenerationId: durationPrimary,
  }), 409, "the old signed contract cannot substitute for a duration change");
  const missingDurationProof = await createPrimaryGeneration(durationApp.id, "10000", "Loan principal: 10,000",
    "without-duration", 18);
  await expect(request(`/api/loan-applications/${durationApp.id}/generated-documents`, staffCookie, {
    kind: "primary", contractGenerationId: missingDurationProof,
  }), 409, "replacement metadata cannot stand in for the count missing from the signed PDF");
  const conflictingDurationProof = await createPrimaryGeneration(durationApp.id, "10000",
    "Loan principal: 10,000\nNumber of installments: 12", "valid", 18);
  await expect(request(`/api/loan-applications/${durationApp.id}/generated-documents`, staffCookie, {
    kind: "primary", contractGenerationId: conflictingDurationProof,
  }), 409, "a contradictory installment count in the PDF blocks replacement");
  const durationReplacement = await createPrimaryGeneration(durationApp.id, "10000", "Loan principal: 10,000", "valid", 18);
  const durationReplacementDoc = await expect(request(`/api/loan-applications/${durationApp.id}/generated-documents`, staffCookie, {
    kind: "primary", contractGenerationId: durationReplacement,
  }), 201, "the replacement contract binds to the revised installment count");
  const durationReplacementSignature = await expect(verifySignature(durationApp.id, durationReplacementDoc.id), 200,
    "replacement signature advances without financial validation");
  assert.equal(durationReplacementSignature.workflowAdvanced, true);
  assert.equal(durationReplacementSignature.nextStage, "guarantor_documents_upload");
  await expect(guardedBackgroundSignatureRefresh(durationApp.id, durationReplacementDoc.id), 200,
    "duration background refresh is idempotent after manual advancement");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", durationApp.id).stage, "guarantor_documents_upload");

  const legacySignatureFee = Number(db.prepare(`INSERT INTO loan_filing_fee_charges
    (customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(?,?,'0','fixture-legacy-signature-fee',?)`)
    .run(customers[2], planId, timestamp).lastInsertRowid);
  const legacySignatureApp = await staffCreate(customers[2], legacySignatureFee);
  const legacySignatureGeneration = await createPrimaryGeneration(
    legacySignatureApp.id,
    "12000",
    "invalid synthetic template-4 PDF",
    "invalid",
    12,
  );
  db.prepare("UPDATE contract_generations SET template_id=4 WHERE id=?").run(legacySignatureGeneration);
  const legacySnapshot = JSON.parse(inspect("SELECT plan_snapshot_json FROM loan_applications WHERE id=?", legacySignatureApp.id)
    .plan_snapshot_json);
  legacySnapshot.contract_template_id = 4;
  db.prepare(`UPDATE loan_applications SET stage='primary_contract_pending_signature',status='reviewing',
    initial_approval_at=?,initial_approval_by_user_id=?,approved_amount='12000',net_amount='10800',
    approved_amount_source='initial_provider_approval',approved_amount_generation_id=NULL,
    approved_amount_reconciled_at=NULL,approved_amount_reconciled_by_user_id=NULL,
    duration_months=12,requested_duration_months=12,new_case_workflow=0,
    current_primary_generation_id=?,plan_snapshot_json=? WHERE id=?`)
    .run(timestamp, registrarId, legacySignatureGeneration, JSON.stringify(legacySnapshot), legacySignatureApp.id);
  const legacySignatureDocument = Number(db.prepare(`INSERT INTO loan_application_generated_documents
    (application_id,kind,contract_generation_id,created_at) VALUES(?,'primary',?,?)`)
    .run(legacySignatureApp.id, legacySignatureGeneration, timestamp).lastInsertRowid);
  const legacyFinancialBeforeSignature = inspect(`SELECT requested_amount,approved_amount,net_amount,duration_months,
    current_primary_generation_id,approved_amount_generation_id,approved_amount_source,approved_amount_reconciled_at,
    approved_amount_reconciled_by_user_id FROM loan_applications WHERE id=?`, legacySignatureApp.id);
  const legacySignature = await expect(verifySignature(legacySignatureApp.id, legacySignatureDocument), 200,
    "preapproved legacy customer signature advances regardless of PDF financial evidence");
  assert.equal(legacySignature.workflowAdvanced, true);
  assert.equal(legacySignature.nextStage, "customer_documents_upload");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", legacySignatureApp.id).stage,
    "customer_documents_upload");
  assert.deepEqual(inspect(`SELECT requested_amount,approved_amount,net_amount,duration_months,
    current_primary_generation_id,approved_amount_generation_id,approved_amount_source,approved_amount_reconciled_at,
    approved_amount_reconciled_by_user_id FROM loan_applications WHERE id=?`, legacySignatureApp.id),
  legacyFinancialBeforeSignature, "signature advancement does not attest legacy approved financial terms");

  db.prepare("UPDATE loan_applications SET stage='expert_approval' WHERE id=?").run(legacySignatureApp.id);
  const legacyExpertGuard = await request(`/api/loan-applications/${legacySignatureApp.id}/expert-approve`, registrarCookie, {});
  assert.equal(legacyExpertGuard.status, 409, "expert approval rejects invalid legacy signed financial evidence");
  assert.equal((await legacyExpertGuard.json()).error, "current_primary_terms_not_verified");

  db.prepare("UPDATE loan_applications SET stage='physical_documents_submission' WHERE id=?").run(legacySignatureApp.id);
  const legacyPhysicalGuard = await request(`/api/loan-applications/${legacySignatureApp.id}/submit-physical-documents`,
    registrarCookie, { noPhysicalDocuments: true });
  assert.equal(legacyPhysicalGuard.status, 409, "physical approval rejects invalid legacy signed financial evidence");
  assert.equal((await legacyPhysicalGuard.json()).error, "approved_primary_generation_evidence_missing");

  db.prepare("UPDATE loan_applications SET stage='admin_approval' WHERE id=?").run(legacySignatureApp.id);
  const legacyWalletGuard = await request(`/api/loan-applications/${legacySignatureApp.id}/admin-approve`, adminCookie, {});
  assert.equal(legacyWalletGuard.status, 409, "direct final wallet approval rejects invalid legacy signed financial evidence");
  assert.equal((await legacyWalletGuard.json()).error, "approved_primary_generation_evidence_missing");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?", legacySignatureApp.id).count, 0);

  const legacyHistoricalFeeId = Number(db.prepare(`INSERT INTO loan_filing_fee_charges
    (customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(?,?,'0','fixture-historical-legacy-expert-fee',?)`)
    .run(customers[1], planId, timestamp).lastInsertRowid);
  const legacyHistoricalApp = await staffCreate(customers[1], legacyHistoricalFeeId);
  const legacyHistoricalGeneration = await createPrimaryGeneration(
    legacyHistoricalApp.id, "10000", "Loan principal: 10,000",
  );
  const legacyHistoricalDocument = await linkAndSubmitPrimary(legacyHistoricalApp.id, legacyHistoricalGeneration);
  db.prepare(`UPDATE loan_applications SET new_case_workflow=0,initial_approval_at=?,
    initial_approval_by_user_id=?,approved_amount='10000',net_amount='9000',
    approved_amount_source='initial_provider_approval',approved_amount_generation_id=NULL,
    approved_amount_reconciled_at=NULL,approved_amount_reconciled_by_user_id=NULL,
    duration_months=12,requested_duration_months=12 WHERE id=?`)
    .run(timestamp, registrarId, legacyHistoricalApp.id);
  await expect(verifySignature(legacyHistoricalApp.id, legacyHistoricalDocument), 200,
    "historical legacy case observes its positive signature");
  db.prepare(`UPDATE loan_applications SET stage='admin_approval',status='reviewing',
    funder_decision='approved',expert_reviewed_at=? WHERE id=?`)
    .run(new Date().toISOString(), legacyHistoricalApp.id);
  const legacyHistoricalFunded = await expect(request(`/api/loan-applications/${legacyHistoricalApp.id}/admin-approve`,
    adminCookie, {}), 200, "untouched legacy approval already reviewed before provenance existed remains fundable");
  assert.equal(legacyHistoricalFunded.stage, "completed");
  assert.equal(inspect("SELECT approved_amount_generation_id FROM loan_applications WHERE id=?",
    legacyHistoricalApp.id).approved_amount_generation_id, null,
    "grandfathering does not rewrite/migrate historical provenance");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?",
    legacyHistoricalApp.id).count, 1);

  const legacyValidFeeId = Number(db.prepare(`INSERT INTO loan_filing_fee_charges
    (customer_id,plan_id,amount_toman,idempotency_key,created_at) VALUES(?,?,'0','fixture-valid-legacy-expert-fee',?)`)
    .run(customers[2], planId, timestamp).lastInsertRowid);
  const legacyValidApp = await staffCreate(customers[2], legacyValidFeeId);
  const legacyValidGeneration = await createPrimaryGeneration(
    legacyValidApp.id, "10000", "Loan principal: 10,000",
  );
  const legacyValidDocument = await linkAndSubmitPrimary(legacyValidApp.id, legacyValidGeneration);
  db.prepare(`UPDATE loan_applications SET new_case_workflow=0,initial_approval_at=?,
    initial_approval_by_user_id=?,approved_amount='10000',net_amount='9000',
    approved_amount_source='initial_provider_approval',approved_amount_generation_id=NULL,
    approved_amount_reconciled_at=NULL,approved_amount_reconciled_by_user_id=NULL,
    duration_months=12,requested_duration_months=12 WHERE id=?`)
    .run(timestamp, registrarId, legacyValidApp.id);
  const legacyValidSignature = await expect(verifySignature(legacyValidApp.id, legacyValidDocument), 200,
    "valid preapproved legacy signature advances without financial attestation");
  assert.equal(legacyValidSignature.workflowAdvanced, true);
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", legacyValidApp.id).stage,
    "customer_documents_upload");
  db.prepare("UPDATE loan_applications SET stage='admin_approval',status='reviewing' WHERE id=?")
    .run(legacyValidApp.id);
  const legacyWithoutExpert = await request(`/api/loan-applications/${legacyValidApp.id}/admin-approve`, adminCookie, {});
  assert.equal(legacyWithoutExpert.status, 409,
    "strictly valid legacy financial evidence cannot fund before current-generation expert reconciliation");
  assert.equal((await legacyWithoutExpert.json()).error, "approved_primary_generation_evidence_missing");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?", legacyValidApp.id).count, 0);

  db.prepare("UPDATE loan_applications SET stage='expert_approval',status='reviewing' WHERE id=?")
    .run(legacyValidApp.id);
  const legacyExpertApproved = await expect(request(`/api/loan-applications/${legacyValidApp.id}/expert-approve`,
    registrarCookie, {}), 200, "expert approval stamps the verified current generation for a valid legacy case");
  assert.equal(legacyExpertApproved.stage, "funder_result_review");
  assert.equal(Number(inspect(`SELECT approved_amount_generation_id FROM loan_applications WHERE id=?`,
    legacyValidApp.id).approved_amount_generation_id), legacyValidGeneration);
  assert.ok(inspect("SELECT approved_amount_reconciled_at FROM loan_applications WHERE id=?", legacyValidApp.id)
    .approved_amount_reconciled_at, "expert action persists current-generation reconciliation provenance");
  db.prepare("UPDATE loan_applications SET stage='admin_approval',status='reviewing' WHERE id=?")
    .run(legacyValidApp.id);
  const legacyFunded = await expect(request(`/api/loan-applications/${legacyValidApp.id}/admin-approve`, adminCookie, {}),
    200, "valid legacy terms fund only after the expert-approved generation is recorded");
  assert.equal(legacyFunded.stage, "completed");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?", legacyValidApp.id).count, 1);

  const guardApp = await staffCreate(customers[2], 3);
  const invalidPdfGeneration = await createPrimaryGeneration(
    guardApp.id,
    "10000",
    "Loan principal: 9,000; incidental fee example: 10,000",
  );
  await expect(request(`/api/loan-applications/${guardApp.id}/generated-documents`, staffCookie, {
    kind: "primary", contractGenerationId: invalidPdfGeneration,
  }), 409, "linking rejects a PDF whose rendered principal differs from requested terms");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", guardApp.id).stage, "draft");

  const undetectableApp = await staffCreate(customers[2], 4);
  const unreadableGeneration = await createPrimaryGeneration(undetectableApp.id, "10000", "10000", "unreadable");
  await expect(request(`/api/loan-applications/${undetectableApp.id}/generated-documents`, staffCookie, {
    kind: "primary", contractGenerationId: unreadableGeneration,
  }), 409, "linking rejects a PDF whose principal cannot be extracted");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", undetectableApp.id).stage, "draft");

  // An omitted deduction means no deduction; an explicitly malformed rule still fails.
  db.prepare("UPDATE loan_applications SET plan_snapshot_json=json_set(plan_snapshot_json,'$.deduct_percents','invalid') WHERE id=?").run(legacyId);
  const invalidDeduction = await request(`/api/loan-applications/${legacyId}/funder-initial-approve`, registrarCookie, {
    approvedAmount: "12000",
  });
  assert.equal(invalidDeduction.status, 409);
  assert.equal((await invalidDeduction.json()).error, "invalid_deduction_percent");
  db.prepare("UPDATE loan_applications SET plan_snapshot_json=json_remove(plan_snapshot_json,'$.deduct_percents') WHERE id=?").run(legacyId);
  // Preserve the old preapproval-first path for historical applications not resequenced.
  const legacyApproval = await expect(request(`/api/loan-applications/${legacyId}/funder-initial-approve`, registrarCookie, {
    approvedAmount: "12000",
  }), 200, "legacy preapproval-first record keeps its old approval path");
  assert.equal(legacyApproval.stage, "draft");
  assert.equal(legacyApproval.netAmount, "12000");
  assert.equal(Number(inspect("SELECT new_case_workflow FROM loan_applications WHERE id=?", legacyId).new_case_workflow), 0);
  // Reopened legacy cases must register the guarantor before amount approval.
  db.prepare(`UPDATE loan_applications SET stage='funder_initial_approval',status='reviewing',
    initial_approval_at=NULL,legacy_reopen_prior_stage='guarantor_registration',
    approved_amount=NULL,net_amount=NULL,condition_snapshot_json=json_set(condition_snapshot_json,'$.needs_guarantor',1)
    WHERE id=?`).run(legacyId);
  const beforeGuarantor = await request(`/api/loan-applications/${legacyId}/funder-initial-approve`, registrarCookie, {
    approvedAmount: "12000",
  });
  assert.equal(beforeGuarantor.status, 409);
  assert.equal((await beforeGuarantor.json()).error, "guarantor_required_before_approval");
  db.prepare("UPDATE loan_applications SET stage='guarantor_registration',status='reviewing' WHERE id=?").run(legacyId);
  await expect(request(`/api/loan-applications/${legacyId}/guarantor`, staffCookie, {
    fullName: "Synthetic guarantor", nationalCode: "0000000000",
  }), 201, "legacy case records guarantor before amount approval");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", legacyId).stage, "funder_initial_approval");
  db.prepare("UPDATE loan_applications SET stage='guarantor_registration',status='reviewing' WHERE id=?").run(legacyId);
  const bypass = await request(`/api/loan-applications/${legacyId}/start-guarantor-documents`, staffCookie, {});
  assert.equal(bypass.status, 409, "legacy guarantor documents cannot bypass amount approval");
  assert.equal((await bypass.json()).error, "loan_amount_approval_required");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", legacyId).stage, "guarantor_registration");
  await expect(request(`/api/loan-applications/${legacyId}/guarantor`, staffCookie, {
    fullName: "Synthetic guarantor", nationalCode: "0000000000",
  }), 201, "existing guarantor is re-confirmed before approval");
  const afterGuarantor = await expect(request(`/api/loan-applications/${legacyId}/funder-initial-approve`, registrarCookie, {
    approvedAmount: "12000",
  }), 200, "legacy case approves changed amount with no configured deduction");
  assert.equal(afterGuarantor.stage, "draft");
  assert.equal(afterGuarantor.netAmount, "12000");
  // The provider can report no active certificate after a PDF was generated.
  // The same verified generation must be reused after the certificate becomes active.
  const retryGeneration = await createPrimaryGeneration(legacyId, "12000", "Loan principal: 12,000");
  db.prepare(`UPDATE contract_generations SET status='generated',provider_contract_id=NULL,
    provider_status=NULL WHERE id=?`).run(retryGeneration);
  await writeFile(certificateUnavailableMarker, "unavailable");
  const certificateFailure = await expect(request(`/api/contracts/generations/${retryGeneration}/send`, staffCookie, {}),
    422, "certificate lookup 404 is an actionable inactive-certificate error");
  assert.equal(certificateFailure.error, "certificate_inactive");
  assert.equal(inspect("SELECT status FROM contract_generations WHERE id=?", retryGeneration).status, "failed");
  // Raw manual inputs and their grouped rendered values are the same contract terms.
  const retryOriginal = inspect("SELECT mappings_snapshot_json,manual_values_json FROM contract_generations WHERE id=?", retryGeneration);
  const retryMappings = [...JSON.parse(retryOriginal.mappings_snapshot_json),
    { variable: "retryNote", sourceType: "manual" }];
  const retryValues = { ...JSON.parse(retryOriginal.manual_values_json), retryNote: "123,456" };
  db.prepare("UPDATE loan_applications SET primary_manual_values_json=? WHERE id=?")
    .run(JSON.stringify({ retryNote: "123456" }), legacyId);
  db.prepare("UPDATE contract_generations SET mappings_snapshot_json=?,manual_values_json=? WHERE id=?")
    .run(JSON.stringify(retryMappings), JSON.stringify(retryValues), retryGeneration);
  const reused = await expect(request("/api/contracts/generate", staffCookie, { loanApplicationId: legacyId }),
    200, "retry reuses the existing generated PDF instead of making a second contract");
  assert.equal(reused.id, retryGeneration);
  db.prepare("UPDATE contract_generations SET manual_values_json=? WHERE id=?")
    .run(JSON.stringify({ ...retryValues, retryNote: "123,457" }), retryGeneration);
  const changedRendered = await request("/api/contracts/generate", staffCookie, { loanApplicationId: legacyId });
  assert.equal(changedRendered.status, 409, "a genuinely changed manual value remains locked");
  assert.equal((await changedRendered.json()).error, "existing_contract_manual_values_locked");
  db.prepare("UPDATE loan_applications SET primary_manual_values_json='{}' WHERE id=?").run(legacyId);
  db.prepare("UPDATE contract_generations SET mappings_snapshot_json=?,manual_values_json=? WHERE id=?")
    .run(retryOriginal.mappings_snapshot_json, retryOriginal.manual_values_json, retryGeneration);
  const savedRetryCase = inspect(`SELECT new_case_workflow,initial_approval_at,legacy_reopen_prior_stage,
    stage,requested_amount,current_primary_generation_id FROM loan_applications WHERE id=?`, legacyId);
  for (const scenario of [
    { name: "requested new case", newCase: 1, approval: null, priorStage: null, stage: "draft" },
    { name: "approved new case", newCase: 1, approval: savedRetryCase.initial_approval_at, priorStage: null, stage: "approved_contract_pending_signature" },
    { name: "reopened legacy case", newCase: 0, approval: null, priorStage: "customer_documents_upload", stage: "draft" },
  ]) {
    db.prepare(`UPDATE loan_applications SET new_case_workflow=?,initial_approval_at=?,
      legacy_reopen_prior_stage=?,stage=?,requested_amount='12000',current_primary_generation_id=NULL WHERE id=?`)
      .run(scenario.newCase, scenario.approval, scenario.priorStage, scenario.stage, legacyId);
    const same = await expect(request("/api/contracts/generate", staffCookie, { loanApplicationId: legacyId }),
      200, `${scenario.name} reuses certificate-failed generation`);
    assert.equal(same.id, retryGeneration);
    for (const failure of ["certificate_inactive", "provider_certificate_check_failed"]) {
      db.prepare("UPDATE contract_generations SET status='failed',error_message=? WHERE id=?").run(failure, retryGeneration);
      const retry = await expect(request(`/api/contracts/generations/${retryGeneration}/send`, staffCookie, {}),
        422, `${scenario.name} reaches certificate check on retry`);
      assert.equal(retry.error, "certificate_inactive");
    }
    db.prepare("UPDATE contract_generations SET provider_file_id='fixture-existing-upload' WHERE id=?").run(retryGeneration);
    await expect(request(`/api/contracts/generations/${retryGeneration}/send`, staffCookie, {}),
      409, `${scenario.name} cannot bypass a prior upload`);
    db.prepare("UPDATE contract_generations SET provider_file_id=NULL,error_message='provider_contract_send_failed' WHERE id=?").run(retryGeneration);
    await expect(request(`/api/contracts/generations/${retryGeneration}/send`, staffCookie, {}),
      409, `${scenario.name} cannot retry an unknown delivery failure as certificate preflight`);
    db.prepare("UPDATE contract_generations SET error_message='certificate_inactive' WHERE id=?").run(retryGeneration);
  }
  db.prepare(`UPDATE loan_applications SET new_case_workflow=?,initial_approval_at=?,legacy_reopen_prior_stage=?,
    stage=?,requested_amount=?,current_primary_generation_id=? WHERE id=?`).run(
      savedRetryCase.new_case_workflow, savedRetryCase.initial_approval_at, savedRetryCase.legacy_reopen_prior_stage,
      savedRetryCase.stage, savedRetryCase.requested_amount, savedRetryCase.current_primary_generation_id, legacyId);
  await rm(certificateUnavailableMarker);
  const retried = await expect(request(`/api/contracts/generations/${retryGeneration}/send`, staffCookie, {}),
    200, "verified failed generation sends after certificate becomes available");
  assert.equal(retried.id, retryGeneration);
  assert.equal(inspect("SELECT status FROM contract_generations WHERE id=?", retryGeneration).status, "sent");

  // Rejected delivery is a fresh attempt for the immutable generation, never a
  // reset of signed terms or an unrecorded overwrite of a provider identifier.
  const rejectedGeneration = inspect("SELECT * FROM contract_generations WHERE id=?", retryGeneration);
  const resendCase = inspect("SELECT * FROM loan_applications WHERE id=?", legacyId);
  db.prepare(`UPDATE loan_applications SET new_case_workflow=1,initial_approval_at=NULL,
    stage='primary_contract_pending_signature',status='waiting_customer_signature',
    requested_amount=?,requested_duration_months=duration_months,current_primary_generation_id=? WHERE id=?`)
    .run(resendCase.approved_amount, retryGeneration, legacyId);
  db.prepare(`INSERT INTO loan_application_generated_documents
    (application_id,kind,contract_generation_id,status,created_at) VALUES(?,'primary',?,'pending',?)`)
    .run(legacyId, retryGeneration, timestamp);
  db.prepare(`UPDATE contract_generations SET status='sent',provider_status='reject',
    provider_contract_id='fixture-rejected-contract',provider_file_id='fixture-existing-upload',
    provider_idempotency_key='fixture-old-idempotency',sent_at=? WHERE id=?`).run(timestamp, retryGeneration);
  const resendPath = `/api/contracts/generations/${retryGeneration}/prepare-resend`;
  await expect(request(resendPath, staffCookie, {}), 409, "a fresh provider signature overrides cached rejection");
  assert.equal(inspect("SELECT COUNT(*) count FROM contract_generation_rejected_deliveries").count, 0);
  assert.equal(inspect("SELECT provider_contract_id FROM contract_generations WHERE id=?", retryGeneration).provider_contract_id,
    "fixture-rejected-contract");
  await writeFile(providerStatusFile, "reject");
  await expect(request(resendPath, registrarCookie, {}), 403, "resend requires send permission");
  db.prepare("UPDATE loan_applications SET stage='admin_approval' WHERE id=?").run(legacyId);
  await expect(request(resendPath, staffCookie, {}), 409, "a funded or advanced case cannot reset its contract");
  db.prepare("UPDATE loan_applications SET stage='primary_contract_pending_signature',current_primary_generation_id=NULL WHERE id=?").run(legacyId);
  await expect(request(resendPath, staffCookie, {}), 409, "a historical generation cannot be resent");
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?").run(retryGeneration, legacyId);
  const preparationResults = await Promise.all([request(resendPath, staffCookie, {}), request(resendPath, staffCookie, {})]);
  assert.deepEqual(preparationResults.map(result => result.status).sort(), [200, 409], "concurrent preparation archives exactly once");
  const archived = inspect("SELECT * FROM contract_generation_rejected_deliveries WHERE generation_id=?", retryGeneration);
  assert.equal(archived.provider_contract_id, "fixture-rejected-contract");
  assert.equal(archived.provider_status, "reject");
  assert.equal(archived.sent_at, timestamp);
  assert.equal(inspect("SELECT COUNT(*) count FROM contract_generation_rejected_deliveries WHERE generation_id=?", retryGeneration).count, 1);
  const prepared = inspect("SELECT * FROM contract_generations WHERE id=?", retryGeneration);
  assert.equal(prepared.pdf_path, rejectedGeneration.pdf_path);
  assert.equal(prepared.pdf_sha256, rejectedGeneration.pdf_sha256);
  assert.equal(prepared.manual_values_json, rejectedGeneration.manual_values_json);
  assert.equal(prepared.provider_file_id, "fixture-existing-upload");
  assert.equal(prepared.provider_contract_id, null);
  assert.equal(prepared.provider_idempotency_key, null);
  const sendsBefore = (await readFile(providerSendLog, "utf8")).trim().split("\n").length;
  await expect(request(`/api/contracts/generations/${retryGeneration}/send`, staffCookie, {}), 200, "same rejected document sends as a new delivery");
  const deliveredAgain = inspect("SELECT * FROM contract_generations WHERE id=?", retryGeneration);
  assert.notEqual(deliveredAgain.provider_contract_id, archived.provider_contract_id);
  assert.notEqual(deliveredAgain.provider_idempotency_key, "fixture-old-idempotency");
  await expect(request(`/api/contracts/generations/${retryGeneration}/send`, staffCookie, {}), 200, "repeated send returns the accepted delivery");
  const sendsAfter = (await readFile(providerSendLog, "utf8")).trim().split("\n").length;
  assert.equal(sendsAfter - sendsBefore, 1, "repeated clicks create only one provider delivery");
  await expect(request(resendPath, staffCookie, {}), 409, "a pending new delivery cannot be reset again");
  await rm(providerStatusFile);
  process.stdout.write("PASS rejected-contract resend: fresh rejection, role/current/stage guards, atomic archived identity, unchanged PDF and values, new delivery key and idempotent send.\n");

  // Simulate a corrupted late-stage record to exercise the final disbursement
  // guard independently of earlier stage checks; credit remains mocked/blocked.
  db.prepare("UPDATE loan_applications SET stage='admin_approval',status='reviewing',approved_amount=NULL,net_amount=NULL WHERE id=?")
    .run(guardApp.id);
  const walletGuard = await request(`/api/loan-applications/${guardApp.id}/admin-approve`, adminCookie, {});
  assert.equal(walletGuard.status, 409, "wallet credit rejects a late-stage record without approved signed terms");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?", guardApp.id).count, 0);

  process.stdout.write(
    "PASS approval-after-guarantor fixture: staff and customer drafts, immediate positive-signature advancement, " +
    "document/guarantor ordering, same-term reuse, changed-duration replacement and rendered-count proof, " +
    "expert-only replacement reconciliation, signature without financial attestation, invalid legacy evidence blocked at later gates, " +
    "valid legacy expert provenance required before wallet credit, untouched historical expert approvals preserved, legacy approval preservation, " +
    "rendered-principal rejection, amendment delivery with current signed primary, and guarded wallet credit.\n" +
    "PASS contract evidence text helper: contradictory/incidental amount rejection, explicit principal acceptance, example-only and conflicting-principal rejection.\n" +
    "PASS synthetic attestation fail-closed checks: unsupported/source hash mismatch and missing/corrupt DOCX reject; generic wrong+incidental/conflicting text is rejected by the legacy label-only helper.\n" +
    "LIMITATION: a positive template-6 anchored-clause match cannot be exercised with synthetic ZIP bytes while preserving its fixed SHA-256 allowlist; no production template or hash bypass was used.\n" +
    "LIMITATION: synthetic signed generations are seeded; contract DOCX generation/rendering and real provider delivery are not exercised.\n",
  );
  }
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  db?.close();
  await rm(temp, { recursive: true, force: true });
}