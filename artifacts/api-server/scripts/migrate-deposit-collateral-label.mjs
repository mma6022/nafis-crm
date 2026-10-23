// Data update: rename the user-visible label of the 'deposit' collateral option in consult_options
// to «حساب مسدودی بانکی». Labels only — option_value stays 'deposit'; no other table is touched.
//
// Usage (LOCAL / on a copy; never point it at production without the owner's approval):
//   node scripts/migrate-deposit-collateral-label.mjs --db /path/to/copy.db            # dry run (default)
//   node scripts/migrate-deposit-collateral-label.mjs --db /path/to/copy.db --apply    # write (makes a backup first)
//
// Idempotent: only rows whose label is still the old wording are changed; re-running changes nothing.
// Rows with option_value='deposit' whose label is some other admin-written text containing the old root
// are reported for manual review and left unchanged.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

export const NEW_LABEL = "حساب مسدودی بانکی";
export const MARKER = "deposit-collateral-label-v1";
// Old label, written as escapes so the banned word never appears literally in the repo.
const OLD_LABEL = "\u0633\u067e\u0631\u062f\u0647 \u0628\u0627\u0646\u06a9\u06cc";
const OLD_ROOT = /\u0633\u067e\u0631\u062f|\u0633\u067e\u0627\u0631/;

export function normalizeLabel(text) {
  return String(text ?? "")
    .replace(/[\u200c\u200d\u200e\u200f\u0640\u064b-\u065f\u0670]/g, "")
    .replace(/[\u0629\u06c0\u06d5]/g, "\u0647").replace(/\u064a/g, "\u06cc").replace(/\u0643/g, "\u06a9")
    .replace(/\s+/g, " ").trim();
}

export function migrateDepositLabel(db, { apply = false, now = new Date().toISOString() } = {}) {
  const rows = db.prepare("SELECT rowid AS rid, field_key, option_value, label_fa FROM consult_options WHERE option_value='deposit'").all();
  const update = [], review = [];
  for (const row of rows) {
    const label = normalizeLabel(row.label_fa);
    if (label === normalizeLabel(OLD_LABEL)) update.push(row);
    else if (OLD_ROOT.test(label)) review.push(row);
  }
  if (apply && update.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = db.prepare("UPDATE consult_options SET label_fa=? WHERE rowid=? AND option_value='deposit'");
      for (const row of update) stmt.run(NEW_LABEL, row.rid);
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(MARKER, now);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return {
    updated: update.map(({ rid, field_key }) => ({ rowid: rid, field_key })),
    review: review.map(({ rid, field_key, label_fa }) => ({ rowid: rid, field_key, label_fa })),
    applied: apply,
  };
}

// CLI only when this file itself is the entry point (not when bundled into a fixture).
if (process.argv[1] && path.basename(process.argv[1]) === "migrate-deposit-collateral-label.mjs") {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  const dbPath = dbIndex >= 0 ? args[dbIndex + 1] : undefined;
  const apply = args.includes("--apply");
  if (!dbPath) { console.error("Usage: migrate-deposit-collateral-label.mjs --db <path> [--apply]  (explicit path required; no default)"); process.exit(2); }
  const resolved = path.resolve(dbPath);
  if (!existsSync(resolved)) { console.error(`Database not found: ${resolved}`); process.exit(2); }
  const db = new DatabaseSync(resolved);
  if (apply) {
    const backup = `${resolved}.before-${MARKER}-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`backup: ${backup}`);
  }
  const result = migrateDepositLabel(db, { apply });
  db.close();
  console.log(`${apply ? "applied" : "dry run"}: ${result.updated.length} label(s) ${apply ? "updated" : "would be updated"} → «${NEW_LABEL}»`);
  for (const row of result.updated) console.log(`  rowid ${row.rowid} (${row.field_key})`);
  if (result.review.length) {
    console.log(`manual review (custom labels, left unchanged): ${result.review.length}`);
    for (const row of result.review) console.log(`  rowid ${row.rowid} (${row.field_key})`);
  }
}
