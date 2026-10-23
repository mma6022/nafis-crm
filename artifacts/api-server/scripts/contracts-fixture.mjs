import JSZip from "jszip";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const zip = new JSZip();
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr></w:body></w:document>`;
const p = (text) => `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const split = `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>سلام %%na</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>me%% و کارمزد 25%</w:t></w:r></w:p>`;
zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
zip.file("word/document.xml", xml(`${split}<w:tbl><w:tr><w:tc><w:p><w:r><w:t>%customer.phone%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`));
zip.file("word/header1.xml", `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>%%header%%</w:t></w:r></w:p></w:hdr>`);
zip.file("word/footer1.xml", `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>%%footer%%</w:t></w:r></w:p></w:ftr>`);
const input = await zip.generateAsync({ type: "nodebuffer" });
const normalizeTemplatePercentDelimiters = (xml, variables) => {
  let value = xml.replaceAll("%%", "%");
  const markers = [];
  for (const [index, variable] of [...new Set(variables)].entries()) {
    const open = `__NAFIS_CONTRACT_OPEN_${index}__`;
    const close = `__NAFIS_CONTRACT_CLOSE_${index}__`;
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp([...`%${variable}%`].map(escape).join("(?:<[^>]+>)*"), "g");
    value = value.replace(pattern, (match) => {
      const first = match.indexOf("%");
      const last = match.lastIndexOf("%");
      return `${match.slice(0, first)}${open}${match.slice(first + 1, last)}${close}${match.slice(last + 1)}`;
    });
    markers.push({ open, close });
  }
  value = value.replaceAll("%", "&#37;");
  for (const marker of markers) value = value.replaceAll(marker.open, "%").replaceAll(marker.close, "%");
  return value;
};
const normalized = await JSZip.loadAsync(input);
const variables = ["name", "customer.phone", "header", "footer"];
for (const name of Object.keys(normalized.files)) if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) normalized.file(name, normalizeTemplatePercentDelimiters(await normalized.file(name).async("string"), variables));
const templater = new Docxtemplater(new PizZip(await normalized.generateAsync({ type: "nodebuffer" })), { delimiters: { start: "%", end: "%" }, paragraphLoop: true, linebreaks: true });
templater.render({ name: "رضایی", "customer.phone": "۰۹۱۲", header: "سربرگ", footer: "پابرگ" });
const output = templater.getZip().generate({ type: "nodebuffer" });
const rendered = await JSZip.loadAsync(output);
const generatedDirectories = Object.keys(rendered.files).filter((name) => rendered.files[name].dir);
if (!generatedDirectories.length || generatedDirectories.some((name) => !name.endsWith("/"))) {
  throw new Error("Expected safe DOCX directory entries in rendered output");
}
for (const name of ["word/document.xml", "word/header1.xml", "word/footer1.xml"]) {
  const text = await rendered.file(name).async("string");
  if (/%%?[A-Za-z][A-Za-z0-9_.-]*%%?/.test(text)) throw new Error(`Unresolved placeholder in ${name}`);
}
const document = await rendered.file("word/document.xml").async("string");
if (!document.includes("رضایی") || !document.includes("۰۹۱۲") || !document.includes("25&#37;")) throw new Error("Fixture values or literal percent were not rendered");
console.log("PASS contracts DOCX single/double-percent split-run/table/header/footer/literal-percent fixture");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const jsonRequest = async (url, cookie, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      cookie,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};
const waitForHealth = async (url, child) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode != null) throw new Error(`API exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("API did not become ready");
};

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "crm-contract-flow-"));
const testDbPath = path.join(tempRoot, "crm.db");
const contractsRoot = path.join(tempRoot, "contracts");
const templateRoot = path.join(contractsRoot, "templates");
await mkdir(templateRoot, { recursive: true });
await copyFile(path.resolve("..", "..", "attached_assets", "customers_1789823100050.db"), testDbPath);

const db = new DatabaseSync(testDbPath);
const timestamp = new Date().toISOString();
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get();
assert(admin?.id, "Integration fixture requires an active admin user");
const registrar = db.prepare("SELECT id FROM users WHERE role='registrar' AND active=1 ORDER BY id LIMIT 1").get();
assert(registrar?.id, "Integration fixture requires an active registrar user");
const customer = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get();
assert(customer?.id, "Integration fixture requires a customer");
db.prepare("UPDATE customers SET name=?,national_code=?,phone=? WHERE id=?").run("مشتری تست قرارداد", "0013546789", "09121234567", customer.id);

const templatePath = path.join(templateRoot, `${randomBytes(16).toString("hex")}.docx`);
await writeFile(templatePath, output);
const templateId = Number(db.prepare(`INSERT INTO contract_templates
  (name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(
    "قالب تست یکپارچه",
    "fixture.docx",
    templatePath,
    "fixture",
    JSON.stringify(variables),
    JSON.stringify([
      { variable: "name", sourceType: "customer", customerField: "customer.name", label: "نام" },
      { variable: "customer.phone", sourceType: "customer", customerField: "customer.phone", label: "تلفن" },
      { variable: "header", sourceType: "constant", constantValue: "سربرگ", label: "سربرگ" },
      { variable: "footer", sourceType: "constant", constantValue: "پابرگ", label: "پابرگ" },
    ]),
    admin.id,
    timestamp,
    timestamp,
  ).lastInsertRowid);
const selectedPlanName = "طرح سپیدار ویژه";
const selectedPlanId = Number(db.prepare(
  "INSERT INTO loan_plans(name,contract_template_id,active,created_at) VALUES(?,?,1,?)",
).run(selectedPlanName, templateId, timestamp).lastInsertRowid);

const consultationId = Number(db.prepare("INSERT INTO consultation_forms(customer_id,requested_amount,updated_at) VALUES(?,?,?)")
  .run(customer.id, "1000000", timestamp).lastInsertRowid);
const appId = Number(db.prepare(`INSERT INTO loan_applications
  (consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,duration_months,stage,status,condition_snapshot_json,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    consultationId, customer.id, admin.id, "[]", "1000000", 12, "draft", "requested", "{}", timestamp, timestamp,
  ).lastInsertRowid);

const sessionSecret = "fixture-session-secret";
const sessionToken = randomBytes(24).toString("base64url");
const sessionHash = createHmac("sha256", sessionSecret).update(sessionToken).digest("hex");
db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
  sessionHash,
  admin.id,
  new Date(Date.now() + 60_000).toISOString(),
  timestamp,
);
const registrarSessionToken = randomBytes(24).toString("base64url");
db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
  createHmac("sha256", sessionSecret).update(registrarSessionToken).digest("hex"),
  registrar.id,
  new Date(Date.now() + 60_000).toISOString(),
  timestamp,
);

let acceptedContractCount = 0;
let deleteAcceptedGeneration = false;
let lastAcceptedGenerationId = null;
let lastUploadedMultipart = "";
let lastSentContract = null;
let providerStatusCheckCount = 0;
const provider = createServer(async (req, res) => {
  const respond = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/login" && req.method === "POST") return respond(200, { accessToken: "fixture-token" });
  if (req.url?.startsWith("/users/checkUserActiveCertificate/")) {
    return respond(200, { active: true });
  }
  if (req.url === "/files" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    lastUploadedMultipart = Buffer.concat(chunks).toString("utf8");
    return respond(200, { fileId: `file-${acceptedContractCount + 1}` });
  }
  if (req.url === "/contracts/sendContract" && req.method === "POST") {
    let payload = "";
    for await (const chunk of req) payload += chunk;
    const parsed = JSON.parse(payload);
    lastSentContract = parsed;
    const match = /^contract-(\d+)$/.exec(parsed.title);
    lastAcceptedGenerationId = match ? Number(match[1]) : null;
    acceptedContractCount++;
    if (deleteAcceptedGeneration && lastAcceptedGenerationId) {
      db.prepare("DELETE FROM contract_generations WHERE id=?").run(lastAcceptedGenerationId);
    }
    return respond(200, { contractId: `provider-contract-${acceptedContractCount}`, status: "pending" });
  }
  if (req.url?.startsWith("/contracts/") && req.method === "GET") {
    providerStatusCheckCount++;
    return respond(200, { status: "signed" });
  }
  return respond(404, { error: "not_found" });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = provider.address().port;
const apiPort = 24000 + Math.floor(Math.random() * 1000);
const apiBase = `http://127.0.0.1:${apiPort}`;
const api = spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(apiPort),
    CRM_DATABASE_PATH: testDbPath,
    CONTRACTS_STORAGE_DIR: contractsRoot,
    SESSION_SECRET: sessionSecret,
    EMZAME_BASE_URL: `http://127.0.0.1:${providerPort}`,
    EMZAME_NATIONAL_CODE: "0013546789",
    EMZAME_PASSWORD: "fixture-password",
    EMZAME_BUSINESS_ID: "fixture-business",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let apiLogs = "";
api.stdout.on("data", (chunk) => { apiLogs += chunk; });
api.stderr.on("data", (chunk) => { apiLogs += chunk; });

try {
  await waitForHealth(apiBase, api);
  const cookie = `crm_session=${sessionToken}`;
  const registrarCookie = `crm_session=${registrarSessionToken}`;

  const generated = await jsonRequest(`${apiBase}/api/contracts/generate`, cookie, {
    method: "POST",
    body: JSON.stringify({ templateId, customerId: Number(customer.id), loanPlanId: selectedPlanId }),
  });
  assert(generated.response.status === 201 && generated.body.status === "generated", `Generation failed: ${JSON.stringify(generated.body)}`);
  const generationId = Number(generated.body.id);

  const sent = await jsonRequest(`${apiBase}/api/contracts/generations/${generationId}/send`, cookie, { method: "POST" });
  assert(sent.response.ok, `sendContract failed: ${JSON.stringify(sent.body)}`);
  assert(sent.body.providerContractId === "provider-contract-1", "sendContract response omitted providerContractId");
  const expectedProviderTitle = `قرارداد طرح ${selectedPlanName} - مشتری تست قرارداد`;
  assert(lastSentContract?.title === expectedProviderTitle,
    `Provider title did not use selected plan and customer names: ${lastSentContract?.title}`);
  assert(lastSentContract.title !== `قرارداد طرح قالب تست یکپارچه - مشتری تست قرارداد`,
    "Provider title incorrectly used the template name");
  assert(lastUploadedMultipart.includes(`filename="${expectedProviderTitle}.pdf"`),
    "Uploaded PDF filename did not match the safe provider title");
  assert(lastUploadedMultipart.includes(`\r\n\r\n${expectedProviderTitle}\r\n`),
    "Uploaded file display name did not match the provider title");
  const persisted = db.prepare("SELECT status,provider_contract_id,mappings_snapshot_json FROM contract_generations WHERE id=?").get(generationId);
  assert(persisted?.status === "sent" && persisted.provider_contract_id === "provider-contract-1", "Provider acceptance was not persisted");
  assert(JSON.stringify(JSON.parse(persisted.mappings_snapshot_json)) === JSON.stringify(JSON.parse(db.prepare("SELECT mappings_json FROM contract_templates WHERE id=?").get(templateId).mappings_json)),
    "Rendered generation did not retain the mappings used for later signed-term proof");

  const registrarLinkAttempt = await jsonRequest(`${apiBase}/api/loan-applications/${appId}/generated-documents`, registrarCookie, {
    method: "POST",
    body: JSON.stringify({ kind: "primary", contractGenerationId: generationId }),
  });
  assert(registrarLinkAttempt.response.status === 403 && registrarLinkAttempt.body.error === "action_forbidden",
    `Registrar unexpectedly gained contract upload/link permission: ${JSON.stringify(registrarLinkAttempt.body)}`);

  const linked = await jsonRequest(`${apiBase}/api/loan-applications/${appId}/generated-documents`, cookie, {
    method: "POST",
    body: JSON.stringify({ kind: "primary", contractGenerationId: generationId }),
  });
  assert(linked.response.status === 201, `Document linking failed: ${JSON.stringify(linked.body)}`);

  const submitted = await jsonRequest(`${apiBase}/api/loan-applications/${appId}/submit-primary-contract`, cookie, { method: "POST", body: "{}" });
  assert(submitted.response.ok && submitted.body.stage === "primary_contract_pending_signature" && submitted.body.status === "requested",
    `Pending-signature transition failed: ${JSON.stringify(submitted.body)}`);

  const verified = await jsonRequest(`${apiBase}/api/loan-applications/${appId}/generated-documents/${linked.body.id}/verify-signature`, cookie, { method: "POST", body: "{}" });
  assert(verified.response.ok && verified.body.signed === true, `Signature verification failed: ${JSON.stringify(verified.body)}`);
  const afterSignature = db.prepare("SELECT stage,status FROM loan_applications WHERE id=?").get(appId);
  assert(afterSignature?.stage === "primary_contract_pending_signature" && afterSignature.status === "requested",
    "Manual signature observation must not advance the application");
  assert.equal(db.prepare("SELECT link FROM loan_application_generated_documents WHERE id=?").get(linked.body.id).link, null,
    "Manual signature observation must not write a signed-document workflow link");
  const generationStatusBeforeReadOnlyLookup = db.prepare("SELECT status,provider_status,updated_at FROM contract_generations WHERE id=?").get(generationId);
  const readOnlyContractsPageStatus = await jsonRequest(
    `${apiBase}/api/contracts/generations/${generationId}/check-status`, cookie, { method: "GET" },
  );
  assert(readOnlyContractsPageStatus.response.ok && readOnlyContractsPageStatus.body.signed === true
      && readOnlyContractsPageStatus.body.readOnly === true,
    `Contracts-page read-only status lookup failed: ${JSON.stringify(readOnlyContractsPageStatus.body)}`);
  assert.deepEqual(db.prepare("SELECT status,provider_status,updated_at FROM contract_generations WHERE id=?").get(generationId),
    generationStatusBeforeReadOnlyLookup, "Contracts-page read-only inquiry must not persist provider status");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(appId).stage, afterSignature.stage,
    "Contracts-page read-only inquiry must not advance the application");
  const providerChecksBeforeContractsPageStatus = providerStatusCheckCount;
  const amendmentStageBeforeContractsPageStatus = afterSignature.stage;
  const amendmentFinancialBeforeContractsPageStatus = db.prepare(`SELECT requested_amount,approved_amount,net_amount,duration_months,
    current_primary_generation_id,approved_amount_generation_id,approved_amount_reconciled_at,
    approved_amount_reconciled_by_user_id FROM loan_applications WHERE id=?`).get(appId);
  const contractsPageStatus = await jsonRequest(
    `${apiBase}/api/contracts/generations/${generationId}/check-status`, cookie, { method: "POST", body: "{}" },
  );
  assert(contractsPageStatus.response.ok && contractsPageStatus.body.signed === true,
    `Contracts-page status observation failed: ${JSON.stringify(contractsPageStatus.body)}`);
  assert.equal(providerStatusCheckCount, providerChecksBeforeContractsPageStatus + 1,
    "Contracts-page manual status action must perform a fresh provider request");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(appId).stage, amendmentStageBeforeContractsPageStatus,
    "Contracts-page manual check must not advance the application");
  assert.deepEqual(db.prepare(`SELECT requested_amount,approved_amount,net_amount,duration_months,
    current_primary_generation_id,approved_amount_generation_id,approved_amount_reconciled_at,
    approved_amount_reconciled_by_user_id FROM loan_applications WHERE id=?`).get(appId),
  amendmentFinancialBeforeContractsPageStatus, "Contracts-page manual check must not change financial fields");
  assert.equal(db.prepare("SELECT link FROM loan_application_generated_documents WHERE id=?").get(linked.body.id).link, null,
    "Contracts-page manual check must not write a signed-document workflow link");
  // Later transition-flow assertions start after the separate guarded
  // background verifier would have completed its work.
  db.prepare("UPDATE loan_applications SET stage='customer_documents_upload',status='reviewing' WHERE id=?").run(appId);

  const transitionCases = [
    ["customer_documents_upload", "customer_documents_review", "submit-customer-documents"],
    ["customer_documents_review", "collateral_upload", "review-customer-documents"],
    ["collateral_upload", "collateral_review", "submit-collateral"],
    ["collateral_review", "expert_approval", "review-collateral"],
    ["expert_approval", "funder_result_review", "expert-approve"],
    ["funder_result_review", "physical_documents_review", "confirm-funder"],
    ["physical_documents_review", "wallet_charge_pending", "approve-physical-documents"],
    ["wallet_charge_pending", "admin_approval", "approve-wallet-charge"],
    ["admin_approval", "completed", "admin-approve"],
  ];
  db.prepare("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,status,storage_path,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(appId, "fixture", "مدرک تست", "plan", "approved", templatePath, timestamp);
  const identityTypes = ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"];
  const insertIdentity = db.prepare(`INSERT INTO customer_identity_documents
    (customer_id,document_type,storage_path,original_name,mime_type,size_bytes,sha256,created_by_user_id,created_at,approved_at,approved_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const documentType of identityTypes) {
    insertIdentity.run(
      customer.id, documentType, templatePath, `${documentType}.docx`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      output.length, "fixture", admin.id, timestamp, timestamp, admin.id,
    );
  }
  const submittedDocuments = await jsonRequest(`${apiBase}/api/loan-applications/${appId}/submit-customer-documents`, cookie, { method: "POST", body: "{}" });
  assert(submittedDocuments.response.ok && submittedDocuments.body.stage === "customer_documents_review",
    `Customer documents were not submitted for registrar review: ${JSON.stringify(submittedDocuments.body)}`);

  const registrarDetail = await jsonRequest(`${apiBase}/api/loan-applications/${appId}`, registrarCookie);
  assert(registrarDetail.response.ok, `Registrar cannot view in-scope application: ${JSON.stringify(registrarDetail.body)}`);
  const registrarContract = registrarDetail.body.generatedDocuments?.find((item) => item.id === linked.body.id);
  assert(registrarContract?.signed === true && registrarContract.fileAvailable === true && registrarContract.downloadUrl,
    `Registrar detail omitted the signed primary contract file: ${JSON.stringify(registrarContract)}`);
  const contractDownload = await fetch(`${apiBase}${registrarContract.downloadUrl}`, { headers: { cookie: registrarCookie } });
  assert(contractDownload.ok && (contractDownload.headers.get("content-type") || "").includes("pdf"),
    `Registrar could not download the linked contract: ${contractDownload.status}`);
  await contractDownload.arrayBuffer();

  const registrarReviewed = await jsonRequest(
    `${apiBase}/api/loan-applications/${appId}/generated-documents/${linked.body.id}/review`,
    registrarCookie,
    { method: "POST", body: JSON.stringify({ decision: "approved" }) },
  );
  assert(registrarReviewed.response.ok && registrarReviewed.body.status === "approved",
    `Registrar could not approve the signed primary contract: ${JSON.stringify(registrarReviewed.body)}`);

  const missingGenerationId = Number(db.prepare(`INSERT INTO contract_generations
    (template_id,customer_id,docx_path,docx_sha256,manual_values_json,status,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      templateId, customer.id, templatePath, "fixture", "{}", "generated", admin.id, timestamp, timestamp,
    ).lastInsertRowid);
  db.prepare("INSERT INTO loan_application_generated_documents(application_id,kind,contract_generation_id,created_at) VALUES(?,?,?,?)")
    .run(appId, "acknowledgement", missingGenerationId, timestamp);
  const detailWithMissingPdf = await jsonRequest(`${apiBase}/api/loan-applications/${appId}`, registrarCookie);
  const missingPdfDocument = detailWithMissingPdf.body.generatedDocuments?.find((item) => item.contractGenerationId === missingGenerationId);
  assert(missingPdfDocument?.fileAvailable === false && missingPdfDocument.downloadUrl === null,
    `Missing generated PDF incorrectly exposed a download: ${JSON.stringify(missingPdfDocument)}`);

  for (const [from, to, action] of transitionCases.slice(1)) {
    if (from === "collateral_upload") {
      db.prepare("INSERT INTO loan_application_collateral(application_id,collateral_type,status,created_at) VALUES(?,?,?,?)")
        .run(appId, "deposit", "approved", timestamp);
    }
    const moved = await jsonRequest(`${apiBase}/api/loan-applications/${appId}/${action}`, cookie, { method: "POST", body: "{}" });
    assert(moved.response.ok && moved.body.stage === to, `${from} -> ${to} failed: ${JSON.stringify(moved.body)}`);
    assert(["requested", "reviewing", "approved", "rejected"].includes(moved.body.status), `Invalid four-state status: ${moved.body.status}`);
  }

  const failureDocx = path.join(contractsRoot, "generations", `${randomBytes(16).toString("hex")}.docx`);
  const failurePdf = path.join(contractsRoot, "generations", `${randomBytes(16).toString("hex")}.pdf`);
  await writeFile(failureDocx, output);
  await writeFile(failurePdf, Buffer.from("%PDF-1.4\n%%EOF\n"));
  const failurePdfHash = createHash("sha256").update(await readFile(failurePdf)).digest("hex");
  const failureGenerationId = Number(db.prepare(`INSERT INTO contract_generations
    (template_id,customer_id,docx_path,pdf_path,docx_sha256,pdf_sha256,manual_values_json,status,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      templateId, customer.id, failureDocx, failurePdf, "fixture", failurePdfHash,
      "{}", "generated", admin.id, timestamp, timestamp,
    ).lastInsertRowid);
  deleteAcceptedGeneration = true;
  const lost = await jsonRequest(`${apiBase}/api/contracts/generations/${failureGenerationId}/send`, cookie, { method: "POST" });
  assert(lost.response.status === 409 && lost.body.error === "provider_state_persist_failed",
    `Zero-change persistence incorrectly returned success: ${lost.response.status} ${JSON.stringify(lost.body)}`);
  assert(lastSentContract?.title === `contract-${failureGenerationId}`,
    "Legacy generation without a loan plan did not retain its contract-id provider title");

  console.log("PASS registrar sees, downloads and reviews signed customer contract; missing generated PDF exposes no download");
  console.log("PASS contract generation/send/persist/link/wait/sign and four-state loan transitions integration fixture");
  console.log("PASS accepted provider result with zero persisted rows returns provider_state_persist_failed");
} catch (error) {
  if (apiLogs) console.error(apiLogs);
  throw error;
} finally {
  api.kill("SIGTERM");
  await new Promise((resolve) => api.once("exit", resolve));
  await new Promise((resolve) => provider.close(resolve));
  db.close();
  await rm(tempRoot, { recursive: true, force: true });
}