import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import PizZip from "pizzip";

// Reuse only the DDL for a synthetic schema from the existing isolated loan
// fixture. No live database, attached_assets, or customer records are opened.
const temp = await mkdtemp(path.join(os.tmpdir(), "crm-legacy-toman-replacement-"));
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(temp, "fixture-worker.mjs");
const databasePath = path.join(temp, "fixture.sqlite");
const contractsRoot = path.join(temp, "contracts");
const templateDir = path.join(contractsRoot, "templates");
const generationDir = path.join(contractsRoot, "generations");
const fixtureBin = path.join(temp, "bin");
const secret = randomBytes(32).toString("hex");
const timestamp = new Date().toISOString();
const unchangedDurationWithoutMapping = process.env.TEST_TOMAN_UNCHANGED_DURATION === "1";
function makePdfBytes() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
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

const pdfBytes = makePdfBytes();
const oldPrincipal = "می شود مبلغ اعتبار \u202a12,345,678\u202cریال به مشتری پرداخت شود";
const tomanPrincipal = "می شود مبلغ اعتبار 12,345,678 تومان به مشتری پرداخت شود";
const durationText = "تعداد اقساط: 24";
const currentDocText = `${tomanPrincipal}\n${durationText}`;
let db;
let serverProcess;
let serverOutput = "";

function makeDocx(principalCurrency) {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  const paragraphs = [
    `می شود مبلغ اعتبار %principal% ${principalCurrency} به مشتری پرداخت شود`,
    unchangedDurationWithoutMapping ? `مدت قرارداد: %days% روز` : `تعداد اقساط: %installments%`,
  ].map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>${paragraphs}<w:sectPr/></w:body>
    </w:document>`);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

function renderDocx(template, principal, installments) {
  const zip = new PizZip(template);
  const document = zip.file("word/document.xml").asText()
    .replaceAll("%principal%", principal)
    .replaceAll("%installments%", installments)
    .replaceAll("%days%", "90");
  zip.file("word/document.xml", document);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

function tokenHash(token) {
  return createHmac("sha256", secret).update(token).digest("hex");
}

async function createSession(userId) {
  const token = randomBytes(24).toString("base64url");
  db.prepare(`INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at)
    VALUES(?,?,?,?)`).run(tokenHash(token), userId,
    new Date(Date.now() + 60 * 60_000).toISOString(), timestamp);
  return `crm_session=${token}`;
}

function request(origin, route, cookie, body, method = "POST") {
  return new Promise((resolve, reject) => {
    const headers = cookie ? { Cookie: cookie } : {};
    let payload;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    const outgoing = httpRequest(new URL(route, origin), { method, headers, agent: false }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: incoming.statusCode, data });
      });
    });
    outgoing.once("error", reject);
    if (payload) outgoing.end(payload);
    else outgoing.end();
  });
}

function uploadRequest(origin, route, cookie, filename, contentType, bytes) {
  return new Promise((resolve, reject) => {
    const boundary = `fixture-${randomUUID()}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const outgoing = httpRequest(new URL(route, origin), {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(payload.length),
      },
      agent: false,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: incoming.statusCode, data });
      });
    });
    outgoing.once("error", reject);
    outgoing.end(payload);
  });
}

function expectStatus(response, status, message) {
  assert.equal(response.status, status,
    `${message}; received ${JSON.stringify(response.data)}${response.status >= 500 ? `\n${serverOutput.slice(-3000)}` : ""}`);
  return response.data;
}

function suppressBackgroundSignatureScheduler(source) {
  const start = source.indexOf("const signatureSyncStartup = setTimeout(");
  const endMarker = "signatureSyncInterval.unref();";
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "fixture can isolate the production signature refresh scheduler");
  return `${source.slice(0, start)}// Background reconciliation timers are disabled only in this isolated harness;\n// guarded refresh remains explicitly exercised through the fixture bridge.\n${source.slice(end + endMarker.length)}`;
}

