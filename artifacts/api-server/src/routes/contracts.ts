import { Router, type Request, type Response } from "express";
import multer from "multer";
import JSZip from "jszip";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import yauzl from "yauzl";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { crmDb, databasePath, execute, queryRow, queryRows } from "../lib/crm-db";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";

const router = Router();
const root = path.resolve(process.env.CONTRACTS_STORAGE_DIR || path.join(path.dirname(databasePath), "contracts"));
const analysisDir = path.join(root, "analyses");
const templateDir = path.join(root, "templates");
const generationDir = path.join(root, "generations");
for (const dir of [root, analysisDir, templateDir, generationDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const MAX_DOCX = 20 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_UNCOMPRESSED = 80 * 1024 * 1024;
const MAX_ENTRY = 50 * 1024 * 1024;
const MAX_RATIO = 200;
const placeholderPattern = () => /%%([A-Za-z][A-Za-z0-9_.-]*)%%|%([A-Za-z][A-Za-z0-9_.-]*)%/g;
const conversionQueue: Array<{ input: string; resolve: (path: string) => void; reject: (error: Error) => void }> = [];
const activeConversionPids = new Set<number>();
let activeConversions = 0;
const pumpConversions = () => {
  while (activeConversions < 2 && conversionQueue.length) {
    const job = conversionQueue.shift()!; activeConversions++;
    runConversion(job.input).then(job.resolve, job.reject).finally(() => { activeConversions--; pumpConversions(); });
  }
};
for (const file of fs.readdirSync(analysisDir)) {
  const full = path.join(analysisDir, file);
  try { if (Date.now() - fs.statSync(full).mtimeMs > 30 * 60_000) fs.rmSync(full, { force: true }); } catch { /* stale cleanup is best effort */ }
}
let emzameToken: { value: string; expires: number } | undefined;
const sending = new Set<number>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCX, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || file.originalname.toLowerCase().endsWith(".docx")),
});
const now = () => new Date().toISOString();
const sha = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const tokenHash = (token: string) => sha(Buffer.from(token));
function cleanupAnalyses(): void {
  const expired = queryRows<{ staged_path: string }>("SELECT staged_path FROM contract_template_analyses WHERE expires_at < ? AND consumed_at IS NULL", [now()]);
  for (const row of expired) { try { fs.rmSync(row.staged_path, { force: true }); } catch { /* cleanup is best effort */ } }
  execute("DELETE FROM contract_template_analyses WHERE expires_at < ? OR consumed_at IS NOT NULL", [now()]);
}
const analysisCleanup = setInterval(cleanupAnalyses, 30 * 60_000);
analysisCleanup.unref();
function reconcileGenerations(): void {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  crmDb.prepare("UPDATE contract_generations SET status='failed',error_message='stale_job',updated_at=? WHERE status='processing' AND updated_at < ?").run(now(), cutoff);
  crmDb.prepare("UPDATE contract_generations SET status='failed',error_message='stale_send',send_claim_id=NULL,send_claim_expires_at=NULL,updated_at=? WHERE status='sending' AND send_claim_expires_at < ?").run(now(), now());
}
reconcileGenerations();
const safePath = (file: string) => {
  const absolute = path.resolve(file);
  return path.relative(root, absolute).startsWith("..") || path.isAbsolute(path.relative(root, absolute)) ? null : absolute;
};
function regularPath(file: string, expectedDir?: string): string {
  const safe = safePath(file);
  if (!safe) throw new Error("Unsafe storage path");
  if (expectedDir && path.dirname(safe) !== path.join(root, expectedDir)) throw new Error("Invalid artifact directory");
  if (!/^[a-f0-9-]{20,}\.(docx|pdf)$/i.test(path.basename(safe))) throw new Error("Invalid artifact filename");
  const stat = fs.lstatSync(safe);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Stored artifact is not a regular file");
  return safe;
}
function json<T>(value: unknown, fallback: T): T { try { return JSON.parse(String(value)); } catch { return fallback; } }
type ContractMappingInput = { variable: string; customerField?: string | null; label?: string };
function normalizeMappings(variables: string[], mappings: unknown): ContractMappingInput[] | null {
  if (!Array.isArray(mappings) || mappings.length !== variables.length) return null;
  const typed = mappings as ContractMappingInput[];
  if (new Set(typed.map((mapping) => mapping.variable)).size !== typed.length) return null;
  const normalized = typed.map((mapping) => ({
    variable: String(mapping.variable || ""),
    customerField: mapping.customerField ?? null,
    label: mapping.label?.trim() || mapping.variable,
  }));
  const provided = new Map(normalized.map((mapping) => [mapping.variable, mapping]));
  if (variables.some((variable) => !provided.has(variable))) return null;
  if ([...provided.keys()].some((variable) => !variables.includes(variable))) return null;
  if ([...provided.values()].some((mapping) => mapping.customerField != null && !fields[mapping.customerField])) return null;
  if (normalized.some((mapping) => mapping.customerField == null && !mapping.label.trim())) return null;
  return normalized;
}
function templateResponse(row: any) {
  return {
    id: row.id,
    name: row.name,
    originalFilename: row.original_filename,
    variables: json(row.variables_json, []),
    mappings: json(row.mappings_json, []),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    downloadUrl: `/api/contracts/templates/${row.id}/download`,
  };
}
function user(req: Request, res: Response) { return res.locals.authUser as AuthUser; }
function canCustomer(auth: AuthUser, customerId: number): boolean {
  if (auth.customerScope !== "assigned") return true;
  return Boolean(queryRow("SELECT 1 FROM customers WHERE id = ? AND salesperson_id = ?", [customerId, auth.salespersonId]));
}
function customer(id: number) {
  return queryRow<Record<string, unknown>>(
    `SELECT c.*, s.name salesperson_name FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=?`, [id],
  );
}
const fields: Record<string, string> = {
  "customer.id": "شناسه مشتری", "customer.name": "نام مشتری", "customer.phone": "تلفن",
  "customer.nationalCode": "کد ملی", "customer.postalCode": "کد پستی", "customer.birthDateJalali": "تاریخ تولد",
  "customer.creditScore": "امتیاز اعتبار", "customer.creditRank": "رتبه اعتبار", "customer.creditCheckedAt": "تاریخ بررسی اعتبار",
  "customer.verificationStatus": "وضعیت احراز", "customer.isUrgent": "فوری", "customer.salespersonName": "کارشناس فروش",
  "customer.createdAt": "تاریخ ایجاد", "current.dateJalali": "تاریخ جاری",
};
function fieldValue(c: Record<string, unknown>, key: string): string {
  if (key === "current.dateJalali") return new Intl.DateTimeFormat("fa-IR-u-ca-persian").format(new Date());
  const map: Record<string, string> = { id: "id", name: "name", phone: "phone", nationalCode: "national_code", postalCode: "postal_code", birthDateJalali: "birth_date_jalali", creditScore: "credit_score", creditRank: "credit_rank", creditCheckedAt: "credit_checked_at", verificationStatus: "verification_status", isUrgent: "is_urgent", salespersonName: "salesperson_name", createdAt: "created_at" };
  const value = c[map[key.replace("customer.", "")] || key];
  return value == null ? "" : String(value);
}
const decodeXml = (value: string) => value
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#([0-9]+);/g, (_m, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const storyText = (xml: string) => decodeXml(xml.replace(/<[^>]*>/g, ""));
function validateZip(data: Buffer): Promise<void> {
  if (data.length > MAX_DOCX || data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return Promise.reject(new Error("Invalid DOCX ZIP"));
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new Error("Invalid DOCX ZIP"));
      const names = new Set<string>(); let total = 0; let count = 0; let done = false;
      const fail = (message: string) => { if (done) return; done = true; try { zip.close(); } catch { /* closed */ } reject(new Error(message)); };
      zip.readEntry();
      zip.on("entry", (entry) => {
        count++; const name = entry.fileName; const normalized = path.posix.normalize(name.replaceAll("\\", "/"));
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
        const isDirectory = name.endsWith("/") || (entry.externalFileAttributes & 0x10) !== 0;
        if (count > MAX_ENTRIES || names.has(name) || !name || name.includes("\\") || path.posix.isAbsolute(name) ||
          normalized !== name || normalized === ".." || normalized.startsWith("../") || unixType === 0o120000 ||
          (isDirectory && !name.endsWith("/"))) return fail("Unsafe DOCX ZIP entry");
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) return fail("Encrypted DOCX is not supported");
        const size = Number(entry.uncompressedSize); const compressed = Number(entry.compressedSize);
        if (isDirectory && (size !== 0 || compressed !== 0)) return fail("Unsafe DOCX ZIP entry");
        if (!Number.isSafeInteger(size) || size > MAX_ENTRY || (compressed === 0 ? size > 0 : size / compressed > MAX_RATIO))
          return fail("DOCX compression limits exceeded");
        total += size; if (total > MAX_UNCOMPRESSED) return fail("DOCX uncompressed size limit exceeded");
        names.add(name); zip.readEntry();
      });
      zip.on("end", () => { if (!done) { done = true; resolve(); } });
      zip.on("error", () => fail("Malformed DOCX ZIP"));
    });
  });
}
async function xmlEntries(data: Buffer) {
  await validateZip(data);
  if (data.length > MAX_DOCX || data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) throw new Error("Invalid DOCX ZIP");
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files);
  if (names.length > MAX_ENTRIES) throw new Error("DOCX contains too many ZIP entries");
  let total = 0;
  for (const name of names) {
    const normalized = path.posix.normalize(name.replaceAll("\\", "/"));
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized !== name.replaceAll("\\", "/")) throw new Error("Unsafe DOCX ZIP entry");
    if (zip.files[name].dir) {
      if (!name.endsWith("/")) throw new Error("Unsafe DOCX ZIP entry");
      continue;
    }
    const entry = zip.files[name] as any;
    const size = Number(entry.uncompressedSize ?? 0);
    const compressed = Number(entry.compressedSize ?? 0);
    if (size > MAX_ENTRY || (compressed > 0 && size / compressed > MAX_RATIO)) throw new Error("DOCX ZIP compression limits exceeded");
    total += size;
    if (total > MAX_UNCOMPRESSED) throw new Error("DOCX uncompressed size limit exceeded");
  }
  const entries: Array<{ name: string; text: string }> = [];
  const contentTypes = zip.file("[Content_Types].xml");
  if (!contentTypes || !(await contentTypes.async("string")).includes("wordprocessingml.document.main+xml")) throw new Error("Invalid DOCX content types");
  for (const name of names) if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) {
    const text = await zip.file(name)!.async("string");
    if (!text.includes("<") || !text.includes(">")) throw new Error(`Malformed XML in ${name}`);
    entries.push({ name, text });
  }
  for (const name of names) if (/^word\/.*\.xml$/.test(name) && !entries.some((entry) => entry.name === name)) {
    const text = await zip.file(name)!.async("string");
    if (placeholderPattern().test(storyText(text))) throw new Error(`Placeholders in unsupported Word part: ${name}`);
  }
  if (!entries.some((x) => x.name === "word/document.xml") || !zip.file("word/_rels/document.xml.rels")) throw new Error("DOCX document or relationships missing");
  return { zip, entries };
}
function detect(entries: Array<{ text: string }>): string[] {
  const out = new Set<string>();
  for (const { text } of entries) {
    // Word frequently splits a placeholder over several w:r/w:t runs.
    // Matching the XML-stripped stream catches both normal and split runs.
    const streams = [text, storyText(text)];
    for (const stream of streams) {
      for (const match of stream.matchAll(placeholderPattern())) out.add(match[1] ?? match[2]);
    }
  }
  return [...out].sort();
}
function assignedGeneration(id: number, auth: AuthUser) {
  const row = queryRow<Record<string, unknown>>(`SELECT g.*, t.name template_name FROM contract_generations g JOIN contract_templates t ON t.id=g.template_id WHERE g.id=? AND g.deleted_at IS NULL`, [id]);
  return row && canCustomer(auth, Number(row.customer_id)) ? row : undefined;
}
function downloadUrl(id: number, kind: string) { return `/api/contracts/generations/${id}/download/${kind}`; }

