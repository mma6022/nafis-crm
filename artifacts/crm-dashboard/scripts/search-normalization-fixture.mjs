import assert from "node:assert/strict";
import { normalizePersianSearchText } from "../src/lib/search.ts";

const storedName = "علي رضايي";
for (const query of ["علي", "علی", "علي", "رضایی", "رضايي"]) {
  assert.ok(
    normalizePersianSearchText(storedName).includes(normalizePersianSearchText(query)),
    `expected query ${query} to match the stored customer name`,
  );
}
console.log("PASS: customer name filtering matches both Arabic and Persian ya variants.");
