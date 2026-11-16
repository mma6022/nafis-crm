// Background signature refresh: skip rejected/missing with in-memory backoff,
// never touch case 98 or generation 263, never write generated-document rows,
// yield between small batches. No SMS / Bale / calls.
import assert from "node:assert/strict";
import {
  isProtectedSignatureTarget,
  rememberSignatureRefreshMiss,
  resetSignatureRefreshSkipForTests,
  runSignatureRefreshQueue,
  shouldSkipSignatureRefresh,
  signatureRefreshSkipSize,
  PROTECTED_APPLICATION_IDS,
  PROTECTED_GENERATION_IDS,
  SIGNATURE_REFRESH_BATCH,
} from "../src/lib/signature-refresh-queue.ts";

let passed = 0;
const ok = (name) => { passed++; console.log("ok", name); };

resetSignatureRefreshSkipForTests();
assert.equal(PROTECTED_APPLICATION_IDS.has(98), true);
assert.equal(PROTECTED_GENERATION_IDS.has(263), true);
assert.equal(isProtectedSignatureTarget({ applicationId: 98, documentId: 1, generationId: 1 }), true);
assert.equal(isProtectedSignatureTarget({ applicationId: 17, documentId: 9, generationId: 263 }), true);
assert.equal(isProtectedSignatureTarget({ applicationId: 17, documentId: 9, generationId: 13 }), false);
ok("protected case 98 and generation 263");

const t0 = 1_000_000;
rememberSignatureRefreshMiss({ applicationId: 17, documentId: 9 }, "generated_document_not_found", t0);
assert.equal(shouldSkipSignatureRefresh({ applicationId: 17, documentId: 9 }, t0 + 60_000), true);
assert.equal(shouldSkipSignatureRefresh({ applicationId: 17, documentId: 9 }, t0 + 16 * 60_000), false);
ok("in-memory backoff (~15min) on generated_document_not_found");

resetSignatureRefreshSkipForTests();
const calls = [];
const written = [];
const items = [
  { applicationId: 98, documentId: 1, generationId: 10 },
  { applicationId: 50, documentId: 2, generationId: 263 },
  { applicationId: 17, documentId: 9, generationId: 13 },
  { applicationId: 219, documentId: 245, generationId: 265 },
  { applicationId: 224, documentId: 250, generationId: 270 },
];
let yields = 0;
const stats = await runSignatureRefreshQueue(items, async (item) => {
  calls.push(`${item.applicationId}:${item.documentId}`);
  if (item.applicationId === 17) throw new Error("generated_document_not_found");
  // pretend a successful observe — fixture must not record a write to generated docs
}, {
  now: t0,
  batch: SIGNATURE_REFRESH_BATCH,
  yieldFn: async () => { yields++; },
  onOtherError: () => { written.push("error-handler"); },
});
assert.equal(calls.includes("98:1"), false, "must not refresh case 98");
assert.equal(calls.includes("50:2"), false, "must not refresh generation 263");
assert.deepEqual(calls, ["17:9", "219:245", "224:250"]);
assert.equal(stats.missed, 1);
assert.equal(stats.skipped, 2);
assert.equal(stats.attempted, 3);
assert.ok(yields >= 1, "must yield between batches");
assert.equal(written.length, 0);
assert.equal(signatureRefreshSkipSize(), 1);
ok("queue skips protected targets, backs off misses, yields, no row writes");

const calls2 = [];
const stats2 = await runSignatureRefreshQueue(items, async (item) => {
  calls2.push(`${item.applicationId}:${item.documentId}`);
}, { now: t0 + 60_000, yieldFn: async () => {} });
assert.deepEqual(calls2, ["219:245", "224:250"], "rejected/missing doc is not retried during backoff");
assert.equal(stats2.skipped, 3); // 98, 263, and 17
ok("second tick does not re-call missing docs");

console.log(`signature-refresh-backoff fixture: ${passed} checks passed`);
