import { isApprovedInstallmentAppendix } from "./approved-contract-installments";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import PizZip from "pizzip";

const PRINCIPAL_LABEL = /(?:مبلغ\s+(?:(?:اصل|اصلی)\s+)?(?:تسهیلات|وام|قرض)|(?:اصل|اصلی)\s+(?:(?:مبلغ)\s+)?(?:تسهیلات|وام|قرض)|principal(?:\s+loan)?(?:\s+amount)?|loan\s+principal(?:\s+amount)?|loan\s+amount|amount\s+of\s+(?:the\s+)?loan|مبلغ\s+(?:اصل\s+)?(?:التمویل|القرض)|(?:اصل\s+)?(?:التمویل|القرض)\s+(?:الرئیسی|الاصلی)?)/giu;
const OTHER_MONEY_FIELD = /(?:مبلغ\s+(?:کل|کلی|اجمالی|جمع|بازپرداخت|قسط|اقساط)|(?:مجموع|جمع|کل|کلی|اجمالی)\s+(?:مبلغ|تسهیلات|وام|التمویل|القرض)|کارمزد|هزینه|قسط|اقساط|بازپرداخت|سود|بهره|جریمه|مالیات|حق\s+الزحمه|رسوم|فایده|سداد|غرامة|fee|fees|total|repayment|installments?|interest|penalty|tax|example|sample)/giu;
const EXAMPLE_CONTEXT = /(?:مثال|نمونه|فرض(?:یه|ی)?|برای\s+مثال|به\s+عنوان\s+مثال|مثلاً|example|sample|illustrat(?:e|ion))/iu;
const AMOUNT_RELATION = /(?:[:：=]|برابر\s+با|به\s+(?:مبلغ|میزان)|بالغ\s+بر|معادل|مبلغ|amount\s*(?:is|of|:|=)?|(?:^|\s)(?:is|equals?|equivalent\s+to)(?=\s|$))/iu;
const NON_AMOUNT_SUFFIX = /^(?:\s*)(?:ماه(?:ه|انه)?|سال(?:ه|انه)?|روز|قسط|اقساط|درصد|%|ماهانه|installments?|months?|years?|days?|percent|%|thousand|million|billion|trillion)(?![\p{L}])/iu;
const NUMBER_WORD = "(?:صفر|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|صد|یکصد|دویست|سیصد|چهارصد|پانصد|ششصد|هفتصد|هشتصد|نهصد|هزار|میلیون|میلیارد|تریلیون|واحد|اثنان|ثلاثه|اربعه|خمسه|سته|سبعه|ثمانیه|تسعه|عشره|مئه|مائه|الف|ملیون|ملیار|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion)";
const SPELLING_AMOUNT = new RegExp(
  `(?:به\\s+حروف|حروفی|بالحروف|in\\s+words|written\\s+out|(?<![\\p{L}])${NUMBER_WORD}(?:\\s+(?:(?:و|and)\\s+)?${NUMBER_WORD}){0,5}\\s+(?:ریال|تومان|دینار|درهم|rial|rials|toman|tomans|dinar|dinars|dirham|dirhams)(?![\\p{L}]))`,
  "iu",
);
const HARD_CLAUSE_BREAK = new Set(["!", "?", "؟", "؛", ";", "۔", "\u06d4", "\r", "\n"]);
const NUMBER_TOKEN = /(?<![\p{L}\p{N}])(?:\d{1,3}(?:[,\u060c\u066c\u00a0\u2000-\u200a\u202f\u205f\u3000 ]\s*\d{3})+|\d{1,18})(?![\p{L}\p{N}])/gu;
const ATTESTED_TEMPLATES: Record<number, { sha256: string; currency: "ریال" | "تومان" }> = {
  6: { sha256: "9bf1cd5c8415e4c85910d22f38a30d3578ba8d57bcec702704f6966ebd5b5e7e", currency: "تومان" },
  // Immutable future-facing copies of templates 4 and 5. Their only visible edit
  // changes the principal clause's unit from ریال to تومان; the originals remain.
  7: { sha256: "6721cad00e5a099bfe3656d9eecb2822e3672efcd1b38f36e4969543a1f31147", currency: "تومان" },
  8: { sha256: "e55e61f8b8f19406d43bdbc68162246ca64f297ae316e6100f4291dfdb965c54", currency: "تومان" },
};
const ATTESTED_SOURCE_CLAUSE = /می\s*شود\s+مبلغ\s+([\p{L}]+)\s+%([A-Za-z][A-Za-z0-9_.-]*)%\s+(ریال|تومان)\s+به(?![\p{L}\p{N}])/gu;
const EVIDENCE_AMOUNT = "(?:\\d{1,3}(?:[,\u060c\u066c\u00a0\u2000-\\u200a\\u202f\\u205f\\u3000 ]\\s*\\d{3})+|\\d{1,18})";
const INSTALLMENT_LABEL = "(?:تعداد\\s+(?:اقساط|قسط)|مدت\\s+(?:بازپرداخت|اقساط|تسهیلات)|number\\s+of\\s+installments|installment\\s+count|repayment\\s+term)";

