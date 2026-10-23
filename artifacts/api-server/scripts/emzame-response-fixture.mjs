import assert from "node:assert/strict";
import { emzameProviderId } from "../src/lib/emzame-response.ts";
const keys = ["fileId", "id", "file_id"];
for (const body of [
  { message: "accepted", result: { file: "synthetic-id" } },
  { id: "synthetic-id" }, { fileId: "synthetic-id" }, { file_id: "synthetic-id" },
  { _id: "synthetic-id" }, { staticFileId: "synthetic-id" },
  { data: "synthetic-id" }, { result: { file: { _id: "synthetic-id" } } },
  { files: [{ id: "synthetic-id" }] }, { payload: { items: ["synthetic-id"] } },
]) assert.equal(emzameProviderId(body, keys), "synthetic-id");
for (const body of [
  null, "a message is not an ID", { message: "accepted" }, { data: { message: "accepted" } },
  { file: "" }, { error: { id: "untrusted-error-id" } },
]) assert.equal(emzameProviderId(body, keys), undefined);
const cycle = {}; cycle.result = cycle;
assert.equal(emzameProviderId(cycle, keys), undefined);
assert.equal(emzameProviderId({ result: { contract: "synthetic-contract" } }, ["contractId", "id", "contract_id"]), "synthetic-contract");
console.log("Passed real result.file response, compatible ID shapes, arrays, contract IDs and message/error/cycle rejection.");