async function waitForServer() {
  serverProcess.stdout.on("data", (chunk) => { serverOutput += chunk; });
  serverProcess.stderr.on("data", (chunk) => { serverOutput += chunk; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (serverProcess.exitCode !== null) throw new Error(`Synthetic API exited during startup:\n${serverOutput}`);
    const port = serverOutput.match(/FIXTURE_PORT:(\d+)/)?.[1];
    if (port) return `http://127.0.0.1:${port}`;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Synthetic API did not start:\n${serverOutput}`);
}

try {
  const referenceFixture = await readFile(path.join(apiRoot, "scripts/approval-after-guarantor-fixture.mjs"), "utf8");
  const schemaStart = referenceFixture.indexOf("function schema() {");
  const schemaEnd = referenceFixture.indexOf("\n\nconst dbModule", schemaStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart, "the synthetic loan schema can be reused");
  const syntheticSchema = new Function(`${referenceFixture.slice(schemaStart, schemaEnd)}; return schema();`)()
    .replace("manual_values_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL,",
      "manual_values_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'processing',");
  db = new DatabaseSync(databasePath);
  db.exec(`${syntheticSchema}
    CREATE TABLE IF NOT EXISTS contract_number_sequences(
      period TEXT PRIMARY KEY,next_value INTEGER NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER,amount TEXT,kind TEXT
    );
    CREATE TABLE IF NOT EXISTS loan_physical_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,original_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,
      uploaded_by_user_id INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fixture_physical_check_unique
      ON loan_physical_checks(application_id,source,source_id);
  `);
  await Promise.all([
    mkdir(templateDir, { recursive: true, mode: 0o700 }),
    mkdir(generationDir, { recursive: true, mode: 0o700 }),
    mkdir(fixtureBin, { recursive: true, mode: 0o700 }),
  ]);

  const rialTemplate = makeDocx("ریال");
  const tomanTemplate = makeDocx("تومان");
  const rialTemplatePath = path.join(templateDir, `${randomUUID()}.docx`);
  const tomanTemplatePath = path.join(templateDir, `${randomUUID()}.docx`);
  await Promise.all([
    writeFile(rialTemplatePath, rialTemplate, { mode: 0o600 }),
    writeFile(tomanTemplatePath, tomanTemplate, { mode: 0o600 }),
    writeFile(path.join(temp, "legacy.pdf"), pdfBytes, { mode: 0o600 }),
    writeFile(path.join(temp, "legacy.pdf.txt"), oldPrincipal, { mode: 0o600 }),
    writeFile(path.join(temp, "toman.pdf"), pdfBytes, { mode: 0o600 }),
    writeFile(path.join(temp, "toman.pdf.txt"), currentDocText, { mode: 0o600 }),
  ]);
  const legacyHash = createHash("sha256").update(rialTemplate).digest("hex");
  const tomanHash = createHash("sha256").update(tomanTemplate).digest("hex");
  const templateMappings = JSON.stringify([
    { variable: "principal", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" },
    unchangedDurationWithoutMapping
      ? { variable: "days", sourceType: "loanPlan", loanPlanField: "loanPlan.contractDurationDays" }
      : { variable: "installments", sourceType: "loanPlan", loanPlanField: "loanPlan.installments" },
  ]);
  db.prepare(`INSERT INTO contract_templates
    (id,name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at)
    VALUES(4,'Synthetic legacy Rial','legacy.docx',?,?,?, ?,1,?,?)`).run(
    rialTemplatePath, legacyHash, JSON.stringify(["principal", unchangedDurationWithoutMapping ? "days" : "installments"]), templateMappings, timestamp, timestamp,
  );
  db.prepare(`INSERT INTO contract_templates
    (id,name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at)
    VALUES(8,'Synthetic approved Toman','toman.docx',?,?,?, ?,1,?,?)`).run(
    tomanTemplatePath, tomanHash, JSON.stringify(["principal", unchangedDurationWithoutMapping ? "days" : "installments"]), templateMappings, timestamp, timestamp,
  );

  const salespersonId = Number(db.prepare("INSERT INTO salespersons(name) VALUES('Synthetic Salesperson')").run().lastInsertRowid);
  const adminId = Number(db.prepare(`INSERT INTO users(username,full_name,role,salesperson_id,active,created_at)
    VALUES('fixture-admin','Synthetic Admin','admin',?,1,?)`).run(salespersonId, timestamp).lastInsertRowid);
  const registrarId = Number(db.prepare(`INSERT INTO users(username,full_name,role,salesperson_id,active,created_at)
    VALUES('fixture-registrar','Synthetic Registrar','registrar',?,1,?)`).run(salespersonId, timestamp).lastInsertRowid);
  const customerId = Number(db.prepare(`INSERT INTO customers
    (name,phone,national_code,birth_date_jalali,postal_code,salesperson_id,created_at,status)
    VALUES('Synthetic Legacy Customer','09123456789','1234567890','1370/01/01','1234567890',?,?,'in_progress')`)
    .run(salespersonId, timestamp).lastInsertRowid);
  const seedApprovedIdentityDocuments = async (id) => {
    const identityTypes = ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"];
    for (const [index, type] of identityTypes.entries()) {
      const storagePath = path.join(temp, `identity-${id}-${index}.pdf`);
      await writeFile(storagePath, pdfBytes, { mode: 0o600 });
      db.prepare(`INSERT INTO customer_identity_documents
        (customer_id,document_type,storage_path,original_name,mime_type,size_bytes,sha256,created_at,
         version,is_latest,approved_at,approved_by_user_id)
        VALUES(?,?,?,?,?,?,?,?,1,1,?,?)`)
        .run(id, type, storagePath, `identity-${index}.pdf`, "application/pdf",
          pdfBytes.length, createHash("sha256").update(pdfBytes).digest("hex"), timestamp, timestamp, adminId);
    }
  };
  await seedApprovedIdentityDocuments(customerId);
  const planId = Number(db.prepare(`INSERT INTO loan_plans
    (name,active,contract_template_id,primary_contract_template_id,principal_amount,installments,installment_terms,
     filing_fee_toman,required_documents,deduct_percents)
    VALUES('Synthetic Rial-to-Toman Plan',1,4,8,'12345678','24','[24]','0','[]','0')`).run().lastInsertRowid);
  const mappings = JSON.parse(templateMappings);
  const planSnapshot = JSON.stringify({
    id: planId, name: "Synthetic Rial-to-Toman Plan", contract_template_id: 4,
    primary_contract_template_id: 8, principal_amount: "12345678", installments: "24",
    contract_duration_days: "90",
  });
  const conditionSnapshot = JSON.stringify({ needs_guarantor: false, collateral_type: null });
  const applicationId = Number(db.prepare(`INSERT INTO loan_applications
    (customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,status,stage,duration_months,
     requested_duration_months,plan_snapshot_json,condition_snapshot_json,primary_manual_values_json,
     salesperson_id_snapshot,salesperson_name_snapshot,created_at,updated_at,initial_approval_at,
     initial_approval_by_user_id,initial_approval_reason,current_primary_generation_id,approved_amount,
     net_amount,approved_amount_source,funder_decision)
    VALUES(?,?,'[1]',?,'12345678','reviewing','customer_documents_review',24,24,?,?,'{}',?,
      'Synthetic Salesperson',?,?,? ,?,'approved terms recorded',NULL,'12345678','12345678',
      'initial_approval',NULL)`).run(
    customerId, adminId, planId, planSnapshot, conditionSnapshot, salespersonId,
    timestamp, timestamp, timestamp, adminId,
  ).lastInsertRowid);
  const legacyPdf = path.join(generationDir, `${randomUUID()}.pdf`);
  const legacyDocx = path.join(generationDir, `${randomUUID()}.docx`);
  const legacyRendered = renderDocx(rialTemplate, "12,345,678", "24");
  await Promise.all([
    writeFile(legacyPdf, pdfBytes, { mode: 0o600 }),
    writeFile(`${legacyPdf}.txt`, oldPrincipal, { mode: 0o600 }),
    writeFile(legacyDocx, legacyRendered, { mode: 0o600 }),
  ]);
  const legacyDocxBytes = await readFile(legacyDocx);
  const legacyGenerationId = Number(db.prepare(`INSERT INTO contract_generations
    (id,template_id,customer_id,loan_plan_id,loan_application_id,generation_purpose,mappings_snapshot_json,
     docx_path,pdf_path,docx_sha256,pdf_sha256,manual_values_json,status,provider_file_id,
     provider_contract_id,provider_status,created_by,created_at,updated_at)
    VALUES(100,4,?,?,?,'primary',?,?,?,?,?,'{"principal":"12345678","installments":"24"}',
    'signed','old-provider-file','old-provider-contract','accept',?,?,?)`).run(
    customerId, planId, applicationId, templateMappings, legacyDocx, legacyPdf,
    createHash("sha256").update(legacyDocxBytes).digest("hex"), createHash("sha256").update(pdfBytes).digest("hex"),
    adminId, timestamp, timestamp,
  ).lastInsertRowid);
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?").run(legacyGenerationId, applicationId);
  const legacyDocumentId = Number(db.prepare(`INSERT INTO loan_application_generated_documents
    (application_id,kind,contract_generation_id,link,status,created_at)
    VALUES(?,'primary',?,NULL,'pending',?)`).run(applicationId, legacyGenerationId, timestamp).lastInsertRowid);

  const downstreamLegacyCustomerId = Number(db.prepare(`INSERT INTO customers
    (name,phone,national_code,birth_date_jalali,postal_code,salesperson_id,created_at,status)
    VALUES('Synthetic Preapproved Legacy Customer','09123456788','1234567891','1370/01/01','1234567891',?,?,'in_progress')`)
    .run(salespersonId, timestamp).lastInsertRowid);
  await seedApprovedIdentityDocuments(downstreamLegacyCustomerId);
  const downstreamLegacyApplicationId = Number(db.prepare(`INSERT INTO loan_applications
    (customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,status,stage,duration_months,
     requested_duration_months,plan_snapshot_json,condition_snapshot_json,primary_manual_values_json,
     salesperson_id_snapshot,salesperson_name_snapshot,created_at,updated_at,current_primary_generation_id,
     approved_amount,net_amount,approved_amount_source,approved_amount_generation_id,
     approved_amount_reconciled_at,approved_amount_reconciled_by_user_id,funder_decision,expert_reviewed_at)
    VALUES(?,?,'[1]',?,'12345678','reviewing','funder_result_review',24,24,?,?,'{}',?,
     'Synthetic Salesperson',?,?,NULL,'12345678','12345678','signed_primary_reconciliation',
     NULL,?,?, 'approved',?)`).run(
    downstreamLegacyCustomerId, adminId, planId, planSnapshot, conditionSnapshot, salespersonId,
    timestamp, timestamp, timestamp, adminId, timestamp,
  ).lastInsertRowid);
  const downstreamLegacyPdf = path.join(generationDir, `${randomUUID()}.pdf`);
  const downstreamLegacyDocx = path.join(generationDir, `${randomUUID()}.docx`);
  const downstreamLegacyDocxBytes = renderDocx(rialTemplate, "12,345,678", "24");
  await Promise.all([
    writeFile(downstreamLegacyPdf, pdfBytes, { mode: 0o600 }),
    writeFile(`${downstreamLegacyPdf}.txt`, oldPrincipal, { mode: 0o600 }),
    writeFile(downstreamLegacyDocx, downstreamLegacyDocxBytes, { mode: 0o600 }),
  ]);
  const downstreamLegacyGenerationId = Number(db.prepare(`INSERT INTO contract_generations
    (id,template_id,customer_id,loan_plan_id,loan_application_id,generation_purpose,mappings_snapshot_json,
     docx_path,pdf_path,docx_sha256,pdf_sha256,manual_values_json,status,provider_file_id,
     provider_contract_id,provider_status,created_by,created_at,updated_at)
    VALUES(101,4,?,?,?,'primary',?,?,?,?,?,'{"principal":"12345678","installments":"24"}',
    'signed','synthetic-old-file-2','synthetic-old-contract-2','accept',?,?,?)`).run(
    downstreamLegacyCustomerId, planId, downstreamLegacyApplicationId, templateMappings,
    downstreamLegacyDocx, downstreamLegacyPdf,
    createHash("sha256").update(downstreamLegacyDocxBytes).digest("hex"),
    createHash("sha256").update(pdfBytes).digest("hex"), adminId, timestamp, timestamp,
  ).lastInsertRowid);
  db.prepare(`UPDATE loan_applications SET current_primary_generation_id=?,approved_amount_generation_id=? WHERE id=?`)
    .run(downstreamLegacyGenerationId, downstreamLegacyGenerationId, downstreamLegacyApplicationId);
  const downstreamLegacyDocumentId = Number(db.prepare(`INSERT INTO loan_application_generated_documents
    (application_id,kind,contract_generation_id,link,status,created_at)
    VALUES(?,'primary',?,'signed:synthetic-old-contract-2','signed',?)`)
    .run(downstreamLegacyApplicationId, downstreamLegacyGenerationId, timestamp).lastInsertRowid);
  db.prepare(`INSERT INTO loan_application_stage_history
    (application_id,from_stage,to_stage,action,reason,actor_id,created_at)
    VALUES(?,'expert_approval','funder_result_review','expert-approve',NULL,?,?)`)
    .run(downstreamLegacyApplicationId, registrarId, timestamp);
  const adminCookie = await createSession(adminId);
  const registrarCookie = await createSession(registrarId);

  // Only the allowlist data is replaced for the disposable test bundle. The
  // real DOCX/PDF path, exact SHA checks, source-clause checks, placeholder
  // mapping, rendered principal, and installment validators remain unchanged.
  const evidencePath = path.join(apiRoot, "src/lib/contract-evidence.ts");
  const evidenceHash = tomanHash;
  await build({
    stdin: {
      contents: `
        import express from "express";
        import cookieParser from "cookie-parser";
        import loanRoutes, { refreshGeneratedDocumentSignature } from "./src/routes/loan-applications";
        import contractRoutes from "./src/routes/contracts";
        import { requireAuth } from "./src/lib/auth";
        import { requirePermission } from "./src/lib/access-control";
        const app=express();
        let sentContracts=0, uploadedFiles=0, signatureInquiries=0;
        const deliveryKeys=[];
        globalThis.fetch=async(input,init)=>{
          const url=String(input), pathname=new URL(url).pathname;
          if(pathname.endsWith("/login")) return Response.json({accessToken:"synthetic-provider-token"});
          if(pathname.includes("checkUserActiveCertificate")) return Response.json({active:true});
          if(pathname.endsWith("/files")) { uploadedFiles++; return Response.json({fileId:"synthetic-provider-file"}); }
          if(pathname.endsWith("/contracts/sendContract")) { sentContracts++; deliveryKeys.push(new Headers(init.headers).get("X-Idempotency-Key")); return Response.json({contractId:"synthetic-toman-contract",status:"sent"}); }
          if(pathname.endsWith("/contracts/synthetic-toman-contract") ||
             pathname.endsWith("/contracts/old-provider-contract") ||
             pathname.endsWith("/contracts/synthetic-old-contract-2")) {
            signatureInquiries++;
            return Response.json({status:"accept"});
          }
          throw new Error("unexpected_external_request:"+url);
        };
        app.use(express.json(),cookieParser());
        app.use((req,_res,next)=>{req.log={warn(){},error(fields,message){process.stderr.write("FIXTURE_LOG:"+String(message)+":"+String(fields?.err?.stack||fields?.err||"")+"\\\\n")}};next()});
        app.get("/healthz",(_req,res)=>res.json({ok:true}));
        app.use("/api",requireAuth,contractRoutes);
        app.use("/api",requireAuth,loanRoutes);
        app.post("/fixture/guarded-signature-refresh/:applicationId/:documentId",requireAuth,
          requirePermission("loan_applications.update"),async(req,res)=>{
            try {
              res.json(await refreshGeneratedDocumentSignature(
                Number(req.params.applicationId),Number(req.params.documentId),Number(res.locals.authUser.id)));
            } catch(error) {
              res.status(409).json({error:String(error?.message||error)});
            }
          });
        app.get("/fixture/provider-counts",(_req,res)=>res.json({sentContracts,uploadedFiles,signatureInquiries,deliveryKeys}));
        app.use((error,_req,res,_next)=>{process.stderr.write("FIXTURE_ERROR:"+String(error?.stack||error)+"\\\\n");res.status(500).json({fixtureError:String(error?.message||error)})});
        const server=app.listen(Number(process.env.PORT),"127.0.0.1",()=>process.stdout.write("FIXTURE_PORT:"+server.address().port+"\\\\n"));
        process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
      `,
      resolveDir: apiRoot,
      sourcefile: "legacy-toman-replacement-fixture.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` },
    plugins: [{
      name: "isolated-legacy-toman-fixture",
      setup(buildApi) {
        buildApi.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "fixture-db", namespace: "legacy-toman-fixture" }));
        buildApi.onResolve({ filter: /^fixture-db$/ }, () => ({ path: "fixture-db", namespace: "legacy-toman-fixture" }));
        buildApi.onLoad({ filter: /^fixture-db$/, namespace: "legacy-toman-fixture" }, () => ({
          contents: `
            import { DatabaseSync } from "node:sqlite";
            import path from "node:path";
            export const databasePath=path.resolve(process.env.CRM_DATABASE_PATH);
            export const crmDb=new DatabaseSync(databasePath);
            crmDb.exec("PRAGMA foreign_keys=ON");
            export const queryRow=(sql,params=[])=>crmDb.prepare(sql).get(...params);
            export const queryRows=(sql,params=[])=>crmDb.prepare(sql).all(...params);
            export const execute=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
            export const executeChanges=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).changes);
            export const runTransaction=fn=>{crmDb.exec("BEGIN");try{const value=fn();crmDb.exec("COMMIT");return value}catch(error){crmDb.exec("ROLLBACK");throw error}};
            export const runImmediateTransaction=fn=>{crmDb.exec("PRAGMA busy_timeout=5000");crmDb.exec("BEGIN IMMEDIATE");try{const value=fn();crmDb.exec("COMMIT");return value}catch(error){crmDb.exec("ROLLBACK");throw error}};
          `,
          loader: "js",
        }));
        buildApi.onResolve({ filter: /\/wallets$/ }, () => ({ path: "fixture-wallets", namespace: "legacy-toman-fixture" }));
        buildApi.onLoad({ filter: /^fixture-wallets$/, namespace: "legacy-toman-fixture" }, () => ({
          contents: `
            import { crmDb } from "fixture-db";
            export const ensureWalletSchema=()=>{};
            export const getWalletSummaryReadOnly=()=>({cash:{balanceToman:"0"},credit:{balanceToman:"0"}});
            export const wallet=()=>({id:1,balance:"0"});
            export const creditLoanWallet=(applicationId,_customerId,amount,actorUserId)=>{
              crmDb.prepare("INSERT OR IGNORE INTO wallet_ledger_v2 (wallet_id,application_id,amount,kind,idempotency_key,actor_user_id,created_at) VALUES(NULL,?,?,'loan_credit',?,?,?)")
                .run(applicationId,amount,"loan-application:"+applicationId+":credit",actorUserId,new Date().toISOString());
            };
          `,
          loader: "js",
        }));
        buildApi.onLoad({ filter: /routes\/loan-applications\.ts$/ }, async (args) => ({
          contents: suppressBackgroundSignatureScheduler(await readFile(args.path, "utf8")),
          loader: "ts",
          resolveDir: path.dirname(args.path),
        }));
        buildApi.onLoad({ filter: /contract-evidence\.ts$/ }, async (args) => {
          let contents = await readFile(args.path, "utf8");
          const start = contents.indexOf("const ATTESTED_TEMPLATES:");
          const end = contents.indexOf("const ATTESTED_SOURCE_CLAUSE", start);
          assert.ok(start >= 0 && end > start, "test bundle can scope replacement to the immutable attestation table");
          contents = `${contents.slice(0, start)}const ATTESTED_TEMPLATES: Record<number, { sha256: string; currency: "ریال" | "تومان" }> = {
            8: { sha256: "${evidenceHash}", currency: "تومان" },
          };\n${contents.slice(end)}`;
          return { contents, loader: "ts" };
        });
      },
    }],
    logLevel: "silent",
  });

  const pdftotext = `#!/bin/sh\nif [ -f "$2.txt" ]; then cat "$2.txt"; else cat "$FIXTURE_TOMAN_TEXT"; fi\n`;
  const soffice = `#!/bin/sh\noutdir=""\ninput=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--outdir" ]; then shift; outdir="$1"; else input="$1"; fi\n  shift\ndone\nbase=$(basename "$input" .docx)\ncp "$FIXTURE_TOMAN_PDF" "$outdir/$base.pdf"\ncp "$FIXTURE_TOMAN_TEXT" "$outdir/$base.pdf.txt"\n`;
  await Promise.all([
    writeFile(path.join(fixtureBin, "pdftotext"), pdftotext, { mode: 0o700 }),
    writeFile(path.join(fixtureBin, "soffice"), soffice, { mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(path.join(fixtureBin, "pdftotext"), 0o700),
    chmod(path.join(fixtureBin, "soffice"), 0o700),
  ]);
  const evidenceBundle = path.join(temp, "evidence-check.mjs");
  await build({
    entryPoints: [evidencePath],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: evidenceBundle,
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` },
    logLevel: "silent",
  });
  process.env.PATH = `${fixtureBin}:${process.env.PATH}`;
  const evidence = await import(pathToFileURL(evidenceBundle).href);
  const legacyDocxBytesForEvidence = await readFile(legacyDocx);
  assert.equal(evidence.renderedPdfContainsLegacyRialPrincipal(legacyPdf, "12345678", {
    templateId: 4,
    templatePath: rialTemplatePath,
    templateRoot: templateDir,
    storedTemplateSha256: legacyHash,
    mappings,
    renderedDocxPath: legacyDocx,
    renderedDocxRoot: generationDir,
    renderedDocxSha256: createHash("sha256").update(legacyDocxBytesForEvidence).digest("hex"),
    renderedValues: { principal: "12345678" },
    renderedPdfRoot: generationDir,
    renderedPdfSha256: createHash("sha256").update(pdfBytes).digest("hex"),
  }), true, "the unmodified legacy Rial evidence validator accepts the precisely rendered synthetic principal");
  serverProcess = spawn(process.execPath, [bundle], {
    cwd: apiRoot,
    env: {
      ...process.env,
      PATH: `${fixtureBin}:${process.env.PATH}`,
      CRM_DATABASE_PATH: databasePath,
      SESSION_SECRET: secret,
      PORT: "0",
      CONTRACTS_STORAGE_DIR: contractsRoot,
      NODE_ENV: "production",
      EMZAME_BASE_URL: "http://fixture-provider.invalid/api/v1",
      EMZAME_NATIONAL_CODE: "0000000000",
      EMZAME_PASSWORD: "synthetic-only",
      EMZAME_BUSINESS_ID: "synthetic-business",
      FIXTURE_TOMAN_PDF: path.join(temp, "toman.pdf"),
      FIXTURE_TOMAN_TEXT: path.join(temp, "toman.pdf.txt"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const origin = await waitForServer();
  const appPath = `/api/loan-applications/${applicationId}`;

  if (unchangedDurationWithoutMapping) {
    for (const requested of [12, null]) {
      db.prepare("UPDATE loan_applications SET requested_duration_months=? WHERE id=?").run(requested, applicationId);
      const blocked = expectStatus(await request(origin, appPath, adminCookie, undefined, "GET"), 200,
        "missing installment mapping must still block changed or unknown original duration");
      assert.equal(blocked.tomanReplacementEligibility?.eligible, false);
      assert.equal(blocked.tomanReplacementEligibility?.blockedReason, "toman_template_terms_mapping_invalid");
    }
    db.prepare("UPDATE loan_applications SET requested_duration_months=24 WHERE id=?").run(applicationId);
  }

  let result = await request(origin, `${appPath}/authorize-toman-replacement`, null, {
    consent: true,
    reason: "ثبت اجازه از نشست بدون هویت",
    expectedGenerationId: legacyGenerationId,
    expectedApprovedAmount: "12345678",
    expectedDurationMonths: 24,
  });
  expectStatus(result, 401, "unauthenticated actors cannot authorize a legacy replacement");

  result = await request(origin, `${appPath}/authorize-toman-replacement`, registrarCookie, {
    consent: true,
    reason: "کارشناس اجازه نمی‌تواند صادر کند",
    expectedGenerationId: legacyGenerationId,
    expectedApprovedAmount: "12345678",
    expectedDurationMonths: 24,
  });
  expectStatus(result, 403, "a non-admin with loan update permission cannot authorize replacement");

  const staleConsent = await request(origin, `${appPath}/authorize-toman-replacement`, adminCookie, {
    consent: true,
    reason: "شرایط قدیمی را بررسی و رد می‌کنیم",
    expectedGenerationId: legacyGenerationId + 1,
    expectedApprovedAmount: "12345678",
    expectedDurationMonths: 24,
  });
  expectStatus(staleConsent, 409, "a stale source generation cannot be consented");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(applicationId).stage, "customer_documents_review");
  assert.equal(db.prepare("SELECT count(*) n FROM loan_application_stage_history WHERE application_id=?").get(applicationId).n, 0);

  const signedSnapshot = db.prepare(`SELECT status,provider_status,provider_contract_id,pdf_path,pdf_sha256
    FROM contract_generations WHERE id=?`).get(legacyGenerationId);
  const legacyPdfBytes = await readFile(signedSnapshot.pdf_path);
  const legacyDocumentSnapshot = db.prepare("SELECT link,status FROM loan_application_generated_documents WHERE id=?")
    .get(legacyDocumentId);
  const originalAmount = db.prepare("SELECT approved_amount FROM loan_applications WHERE id=?").get(applicationId).approved_amount;
  const sellerSnapshot = db.prepare("SELECT salesperson_id_snapshot,salesperson_name_snapshot FROM loan_applications WHERE id=?").get(applicationId);
  const consentBody = {
    consent: true,
    reason: "نسخه ریالی قدیمی با مبلغ مصوب پرونده تطبیق‌پذیر نیست",
    expectedGenerationId: legacyGenerationId,
    expectedApprovedAmount: "12345678",
    expectedDurationMonths: 24,
  };
  const authorization = expectStatus(
    await request(origin, `${appPath}/authorize-toman-replacement`, adminCookie, consentBody),
    200,
    "administrator consent is accepted only for the current pinned terms",
  );
  assert.equal(authorization.stage, "approved_contract_pending_signature");
  assert.equal(authorization.tomanReplacement?.authorized, true);
  assert.equal(authorization.tomanReplacement?.sourceGenerationId, legacyGenerationId);
  assert.equal(authorization.tomanReplacement?.approvedAmount, "12345678");
  assert.equal(authorization.tomanReplacement?.durationMonths, 24);
  assert.equal(authorization.tomanReplacement?.tomanTemplateId, 8);
  assert.equal(authorization.tomanReplacement?.priorStage, "customer_documents_review");
  assert.equal(authorization.tomanReplacement?.resumeStage, "customer_documents_review");
  assert.equal(db.prepare("SELECT approved_amount FROM loan_applications WHERE id=?").get(applicationId).approved_amount, originalAmount,
    "consent never multiplies or divides the stored Toman amount");
  assert.deepEqual(
    db.prepare("SELECT salesperson_id_snapshot,salesperson_name_snapshot FROM loan_applications WHERE id=?").get(applicationId),
    sellerSnapshot,
    "seller attribution remains unchanged during consent",
  );
  assert.deepEqual(
    db.prepare(`SELECT status,provider_status,provider_contract_id,pdf_path,pdf_sha256
      FROM contract_generations WHERE id=?`).get(legacyGenerationId),
    signedSnapshot,
    "the old signed generation and PDF evidence remain intact",
  );
  assert.deepEqual(await readFile(signedSnapshot.pdf_path), legacyPdfBytes,
    "the old signed PDF file is byte-for-byte unchanged");
  assert.deepEqual(
    db.prepare("SELECT link,status FROM loan_application_generated_documents WHERE id=?").get(legacyDocumentId),
    legacyDocumentSnapshot,
    "the old signature link and review status are unchanged",
  );
  const consentAudit = db.prepare(`SELECT actor_id,from_stage,to_stage,reason FROM loan_application_stage_history
    WHERE application_id=? AND action='authorize-toman-replacement'`).get(applicationId);
  assert.equal(consentAudit.actor_id, adminId);
  assert.equal(consentAudit.from_stage, "customer_documents_review");
  assert.equal(consentAudit.to_stage, "approved_contract_pending_signature");
  assert.match(consentAudit.reason, /12345678/);

  const duplicateConsent = expectStatus(
    await request(origin, `${appPath}/authorize-toman-replacement`, adminCookie, consentBody),
    200,
    "an identical consent retry is idempotent",
  );
  assert.equal(duplicateConsent.tomanReplacement?.authorized, true);
  assert.equal(db.prepare("SELECT count(*) n FROM loan_application_stage_history WHERE application_id=? AND action='authorize-toman-replacement'")
    .get(applicationId).n, 1, "consent retry does not duplicate the audit record");

  const providerCountsBeforeOldInquiry = (await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data;
  result = await request(origin,
    `${appPath}/generated-documents/${legacyDocumentId}/verify-signature`,
    adminCookie, {});
  expectStatus(result, 200, "manual signature inquiry performs a fresh read of the old provider-accepted contract");
  assert.equal(result.data.signed, true);
  assert.equal(result.data.providerStatus, "accept");
  const providerCountsAfterOldInquiry = (await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data;
  assert.equal(providerCountsAfterOldInquiry.signatureInquiries, providerCountsBeforeOldInquiry.signatureInquiries + 1,
    "manual signature status forces a fresh synthetic provider inquiry");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(applicationId).stage,
    "approved_contract_pending_signature", "a manual status inquiry never advances the replacement workflow");
  assert.deepEqual(db.prepare("SELECT link,status FROM loan_application_generated_documents WHERE id=?")
    .get(legacyDocumentId), legacyDocumentSnapshot,
  "manual inquiry cannot rewrite the old signature document record");
  assert.equal(db.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE application_id=?").get(applicationId).n, 0);
  const guardedSource = await request(origin,
    `/fixture/guarded-signature-refresh/${applicationId}/${legacyDocumentId}`, adminCookie, {});
  expectStatus(guardedSource, 200, "the legacy source signature can be observed but cannot advance replacement workflow");
  assert.equal(guardedSource.data.workflowAdvanced, false);
  const providerCountsAfterGuardedSource = (await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data;
  assert.equal(providerCountsAfterGuardedSource.signatureInquiries, providerCountsAfterOldInquiry.signatureInquiries,
    "guarded refresh refuses the legacy source before treating its provider acceptance as completion");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(applicationId).stage,
    "approved_contract_pending_signature");

  const generated = expectStatus(await request(origin, "/api/contracts/generate", adminCookie, {
    loanApplicationId: applicationId,
    manualValues: {},
  }), 201, "the pinned Toman replacement is generated through the existing contract path");
  const generationId = generated.id;
  const generationRow = db.prepare("SELECT * FROM contract_generations WHERE id=?").get(generationId);
  assert.equal(generationRow.generation_purpose, "legacy_toman_replacement");
  assert.equal(generationRow.template_id, 8);
  assert.equal(generationRow.loan_application_id, applicationId);
  assert.equal(generationRow.status, "generated");
  assert.deepEqual(JSON.parse(generationRow.mappings_snapshot_json), mappings,
    "the replacement stores its actual source mappings");
  assert.equal(JSON.parse(generationRow.manual_values_json).principal, "12,345,678");
  assert.equal(JSON.parse(generationRow.manual_values_json)[unchangedDurationWithoutMapping ? "days" : "installments"],
    unchangedDurationWithoutMapping ? "90" : "24");
  const retryGeneration = expectStatus(await request(origin, "/api/contracts/generate", adminCookie, {
    loanApplicationId: applicationId,
    manualValues: {},
  }), 200, "retrying generation reuses the prior immutable Toman document");
  assert.equal(retryGeneration.id, generationId);
  assert.equal(db.prepare(`SELECT count(*) n FROM contract_generations
    WHERE loan_application_id=? AND generation_purpose='legacy_toman_replacement'`).get(applicationId).n, 1,
  "retry does not create a duplicate generation");

  const sent = expectStatus(await request(origin, `/api/contracts/generations/${generationId}/send`, adminCookie, {}),
    200, "the replacement is sent using existing delivery controls");
  assert.equal(sent.status, "sent");
  assert.equal(db.prepare("SELECT status FROM contract_generations WHERE id=?").get(generationId).status, "sent");
  const countsAfterFirstSend = (await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data;
  assert.equal(countsAfterFirstSend.sentContracts, 1);
  assert.equal(countsAfterFirstSend.uploadedFiles, 1);
  assert.equal(countsAfterFirstSend.signatureInquiries, 1,
    "the old source's explicit manual status request queried provider state before replacement delivery");
  const sendRetry = expectStatus(await request(origin, `/api/contracts/generations/${generationId}/send`, adminCookie, {}),
    200, "a repeated send request returns the existing provider contract");
  assert.equal(sendRetry.providerContractId, "synthetic-toman-contract");
  assert.deepEqual(
    (await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data,
    countsAfterFirstSend,
    "resending the same generation never uploads or sends a second provider contract",
  );

  const linked = expectStatus(await request(origin, `${appPath}/generated-documents`, adminCookie, {
    kind: "primary",
    contractGenerationId: generationId,
  }), 201, "the sent replacement is linked through the existing application route");
  const replacementDocumentId = linked.id;

  const originalPdf = await readFile(generationRow.pdf_path);
  const manualReplacementStatus = expectStatus(await request(origin,
    `${appPath}/generated-documents/${replacementDocumentId}/verify-signature`,
    adminCookie, {}), 200, "manual inquiry records the current replacement signature and advances the pending case");
  assert.equal(manualReplacementStatus.signed, true);
  const providerCountsAfterReplacementInquiry = (await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data;
  assert.equal(providerCountsAfterReplacementInquiry.signatureInquiries,
    providerCountsAfterOldInquiry.signatureInquiries + 1,
    "manual replacement inquiry also forces a fresh provider read");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(applicationId).stage,
    "customer_documents_review", "manual status inquiry advances a signed pending replacement");
  assert.equal(db.prepare("SELECT link FROM loan_application_generated_documents WHERE id=?")
    .get(replacementDocumentId).link, "signed:synthetic-toman-contract", "manual inquiry records the current signature");
  assert.equal(db.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE application_id=?").get(applicationId).n, 0);

  const assertSignatureIndependentOfFinancialProof = async (label) => {
    const response = await request(origin,
      `/fixture/guarded-signature-refresh/${applicationId}/${replacementDocumentId}`,
      adminCookie, {});
    expectStatus(response, 200, label);
    assert.equal(response.data.signed, true);
    assert.equal(response.data.workflowAdvanced, false, "repeated observations never advance twice");
    assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(applicationId).stage,
      "customer_documents_review", "financial proof is checked at later approval and funding gates");
    assert.equal(db.prepare("SELECT link FROM loan_application_generated_documents WHERE id=?")
      .get(replacementDocumentId).link, "signed:synthetic-toman-contract", "provider signature remains distinct from financial proof");
  };
  const generationValues = JSON.parse(generationRow.manual_values_json);
  db.prepare("UPDATE contract_generations SET manual_values_json=? WHERE id=?").run(
    JSON.stringify({ ...generationValues, principal: "12345679" }), generationId);
  await assertSignatureIndependentOfFinancialProof("signature observation does not recheck principal");
  db.prepare("UPDATE contract_generations SET manual_values_json=? WHERE id=?").run(
    JSON.stringify({ ...generationValues, installments: "36" }), generationId);
  await assertSignatureIndependentOfFinancialProof("signature observation does not recheck duration");
  db.prepare("UPDATE contract_generations SET manual_values_json=?,pdf_sha256='incorrect-hash' WHERE id=?")
    .run(JSON.stringify(generationValues), generationId);
  await assertSignatureIndependentOfFinancialProof("signature observation does not recheck PDF hashes");
  await writeFile(generationRow.pdf_path, originalPdf, { mode: 0o600 });
  db.prepare("UPDATE contract_generations SET manual_values_json=?,pdf_sha256=? WHERE id=?")
    .run(JSON.stringify(generationValues), createHash("sha256").update(originalPdf).digest("hex"), generationId);
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?")
    .run(legacyGenerationId, applicationId);
  result = await request(origin, `/fixture/guarded-signature-refresh/${applicationId}/${replacementDocumentId}`, adminCookie, {});
  expectStatus(result, 409, "a noncurrent replacement generation cannot complete guarded verification even with matching terms and hash");
  assert.equal(result.data.error, "primary_contract_not_current");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(applicationId).stage,
    "customer_documents_review");
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?").run(generationId, applicationId);

  const verified = expectStatus(await request(origin,
    `/fixture/guarded-signature-refresh/${applicationId}/${replacementDocumentId}`,
    adminCookie, {}), 200, "a repeated observation of the current signed generation is idempotent");
  assert.equal(verified.signed, true);
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(applicationId).stage,
    "customer_documents_review");
  assert.equal(db.prepare("SELECT status FROM contract_generations WHERE id=?").get(generationId).status, "signed");
  assert.equal(db.prepare("SELECT link FROM loan_application_generated_documents WHERE id=?").get(replacementDocumentId).link,
    "signed:synthetic-toman-contract");
  assert.equal(db.prepare("SELECT approved_amount FROM loan_applications WHERE id=?").get(applicationId).approved_amount,
    "12345678", "the verified replacement never converts the saved monetary value");
  assert.equal(db.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE application_id=?").get(applicationId).n,
    0, "replacement verification alone never funds the loan");
  const verifiedAudit = db.prepare(`SELECT actor_id,actor_customer_id,from_stage,to_stage,reason FROM loan_application_stage_history
    WHERE application_id=? AND action='toman-replacement-signature-verified'`).get(applicationId);
  assert.equal(verifiedAudit.actor_id, null,
    "provider signature observations do not attribute the customer's signature to the staff member checking it");
  assert.equal(verifiedAudit.actor_customer_id, null);
  assert.equal(verifiedAudit.from_stage, "approved_contract_pending_signature");
  assert.equal(verifiedAudit.to_stage, "customer_documents_review");
  assert.equal(JSON.parse(verifiedAudit.reason).sourceGenerationId, legacyGenerationId);
  assert.equal(JSON.parse(verifiedAudit.reason).replacementGenerationId, generationId);
  assert.deepEqual(
    db.prepare("SELECT action FROM loan_application_stage_history WHERE application_id=? ORDER BY id")
      .all(applicationId).map((row) => row.action),
    ["authorize-toman-replacement", `generated_document_linked:primary:${replacementDocumentId}`, "toman-replacement-signature-verified"],
    "the audit history records one consent, the document link, and its verified replacement without rewriting prior history",
  );
  assert.deepEqual(
    db.prepare(`SELECT status,provider_status,provider_contract_id,pdf_path,pdf_sha256
      FROM contract_generations WHERE id=?`).get(legacyGenerationId),
    signedSnapshot,
    "the original signed PDF, status, and provider attribution are still preserved after completion",
  );
  assert.deepEqual(await readFile(signedSnapshot.pdf_path), legacyPdfBytes,
    "the original signed PDF bytes remain unchanged after replacement verification");
  assert.deepEqual(
    db.prepare("SELECT link,status FROM loan_application_generated_documents WHERE id=?").get(legacyDocumentId),
    legacyDocumentSnapshot,
    "the old generated-document signature link and review status remain intact",
  );
  assert.deepEqual(
    db.prepare("SELECT salesperson_id_snapshot,salesperson_name_snapshot FROM loan_applications WHERE id=?").get(applicationId),
    sellerSnapshot,
    "the historical salesperson snapshot is preserved",
  );

  const downstreamGate = async ({ caseName, id, generationId: currentGenerationId, sourceGenerationId,
    documentId, expectExpertApproval, initialStage }) => {
    const pathForCase = `/api/loan-applications/${id}`;
    const beforeApp = db.prepare(`SELECT approved_amount,duration_months,net_amount,
      salesperson_id_snapshot,salesperson_name_snapshot,current_primary_generation_id
      FROM loan_applications WHERE id=?`).get(id);
    const beforeHistory = db.prepare("SELECT action,from_stage,to_stage,reason,actor_id FROM loan_application_stage_history WHERE application_id=? ORDER BY id")
      .all(id);
    const sourcePdfPath = db.prepare("SELECT pdf_path FROM contract_generations WHERE id=?").get(sourceGenerationId).pdf_path;
    const sourcePdf = await readFile(sourcePdfPath);
    const sourceGeneration = db.prepare(`SELECT status,provider_status,provider_contract_id,pdf_path,pdf_sha256
      FROM contract_generations WHERE id=?`).get(sourceGenerationId);
    const sourceDocument = db.prepare("SELECT link,status FROM loan_application_generated_documents WHERE id=?")
      .get(documentId);

    if (expectExpertApproval) {
      expectStatus(await request(origin,
        `${pathForCase}/generated-documents/${db.prepare("SELECT id FROM loan_application_generated_documents WHERE application_id=? AND contract_generation_id=?")
          .get(id, currentGenerationId).id}/review`,
        registrarCookie, { decision: "approved" }), 200,
      `${caseName}: registrar verifies the signed replacement document`);
      expectStatus(await request(origin, `${pathForCase}/review-customer-documents`, registrarCookie, {}),
        200, `${caseName}: reviewed customer documents continue to collateral review`);
      assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(id).stage, "collateral_upload");
      expectStatus(await request(origin, `${pathForCase}/submit-collateral`, adminCookie, {}),
        200, `${caseName}: the plan with no collateral requirements submits the collateral section`);
      expectStatus(await request(origin, `${pathForCase}/review-collateral`, registrarCookie, {}),
        200, `${caseName}: collateral review reaches expert approval`);
      assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(id).stage, "expert_approval");
      await assertDownstreamGateRejectsTampering({
        caseName, id, currentGenerationId, sourceGenerationId,
        route: `${pathForCase}/expert-approve`, label: "expert approval",
      });
      expectStatus(await request(origin, `${pathForCase}/expert-approve`, registrarCookie, {}),
        200, `${caseName}: verified replacement evidence allows expert approval`);
      assert.equal(db.prepare("SELECT stage,funder_decision FROM loan_applications WHERE id=?").get(id).stage,
        "funder_result_review");
      assert.equal(db.prepare("SELECT funder_decision FROM loan_applications WHERE id=?").get(id).funder_decision, "approved");
    } else {
      assert.equal(initialStage, "funder_result_review");
      assert.equal(db.prepare("SELECT initial_approval_at FROM loan_applications WHERE id=?").get(id).initial_approval_at, null);
      assert.equal(db.prepare("SELECT funder_decision FROM loan_applications WHERE id=?").get(id).funder_decision, "approved",
        `${caseName}: this is a previously expert-approved legacy case with no initial approval timestamp`);
    }

    expectStatus(await request(origin, `${pathForCase}/confirm-funder`, registrarCookie, {}),
      200, `${caseName}: the approved funder decision proceeds to physical submission`);
    assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(id).stage, "physical_documents_submission");
    const uploaded = expectStatus(await uploadRequest(origin, `${pathForCase}/physical-documents`, registrarCookie,
      "synthetic-physical-evidence.pdf", "application/pdf", pdfBytes),
    201, `${caseName}: a synthetic physical document is submitted through the HTTP upload route`);
    expectStatus(await request(origin, `${pathForCase}/submit-physical-documents`, registrarCookie,
      { noPhysicalDocuments: false }), 200,
    `${caseName}: the uploaded physical document enters registrar review`);
    assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(id).stage, "physical_documents_review");
    const prepared = expectStatus(await request(origin, `${pathForCase}/prepare-physical-checks`, registrarCookie, {}),
      200, `${caseName}: physical review materializes checks for the uploaded evidence`);
    assert.equal(prepared.physicalChecks.length, 1);
    assert.equal(prepared.physicalChecks[0].status, "pending");
    expectStatus(await request(origin,
      `${pathForCase}/physical-checks/${prepared.physicalChecks[0].id}/review`,
      registrarCookie, { decision: "approved" }), 200,
    `${caseName}: registrar approves the synthetic physical evidence`);
    await assertDownstreamGateRejectsTampering({
      caseName, id, currentGenerationId, sourceGenerationId,
      route: `${pathForCase}/approve-physical-documents`, label: "physical-document approval",
    });
    expectStatus(await request(origin, `${pathForCase}/approve-physical-documents`, registrarCookie, {}),
      200, `${caseName}: verified replacement evidence permits physical-document approval`);
    assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(id).stage, "wallet_charge_pending");
    await assertDownstreamGateRejectsTampering({
      caseName, id, currentGenerationId, sourceGenerationId,
      route: `${pathForCase}/approve-wallet-charge`, label: "wallet-charge approval",
    });
    expectStatus(await request(origin, `${pathForCase}/approve-wallet-charge`, registrarCookie, {}),
      200, `${caseName}: verified replacement evidence permits the wallet-charge review gate`);
    assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(id).stage, "admin_approval");
    await assertDownstreamGateRejectsTampering({
      caseName, id, currentGenerationId, sourceGenerationId,
      route: `${pathForCase}/admin-approve`, label: "final funding",
    });
    assert.equal(db.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE application_id=?").get(id).n, 0,
      `${caseName}: all tampered evidence is rejected before any wallet credit`);
    expectStatus(await request(origin, `${pathForCase}/admin-approve`, adminCookie, {
      reason: "مدارک و قرارداد امضاشده بررسی شدند",
    }), 200, `${caseName}: a verified replacement reaches final approval and funding`);

    const funded = db.prepare("SELECT stage,status,approved_amount,duration_months,net_amount FROM loan_applications WHERE id=?").get(id);
    assert.equal(funded.stage, "completed");
    assert.equal(funded.status, "approved");
    assert.equal(funded.approved_amount, beforeApp.approved_amount,
      `${caseName}: funding leaves the stored approved amount unchanged`);
    assert.equal(funded.duration_months, beforeApp.duration_months,
      `${caseName}: funding leaves the approved duration unchanged`);
    assert.equal(funded.net_amount, beforeApp.net_amount,
      `${caseName}: funding leaves the saved net disbursement unchanged`);
    const credit = db.prepare(`SELECT amount,kind,idempotency_key FROM wallet_ledger_v2 WHERE application_id=?`).get(id);
    assert.equal(credit.amount, funded.net_amount);
    assert.equal(credit.kind, "loan_credit");
    assert.equal(credit.idempotency_key, `loan-application:${id}:credit`);
    assert.deepEqual(
      db.prepare(`SELECT status,provider_status,provider_contract_id,pdf_path,pdf_sha256
        FROM contract_generations WHERE id=?`).get(sourceGenerationId),
      sourceGeneration,
      `${caseName}: the original Rial contract metadata and signature are preserved after funding`,
    );
    assert.deepEqual(await readFile(sourcePdfPath), sourcePdf,
      `${caseName}: the original Rial PDF bytes remain unchanged after funding`);
    assert.deepEqual(
      db.prepare("SELECT link,status FROM loan_application_generated_documents WHERE id=?").get(documentId),
      sourceDocument,
      `${caseName}: the original signature record remains intact after funding`,
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(db.prepare("SELECT salesperson_id_snapshot,salesperson_name_snapshot FROM loan_applications WHERE id=?").get(id))),
      { salesperson_id_snapshot: beforeApp.salesperson_id_snapshot, salesperson_name_snapshot: beforeApp.salesperson_name_snapshot },
      `${caseName}: historical salesperson attribution remains unchanged after funding`,
    );
    assert.deepEqual(
      db.prepare("SELECT action,from_stage,to_stage,reason,actor_id FROM loan_application_stage_history WHERE application_id=? ORDER BY id")
        .all(id).slice(0, beforeHistory.length),
      beforeHistory,
      `${caseName}: downstream events append to, but never rewrite, prior audit history`,
    );
    assert.equal(db.prepare("SELECT approved_amount_generation_id FROM loan_applications WHERE id=?").get(id)
      .approved_amount_generation_id, currentGenerationId,
    `${caseName}: funded terms remain reconciled to the current signed replacement`);

    async function assertDownstreamGateRejectsTampering({ caseName, id, currentGenerationId, sourceGenerationId, route, label }) {
      const generation = db.prepare("SELECT * FROM contract_generations WHERE id=?").get(currentGenerationId);
      const app = db.prepare("SELECT * FROM loan_applications WHERE id=?").get(id);
      const sourceValues = JSON.parse(generation.manual_values_json);
      const savedPdf = await readFile(generation.pdf_path);
      const corruptPdf = Buffer.concat([savedPdf, Buffer.from("\n% fixture tamper\n")]);
      const invalidCases = [
        ["principal", () => db.prepare("UPDATE contract_generations SET manual_values_json=? WHERE id=?")
          .run(JSON.stringify({ ...sourceValues, principal: "99999999" }), currentGenerationId)],
        ["duration", () => unchangedDurationWithoutMapping
          ? db.prepare("UPDATE loan_applications SET requested_duration_months=12 WHERE id=?").run(id)
          : db.prepare("UPDATE contract_generations SET manual_values_json=? WHERE id=?")
            .run(JSON.stringify({ ...sourceValues, installments: "36" }), currentGenerationId)],
        ["hash", () => writeFile(generation.pdf_path, corruptPdf, { mode: 0o600 })],
        ["current generation", () => db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?")
          .run(sourceGenerationId, id)],
      ];
      for (const [tamperName, corrupt] of invalidCases) {
        await corrupt();
        const blocked = await request(origin, route, tamperName === "current generation" ? adminCookie : adminCookie,
          route.endsWith("/expert-approve") ? {} : { reason: "synthetic blocked funding evidence" });
        expectStatus(blocked, 409, `${caseName}: changed ${tamperName} evidence blocks ${label}`);
        assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(id).stage, app.stage,
          `${caseName}: failed ${label} leaves the workflow in its original stage`);
        assert.equal(db.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE application_id=?").get(id).n, 0,
          `${caseName}: changed ${tamperName} cannot create a wallet credit`);
        assert.equal(db.prepare("SELECT approved_amount FROM loan_applications WHERE id=?").get(id).approved_amount,
          app.approved_amount, `${caseName}: changed ${tamperName} cannot rewrite the approved amount`);
        assert.equal(db.prepare("SELECT duration_months FROM loan_applications WHERE id=?").get(id).duration_months,
          app.duration_months, `${caseName}: changed ${tamperName} cannot rewrite the approved duration`);
        db.prepare("UPDATE contract_generations SET manual_values_json=?,pdf_sha256=? WHERE id=?")
          .run(generation.manual_values_json, generation.pdf_sha256, currentGenerationId);
        db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?")
          .run(generation.id, id);
        db.prepare("UPDATE loan_applications SET requested_duration_months=? WHERE id=?")
          .run(app.requested_duration_months, id);
        await writeFile(generation.pdf_path, savedPdf, { mode: 0o600 });
      }
    }
  };

  await downstreamGate({
    caseName: "initially approved application",
    id: applicationId,
    generationId,
    sourceGenerationId: legacyGenerationId,
    documentId: legacyDocumentId,
    expectExpertApproval: true,
    initialStage: "customer_documents_review",
  });

  assert.equal(db.prepare("SELECT initial_approval_at FROM loan_applications WHERE id=?").get(downstreamLegacyApplicationId).initial_approval_at, null);
  assert.equal(db.prepare("SELECT funder_decision FROM loan_applications WHERE id=?").get(downstreamLegacyApplicationId).funder_decision, "approved");
  assert.equal(db.prepare(`SELECT count(*) n FROM loan_application_stage_history
    WHERE application_id=? AND action='expert-approve'`).get(downstreamLegacyApplicationId).n, 1,
  "the no-initial-approval legacy case is already recorded as expert-approved before replacement consent");
  const downstreamLegacySnapshot = db.prepare(`SELECT status,provider_status,provider_contract_id,pdf_path,pdf_sha256
    FROM contract_generations WHERE id=?`).get(downstreamLegacyGenerationId);
  const downstreamLegacyPdfBytes = await readFile(downstreamLegacySnapshot.pdf_path);
  const downstreamLegacySeller = db.prepare(`SELECT salesperson_id_snapshot,salesperson_name_snapshot,approved_amount,duration_months
    FROM loan_applications WHERE id=?`).get(downstreamLegacyApplicationId);
  const downstreamLegacyConsent = expectStatus(await request(origin,
    `/api/loan-applications/${downstreamLegacyApplicationId}/authorize-toman-replacement`, adminCookie, {
      consent: true,
      reason: "قرارداد ریالی پیشین با شرایط تصویب‌شده تطبیق ندارد",
      expectedGenerationId: downstreamLegacyGenerationId,
      expectedApprovedAmount: "12345678",
      expectedDurationMonths: 24,
    }), 200, "administrator consent pins terms for a legacy case without an initial approval timestamp");
  assert.equal(downstreamLegacyConsent.tomanReplacement?.resumeStage, "funder_result_review");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(downstreamLegacyApplicationId).stage,
    "approved_contract_pending_signature");
  const downstreamLegacyPath = `/api/loan-applications/${downstreamLegacyApplicationId}`;
  const downstreamLegacyGenerated = expectStatus(await request(origin, "/api/contracts/generate", adminCookie, {
    loanApplicationId: downstreamLegacyApplicationId, manualValues: {},
  }), 201, "the already-approved legacy case generates its pinned replacement");
  const downstreamLegacyGenerationIdCurrent = downstreamLegacyGenerated.id;
  const downstreamLegacyGeneration = db.prepare("SELECT * FROM contract_generations WHERE id=?").get(downstreamLegacyGenerationIdCurrent);
  const downstreamLegacySent = expectStatus(await request(origin,
    `/api/contracts/generations/${downstreamLegacyGenerationIdCurrent}/send`, adminCookie, {}),
  200, "the legacy replacement is sent through the existing provider route");
  assert.equal(downstreamLegacySent.status, "sent");
  const downstreamLegacyLinked = expectStatus(await request(origin, `${downstreamLegacyPath}/generated-documents`, adminCookie, {
    kind: "primary", contractGenerationId: downstreamLegacyGenerationIdCurrent,
  }), 201, "the legacy replacement is linked as the current primary generation");
  const downstreamLegacyReplacementDocumentId = downstreamLegacyLinked.id;
  assert.equal(db.prepare("SELECT current_primary_generation_id FROM loan_applications WHERE id=?").get(downstreamLegacyApplicationId)
    .current_primary_generation_id, downstreamLegacyGenerationIdCurrent);
  const downstreamLegacyManualStatus = expectStatus(await request(origin,
    `${downstreamLegacyPath}/generated-documents/${downstreamLegacyReplacementDocumentId}/verify-signature`,
    adminCookie, {}), 200, "manual provider inquiry reports the replacement acceptance for the previously expert-approved legacy case");
  assert.equal(downstreamLegacyManualStatus.signed, true);
  const providerCountsAfterLegacyInquiry = (await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data;
  assert.equal(providerCountsAfterLegacyInquiry.signatureInquiries, providerCountsAfterReplacementInquiry.signatureInquiries + 1,
    "legacy replacement manual inquiry obtains a fresh provider response");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(downstreamLegacyApplicationId).stage,
    "funder_result_review", "manual status inquiry advances the signed legacy replacement to its review stage");
  assert.equal(db.prepare("SELECT link FROM loan_application_generated_documents WHERE id=?")
    .get(downstreamLegacyReplacementDocumentId).link, "signed:synthetic-toman-contract");
  const downstreamLegacyVerified = expectStatus(await request(origin,
    `/fixture/guarded-signature-refresh/${downstreamLegacyApplicationId}/${downstreamLegacyReplacementDocumentId}`,
    adminCookie, {}), 200, "guarded financial verification restores the previously expert-approved legacy stage");
  assert.equal(downstreamLegacyVerified.signed, true);
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=?").get(downstreamLegacyApplicationId).stage,
    "funder_result_review");
  assert.equal(db.prepare("SELECT approved_amount FROM loan_applications WHERE id=?").get(downstreamLegacyApplicationId).approved_amount,
    downstreamLegacySeller.approved_amount, "legacy signature verification leaves its stored Toman principal unchanged");
  assert.equal(db.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE application_id=?").get(downstreamLegacyApplicationId).n, 0);
  await downstreamGate({
    caseName: "previously approved legacy application without initial_approval_at",
    id: downstreamLegacyApplicationId,
    generationId: downstreamLegacyGenerationIdCurrent,
    sourceGenerationId: downstreamLegacyGenerationId,
    documentId: downstreamLegacyDocumentId,
    expectExpertApproval: false,
    initialStage: "funder_result_review",
  });
  assert.deepEqual(
    db.prepare(`SELECT status,provider_status,provider_contract_id,pdf_path,pdf_sha256
      FROM contract_generations WHERE id=?`).get(downstreamLegacyGenerationId),
    downstreamLegacySnapshot,
    "the old Rial signature and evidence remain unchanged in the previously approved legacy case",
  );
  assert.deepEqual(await readFile(downstreamLegacySnapshot.pdf_path), downstreamLegacyPdfBytes,
    "the old legacy PDF remains byte-for-byte unchanged after funding");
  assert.equal(db.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE application_id=? AND idempotency_key=?")
    .get(downstreamLegacyApplicationId, `loan-application:${downstreamLegacyApplicationId}:credit`).n, 1,
  "a valid replacement funds the previously approved legacy case exactly once");

  // A current signed Toman contract with matching terms is not a Rial repair
  // candidate. Clone only the disposable synthetic rows; no consent is copied.
  const cloneRow = (table, row, overrides) => {
    const values = { ...row, ...overrides };
    delete values.id;
    const keys = Object.keys(values);
    return Number(db.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
      .run(...keys.map(key => values[key])).lastInsertRowid);
  };
  const matchingId = cloneRow("loan_applications",
    db.prepare("SELECT * FROM loan_applications WHERE id=?").get(applicationId), {
      stage: "customer_documents_review", status: "reviewing", new_case_workflow: 1,
      plan_snapshot_json: JSON.stringify({ ...JSON.parse(planSnapshot), contract_template_id: 8 }),
    });
  const matchingGenerationId = cloneRow("contract_generations",
    db.prepare("SELECT * FROM contract_generations WHERE id=?").get(generationId), {
      loan_application_id: matchingId, generation_purpose: "primary",
    });
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=?,approved_amount_generation_id=? WHERE id=?")
    .run(matchingGenerationId, matchingGenerationId, matchingId);
  db.prepare(`INSERT INTO loan_application_generated_documents
    (application_id,kind,contract_generation_id,link,status,created_at)
    VALUES(?,'primary',?,'signed:synthetic-toman-contract','signed',?)`)
    .run(matchingId, matchingGenerationId, timestamp);
  const matching = expectStatus(await request(origin, `/api/loan-applications/${matchingId}`,
    adminCookie, undefined, "GET"), 200, "verified current Toman contract remains an ordinary case");
  assert.equal(matching.tomanReplacementEligibility, null,
    "a matching current Toman signature must not show the legacy Rial warning or request replacement consent");
  assert.equal(matching.stage, "customer_documents_review");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM loan_application_stage_history WHERE application_id=?")
    .get(matchingId).n, 0, "reading eligibility does not mutate the case or manufacture consent");

  // A new requested-primary case whose upload succeeded but send was interrupted.
  // Exercise the real generate/send routes, not a relaxed copy of their guards.
  const recoverySnapshot = { ...JSON.parse(planSnapshot), contract_template_id: 8 };
  const recoveryId = Number(db.prepare(`INSERT INTO loan_applications
    (customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,status,stage,
     new_case_workflow,duration_months,requested_duration_months,plan_snapshot_json,
     condition_snapshot_json,primary_manual_values_json,created_at,updated_at)
    VALUES(?,?,'[1]',?,'12345678','requested','draft',1,24,24,?,?,'{}',?,?)`)
    .run(customerId, adminId, planId, JSON.stringify(recoverySnapshot), conditionSnapshot, timestamp, timestamp).lastInsertRowid);
  const recoveryBody = { loanApplicationId: recoveryId, manualValues: {} };
  const recovery = expectStatus(await request(origin, "/api/contracts/generate", adminCookie, recoveryBody),
    201, "generate a synthetic requested-primary PDF for interrupted delivery recovery");
  const recoveryRow = db.prepare("SELECT * FROM contract_generations WHERE id=?").get(recovery.id);
  const recoveryPdf = await readFile(recoveryRow.pdf_path);
  const markInterrupted = () => db.prepare(`UPDATE contract_generations SET status='failed',
    error_message='stale_send',provider_file_id='synthetic-provider-file',
    provider_contract_id=NULL,provider_status=NULL,provider_idempotency_key='synthetic-stable-delivery-key',
    send_claim_id=NULL,send_claim_expires_at=NULL WHERE id=?`).run(recovery.id);
  markInterrupted();
  for (const [label, sql] of [
    ["missing delivery identity", "provider_idempotency_key=NULL"],
    ["unknown failure", "error_message='unknown_failure'"],
    ["artifact integrity failure", "error_message='artifact_integrity'"],
    ["active send claim", "send_claim_id='synthetic-active-claim'"],
    ["provider contract already exists", "provider_contract_id='synthetic-existing-contract'"],
    ["provider rejection", "provider_status='reject'"],
    ["changed principal", `manual_values_json='${JSON.stringify({ principal: "999", installments: "24" })}'`],
  ]) {
    markInterrupted();
    db.prepare("UPDATE contract_generations SET manual_values_json=? WHERE id=?").run(recoveryRow.manual_values_json, recovery.id);
    db.prepare(`UPDATE contract_generations SET ${sql} WHERE id=?`).run(recovery.id);
    expectStatus(await request(origin, "/api/contracts/generate", adminCookie, recoveryBody), 409,
      "interrupted recovery still blocks " + label);
  }
  markInterrupted();
  db.prepare("UPDATE contract_generations SET manual_values_json=? WHERE id=?").run(recoveryRow.manual_values_json, recovery.id);
  await writeFile(recoveryRow.pdf_path, Buffer.from("tampered-synthetic-pdf"));
  expectStatus(await request(origin, "/api/contracts/generate", adminCookie, recoveryBody), 409,
    "interrupted recovery cannot bypass immutable PDF hash checks");
  await writeFile(recoveryRow.pdf_path, recoveryPdf);
  const countsBeforeRecovery = (await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data;
  const reused = expectStatus(await request(origin, "/api/contracts/generate", adminCookie, recoveryBody), 200,
    "interrupted requested-primary generation reuses its existing PDF and identifier");
  assert.equal(reused.id, recovery.id);
  assert.equal(reused.status, "failed", "reuse is not evidence of provider acceptance");
  expectStatus(await request(origin, `/api/contracts/generations/${recovery.id}/send`, adminCookie, {}), 200,
    "explicit retry continues the existing uploaded delivery");
  const countsAfterRecovery = (await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data;
  assert.equal(countsAfterRecovery.uploadedFiles, countsBeforeRecovery.uploadedFiles,
    "retry never uploads a second PDF");
  assert.equal(countsAfterRecovery.sentContracts, countsBeforeRecovery.sentContracts + 1);
  assert.equal(countsAfterRecovery.deliveryKeys.at(-1), "synthetic-stable-delivery-key",
    "retry keeps the existing provider idempotency identity");
  expectStatus(await request(origin, `/api/contracts/generations/${recovery.id}/send`, adminCookie, {}), 200,
    "a successful send retry returns the existing provider acceptance");
  assert.deepEqual((await request(origin, "/fixture/provider-counts", adminCookie, undefined, "GET")).data, countsAfterRecovery,
    "repeated send does not contact the provider again");
  assert.equal(db.prepare("SELECT count(*) n FROM contract_generations WHERE loan_application_id=?").get(recoveryId).n, 1);
  const recoveredRow = db.prepare("SELECT * FROM contract_generations WHERE id=?").get(recovery.id);
  assert.equal(recoveredRow.contract_number, recoveryRow.contract_number);
  assert.equal(recoveredRow.pdf_sha256, recoveryRow.pdf_sha256);
  assert.equal(recoveredRow.manual_values_json, recoveryRow.manual_values_json);
  assert.deepEqual(await readFile(recoveredRow.pdf_path), recoveryPdf);
  console.log(`Legacy Toman replacement HTTP fixture passed (${unchangedDurationWithoutMapping ? "unchanged duration, daily-only template" : "mapped installments"}): financial/signature guards and interrupted primary delivery reuse passed with synthetic data only.`);
} finally {
  db?.close();
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  await rm(temp, { recursive: true, force: true });
}