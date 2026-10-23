#!/usr/bin/env node
// Make a Kazemi-only allocation program the default (all new auto-allocated leads -> salesperson 6).
// Automatic intakes (Instagram, site public leads, callback requests, portal sign-up) create customers with
// priority NULL and use the default program, so "no priority / 2 / 3 -> Kazemi" is pure data.
// Trainees (5, 19, 20) are in no item of the new program. Existing customers are not touched.
// DRY RUN by default. --apply writes; --rollback --previous-default ID restores the old default.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs, openWritable, fullBackup, QUALIFIER_SALESPERSON_ID, TRAINEE_SALESPERSON_IDS } from "./common.mjs";

const NAME = "مدل فروش تیمی — تماس اول کاظمی";
const args = parseArgs(process.argv.slice(2));
const ro = new DatabaseSync(args.db, { readOnly: true, timeout: 10000 });
const current = ro.prepare("SELECT id, name FROM allocation_programs WHERE is_default=1 AND active=1 ORDER BY id").all();
const existing = ro.prepare("SELECT id FROM allocation_programs WHERE name=? AND active=1").get(NAME);
ro.close();
const plan = args.rollback
  ? { action: "rollback", restoreDefault: Number(args.previousDefault) }
  : { action: "set", currentDefault: current, newProgram: existing ? `reuse #${existing.id}` : `create «${NAME}»`,
      items: [{ salespersonId: QUALIFIER_SALESPERSON_ID, quota: 1 }], excludedTrainees: TRAINEE_SALESPERSON_IDS };
if (!args.apply) { console.log(JSON.stringify({ mode: "dry-run", ...plan }, null, 2)); process.exit(0); }
if (args.rollback && !plan.restoreDefault) { console.error("--previous-default required"); process.exit(1); }

const bk = await fullBackup(args.db, args.backupDir || path.join(path.dirname(args.db), "backups", "team-sales"), "before-allocation-change");
const db = openWritable(args.db);
const now = new Date().toISOString();
db.exec("BEGIN IMMEDIATE");
try {
  let id;
  if (args.rollback) {
    id = plan.restoreDefault;
    if (!db.prepare("SELECT 1 FROM allocation_programs WHERE id=? AND active=1").get(id)) throw new Error("program not found");
  } else {
    id = existing ? Number(existing.id) : Number(db.prepare(`INSERT INTO allocation_programs
      (name, is_default, active, cursor_item_index, cursor_item_used, created_at, updated_at) VALUES (?,0,1,0,0,?,?)`).run(NAME, now, now).lastInsertRowid);
    db.prepare("DELETE FROM allocation_program_items WHERE program_id=?").run(id);
    db.prepare("INSERT INTO allocation_program_items (program_id, salesperson_id, quota, sort_order) VALUES (?,?,1,0)").run(id, QUALIFIER_SALESPERSON_ID);
  }
  db.prepare("UPDATE allocation_programs SET is_default=0, updated_at=? WHERE is_default=1").run(now);
  db.prepare(args.rollback ? "UPDATE allocation_programs SET is_default=1, updated_at=? WHERE id=?"
    : "UPDATE allocation_programs SET is_default=1, cursor_item_index=0, cursor_item_used=0, updated_at=? WHERE id=?").run(now, id);
  db.exec("COMMIT");
  const after = db.prepare(`SELECT p.id, p.name, p.is_default, group_concat(i.salesperson_id||'x'||i.quota) items
    FROM allocation_programs p LEFT JOIN allocation_program_items i ON i.program_id=p.id WHERE p.is_default=1 GROUP BY p.id`).all();
  console.log(JSON.stringify({ applied: plan.action, backup: bk, previousDefault: current, nowDefault: after }, null, 2));
  if (!args.rollback) console.log(`Rollback: node set-qualifier-allocation.mjs --db ${args.db} --rollback --previous-default ${current[0]?.id} --apply`);
} catch (e) { db.exec("ROLLBACK"); console.error("ABORTED, nothing changed:", e.message); process.exit(2); }
db.close();