router.get("/contracts/customer-fields", requirePermission("contracts.view"), (_req, res) => {
  res.json({ fields: Object.entries(fields).map(([value, label]) => ({ value, label })) });
});

router.post("/contracts/templates/analyze", requirePermission("contracts.manage"), upload.single("file"), async (req, res): Promise<void> => {
  try {
    if (!req.file?.buffer) { res.status(400).json({ error: "DOCX file is required" }); return; }
    const { entries } = await xmlEntries(req.file.buffer);
    cleanupAnalyses();
    const token = crypto.randomBytes(24).toString("base64url");
    const stagedPath = path.join(analysisDir, `${crypto.randomUUID()}.docx`);
    await fsp.writeFile(stagedPath, req.file.buffer, { mode: 0o600 });
    const expires = new Date(Date.now() + 30 * 60_000).toISOString();
    execute("INSERT INTO contract_template_analyses(token_hash,user_id,staged_path,original_filename,variables_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
      [tokenHash(token), user(req, res).id, stagedPath, req.file.originalname.slice(0, 255), JSON.stringify(detect(entries)), expires, now()]);
    res.json({ uploadToken: token, variables: detect(entries), expiresAt: expires });
  } catch (e) { res.status(400).json({ error: "Invalid DOCX template" }); }
});

