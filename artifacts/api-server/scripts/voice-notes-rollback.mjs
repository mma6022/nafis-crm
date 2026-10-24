// Rollback for scripts/voice-notes-migrate.mjs: drops voice_note_transcriptions (usage log only — no audio, no text).
// Its rows are exported to JSON and the DB is backed up (VACUUM INTO + integrity_check) first.
//
//   node scripts/voice-notes-rollback.mjs --db /path/to/customers.db             # dry run (default): counts rows
//   node scripts/voice-notes-rollback.mjs --db /path/to/customers.db --apply     # backup + JSON export, then DROP TABLE
//   optional: --backup /path/to/backup.db  --export /path/to/voice-notes.json
//
// Turn the feature off first (STT_ENABLED unset/0) or deploy the previous build: an enabled server re-creates the table
// on the next transcription. Notes already saved with transcribed text are ordinary notes and are not touched.
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tableState } from "./voice-notes-migrate.mjs";

const quote = (s) => s.replace(/'/g, "''");
export function planTableRollback(db) {
  return tableState(db).map((t) => ({ ...t, rows: t.present ? Number(db.prepare(`SELECT count(*) n FROM ${t.table}`).get().n) : 0 }));
}
export function exportData(db) {
  const out = {};
  for (const t of tableState(db)) if (t.present) out[`table ${t.table}`] = db.prepare(`SELECT * FROM ${t.table} ORDER BY id`).all();
  return out;
}
export function backup(db, target) {
  if (existsSync(target)) throw new Error(`backup target exists: ${target}`);
  db.exec(`VACUUM INTO '${quote(target)}'`);
  const b = new DatabaseSync(target, { readOnly: true });
  try {
    if (Object.values(b.prepare("PRAGMA integrity_check").get())[0] !== "ok") throw new Error("backup integrity_check failed");
    for (const t of tableState(db)) if (t.present && b.prepare(`SELECT count(*) n FROM ${t.table}`).get().n !== db.prepare(`SELECT count(*) n FROM ${t.table}`).get().n)
      throw new Error(`backup row count mismatch: ${t.table}`);
  } finally { b.close(); }
}
export function applyRollback(db) {
  const dropped = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const t of tableState(db)) { if (!t.present) continue; db.exec(`DROP TABLE ${t.table}`); dropped.push(`table ${t.table}`); }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  if (Object.values(db.prepare("PRAGMA integrity_check").get())[0] !== "ok") throw new Error("integrity_check failed after rollback");
  return { applied: dropped.length > 0, dropped };
}

if (process.argv[1] && path.basename(process.argv[1]) === "voice-notes-rollback.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: voice-notes-rollback.mjs --db <path> [--apply] [--backup <path>] [--export <path>]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const tables = planTableRollback(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", tables }, null, 2));
  const present = tables.filter((t) => t.present);
  if (!apply) { console.log(present.length ? "Dry run: nothing written. Re-run with --apply to back up, export and drop the table." : "Dry run: nothing to roll back."); process.exit(0); }
  if (!present.length) { console.log("Nothing to roll back."); process.exit(0); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = val("--backup") ?? `${dbPath}.bak-voice-notes-rollback-${stamp}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const exportPath = val("--export") ?? `${dbPath}.voice-notes-${stamp}.json`;
  const data = exportData(db);
  writeFileSync(exportPath, JSON.stringify(data, null, 2));
  console.log(`Exported ${Object.values(data).reduce((n, r) => n + r.length, 0)} row(s): ${exportPath}`);
  console.log(JSON.stringify(applyRollback(db)));
  db.close();
}