export interface RenderedPrincipalTemplateEvidence {
  templateId: unknown;
  templatePath: unknown;
  templateRoot: unknown;
  storedTemplateSha256: unknown;
  mappings: unknown;
  renderedDocxPath: unknown;
  renderedDocxRoot: unknown;
  renderedDocxSha256: unknown;
  renderedValues: unknown;
  renderedPdfRoot: unknown;
  renderedPdfSha256: unknown;
}

export interface PrincipalEvidenceDiagnostic {
  matched: boolean;
  reason: string;
}

function normalizePdfText(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/[\u061c\u200b-\u200f\ufeff]/g, "")
    .normalize("NFKC")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/\p{M}/gu, "")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n");
}

function canonicalInteger(value: string): string | null {
  const digits = value.replace(/[,\u060c\u066c\u00a0\u2000-\u200a\u202f\u205f\u3000 ]/g, "");
  if (!/^\d{1,18}$/.test(digits)) return null;
  try {
    const amount = BigInt(digits);
    return amount > 0n ? amount.toString() : null;
  } catch {
    return null;
  }
}

function readEvidenceFile(filePath: unknown, rootPath: unknown, extension: "docx" | "pdf", maxBytes: number): { path: string; bytes: Buffer } | null {
  if (typeof filePath !== "string" || typeof rootPath !== "string" || !filePath || !rootPath) return null;
  try {
    const realRoot = fs.realpathSync(rootPath);
    const realPath = fs.realpathSync(filePath);
    const stat = fs.lstatSync(filePath);
    if (path.dirname(realPath) !== realRoot || !stat.isFile() || stat.isSymbolicLink() ||
        !new RegExp(`^[a-f0-9-]{20,}\\.${extension}$`, "i").test(path.basename(realPath)) ||
        stat.size <= 0 || stat.size > maxBytes) return null;
    const bytes = fs.readFileSync(realPath);
    return bytes.length === stat.size ? { path: realPath, bytes } : null;
  } catch {
    return null;
  }
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits) => String.fromCodePoint(parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_match, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function documentParagraphs(docx: Buffer): string[] | null {
  try {
    const document = new PizZip(docx).file("word/document.xml")?.asText();
    if (!document) return null;
    const paragraphs: string[] = [];
    for (const paragraph of document.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gu)) {
      const xml = paragraph[1];
      const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)]
        .map((node) => decodeXmlText(node[1]))
        .join("");
      paragraphs.push(normalizePdfText(text));
    }
    return paragraphs.length ? paragraphs : null;
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function amountTokenCount(text: string): number {
  NUMBER_TOKEN.lastIndex = 0;
  return [...text.matchAll(NUMBER_TOKEN)].length;
}

