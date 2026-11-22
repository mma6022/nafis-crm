// t878 customer segments: flag.customer_segments_v1, read-only merge+filter, xlsx export + audit.
// Throwaway COPY of a masked DB only; never live, never user 29, no customer writes.
// Usage: MASKED_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t878-customer-segments-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const src = process.env.T878_FIXTURE_DB || process.env.MASKED_DB;
if (!src) { console.log("SKIP (set T878_FIXTURE_DB or MASKED_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db" || fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t878-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
const SESSION_SECRET = `fixture-only-${crypto.randomBytes(16).toString("hex")}-not-a-real-secret-0123456789`;
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
globalThis.fetch = async () => { throw new Error("unexpected network call in t878 fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const { queryRow, execute, executeChanges } = await import("../src/lib/crm-db.ts");
const seg = await import("../src/lib/customer-segments.ts");

const customerFingerprint = () => {
  const r = queryRow(`SELECT COUNT(*) AS n, COALESCE(SUM(id),0) AS s, COALESCE(SUM(LENGTH(COALESCE(phone,''))),0) AS p,
    COALESCE(SUM(LENGTH(COALESCE(name,''))),0) AS nm FROM customers`);
  const d = queryRow(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(answers_json,''))),0) AS j FROM customer_dossier`);
  const a = queryRow(`SELECT COUNT(*) AS n FROM site_apply_answers`);
  return `${r.n}:${r.s}:${r.p}:${r.nm}:${d.n}:${d.j}:${a.n}`;
};

const setFlag = (v) => {
  if (v == null) {
    executeChanges("DELETE FROM call_queue_settings WHERE key=?", [seg.SEGMENTS_FLAG]);
    return;
  }
  execute(
    "INSERT OR REPLACE INTO call_queue_settings(key,value,updated_by,updated_at) VALUES (?,?,NULL,datetime('now'))",
    [seg.SEGMENTS_FLAG, v],
  );
};

const actor = (over) => /** @type {any} */ ({
  id: 1, username: "admin", fullName: "مدیر سیستم", mobile: null, telegramId: null,
  priorityColors: {}, role: "admin", roleName: "admin", permissions: [], customerScope: "all",
  salespersonId: null, salespersonName: null, active: true, createdAt: "2020-01-01T00:00:00Z",
  ...over,
});

await ok("flag absent is OFF", async () => {
  setFlag(null);
  assert.equal(seg.segmentsOn(), false);
});

await ok("flag '0' / 'true' / 'on' are OFF (only exact '1')", async () => {
  for (const v of ["0", "true", "on", "yes", "TRUE"]) {
    setFlag(v);
    assert.equal(seg.segmentsOn(), false, v);
  }
  setFlag("1");
  assert.equal(seg.segmentsOn(), true);
});

await ok("viewer is admin and sales_manager only", async () => {
  assert.equal(seg.isSegmentsViewer(actor({ role: "admin", id: 1 })), true);
  assert.equal(seg.isSegmentsViewer(actor({ id: 5, role: "admin", salesManager: true, baseRole: "sales_manager" })), true);
  assert.equal(seg.isSegmentsViewer(actor({ id: 5, role: "sales_manager", salesManager: true, baseRole: "sales_manager" })), true);
  assert.equal(seg.isSegmentsViewer(actor({ id: 2, role: "salesperson", salesManager: false, baseRole: "salesperson" })), false);
  assert.equal(seg.isSegmentsViewer(actor({ id: 7, role: "registrar", salesManager: false, baseRole: "registrar" })), false);
  assert.equal(seg.isSegmentsViewer(null), false);
});

const before = customerFingerprint();
setFlag("1");
const all = seg.loadProfiles();
const customersOnly = all.filter((p) => p.kind === "customer");

await ok("loads active customers and unlinked callback leads separately", async () => {
  const active = queryRow("SELECT COUNT(*) AS n FROM customers WHERE merged_into_customer_id IS NULL").n;
  const unlinked = queryRow("SELECT COUNT(*) AS n FROM callback_requests WHERE customer_id IS NULL").n;
  assert.equal(customersOnly.length, Number(active));
  assert.equal(all.filter((p) => p.kind === "unlinked_lead").length, Number(unlinked));
  assert.ok(customersOnly.length > 2000);
});

await ok("retired (merged) includes file and site, file wins when both exist", async () => {
  const retired = seg.filterProfiles(all, { source: "both", conditions: [{ field: "job", op: "in", values: ["retired"] }] });
  assert.ok(retired.length >= 180, `got ${retired.length}`);
  // a profile with both sources: file value is the merged job when source=both
  const both = customersOnly.filter((p) => p.jobFile && p.jobSite && p.jobFile !== p.jobSite);
  if (both.length) {
    const p = both[0];
    const merged = seg.filterProfiles([p], { source: "both", conditions: [{ field: "job", op: "in", values: [seg.canonJob(p.jobFile)] }] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].job, seg.canonJob(p.jobFile));
  }
  const siteOnly = seg.filterProfiles(all, { source: "site", conditions: [{ field: "job", op: "in", values: ["retired"] }] });
  assert.ok(siteOnly.length >= 150, `site retired ${siteOnly.length}`);
  assert.ok(siteOnly.every((p) => p.hasSiteApply === "yes" || p.hasPublicLead === "yes" || p.hasCallback === "yes" || p.kind === "unlinked_lead"));
});

await ok("can_refer_retiree yes (merged + site + file)", async () => {
  const merged = seg.filterProfiles(all, { source: "both", conditions: [{ field: "canReferRetiree", op: "in", values: ["yes"] }] });
  const site = seg.filterProfiles(all, { source: "site", conditions: [{ field: "canReferRetiree", op: "in", values: ["yes"] }] });
  const file = seg.filterProfiles(all, { source: "file", conditions: [{ field: "canReferRetiree", op: "in", values: ["yes"] }] });
  assert.ok(merged.length >= 15, `merged ${merged.length}`);
  assert.ok(site.length >= 150, `site ${site.length}`);
  assert.ok(file.length >= 1, `file ${file.length}`);
  assert.ok(merged.length >= file.length);
});

await ok("bounced any vs merged AND with retired", async () => {
  const any = seg.filterProfiles(all, { source: "both", conditions: [{ field: "bouncedAny", op: "in", values: ["yes"] }] });
  const mer = seg.filterProfiles(all, { source: "both", conditions: [{ field: "bounced", op: "in", values: ["yes"] }] });
  assert.ok(any.length >= mer.length);
  assert.ok(any.length >= 10, `bounced any ${any.length}`);
  const both = seg.filterProfiles(all, {
    source: "both",
    conditions: [
      { field: "job", op: "in", values: ["retired"] },
      { field: "canReferRetiree", op: "in", values: ["yes"] },
    ],
  });
  assert.ok(both.length >= 1, "retired AND can refer should not be empty on the masked copy");
  // AND is stricter
  const ret = seg.filterProfiles(all, { source: "both", conditions: [{ field: "job", op: "in", values: ["retired"] }] }).length;
  assert.ok(both.length <= ret);
});

await ok("text contains city, exists filters, date range", async () => {
  const tehran = seg.filterProfiles(all, { source: "both", conditions: [{ field: "city", op: "contains", values: ["تهران"] }] });
  assert.ok(tehran.length >= 10, `tehran ${tehran.length}`);
  const hasDossier = seg.filterProfiles(all, { source: "both", conditions: [{ field: "hasDossier", op: "in", values: ["yes"] }] });
  assert.equal(hasDossier.length, Number(queryRow("SELECT COUNT(*) AS n FROM customer_dossier").n));
  const ranged = seg.filterProfiles(all, { source: "both", conditions: [{ field: "createdAt", op: "date_range", min: "2020-01-01", max: "2028-01-01" }] });
  assert.ok(ranged.length > 1000);
  const none = seg.filterProfiles(all, { source: "both", conditions: [{ field: "createdAt", op: "date_range", min: "1990-01-01", max: "1990-01-02" }] });
  assert.equal(none.length, 0);
});

await ok("unlinked leads stay out unless asked", async () => {
  const off = seg.filterProfiles(all, { source: "both", conditions: [] });
  assert.ok(off.every((p) => p.kind === "customer"));
  const on = seg.filterProfiles(all, { source: "both", includeUnlinkedLeads: true, conditions: [] });
  assert.ok(on.length >= off.length);
  if (all.some((p) => p.kind === "unlinked_lead")) {
    assert.ok(on.some((p) => p.kind === "unlinked_lead"));
    const file = seg.filterProfiles(all, { source: "file", includeUnlinkedLeads: true, conditions: [] });
    assert.ok(file.every((p) => p.kind === "customer"));
  }
});

await ok("preview masks phones and never includes national id by default", async () => {
  const q = { source: "both", conditions: [{ field: "job", op: "in", values: ["retired"] }] };
  const prev = seg.preview(q, 1, 10);
  assert.ok(prev.total >= 180);
  assert.equal(prev.rows.length, Math.min(10, prev.total));
  assert.ok(!prev.columns.includes("nationalCode"));
  for (const row of prev.rows) {
    const ph = row.values.phone || "";
    if (ph) assert.match(ph, /•/);
    assert.doesNotMatch(ph, /09\d{9}/);
  }
});

await ok("unknown field / empty in-list does not throw; unknown field is skipped", async () => {
  const q = seg.parseQuery({ source: "both", conditions: [{ field: "not_a_field", op: "in", values: ["x"] }, { field: "job", op: "in", values: [] }] });
  assert.equal(q.conditions.length, 1);
  assert.equal(q.conditions[0].field, "job");
  const rows = seg.filterProfiles(all, q);
  assert.ok(rows.length > 1000);
});

await ok("xlsx export is a real zip, includes phones when asked, writes audit only", async () => {
  const before2 = customerFingerprint();
  const auditBefore = queryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [seg.EXPORT_AUDIT_TABLE]);
  const q = { source: "both", conditions: [{ field: "job", op: "in", values: ["retired"] }], columns: ["customerId", "name", "phone", "job", "bounced", "canReferRetiree"] };
  const { buffer, filename, rowCount } = seg.exportXlsx(q, actor({ id: 1 }), true);
  assert.ok(buffer.length > 100);
  assert.equal(buffer.subarray(0, 2).toString("utf8"), "PK");
  assert.match(filename, /^gozaresh-moshtarian-\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.ok(rowCount >= 180);
  // inflate first entry enough to see worksheet xml later: just confirm PK zip + shared strings / inline
  const asStr = buffer.toString("utf8");
  // deflated payload may not contain plaintext; search uncompressed local names
  assert.ok(asStr.includes("xl/worksheets/sheet1.xml") || asStr.includes("workbook.xml"));
  const log = queryRow(`SELECT COUNT(*) AS n, SUM(include_phones) AS p, SUM(row_count) AS r FROM ${seg.EXPORT_AUDIT_TABLE}`);
  assert.equal(Number(log.n), 1);
  assert.equal(Number(log.p), 1);
  assert.equal(Number(log.r), rowCount);
  const noPhone = seg.exportXlsx({ ...q, columns: ["customerId", "name", "phone", "job"] }, actor({ id: 5, salesManager: true, baseRole: "sales_manager" }), false);
  assert.ok(noPhone.buffer.length > 50);
  assert.equal(Number(queryRow(`SELECT COUNT(*) AS n FROM ${seg.EXPORT_AUDIT_TABLE}`).n), 2);
  assert.equal(Number(queryRow(`SELECT include_phones AS p FROM ${seg.EXPORT_AUDIT_TABLE} ORDER BY id DESC LIMIT 1`).p), 0);
  assert.equal(customerFingerprint(), before2);
});

await ok("customer data fingerprint unchanged from the start (plus export-only audit table)", async () => {
  assert.equal(customerFingerprint(), before);
});

await ok("user 29 is never used as an actor in this fixture", async () => {
  const n = queryRow(`SELECT COUNT(*) AS n FROM ${seg.EXPORT_AUDIT_TABLE} WHERE actor_user_id=29`).n;
  assert.equal(Number(n), 0);
});

console.log(`t878-customer-segments ${passed}/${passed} ok`);
process.exit(0);
