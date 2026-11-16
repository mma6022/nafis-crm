import assert from "node:assert/strict";
import test from "node:test";
import { textContainsUnambiguousPrincipal } from "../src/lib/contract-evidence.ts";

test("principal amount remains delimited by PDF bidi embeddings", () => {
  const extracted = "مبلغ اصل تسهیلات\u202a 173819273\u202cتومان";
  assert.equal(textContainsUnambiguousPrincipal(extracted, "173819273"), true);
});