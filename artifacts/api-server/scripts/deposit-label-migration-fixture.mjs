// In-memory DB: consult_options DDL as used by the existing fixtures (the table predates crm-db.ts) plus the
// real seed INSERT extracted from src/lib/crm-db.ts. Simulates an existing database that still has the old
// deposit label and checks the label migration is correct and idempotent. Never touches a real DB.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrateDepositLabel, NEW_LABEL, MARKER } from "./migrate-deposit-collateral-label.mjs";

const source = readFileSync(new URL("../src/lib/crm-db.ts", import.meta.url), "utf8");
const seed = source.match(/INSERT OR IGNORE INTO consult_options \(field_key, option_value, label_fa, sort_order, active\) VALUES[\s\S]*?\);/)?.[0];
assert.ok(seed, "consult_options seed found in crm-db.ts");
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE consult_options (id INTEGER PRIMARY KEY, field_key TEXT NOT NULL, option_value TEXT NOT NULL,
  label_fa TEXT NOT NULL, sort_order INTEGER, active INTEGER, UNIQUE(field_key, option_value));
  CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
db.exec(seed);
let code = 0;
try {
  const OLD = "\u0633\u067e\u0631\u062f\u0647 \u0628\u0627\u0646\u06a9\u06cc";
  const label = (key) => db.prepare("SELECT label_fa FROM consult_options WHERE field_key=? AND option_value='deposit'").get(key)?.label_fa;

  // Fresh databases get the new label from the seed.
  assert.equal(label("collateral_type"), NEW_LABEL);
  assert.equal(migrateDepositLabel(db, { apply: true }).updated.length, 0, "fresh DB needs nothing");

  // Simulate an existing database: old label, a ZWNJ/Arabic-letter variant under another field, a custom label.
  db.prepare("UPDATE consult_options SET label_fa=? WHERE field_key='collateral_type' AND option_value='deposit'").run(OLD);
  db.prepare("INSERT INTO consult_options(field_key,option_value,label_fa,sort_order,active) VALUES ('guarantor_collateral_type','deposit',?,8,1)")
    .run("\u0633\u067e\u0631\u062f\u0629\u200c  \u0628\u0627\u0646\u0643\u064a");
  db.prepare("INSERT INTO consult_options(field_key,option_value,label_fa,sort_order,active) VALUES ('custom_field','deposit',?,1,1)")
    .run("\u0633\u067e\u0631\u062f\u0647 \u0645\u062f\u062a\u200c\u062f\u0627\u0631");
  const others = db.prepare("SELECT field_key, option_value, label_fa FROM consult_options WHERE option_value<>'deposit' ORDER BY rowid").all();

  const dry = migrateDepositLabel(db);
  assert.equal(dry.updated.length, 2); assert.equal(dry.review.length, 1);
  assert.equal(label("collateral_type"), OLD, "dry run writes nothing");

  const first = migrateDepositLabel(db, { apply: true });
  assert.deepEqual(first.updated.map((r) => r.field_key).sort(), ["collateral_type", "guarantor_collateral_type"]);
  assert.equal(label("collateral_type"), NEW_LABEL);
  assert.equal(label("guarantor_collateral_type"), NEW_LABEL);
  assert.equal(label("custom_field"), "\u0633\u067e\u0631\u062f\u0647 \u0645\u062f\u062a\u200c\u062f\u0627\u0631", "custom label left for manual review");
  assert.equal(db.prepare("SELECT count(*) AS n FROM consult_options WHERE option_value='deposit'").get().n, 3, "keys unchanged");
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MARKER));
  assert.deepEqual(db.prepare("SELECT field_key, option_value, label_fa FROM consult_options WHERE option_value<>'deposit' ORDER BY rowid").all(), others, "other rows untouched");

  const second = migrateDepositLabel(db, { apply: true });
  assert.equal(second.updated.length, 0, "idempotent"); assert.equal(second.review.length, 1);
  console.log("deposit-label-migration: ok");
} catch (error) { console.error(error); code = 1; }
process.exit(code);
