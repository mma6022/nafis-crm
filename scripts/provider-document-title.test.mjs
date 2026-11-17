import assert from "node:assert/strict";
import { providerContractTitle, providerErrorMessage, safeProviderPdfFilename, PROVIDER_TITLE_MAX_CHARS, PROVIDER_TITLE_MAX_BYTES, PROVIDER_FILENAME_MAX_CHARS } from "../src/lib/provider-document-title.ts";

const sepehr = "سپهر ( حقوق بگیران آموزش و پرورش و بانک صادرات )(حقوق بگیران بانک سپه .لشگری)";
const customer = "علی رضایی";
const raw = `قرارداد طرح ${sepehr} - ${customer}`;
assert.ok([...raw].length > PROVIDER_TITLE_MAX_CHARS || Buffer.byteLength(raw, "utf8") > PROVIDER_TITLE_MAX_BYTES, "unclipped Sepehr title must exceed the live cap");
const title = providerContractTitle(sepehr, customer);
assert.ok(title.startsWith("قرارداد طرح "), title);
assert.ok(title.includes("سپهر"), `plan prefix kept: ${title}`);
assert.ok([...title].length <= PROVIDER_TITLE_MAX_CHARS, `${[...title].length} chars: ${title}`);
assert.ok(Buffer.byteLength(title, "utf8") <= PROVIDER_TITLE_MAX_BYTES, `${Buffer.byteLength(title, "utf8")} bytes: ${title}`);

const short = providerContractTitle("ترنم ( بازنشسته ها )", "رضا");
assert.equal(short, "قرارداد طرح ترنم ( بازنشسته ها ) - رضا");

// Plan 24 with a 35-character customer name (live gen 299 pattern) must also fit.
const longCustomer = "عبدالله‌محمدرضاعلی‌حسینی‌زادهپورآباد";
assert.ok([...longCustomer].length >= 20);
const t24 = providerContractTitle("کوشا", longCustomer);
assert.ok([...t24].length <= PROVIDER_TITLE_MAX_CHARS);
assert.ok(Buffer.byteLength(t24, "utf8") <= PROVIDER_TITLE_MAX_BYTES);

const filename = safeProviderPdfFilename(raw, "contract-271");
assert.ok(filename.endsWith(".pdf"));
assert.ok([...filename].length <= PROVIDER_FILENAME_MAX_CHARS, `${[...filename].length} chars: ${filename}`);
assert.ok(Buffer.byteLength(filename, "utf8") <= PROVIDER_TITLE_MAX_BYTES, String(Buffer.byteLength(filename, "utf8")));
// Stem was cut; extension kept; no mid-codepoint (every char is a full JS string character / UTF-16 surrogate pair kept by [...]).
assert.equal(filename.slice(-4), ".pdf");
assert.notEqual(filename[filename.length - 5], "\uFFFD");

// Live gen 299 pattern: a title already at the 111-byte cap must not grow past 111 bytes or 95 chars when ".pdf" is added.
const atCap = t24;
assert.ok(Buffer.byteLength(atCap, "utf8") <= 111);
const fn299 = safeProviderPdfFilename(atCap, "contract-299");
assert.ok(fn299.endsWith(".pdf"));
assert.ok([...fn299].length <= PROVIDER_FILENAME_MAX_CHARS, `${[...fn299].length}`);
assert.ok(Buffer.byteLength(fn299, "utf8") <= PROVIDER_TITLE_MAX_BYTES, String(Buffer.byteLength(fn299, "utf8")));

// A 200-character stem is cut so the complete filename is exactly at most 95 characters, extension kept.
const longStem = "الف".repeat(80);
const fn95 = safeProviderPdfFilename(longStem, "contract-x");
assert.ok(fn95.endsWith(".pdf"));
assert.ok([...fn95].length <= 95, `${[...fn95].length}`);
assert.ok([...fn95].length === 95 || Buffer.byteLength(fn95, "utf8") <= 111);

assert.equal(providerErrorMessage({ persianMessage: "", message: "", errorCode: "TITLE_TOO_LONG" }), "TITLE_TOO_LONG");
assert.equal(providerErrorMessage({ persianMessage: "عنوان بیش از حد طولانی است" }), "عنوان بیش از حد طولانی است");
assert.equal(providerErrorMessage({}), undefined);

console.log("PASS provider title clip stays within 63/111; filename cap is 95 chars and 111 bytes including .pdf.");
