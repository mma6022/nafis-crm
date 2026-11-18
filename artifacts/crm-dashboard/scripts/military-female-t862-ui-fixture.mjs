// t862 (Mohammad t862s2908): «خانم» chip for «پایان خدمت» on the customer file; site answer «خانم» labelled and prefilled.
// Pure helpers only. No network, no live DB.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The dashboard sources use extensionless imports: bundle the three helper modules (react-query stays external).
const here = path.dirname(fileURLToPath(import.meta.url));
const { build } = createRequire(path.resolve(here, "../../api-server/package.json"))("esbuild");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t862-ui-"));
const out = path.join(tmp, "helpers.mjs");
await build({
  stdin: { contents: `export * from "./src/features/daily-customer-inline/file-dossier";
export { sitePrefill, siteHints } from "./src/features/site-answers/prefill";
export { saText } from "./src/features/site-answers/api";`, resolveDir: path.resolve(here, ".."), loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", external: ["@tanstack/react-query", "react"],
});
fs.symlinkSync(path.resolve(here, "../node_modules"), path.join(tmp, "node_modules"));
const { MILITARY_FA, MILITARY_OPTS, emptyFile, fileComplete, fileKvRows, sitePrefill, siteHints, saText } = await import(pathToFileURL(out).href);

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };
const base = {
  ...emptyFile(), city: "تهران", amount: "150000000", amount_range: "300m_500m", job_status: "self_employed",
  documents: ["sayadi_cheque"], has_military_card: "female", can_refer_retiree: "no",
  has_bounced_or_overdue: "no", need_timing: "this_month", credit_rank: "B3",
};

ok("file chip offers «خانم» next to «مشمول نیست» and «ندارد» (old chips unchanged, same order)", () => {
  assert.deepEqual(MILITARY_OPTS, [["yes", "دارد"], ["no", "ندارد"], ["not_applicable", "مشمول نیست"], ["female", "خانم"]]);
  assert.equal(MILITARY_FA.female, "خانم");
});
ok("a file with «خانم» is complete and shows «پایان خدمت: خانم»", () => {
  assert.equal(fileComplete(base), true);
  const row = fileKvRows(base, true).find((r) => r.key === "has_military_card");
  assert.equal(row?.value, "خانم");
  for (const [v, l] of [["yes", "دارد"], ["no", "ندارد"], ["not_applicable", "مشمول نیست"]])
    assert.equal(fileKvRows({ ...base, has_military_card: v }, true).find((r) => r.key === "has_military_card")?.value, l);
});
ok("site answer «خانم»: labelled, prefills «مشتری خانم است», no «مشمول نیستم» hint", () => {
  const a = { amount_range: null, loan_purpose: null, job_status: null, documents: [], has_military_card: "female",
    can_refer_retiree: null, has_bounced_or_overdue: null, need_timing: null };
  assert.equal(saText("has_military_card", "female"), "خانم");
  assert.equal(sitePrefill(a).military, "female");
  assert.equal(siteHints(a).military, undefined);
  assert.equal(sitePrefill({ ...a, has_military_card: "no" }).military, "no_card");
  assert.equal(sitePrefill({ ...a, has_military_card: "not_applicable" }).military, undefined);
  assert.ok(siteHints({ ...a, has_military_card: "not_applicable" }).military);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`t862 UI fixture: ${passed}/3 passed`);