function attestedTemplateContainsPrincipal(
  pdfText: string,
  pdfPath: unknown,
  expectedAmount: string,
  evidence: RenderedPrincipalTemplateEvidence,
): PrincipalEvidenceDiagnostic {
  const reject = (reason: string): PrincipalEvidenceDiagnostic => ({ matched: false, reason });
  const templateId = Number(evidence.templateId);
  const attested = ATTESTED_TEMPLATES[templateId];
  if (!attested) return reject("template_not_allowlisted");
  if (attested.currency !== "تومان") return reject("template_unit_policy_unapproved");
  if (!/^[1-9]\d{0,17}$/.test(expectedAmount)) return reject("expected_amount_invalid");
  if (typeof evidence.storedTemplateSha256 !== "string" ||
      evidence.storedTemplateSha256.toLowerCase() !== attested.sha256) return reject("stored_template_digest_mismatch");

  const sourceFile = readEvidenceFile(evidence.templatePath, evidence.templateRoot, "docx", 20 * 1024 * 1024);
  const renderedFile = readEvidenceFile(evidence.renderedDocxPath, evidence.renderedDocxRoot, "docx", 20 * 1024 * 1024);
  const renderedPdf = readEvidenceFile(pdfPath, evidence.renderedPdfRoot, "pdf", 50 * 1024 * 1024);
  if (!sourceFile) return reject("source_file_path_or_size_invalid");
  if (!renderedFile) return reject("rendered_docx_path_or_size_invalid");
  if (!renderedPdf) return reject("rendered_pdf_path_or_size_invalid");
  if (crypto.createHash("sha256").update(sourceFile.bytes).digest("hex") !== attested.sha256)
    return reject("source_template_digest_mismatch");
  if (typeof evidence.renderedDocxSha256 !== "string" ||
      crypto.createHash("sha256").update(renderedFile.bytes).digest("hex") !== evidence.renderedDocxSha256.toLowerCase())
    return reject("rendered_docx_digest_mismatch");
  if (typeof evidence.renderedPdfSha256 !== "string" ||
      crypto.createHash("sha256").update(renderedPdf.bytes).digest("hex") !== evidence.renderedPdfSha256.toLowerCase())
    return reject("rendered_pdf_digest_mismatch");

  const mappings = evidence.mappings;
  if (!Array.isArray(mappings)) return reject("generation_mappings_missing");
  const directPrincipalMappings = mappings.filter((mapping: any) =>
    (mapping?.sourceType ?? (mapping?.customerField ? "customer" : mapping?.loanPlanField ? "loanPlan" : "manual")) === "loanPlan" &&
    mapping?.loanPlanField === "loanPlan.principalAmount");
  if (directPrincipalMappings.length !== 1 || typeof directPrincipalMappings[0].variable !== "string")
    return reject("principal_mapping_not_unique");
  const variable = directPrincipalMappings[0].variable;
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(variable)) return reject("principal_mapping_variable_invalid");
  const rawValues = evidence.renderedValues;
  if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) return reject("rendered_values_missing");
  const values = rawValues as Record<string, unknown>;
  const mappedAmount = typeof values[variable] === "string"
    ? canonicalInteger(normalizePdfText(values[variable]))
    : null;
  if (!mappedAmount || mappedAmount !== expectedAmount) return reject("mapped_amount_mismatch");

  const sourceParagraphs = documentParagraphs(sourceFile.bytes);
  const renderedParagraphs = documentParagraphs(renderedFile.bytes);
  if (!sourceParagraphs) return reject("source_docx_unreadable");
  if (!renderedParagraphs) return reject("rendered_docx_unreadable");
  const escapedVariable = escapeRegex(variable);
  const placeholderPattern = new RegExp(`%${escapedVariable}%`, "g");
  const sourceText = sourceParagraphs.join("\n");
  if ((sourceText.match(placeholderPattern) ?? []).length !== 1) return reject("source_placeholder_not_unique");

  const sourceClauses: Array<{ word: string; variable: string; currency: string }> = [];
  for (const paragraph of sourceParagraphs) {
    ATTESTED_SOURCE_CLAUSE.lastIndex = 0;
    for (const match of paragraph.matchAll(ATTESTED_SOURCE_CLAUSE)) {
      sourceClauses.push({ word: match[1], variable: match[2], currency: match[3] });
    }
  }
  if (sourceClauses.length !== 1 || sourceClauses[0].variable !== variable ||
      sourceClauses[0].currency !== attested.currency) return reject("source_clause_not_attested");

  const clauseRegex = new RegExp(
    `می\\s*شود\\s+مبلغ\\s+${escapeRegex(sourceClauses[0].word)}\\s+(${EVIDENCE_AMOUNT})\\s+${escapeRegex(attested.currency)}\\s+به(?![\\p{L}\\p{N}])`,
    "gu",
  );
  const renderedClauses: string[] = [];
  for (const paragraph of renderedParagraphs) {
    clauseRegex.lastIndex = 0;
    for (const match of paragraph.matchAll(clauseRegex)) {
      if (amountTokenCount(paragraph) !== 1 || canonicalInteger(match[1]) !== expectedAmount)
        return reject("rendered_docx_clause_ambiguous_or_amount_mismatch");
      renderedClauses.push(paragraph);
    }
  }
  if (renderedClauses.length !== 1) return reject("rendered_docx_clause_not_unique");

  const pdfClauses: string[] = [];
  for (const rawLine of pdfText.split(/\r?\n/u)) {
    const line = normalizePdfText(rawLine);
    clauseRegex.lastIndex = 0;
    for (const match of line.matchAll(clauseRegex)) {
      if (amountTokenCount(line) !== 1 || canonicalInteger(match[1]) !== expectedAmount)
        return reject("pdf_clause_ambiguous_or_amount_mismatch");
      pdfClauses.push(line);
    }
  }
  if (pdfClauses.length !== 1) return reject("pdf_clause_not_unique");
  return { matched: true, reason: "attested_toman_template_clause_matched" };
}

