// Release 84(A) unit fixture: release registry (site + CRM meta), time conversion, schema cut-off, seeds, loaders.
// Run: node --experimental-strip-types scripts/release-registry-fixture.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ridToDate, ridToTehran, normalizeSiteEntry, parseSiteRegistry, parseCrmMeta, loadSiteReleases, loadCrmMeta,
} from "../src/lib/release-registry.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("ridToDate strict UTC", () => {
  assert.equal(ridToDate("20261028212415").toISOString(), "2026-10-28T21:24:15.000Z");
  for (const bad of ["2026102821241", "202610282124150", "20261332000000", "20260230000000", "20261028246000", "abcd", "", null]) assert.equal(ridToDate(bad), null, String(bad));
});
t("ridToTehran = UTC+03:30, crosses midnight/month/year", () => {
  assert.equal(ridToTehran("20261028212415"), "2026-10-29 00:54:15");
  assert.equal(ridToTehran("20261031203000"), "2026-11-01 00:00:00");
  assert.equal(ridToTehran("20261231210000"), "2027-01-01 00:30:00");
  assert.equal(ridToTehran("20260922114028"), "2026-09-22 15:10:28");
  assert.equal(ridToTehran("x"), null);
});
t("normalizeSiteEntry validation", () => {
  assert.equal(normalizeSiteEntry({ rid: "20261028212415", commit: "C03D782" }).entry.commit, "c03d782");
  assert.equal(normalizeSiteEntry({ rid: "20261028212415", commit: "zz" }).error, "commit_invalid");
  assert.equal(normalizeSiteEntry({ rid: "20261028212415", branch: "a b" }).error, "branch_invalid");
  assert.equal(normalizeSiteEntry({ rid: "2026" }).error, "rid_invalid");
  assert.equal(normalizeSiteEntry([]).error, "not_object");
  const e = normalizeSiteEntry({ rid: "20261028212415", description: "x".repeat(400) + "\u0007", rollback: "  " }).entry;
  assert.equal(e.description.length, 200); assert.equal(e.rollback, null); assert.equal(e.commit, null);
});
t("parseSiteRegistry: drop invalid, keep first duplicate, newest first", () => {
  const r = parseSiteRegistry({ releases: [
    { rid: "20261001000000", description: "a" }, { rid: "20261002000000", description: "b" },
    { rid: "20261001000000", description: "dup" }, { rid: "bad" }, "str",
  ] });
  assert.deepEqual(r.releases.map((x) => x.rid), ["20261002000000", "20261001000000"]);
  assert.equal(r.releases[1].description, "a");
  assert.equal(r.errors.length, 3);
  assert.deepEqual(parseSiteRegistry({}).errors, ["releases_missing"]);
});
t("parseCrmMeta schema cut-off", () => {
  const rel = { "20261020000000": { schemaChange: "x" }, "20261025000000": { schemaChange: "y" }, "20261027000000": {} };
  assert.deepEqual([parseCrmMeta({ releases: rel }).schemaCutoff, parseCrmMeta({ releases: rel }).cutoffSource], ["20261025000000", "derived"]);
  // stale explicit cut-off must NOT re-open rollbacks
  assert.equal(parseCrmMeta({ schemaCutoff: "20261020000000", releases: rel }).schemaCutoff, "20261025000000");
  // newer explicit cut-off wins
  const ex = parseCrmMeta({ schemaCutoff: "20261027000000", releases: rel });
  assert.deepEqual([ex.schemaCutoff, ex.cutoffSource], ["20261027000000", "explicit"]);
  assert.deepEqual([parseCrmMeta({}).schemaCutoff, parseCrmMeta({}).cutoffSource], [null, "none"]);
  assert.equal(parseCrmMeta({ schemaCutoff: "junk", releases: {} }).schemaCutoff, null);
  assert.equal(parseCrmMeta({ releases: { bad: { schemaChange: "x" } } }).schemaCutoff, null);
});
t("seed site-releases.json: 23 valid rows", () => {
  const doc = JSON.parse(readFileSync(path.join(here, "../release-registry/site-releases.json"), "utf8"));
  const r = parseSiteRegistry(doc);
  assert.equal(r.errors.length, 0, r.errors.join(","));
  assert.equal(r.releases.length, 23);
  for (const e of r.releases) { assert.ok(e.description, e.rid); assert.ok(ridToTehran(e.rid)); }
  assert.equal(r.releases[0].rid, "20261028212415");
  assert.equal(r.releases[r.releases.length - 1].rollback === null || typeof r.releases.at(-1).rollback === "string", true);
});
t("seed crm-releases-meta.json: cut-off = 20261028211337", () => {
  const doc = JSON.parse(readFileSync(path.join(here, "../release-registry/crm-releases-meta.json"), "utf8"));
  const m = parseCrmMeta(doc);
  assert.equal(m.schemaCutoff, "20261028211337");
  assert.ok(Object.keys(m.releases).length >= 60);
});

const tmp = mkdtempSync(path.join(tmpdir(), "relreg-"));
try {
  process.env.NAFISVAM_RELEASE_REGISTRY_DIR = path.join(tmp, "reg");
  process.env.NAFISVAM_SITE_ROOT = path.join(tmp, "site");
  mkdirSync(path.join(tmp, "reg")); mkdirSync(path.join(tmp, "site", "releases", "20261028212415"), { recursive: true });
  symlinkSync(path.join(tmp, "site", "releases", "20261028212415"), path.join(tmp, "site", "current"));
  const missingSite = await loadSiteReleases();
  assert.deepEqual(missingSite, { available: false, reason: "missing" }); n++; console.log("ok - loadSiteReleases missing file fails soft");
  const missingCrm = await loadCrmMeta();
  assert.equal(missingCrm.available, false); assert.equal(missingCrm.schemaCutoff, null); n++; console.log("ok - loadCrmMeta missing file -> cut-off null");
  writeFileSync(path.join(tmp, "reg", "site-releases.json"), "{not json");
  assert.equal((await loadSiteReleases()).reason, "invalid_json"); n++; console.log("ok - invalid json fails soft");
  writeFileSync(path.join(tmp, "reg", "site-releases.json"), JSON.stringify({ releases: [
    { rid: "20261028212415", commit: "c03d782", branch: "site/apply-wizard-82", description: "x" },
    { rid: "20261027000000", description: "gone" }, { rid: "nope" },
  ] }));
  const s = await loadSiteReleases();
  assert.equal(s.available, true); assert.equal(s.current, "20261028212415"); assert.equal(s.invalidRows, 1);
  assert.deepEqual(s.releases.map((r) => [r.rid, r.current, r.onDisk, r.tehran]), [
    ["20261028212415", true, true, "2026-10-29 00:54:15"], ["20261027000000", false, false, "2026-10-27 03:30:00"],
  ]); n++; console.log("ok - loadSiteReleases current/onDisk/tehran");
  writeFileSync(path.join(tmp, "reg", "crm-releases-meta.json"), JSON.stringify({ releases: { "20261028211337": { commit: "33c26f9", schemaChange: "x" } } }));
  const c = await loadCrmMeta();
  assert.deepEqual([c.available, c.schemaCutoff, c.cutoffSource], [true, "20261028211337", "derived"]); n++; console.log("ok - loadCrmMeta");
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`release-registry fixture: ${n} passed`);
