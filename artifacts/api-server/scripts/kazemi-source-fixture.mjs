// crm-kazemi-source fixture: «از کاظمی» / «مشتری قبلی» label + «منبع» filter on a throwaway DB copy.
// Never touches live; sends nothing; display-only feature (no writes by the code under test).
// Usage: KAZEMI_SOURCE_FIXTURE_DB=/path/to/copy-source.db [KAZEMI_SOURCE_EXPECT=7/471] \
//        node scripts/run-bundled-fixture.mjs scripts/kazemi-source-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const src = process.env.KAZEMI_SOURCE_FIXTURE_DB;
if (!src) { console.log("SKIP (set KAZEMI_SOURCE_FIXTURE_DB to a DB copy)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kzsrc-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
const sha = () => crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex");
const srcHash = sha();
try {
  const db = await import("../src/lib/crm-db.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const kz = await import("../src/lib/kazemi-source.ts");
  ts.ensureTeamSalesSchema();
  const K = kz.kazemiSalespersonId();
  const filterIds = (source) => {
    const f = kz.kazemiSourceFilterSql(source);
    return f ? db.queryRows(`SELECT c.id FROM customers c WHERE c.merged_into_customer_id IS NULL AND ${f.sql} ORDER BY c.id`, f.params).map((r) => Number(r.id)) : null;
  };
  const allIds = () => db.queryRows("SELECT id FROM customers WHERE merged_into_customer_id IS NULL ORDER BY id").map((r) => Number(r.id));
  const owner = (id) => db.queryRow("SELECT salesperson_id FROM customers WHERE id=?", [id])?.salesperson_id ?? null;

  await ok("qualifier = team-sales qualifierSalespersonId (Kazemi, 6)", () => assert.equal(K, 6));

  /* ---------- A. the real data as copied (read-only behaviour) ---------- */
  const fp = () => db.queryRow("SELECT (SELECT count(*) FROM customers) n, (SELECT group_concat(id||':'||IFNULL(salesperson_id,'')||':'||IFNULL(priority,''), ',') FROM customers) o, (SELECT count(*) FROM customer_priority_history) h, (SELECT IFNULL(group_concat(key||'='||value),'') FROM notification_settings WHERE key LIKE 'team_sales%') s");
  const before = fp();
  const labels = kz.kazemiSources(allIds());
  const from = [...labels].filter(([, v]) => v.kind === "from_kazemi").map(([id]) => id).sort((a, b) => a - b);
  const prev = [...labels].filter(([, v]) => v.kind === "previous").map(([id]) => id).sort((a, b) => a - b);
  console.log(`  copy: from_kazemi=${from.length} previous=${prev.length} [${from.join(",")}]`);
  await ok("«منبع» SQL filter returns exactly the helper's labels", () => {
    assert.deepEqual(filterIds("from_kazemi"), from);
    assert.deepEqual(filterIds("previous"), prev);
    assert.equal(kz.kazemiSourceFilterSql(""), null); assert.equal(kz.kazemiSourceFilterSql("all"), null); assert.equal(kz.kazemiSourceFilterSql(["previous"]), null);
  });
  await ok("Kazemi-owned and unassigned customers never get a chip", () => {
    for (const [id] of labels) { const o = owner(id); assert.ok(o != null && Number(o) !== K, `#${id}`); }
    const kzOwned = db.queryRow("SELECT count(*) n FROM customers WHERE merged_into_customer_id IS NULL AND salesperson_id=?", [K]).n;
    const unassigned = db.queryRow("SELECT count(*) n FROM customers WHERE merged_into_customer_id IS NULL AND salesperson_id IS NULL").n;
    assert.equal(labels.size + kzOwned + unassigned, allIds().length);
  });
  await ok("the 848 bulk move to Kazemi alone never makes anyone «از کاظمی»", () => {
    const bulkOnly = db.queryRows(`SELECT s.customer_id id FROM team_sales_transfer_snapshot s WHERE s.new_salesperson_id=? AND s.rolled_back_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM customer_priority_history h WHERE h.customer_id=s.customer_id AND h.old_salesperson_id=?)`, [K, K]).map((r) => Number(r.id));
    assert.ok(bulkOnly.length > 800, `bulk rows ${bulkOnly.length}`);
    for (const id of bulkOnly) assert.notEqual(labels.get(id)?.kind, "from_kazemi", `#${id}`);
  });
  await ok("#181 and #649 are «مشتری قبلی» (if present and not with Kazemi)", () => {
    for (const id of [181, 649]) { const o = owner(id); if (o == null || Number(o) === K) continue; assert.equal(labels.get(id)?.kind, "previous", `#${id}`); }
  });
  if (process.env.KAZEMI_SOURCE_EXPECT) await ok(`counts match the dry run (${process.env.KAZEMI_SOURCE_EXPECT})`, () => {
    assert.equal(`${from.length}/${prev.length}`, process.env.KAZEMI_SOURCE_EXPECT);
  });
  await ok("reading labels writes nothing (ownership, priority, history, team_sales_config unchanged)", () => assert.deepEqual(fp(), before));

  /* ---------- B. synthetic cases on the throwaway copy ---------- */
  const pool = db.queryRows(`SELECT id FROM customers WHERE merged_into_customer_id IS NULL AND salesperson_id=?
    AND id NOT IN (SELECT customer_id FROM customer_priority_history) AND id NOT IN (SELECT customer_id FROM team_sales_transfer_snapshot) ORDER BY id LIMIT 9`, [K]).map((r) => Number(r.id));
  assert.equal(pool.length, 9, "need 9 untouched Kazemi customers in the copy");
  const [cQual, cPromote, cReturned, cChain, cBack, cStillK, cPrioOnly, cBulkOnly, cXKX] = pool;
  const H = (id, o, n, source, at, op = 2, np = 1) => db.execute(
    "INSERT INTO customer_priority_history (customer_id, old_priority, new_priority, old_salesperson_id, new_salesperson_id, actor_user_id, source, reason, created_at) VALUES (?,?,?,?,?,NULL,?,NULL,?)",
    [id, op, np, o, n, source, at]);
  const B = (id, prevSp, at = "2026-10-23T21:55:58.546Z") => db.execute(
    "INSERT INTO team_sales_transfer_snapshot (batch, customer_id, previous_salesperson_id, previous_priority, new_salesperson_id, backup_path, created_at) VALUES ('fixture-bulk', ?, ?, 2, ?, '/dev/null', ?)",
    [id, prevSp, K, at]);
  const setOwner = (id, sp) => db.execute("UPDATE customers SET salesperson_id=? WHERE id=?", [sp, id]);
  // P1 auto from the first-call form → Hasani
  H(cQual, K, 3, "qualifier_form", "2026-10-24T07:40:00.000Z"); setOwner(cQual, 3);
  // manual «ارتقا به اولویت ۱» → Ghasemi
  H(cPromote, K, 4, "promote", "2026-10-24T13:21:00.000Z"); setOwner(cPromote, 4);
  // Ghasemi → (bulk) Kazemi → promote back to Ghasemi = returned
  B(cReturned, 4); H(cReturned, K, 4, "promote", "2026-10-24T10:37:00.000Z"); setOwner(cReturned, 4);
  // Hasani → (bulk) Kazemi → promote to Hasani → admin moves to Ghasemi = from_kazemi, chain, not returned
  B(cChain, 3); H(cChain, K, 3, "promote", "2026-10-24T12:49:00.000Z"); H(cChain, 3, 3, "customer_update", "2026-10-24T12:50:00.000Z", 1, 1);
  db.execute("UPDATE customer_priority_history SET new_salesperson_id=4 WHERE id=(SELECT max(id) FROM customer_priority_history)"); setOwner(cChain, 4);
  // Kazemi → Ghasemi → Kheradkar → back to Kazemi = Kazemi-owned, no chip
  H(cBack, K, 4, "qualifier_form", "2026-10-24T08:00:00.000Z"); H(cBack, 4, 20, "customer_update", "2026-10-24T09:00:00.000Z", 1, 1); H(cBack, 20, K, "customer_update", "2026-10-24T09:30:00.000Z", 1, 2);
  // a priority change while with Kazemi (no owner change) = still Kazemi, no chip
  H(cStillK, K, K, "customer_update", "2026-10-24T09:00:00.000Z", 3, 2);
  // with Ghasemi, priority 3→1 only (the #649 shape) = «مشتری قبلی»
  setOwner(cPrioOnly, 4); H(cPrioOnly, 4, 4, "customer_update", "2026-10-24T11:31:00.000Z", 3, 1);
  // bulk to Kazemi then (outside history) owner set back to Hasani, e.g. a rollback = no Kazemi hand-off → «مشتری قبلی»
  B(cBulkOnly, 3); setOwner(cBulkOnly, 3);
  // Arash → Kazemi (admin edit) → Arash (promote): X→K→X via history = from_kazemi, returned
  H(cXKX, 5, K, "customer_update", "2026-10-24T05:00:00.000Z", 2, 2); H(cXKX, K, 5, "promote", "2026-10-24T06:00:00.000Z"); setOwner(cXKX, 5);

  const L = kz.kazemiSources(pool);
  await ok("P1 auto-handoff (qualifier_form) → «از کاظمی» with the hand-off date", () => {
    assert.deepEqual(L.get(cQual), { kind: "from_kazemi", handoffAt: "2026-10-24T07:40:00.000Z", mechanism: "qualifier_form", handoffToSalespersonId: 3, returned: false });
  });
  await ok("manual «ارتقا به اولویت ۱» (promote) → «از کاظمی»", () => {
    assert.equal(L.get(cPromote)?.kind, "from_kazemi"); assert.equal(L.get(cPromote)?.mechanism, "promote"); assert.equal(L.get(cPromote)?.returned, false);
  });
  await ok("X → (bulk) Kazemi → back to X → «از کاظمی», flagged returned", () => {
    assert.equal(L.get(cReturned)?.kind, "from_kazemi"); assert.equal(L.get(cReturned)?.returned, true);
  });
  await ok("X → Kazemi → X via history only → «از کاظمی», returned", () => {
    assert.equal(L.get(cXKX)?.kind, "from_kazemi"); assert.equal(L.get(cXKX)?.returned, true); assert.equal(L.get(cXKX)?.mechanism, "promote");
  });
  await ok("hand-off then admin reassignment → «از کاظمی», not returned, hand-off target kept", () => {
    const v = L.get(cChain); assert.equal(v?.kind, "from_kazemi"); assert.equal(v?.returned, false); assert.equal(v?.handoffToSalespersonId, 3); assert.equal(owner(cChain), 4);
  });
  await ok("back with Kazemi now → no chip; Kazemi priority-only change → no chip", () => {
    assert.equal(L.has(cBack), false); assert.equal(L.has(cStillK), false);
  });
  await ok("priority-only change under the same salesperson (#649 shape) → «مشتری قبلی»", () => assert.equal(L.get(cPrioOnly)?.kind, "previous"));
  await ok("bulk move to Kazemi without a Kazemi hand-off → never «از کاظمی»", () => assert.equal(L.get(cBulkOnly)?.kind, "previous"));
  await ok("filter agrees with labels for the synthetic cases", () => {
    const fk = new Set(filterIds("from_kazemi")), pv = new Set(filterIds("previous"));
    for (const id of pool) {
      const k = L.get(id)?.kind;
      assert.equal(fk.has(id), k === "from_kazemi", `#${id} from`); assert.equal(pv.has(id), k === "previous", `#${id} prev`);
    }
  });
  await ok("single-customer helper == batch helper", () => { for (const id of pool) assert.deepEqual(kz.kazemiSourceOf(id), L.get(id) ?? null); });
  await ok("source DB file untouched", () => assert.equal(sha(), srcHash));
  console.log(`${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