function templateUnitIsAttested(
  templateId: unknown,
  currency: "ریال" | "تومان",
  templatePath: unknown,
  templateRoot: unknown,
  storedTemplateSha256: unknown,
): boolean {
  const attested = ATTESTED_TEMPLATES[Number(templateId)];
  if (!attested || attested.currency !== currency ||
      typeof storedTemplateSha256 !== "string" ||
      storedTemplateSha256.toLowerCase() !== attested.sha256) return false;
  const source = readEvidenceFile(templatePath, templateRoot, "docx", 20 * 1024 * 1024);
  return Boolean(source && crypto.createHash("sha256").update(source.bytes).digest("hex") === attested.sha256);
}

/**
 * Only the immutable, allowlisted future-facing template copies can be used for
 * a toman replacement. A plan label or user-supplied template ID is not proof
 * of its denomination.
 */
export function isAttestedTomanTemplate(
  templateId: unknown,
  templatePath: unknown,
  templateRoot: unknown,
  storedTemplateSha256: unknown,
): boolean {
  return templateUnitIsAttested(templateId, "تومان", templatePath, templateRoot, storedTemplateSha256);
}

/**
 * A legacy signed contract is eligible for an explicit unit repair only when
 * its exact rendered principal provision proves that the old document said
 * ریال. This deliberately does not use incidental numbers elsewhere in a PDF.
 */
