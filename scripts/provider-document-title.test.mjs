import assert from "node:assert/strict";
import { providerContractTitle, providerErrorMessage, safeProviderPdfFilename, PROVIDER_TITLE_MAX_CHARS, PROVIDER_TITLE_MAX_BYTES } from "../src/lib/provider-document-title.ts";

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
assert.ok([...filename].length <= 68, filename); // 63 + .pdf
assert.ok(Buffer.byteLength(filename, "utf8") <= 115, String(Buffer.byteLength(filename, "utf8")));

assert.equal(providerErrorMessage({ persianMessage: "", message: "", errorCode: "TITLE_TOO_LONG" }), "TITLE_TOO_LONG");
assert.equal(providerErrorMessage({ persianMessage: "عنوان بیش از حد طولانی است" }), "عنوان بیش از حد طولانی است");
assert.equal(providerErrorMessage({}), undefined);

console.log("PASS provider title clip stays within 63/111 and keeps a readable سپهر prefix; errorCode is logged when messages are empty.");
