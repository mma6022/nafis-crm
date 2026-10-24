// Additive migration for crm-voice-notes (voice-to-text for sales notes, behind STT_ENABLED, default OFF).
//
//   node scripts/voice-notes-migrate.mjs --db /path/to/customers.db            # dry run (default): reports what would change
//   node scripts/voice-notes-migrate.mjs --db /path/to/customers.db --apply    # creates the table (idempotent)
//
// Only change: one new, empty table + two indexes. No existing table or row is touched.
//   voice_note_transcriptions   one row per transcription attempt: user id/name/role, field, provider, model,
//                               audio seconds/bytes, mime, ok, error code, Tehran day, Jalali month, created_at.
//                               It never holds audio or transcript text.
// The server also creates it on first use (ensureVoiceNotesSchema in src/lib/voice-notes-core.ts — same DDL; the
// fixture checks they match). Older code never reads it. Undo: scripts/voice-notes-rollback.mjs.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

export const TABLES = [
  { table: "voice_note_transcriptions", ddl: `
    CREATE TABLE IF NOT EXISTS voice_note_transcriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_name TEXT,
      role TEXT NOT NULL,
      field TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      audio_seconds REAL NOT NULL DEFAULT 0,
      audio_bytes INTEGER NOT NULL DEFAULT 0,
      mime TEXT,
      ok INTEGER NOT NULL,
      error_code TEXT,
      day_tehran TEXT NOT NULL,
      month_jalali TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_note_transcriptions_user_day ON voice_note_transcriptions(user_id, day_tehran);
    CREATE INDEX IF NOT EXISTS idx_voice_note_transcriptions_month ON voice_note_transcriptions(month_jalali);` },
];

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
export function tableState(db) { return TABLES.map(({ table }) => ({ table, present: hasTable(db, table) })); }

export function migrate(db) {
  const added = []; const skipped = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const t of TABLES) {
      if (hasTable(db, t.table)) { skipped.push(`${t.table} (table already present)`); continue; }
      db.exec(t.ddl);
      added.push(`table ${t.table}`);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { applied: added.length > 0, added, skipped };
}

if (process.argv[1] && path.basename(process.argv[1]) === "voice-notes-migrate.mjs") {
  const args = process.argv.slice(2);
  const i = args.indexOf("--db"); const dbPath = i >= 0 ? args[i + 1] : undefined; const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: voice-notes-migrate.mjs --db <path> [--apply]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const tables = tableState(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", tables }, null, 2));
  const todo = tables.filter((t) => !t.present).map((t) => `table ${t.table}`);
  if (!apply) { console.log(todo.length ? `Dry run: would add ${todo.join(", ")}. Re-run with --apply.` : "Dry run: nothing to do."); process.exit(0); }
  console.log(JSON.stringify(migrate(db)));
  db.close();
}