export function renderedPdfContainsLegacyRialPrincipal(
  pdfPath: unknown,
  expectedAmount: string,
  evidence: RenderedPrincipalTemplateEvidence,
): boolean {
  if (typeof pdfPath !== "string" || !pdfPath || !/^[1-9]\d{0,17}$/.test(expectedAmount)) return false;
  try {
    const source = readEvidenceFile(evidence.templatePath, evidence.templateRoot, "docx", 20 * 1024 * 1024);
    const rendered = readEvidenceFile(evidence.renderedDocxPath, evidence.renderedDocxRoot, "docx", 20 * 1024 * 1024);
    const pdf = readEvidenceFile(pdfPath, evidence.renderedPdfRoot, "pdf", 50 * 1024 * 1024);
    if (!source || !rendered || !pdf ||
        typeof evidence.storedTemplateSha256 !== "string" ||
        crypto.createHash("sha256").update(source.bytes).digest("hex") !== evidence.storedTemplateSha256.toLowerCase() ||
        typeof evidence.renderedDocxSha256 !== "string" ||
        crypto.createHash("sha256").update(rendered.bytes).digest("hex") !== evidence.renderedDocxSha256.toLowerCase() ||
        typeof evidence.renderedPdfSha256 !== "string" ||
        crypto.createHash("sha256").update(pdf.bytes).digest("hex") !== evidence.renderedPdfSha256.toLowerCase()) return false;

    const mappings = evidence.mappings;
    if (!Array.isArray(mappings)) return false;
    const principals = mappings.filter((mapping: any) =>
      (mapping?.sourceType ?? (mapping?.customerField ? "customer" : mapping?.loanPlanField ? "loanPlan" : "manual")) === "loanPlan" &&
      mapping?.loanPlanField === "loanPlan.principalAmount");
    if (principals.length !== 1 || typeof principals[0].variable !== "string") return false;
    const variable = principals[0].variable;
    const values = evidence.renderedValues;
    if (!values || typeof values !== "object" || Array.isArray(values) ||
        canonicalInteger(normalizePdfText(String((values as Record<string, unknown>)[variable] ?? ""))) !== expectedAmount)
      return false;

    const sourceParagraphs = documentParagraphs(source.bytes);
    const renderedParagraphs = documentParagraphs(rendered.bytes);
    if (!sourceParagraphs || !renderedParagraphs) return false;
    const sourceClauses: Array<{ word: string; variable: string; currency: string }> = [];
    for (const paragraph of sourceParagraphs) {
      ATTESTED_SOURCE_CLAUSE.lastIndex = 0;
      for (const match of paragraph.matchAll(ATTESTED_SOURCE_CLAUSE))
        sourceClauses.push({ word: match[1], variable: match[2], currency: match[3] });
    }
    if (sourceClauses.length !== 1 || sourceClauses[0].variable !== variable ||
        sourceClauses[0].currency !== "ریال") return false;

    const clause = new RegExp(
      `می\\s*شود\\s+مبلغ\\s+${escapeRegex(sourceClauses[0].word)}\\s+(${EVIDENCE_AMOUNT})\\s+ریال\\s+به(?![\\p{L}\\p{N}])`,
      "gu",
    );
    const matchingParagraph = (paragraphs: string[]) => {
      const found: string[] = [];
      for (const rawParagraph of paragraphs) {
        const paragraph = normalizePdfText(rawParagraph);
        clause.lastIndex = 0;
        for (const match of paragraph.matchAll(clause)) {
          if (amountTokenCount(paragraph) !== 1 || canonicalInteger(match[1]) !== expectedAmount) return null;
          found.push(paragraph);
        }
      }
      return found;
    };
    const renderedClauses = matchingParagraph(renderedParagraphs);
    if (renderedClauses?.length !== 1) return false;
    const pdfText = execFileSync("pdftotext", ["-layout", pdf.path, "-"], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pdfClauses = matchingParagraph(pdfText.split(/\r?\n/u));
    return pdfClauses?.length === 1;
  } catch {
    return false;
  }
}

function previousBreak(text: string, from: number): number {
  for (let index = from - 1; index >= 0; index--) {
    if (isHardClauseBreak(text, index)) return index + 1;
  }
  return Math.max(0, from - 180);
}

function nextBreak(text: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    if (isHardClauseBreak(text, index)) return index;
  }
  return Math.min(text.length, from + 220);
}

function isHardClauseBreak(text: string, index: number): boolean {
  const character = text[index];
  if (character === ".") {
    const before = text.slice(0, index).trimEnd().slice(-1);
    const after = text.slice(index + 1).trimStart()[0] ?? "";
    return !(/\d/.test(before) && /\d/.test(after));
  }
  return HARD_CLAUSE_BREAK.has(character);
}