router.post("/contracts/templates", requirePermission("contracts.manage"), async (req, res): Promise<void> => {
  const { name, uploadToken, mappings } = req.body as { name?: string; uploadToken?: string; mappings?: ContractMappingInput[] };
  if (!name?.trim() || name.trim().length > 160 || !uploadToken || !/^[A-Za-z0-9_-]{20,}$/.test(uploadToken)) { res.status(400).json({ error: "name and uploadToken are required" }); return; }
  cleanupAnalyses();
  const metadata = queryRow<any>("SELECT * FROM contract_template_analyses WHERE token_hash=? AND user_id=? AND consumed_at IS NULL AND expires_at > ?", [tokenHash(uploadToken), user(req, res).id, now()]);
  const source = metadata?.staged_path ? safePath(String(metadata.staged_path)) : null;
  if (!source || !metadata) { res.status(400).json({ error: "Upload analysis expired" }); return; }
  try { const stat = fs.lstatSync(source); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid"); } catch { res.status(400).json({ error: "Upload analysis expired" }); return; }
  try {
    const data = await fsp.readFile(source); const { entries } = await xmlEntries(data); const variables = detect(entries);
    const normalizedMappings = normalizeMappings(variables, mappings);
    if (!normalizedMappings) { res.status(400).json({ error: "Every detected variable requires a valid mapping" }); return; }
    const destination = path.join(templateDir, `${crypto.randomUUID()}.docx`);
    await fsp.rename(source, destination);
    let id: number;
    try {
      crmDb.exec("BEGIN IMMEDIATE");
      id = execute(`INSERT INTO contract_templates (name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [name.trim(), String(metadata.original_filename), destination, sha(data), JSON.stringify(variables), JSON.stringify(normalizedMappings), user(req, res).id, now(), now()]);
      crmDb.prepare("UPDATE contract_template_analyses SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(now(), metadata.id);
      crmDb.exec("COMMIT");
    } catch (error) {
      try { crmDb.exec("ROLLBACK"); } catch { /* rollback best effort */ }
      await fsp.rm(destination, { force: true }); throw error;
    }
    res.status(201).json({ id, name: name.trim(), variables, mappings: normalizedMappings });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : "Invalid template" }); }
});

router.get("/contracts/templates", requirePermission("contracts.view"), (_req, res) => res.json(queryRows("SELECT * FROM contract_templates WHERE deleted_at IS NULL ORDER BY created_at DESC").map(templateResponse)));
router.get("/contracts/templates/:id", requirePermission("contracts.view"), (req, res) => {
  const r = queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [Number(req.params.id)]);
  if (!r) return res.status(404).json({ error: "Template not found" }); return res.json(templateResponse(r));
});
router.patch("/contracts/templates/:id", requirePermission("contracts.manage"), (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isSafeInteger(id) && id > 0 ? queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [id]) : undefined;
  if (!row) { res.status(404).json({ error: "Template not found" }); return; }
  const { name, mappings } = req.body as { name?: string; mappings?: ContractMappingInput[] };
  const normalizedName = name?.trim();
  const normalizedMappings = normalizeMappings(json<string[]>(row.variables_json, []), mappings);
  if (!normalizedName || normalizedName.length > 160 || !normalizedMappings) { res.status(400).json({ error: "Template name and mappings are invalid" }); return; }
  const updatedAt = now();
  execute("UPDATE contract_templates SET name=?,mappings_json=?,updated_at=? WHERE id=? AND deleted_at IS NULL", [normalizedName, JSON.stringify(normalizedMappings), updatedAt, id]);
  res.json(templateResponse({ ...row, name: normalizedName, mappings_json: JSON.stringify(normalizedMappings), updated_at: updatedAt }));
});
router.delete("/contracts/templates/:id", requirePermission("contracts.manage"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(404).json({ error: "Template not found" }); return; }
  const deleted = crmDb.prepare("UPDATE contract_templates SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now(), now(), id);
  if (!deleted.changes) { res.status(404).json({ error: "Template not found" }); return; }
  res.status(204).send();
});
router.get("/contracts/templates/:id/download", requirePermission("contracts.view"), (req, res) => {
  const r = queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [Number(req.params.id)]); let p: string | null = null;
  try { if (r) p = regularPath(r.storage_path, "templates"); } catch { p = null; }
  if (!r || !p) return res.status(404).json({ error: "Template not found" }); return res.download(p, `${String(r.name).replace(/[^a-zA-Z0-9._-]/g, "_")}.docx`);
});

router.post("/contracts/generate", requirePermission("contracts.generate"), async (req, res): Promise<void> => {
  const { templateId, customerId, manualValues = {} } = req.body as { templateId?: number; customerId?: number; manualValues?: Record<string, string> };
  const auth = user(req, res); const t = templateId && queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [templateId]); const c = customerId && customer(Number(customerId));
  if (!t || !c) { res.status(404).json({ error: "Template or customer not found" }); return; } if (!canCustomer(auth, Number(customerId))) { res.status(403).json({ error: "Customer is outside your assignment" }); return; }
  if (!manualValues || typeof manualValues !== "object" || Array.isArray(manualValues)) { res.status(400).json({ error: "manualValues must be an object" }); return; }
  const mappings = json<Array<{ variable: string; customerField?: string | null }>>(t.mappings_json, []);
  const manualKeys = new Set(mappings.filter((m) => !m.customerField).map((m) => m.variable));
  if (Object.keys(manualValues).some((key) => !manualKeys.has(key))) { res.status(400).json({ error: "Unknown manual variable" }); return; }
  let manualTotal = 0; for (let [key, value] of Object.entries(manualValues)) {
    if (typeof value !== "string" || !(value = value.trim())) { res.status(400).json({ error: `Missing value for ${key}` }); return; }
    if (value.length > 5000) { res.status(400).json({ error: "Manual values are too long" }); return; } manualTotal += value.length;
  }
  if (manualTotal > 50 * 1024) { res.status(400).json({ error: "Manual values are too long" }); return; }
  const values: Record<string, string> = {};
  for (const m of mappings) { values[m.variable] = m.customerField ? fieldValue(c, m.customerField) : String(manualValues[m.variable] ?? ""); if (!values[m.variable].trim()) { res.status(400).json({ error: `Missing value for ${m.variable}` }); return; } }
  let generationId = 0; let partialDocx = ""; let partialPdf = ""; let stage = "read_template";
  try {
    const source = await fsp.readFile(regularPath(t.storage_path, "templates"));
    // docxtemplater merges placeholders split across w:r/w:t nodes while retaining
    // the first run's formatting. Custom delimiters avoid interpreting Word fields.
    stage = "prepare_template";
    const sourceZip = await JSZip.loadAsync(source);
    for (const name of Object.keys(sourceZip.files)) {
      if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) {
        const xml = await sourceZip.file(name)!.async("string");
        sourceZip.file(name, xml.replaceAll("%%", "%"));
      }
    }
    stage = "compile_template";
    const templater = new Docxtemplater(new PizZip(await sourceZip.generateAsync({ type: "nodebuffer" })), {
      delimiters: { start: "%", end: "%" },
      paragraphLoop: true,
      linebreaks: true,
    });
    stage = "render_template";
    templater.render(values);
    const docx = templater.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
    stage = "validate_rendered_document";
    const rendered = await xmlEntries(docx);
    if (detect(rendered.entries).length) throw new Error("Rendered DOCX contains unresolved placeholders");
    stage = "save_generation";
    const id = execute(`INSERT INTO contract_generations (template_id,customer_id,docx_path,docx_sha256,manual_values_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`, [t.id, customerId, "", sha(docx), JSON.stringify(manualValues), auth.id, now(), now()]);
    generationId = id; const docxPath = path.join(generationDir, `${crypto.randomUUID()}.docx`); partialDocx = docxPath; await fsp.writeFile(docxPath, docx, { mode: 0o600 }); crmDb.prepare("UPDATE contract_generations SET docx_path=?,manual_values_json=?,status='processing' WHERE id=?").run(docxPath, JSON.stringify(values), id);
    stage = "convert_pdf";
    const pdfPath = await convertPdf(docxPath); partialPdf = pdfPath; crmDb.prepare("UPDATE contract_generations SET pdf_path=?,pdf_sha256=?,status='generated',updated_at=? WHERE id=?").run(pdfPath, sha(await fsp.readFile(pdfPath)), now(), id);
    res.status(201).json({ id, status: "generated", docxUrl: downloadUrl(id, "docx"), pdfUrl: downloadUrl(id, "pdf") });
  } catch (e) {
    req.log.error({ err: e, stage, templateId: Number(templateId), customerId: Number(customerId), generationId: generationId || undefined }, "contract generation failed");
    if (generationId) crmDb.prepare("UPDATE contract_generations SET status='failed',error_message=?,updated_at=? WHERE id=?").run("Document generation failed", now(), generationId);
    for (const file of [partialDocx, partialPdf]) if (file) fs.rmSync(file, { force: true });
    res.status(503).json({ error: e instanceof Error && e.message === "conversion_queue_full" ? "conversion_queue_full" : "document_generation_failed" });
  }
});
async function runConversion(input: string): Promise<string> {
  const out = path.join(root, `convert-${crypto.randomUUID()}`), profile = path.join(root, `lo-${crypto.randomUUID()}`);
  await fsp.mkdir(out, { mode: 0o700 }); await fsp.mkdir(profile, { mode: 0o700 });
  let child: ReturnType<typeof spawn> | undefined; let settled = false;
  const kill = () => { if (!child?.pid) return; try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* exited */ } } };
  try {
    const result = await new Promise<number>((resolve, reject) => {
      child = spawn("soffice", ["--headless", `-env:UserInstallation=file://${profile}`, "--convert-to", "pdf", "--outdir", out, input], { stdio: "ignore", detached: true });
      if (child.pid) activeConversionPids.add(child.pid);
      const timer = setTimeout(() => { kill(); if (!settled) { settled = true; reject(new Error("converter_timeout")); } }, 30_000);
      child.once("error", () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error("converter_unavailable")); } });
      child.once("exit", (code) => { clearTimeout(timer); if (child?.pid) activeConversionPids.delete(child.pid); if (!settled) { settled = true; resolve(code ?? 1); } });
    });
    const pdf = path.join(out, `${path.basename(input, ".docx")}.pdf`); const stat = await fsp.lstat(pdf);
    const head = Buffer.alloc(5); const fd = await fsp.open(pdf, "r"); await fd.read(head, 0, 5, 0); await fd.close();
    if (result !== 0 || !stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 80 * 1024 * 1024 || head.toString() !== "%PDF-") throw new Error("conversion_invalid");
    const finalPath = path.join(generationDir, `${crypto.randomUUID()}.pdf`);
    await fsp.rename(pdf, finalPath); const finalStat = await fsp.lstat(finalPath);
    if (!finalStat.isFile() || finalStat.isSymbolicLink() || (await fsp.readFile(finalPath)).subarray(0, 5).toString() !== "%PDF-") throw new Error("conversion_invalid");
    return finalPath;
  } finally { if (child?.pid) activeConversionPids.delete(child.pid); await fsp.rm(out, { recursive: true, force: true }); await fsp.rm(profile, { recursive: true, force: true }); }
}
function convertPdf(input: string): Promise<string> {
  if (conversionQueue.length >= 20) return Promise.reject(new Error("conversion_queue_full"));
  return new Promise((resolve, reject) => { conversionQueue.push({ input, resolve, reject }); pumpConversions(); });
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    for (const pid of activeConversionPids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
    }
    process.exit(0);
  });
}
router.get("/contracts/generations/:id/download/:kind", requirePermission("contracts.view"), async (req, res) => { const r = assignedGeneration(Number(req.params.id), user(req, res)); let p: string | null = null; try { if (r) p = regularPath(req.params.kind === "pdf" ? String(r.pdf_path) : String(r.docx_path), "generations"); } catch { p = null; } if (!r || !p) return res.status(404).json({ error: "Generation not found" }); return res.download(p, `contract-${r.id}.${req.params.kind === "pdf" ? "pdf" : "docx"}`); });
router.get("/contracts/generations/:id", requirePermission("contracts.view"), (req, res) => { const r = assignedGeneration(Number(req.params.id), user(req, res)); if (!r) return res.status(404).json({ error: "Generation not found" }); return res.json({ id: r.id, templateId: r.template_id, templateName: r.template_name, customerId: r.customer_id, status: r.status, providerFileId: r.provider_file_id, providerContractId: r.provider_contract_id, providerStatus: r.provider_status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, manualValues: json(r.manual_values_json, {}), docxUrl: downloadUrl(Number(r.id), "docx"), pdfUrl: r.pdf_path ? downloadUrl(Number(r.id), "pdf") : null }); });
router.delete("/contracts/generations/:id", requirePermission("contracts.manage"), (req, res) => {
  const id = Number(req.params.id); const auth = user(req, res); const row = assignedGeneration(id, auth);
  if (!row) return res.status(404).json({ error: "Generation not found" });
  if (row.status === "sending") return res.status(409).json({ error: "Generation is already being sent" });
  const result = crmDb.prepare("UPDATE contract_generations SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now(), now(), id);
  if (Number(result.changes) !== 1) return res.status(404).json({ error: "Generation not found" });
  return res.status(204).end();
});
router.get("/contracts/generations", requirePermission("contracts.view"), (req, res) => {
  const auth = user(req, res);
  const rows = queryRows<any>(`SELECT g.id,g.template_id,g.customer_id,g.status,g.pdf_path,g.provider_file_id,g.provider_contract_id,g.created_at,g.updated_at,t.name template_name
    FROM contract_generations g JOIN contract_templates t ON t.id=g.template_id
    WHERE g.deleted_at IS NULL ${auth.customerScope === "assigned" ? "AND g.customer_id IN (SELECT id FROM customers WHERE salesperson_id=?)" : ""}
    ORDER BY g.created_at DESC`, auth.customerScope === "assigned" ? [auth.salespersonId] : []);
  return res.json(rows.map((row) => ({
    id: row.id, templateId: row.template_id, templateName: row.template_name, customerId: row.customer_id,
    status: row.status, providerFileId: row.provider_file_id, providerContractId: row.provider_contract_id, providerStatus: row.provider_status,
    createdAt: row.created_at, updatedAt: row.updated_at,
    docxUrl: downloadUrl(row.id, "docx"), pdfUrl: row.pdf_path ? downloadUrl(row.id, "pdf") : null,
  })));
});

async function emzameAuth(base: string): Promise<string> {
  if (emzameToken && emzameToken.expires > Date.now() + 30_000) return emzameToken.value;
  const nationalCode = process.env.EMZAME_NATIONAL_CODE;
  const password = process.env.EMZAME_PASSWORD;
  if (!nationalCode || !password) throw new Error("Emzame credentials are not configured");
  const response = await fetchWithTimeout(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nationalCode, password }) }, 20_000, true);
  const body = await response.json().catch(() => ({})) as any;
  const token = body.accessToken ?? body.data?.accessToken ?? body.token;
  if (!response.ok || typeof token !== "string") throw new Error("Emzame login failed");
  emzameToken = { value: token, expires: Date.now() + 10 * 60_000 };
  return token;
}
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, retry = false): Promise<globalThis.Response> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (retry && attempt === 0 && response.status >= 500) { await response.body?.cancel(); continue; }
      return response;
    } catch (error) { if (!retry || attempt > 0) throw error; }
    finally { clearTimeout(timer); }
  }
}
function certificateActive(body: any): boolean {
  const candidates = [body?.active, body?.isActive, body?.data?.active, body?.data?.isActive, body?.result?.active];
  const explicit = candidates.find((value) => typeof value === "boolean");
  if (typeof explicit === "boolean") return explicit;
  const certificate = body?.data && typeof body.data === "object" ? body.data : body;
  return Boolean(
    certificate
    && typeof certificate === "object"
    && String(certificate.nationalCode ?? "").trim()
    && String(certificate.phoneNumber ?? "").trim()
    && (String(certificate.firstName ?? "").trim() || String(certificate.lastName ?? "").trim()),
  );
}
function providerId(body: any, names: string[]): string | undefined {
  for (const name of names) { const value = body?.[name] ?? body?.data?.[name] ?? body?.result?.[name]; if (value != null) return String(value); }
  return undefined;
}
function providerContractState(body: any): { status: string | null; title: string | null } {
  const objects = [body, body?.data, body?.result, body?.contract, body?.data?.contract, body?.result?.contract]
    .filter((value) => value && typeof value === "object");
  const firstString = (names: string[]) => {
    for (const object of objects) for (const name of names) {
      const value = object[name];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
    }
    return null;
  };
  return {
    status: firstString(["status", "contractStatus", "state"]),
    title: firstString(["statusTitle", "statusText", "statusLabel", "statusFa"]),
  };
}
function providerStateIsSigned(status: string | null, title: string | null): boolean {
  const value = `${status ?? ""} ${title ?? ""}`.toLowerCase();
  if (["not_completed", "incomplete", "pending", "waiting", "rejected", "declined", "cancelled", "canceled", "expired", "در انتظار", "رد شده", "لغو شده"].some((item) => value.includes(item))) return false;
  return ["signed", "completed", "complete", "finished", "done", "امضا شده", "تکمیل شده"].some((item) => value.includes(item));
}
router.post("/contracts/generations/:id/check-status", requirePermission("contracts.view"), async (req, res): Promise<void> => {
  const id = Number(req.params.id); const row = assignedGeneration(id, user(req, res));
  if (!row) { res.status(404).json({ error: "Generation not found" }); return; }
  if (!row.provider_contract_id) { res.status(409).json({ error: "Contract has not been sent" }); return; }
  try {
    const base = (process.env.EMZAME_BASE_URL || "https://core.emzame.com/api/v1/backoffice").replace(/\/+$/, "");
    const token = await emzameAuth(base);
    const response = await fetchWithTimeout(`${base}/contracts/${encodeURIComponent(String(row.provider_contract_id))}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, 20_000, true);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("provider_status_failed");
    const state = providerContractState(body);
    if (!state.status && !state.title) throw new Error("provider_status_failed");
    const checkedAt = now();
    crmDb.prepare("UPDATE contract_generations SET provider_status=?,updated_at=? WHERE id=?").run(state.status ?? state.title, checkedAt, id);
    res.json({ id, providerStatus: state.status, providerStatusTitle: state.title, signed: providerStateIsSigned(state.status, state.title), checkedAt });
  } catch {
    res.status(502).json({ error: "provider_status_failed" });
  }
});
router.post("/contracts/generations/:id/send", requirePermission("contracts.send"), async (req, res): Promise<void> => {
  const id = Number(req.params.id); const auth = user(req, res); const row = assignedGeneration(id, auth);
  reconcileGenerations();
  if (!row) { res.status(404).json({ error: "Generation not found" }); return; }
  if (row.status === "sent" && row.provider_contract_id) { res.json({ id, status: row.status, providerContractId: row.provider_contract_id, providerFileId: row.provider_file_id }); return; }
  if (!row.pdf_path) { res.status(409).json({ error: "PDF is not available" }); return; }
  const claimId = crypto.randomUUID(); const claimExpires = new Date(Date.now() + 10 * 60_000).toISOString();
  const claimed = crmDb.prepare("UPDATE contract_generations SET status='sending',send_claim_id=?,send_claim_expires_at=?,error_message=NULL,updated_at=? WHERE id=? AND (status IN ('generated','failed') OR (status='sending' AND send_claim_expires_at < ?))").run(claimId, claimExpires, now(), id, now());
  if (Number(claimed.changes) !== 1) { res.status(409).json({ error: "Generation is already being sent" }); return; }
  try {
    const base = (process.env.EMZAME_BASE_URL || "https://core.emzame.com/api/v1/backoffice").replace(/\/+$/, "");
    const businessId = process.env.EMZAME_BUSINESS_ID?.trim(); if (!businessId) throw new Error("provider_configuration");
    const c = customer(Number(row.customer_id)); if (!c || !String(c.national_code ?? "").trim() || !String(c.name ?? "").trim() || !String(c.phone ?? "").trim()) throw new Error("collaborator_required");
    const pdfPath = regularPath(String(row.pdf_path), "generations"); const pdf = await fsp.readFile(pdfPath);
    if (!row.pdf_sha256 || sha(pdf) !== String(row.pdf_sha256)) throw new Error("artifact_integrity");
    const token = await emzameAuth(base); const headers = { authorization: `Bearer ${token}` };
    const certPath = process.env.EMZAME_CERTIFICATE_PATH || "users/checkUserActiveCertificate/";
    const certUrl = `${base}/${certPath.replace(/^\/+/, "")}${certPath.includes("?") ? "&" : "?"}nationalCode=${encodeURIComponent(String(c.national_code))}`;
    const cert = await fetchWithTimeout(certUrl, { method: "GET", headers }, 20_000, true); const certBody = await cert.json().catch(() => ({}));
    if (!cert.ok || !certificateActive(certBody)) throw new Error("certificate_inactive");
    let fileId = row.provider_file_id ? String(row.provider_file_id) : "";
    const idempotency = row.provider_idempotency_key ? String(row.provider_idempotency_key) : crypto.randomUUID();
    if (!row.provider_idempotency_key) crmDb.prepare("UPDATE contract_generations SET provider_idempotency_key=?,updated_at=? WHERE id=? AND send_claim_id=?").run(idempotency, now(), id, claimId);
    if (!fileId) {
      const form = new FormData();
      form.append("file", new Blob([pdf], { type: "application/pdf" }), `contract-${id}.pdf`);
      form.append("name", `contract-${id}.pdf`);
      form.append("REQUIRED_FILE_NAME", `contract-${id}.pdf`);
       const uploaded = await fetchWithTimeout(`${base}/files`, { method: "POST", headers: { ...headers, "X-Idempotency-Key": idempotency }, body: form }, 60_000, true); const uploadedBody = await uploaded.json().catch(() => ({})) as any;
      fileId = providerId(uploadedBody, ["fileId", "id", "file_id"]) || "";
      if (!uploaded.ok || !fileId) throw new Error("Emzame file upload failed");
       crmDb.prepare("UPDATE contract_generations SET provider_file_id=?,updated_at=? WHERE id=? AND send_claim_id=?").run(fileId, now(), id, claimId);
    }
    const collaborator = { status: "checked", fullName: String(c.name ?? ""), nationalCode: String(c.national_code ?? ""), phoneNumber: String(c.phone ?? ""), order: 1 };
    const sendBody = {
       collaboratorList: [collaborator], title: `contract-${id}`, provider: process.env.EMZAME_PROVIDER || "gica",
      signType: process.env.EMZAME_SIGN_TYPE || "e-sign", isBlankPageRequired: false,
       isElectronicSignatureRequired: true, isSignatureDescriptionRequired: true,
       shouldEveryPageHaveSignatureImage: true, staticFileId: fileId, businessId: businessId,
    };
    const sent = await fetchWithTimeout(`${base}/contracts/sendContract`, { method: "POST", headers: { ...headers, "content-type": "application/json", "X-Idempotency-Key": idempotency }, body: JSON.stringify(sendBody) }, 60_000); const sentBody = await sent.json().catch(() => ({})) as any;
    const contractId = providerId(sentBody, ["contractId", "id", "contract_id"]);
    if (!sent.ok || !contractId) throw new Error("Emzame contract send failed");
     crmDb.prepare("UPDATE contract_generations SET status='sent',provider_file_id=?,provider_contract_id=?,provider_status=?,sent_at=?,send_claim_id=NULL,send_claim_expires_at=NULL,updated_at=? WHERE id=? AND send_claim_id=?").run(fileId, contractId, String(sentBody.status ?? sentBody.data?.status ?? "sent"), now(), id, claimId);
    res.json({ id, status: "sent", providerFileId: fileId, providerContractId: contractId });
  } catch (e) {
    const code = e instanceof Error && ["provider_configuration", "collaborator_required", "artifact_integrity", "certificate_inactive"].includes(e.message) ? e.message : "provider_delivery_failed";
    crmDb.prepare("UPDATE contract_generations SET status='failed',error_message=?,send_claim_id=NULL,send_claim_expires_at=NULL,updated_at=? WHERE id=? AND send_claim_id=?").run(code, now(), id, claimId);
    const status = code === "certificate_inactive" || code === "collaborator_required"
      ? 422
      : code === "artifact_integrity"
        ? 409
        : code === "provider_configuration"
          ? 503
          : 502;
    res.status(status).json({ error: code });
  }
});

export default router;