function containsUnambiguousPrincipalText(text: string, expectedAmount: string): boolean {
  if (!/^[1-9]\d{0,17}$/.test(expectedAmount)) return false;
  const normalized = normalizePdfText(text);
  PRINCIPAL_LABEL.lastIndex = 0;
  const labels = [...normalized.matchAll(PRINCIPAL_LABEL)];
  if (!labels.length) return false;

  const observed: string[] = [];
  for (const label of labels) {
    const labelStart = label.index ?? 0;
    const labelEnd = labelStart + label[0].length;
    const clauseStart = previousBreak(normalized, labelStart);
    const clauseEnd = nextBreak(normalized, labelEnd);
    const clause = normalized.slice(clauseStart, clauseEnd);
    if (EXAMPLE_CONTEXT.test(clause) || SPELLING_AMOUNT.test(clause)) return false;

    const before = normalized.slice(Math.max(clauseStart, labelStart - 48), labelStart);
    const after = normalized.slice(labelEnd, Math.min(clauseEnd, labelEnd + 128));
    const prefixExcluded = /(?:کل|كلي|اجمالي|إجمالي|جمع|total)\s*$/iu.test(before);
    if (prefixExcluded) continue;

    // Treat the next explicit fee/total/repayment field as a boundary, so its
    // amount can neither satisfy nor make ambiguous the principal assertion.
    OTHER_MONEY_FIELD.lastIndex = 0;
    const otherField = OTHER_MONEY_FIELD.exec(after);
    const boundedAfter = otherField ? after.slice(0, otherField.index) : after;
    OTHER_MONEY_FIELD.lastIndex = 0;
    const priorFields = [...before.matchAll(OTHER_MONEY_FIELD)];
    const boundedBefore = priorFields.length
      ? before.slice((priorFields[priorFields.length - 1].index ?? 0) + priorFields[priorFields.length - 1][0].length)
      : before;
    const clauseText = `${boundedBefore} ${boundedAfter}`;
    NUMBER_TOKEN.lastIndex = 0;
    const amountMatches = [...clauseText.matchAll(NUMBER_TOKEN)];
    const amountTokens = amountMatches.map((match) => canonicalInteger(match[0]));
    if (amountTokens.length !== 1) return false;
    const amount = amountTokens[0];
    if (amount == null) return false;
    const amountMatch = amountMatches[0];
    const amountStart = amountMatch.index ?? 0;
    const beforeLength = boundedBefore.length;
    if (amountStart > beforeLength) {
      const gap = amountStart - beforeLength - 1;
      if (gap > 48 && !AMOUNT_RELATION.test(boundedAfter.slice(0, gap))) return false;
      if (NON_AMOUNT_SUFFIX.test(boundedAfter.slice(gap + amountMatch[0].length))) return false;
    } else if (beforeLength - amountStart - amountMatch[0].length > 32) {
      return false;
    } else if (NON_AMOUNT_SUFFIX.test(boundedBefore.slice(amountStart + amountMatch[0].length))) {
      return false;
    }
    observed.push(amount);
  }

  return observed.length > 0 && observed.every((amount) => amount === expectedAmount);
}

/**
 * Testable pure check: the expected amount must be the only amount explicitly
 * attached to every extracted principal-specific clause. Fee, total, repayment,
 * example, incidental, missing, and ambiguous amounts are never evidence.
 */
export function textContainsUnambiguousPrincipal(text: string, expectedAmount: string): boolean {
  if (typeof text !== "string") return false;
  try {
    return containsUnambiguousPrincipalText(text, expectedAmount);
  } catch {
    return false;
  }
}

/**
 * Safe diagnostic seam for local preflight tests. It exposes only fixed reason
 * codes; paths, hashes, values, and extracted contract text are never returned.
 */
export function diagnoseRenderedPdfContainsPrincipal(
  pdfPath: unknown,
  expectedAmount: string,
  templateEvidence?: RenderedPrincipalTemplateEvidence,
): PrincipalEvidenceDiagnostic {
  if (typeof pdfPath !== "string" || !pdfPath || !/^[1-9]\d{0,17}$/.test(expectedAmount))
    return { matched: false, reason: "input_invalid" };
  if (templateEvidence && [4, 5].includes(Number(templateEvidence.templateId)))
    return { matched: false, reason: "template_unit_policy_unapproved" };
  try {
    if (!fs.statSync(pdfPath).isFile()) return { matched: false, reason: "pdf_file_invalid" };
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (textContainsUnambiguousPrincipal(text, expectedAmount))
      return { matched: true, reason: "explicit_principal_label_matched" };
    if (!templateEvidence) return { matched: false, reason: "principal_clause_not_found" };
    return attestedTemplateContainsPrincipal(text, pdfPath, expectedAmount, templateEvidence);
  } catch {
    return { matched: false, reason: "pdf_extraction_failed" };
  }
}

/**
 * Mapping metadata records renderer inputs, not what is actually legible in
 * the PDF. Require a principal-labeled, unambiguous rendered assertion.
 */
export function renderedPdfContainsPrincipal(
  pdfPath: unknown,
  expectedAmount: string,
  templateEvidence?: RenderedPrincipalTemplateEvidence,
): boolean {
  return diagnoseRenderedPdfContainsPrincipal(pdfPath, expectedAmount, templateEvidence).matched;
}

/**
 * A changed installment count must appear in the contract the customer signs,
 * not merely in the values used to prepare it. Require a labeled placeholder
 * in the source, the matching rendered Word paragraph, and the extracted PDF.
 */
export function renderedPdfContainsInstallmentCount(
  pdfPath: unknown,
  expectedCount: number,
  evidence: RenderedPrincipalTemplateEvidence,
): boolean {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 600) return false;
  try {
    const source = readEvidenceFile(evidence.templatePath, evidence.templateRoot, "docx", 20 * 1024 * 1024);
    const rendered = readEvidenceFile(evidence.renderedDocxPath, evidence.renderedDocxRoot, "docx", 20 * 1024 * 1024);
    const pdf = readEvidenceFile(pdfPath, evidence.renderedPdfRoot, "pdf", 50 * 1024 * 1024);
    if (!source || !rendered || !pdf ||
        crypto.createHash("sha256").update(source.bytes).digest("hex") !== evidence.storedTemplateSha256 ||
        crypto.createHash("sha256").update(rendered.bytes).digest("hex") !== evidence.renderedDocxSha256 ||
        crypto.createHash("sha256").update(pdf.bytes).digest("hex") !== evidence.renderedPdfSha256) return false;
    const mappings = evidence.mappings;
    if (!Array.isArray(mappings)) return false;
    const durationMappings = mappings.filter((mapping: any) =>
      (mapping?.sourceType ?? (mapping?.loanPlanField ? "loanPlan" : "manual")) === "loanPlan" &&
      ["loanPlan.installments", "loanPlan.durationMonths"].includes(String(mapping?.loanPlanField)));
    if (durationMappings.length !== 1 || typeof durationMappings[0].variable !== "string") return false;
    const variable = durationMappings[0].variable;
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(variable)) return false;
    const values = evidence.renderedValues;
    if (!values || typeof values !== "object" || Array.isArray(values) ||
        canonicalInteger(normalizePdfText(String((values as Record<string, unknown>)[variable] ?? ""))) !== String(expectedCount)) return false;
    const sourceParagraphs = documentParagraphs(source.bytes);
    const renderedParagraphs = documentParagraphs(rendered.bytes);
    if (!sourceParagraphs || !renderedParagraphs) return false;
    const sourceText = sourceParagraphs.join("\n");
    const sourcePattern = new RegExp(`${INSTALLMENT_LABEL}[ \\t:：=]*%${escapeRegex(variable)}%(?![\\p{L}\\p{N}])`, "giu");
    const sourceMappingProven = [...sourceText.matchAll(sourcePattern)].length === 1 &&
      (sourceText.match(new RegExp(`%${escapeRegex(variable)}%`, "g")) ?? []).length === 1;
    const renderedXml = new PizZip(rendered.bytes).file("word/document.xml")?.asText() ?? "";
    if (!sourceMappingProven &&
        !isApprovedInstallmentAppendix(durationMappings[0], renderedXml, sourceText)) return false;
    const assertionPattern = new RegExp(`${INSTALLMENT_LABEL}[ \\t:：=]*(${EVIDENCE_AMOUNT})(?![\\p{L}\\p{N}])`, "giu");
    const assertions = (paragraphs: string[]) => {
      const matches: string[] = [];
      for (const paragraph of paragraphs) {
        const normalized = normalizePdfText(paragraph);
        for (const match of normalized.matchAll(assertionPattern)) {
          if (EXAMPLE_CONTEXT.test(normalized)) return null;
          const count = canonicalInteger(match[1]);
          if (!count) return null;
          matches.push(count);
        }
      }
      return matches;
    };
    const wordCounts = assertions(renderedParagraphs);
    const pdfText = execFileSync("pdftotext", ["-layout", pdf.path, "-"], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pdfCounts = assertions(pdfText.split(/\r?\n/u));
    return wordCounts?.length === 1 && pdfCounts?.length === 1 &&
      wordCounts[0] === String(expectedCount) && pdfCounts[0] === String(expectedCount);
  } catch {
    return false;
  }
}