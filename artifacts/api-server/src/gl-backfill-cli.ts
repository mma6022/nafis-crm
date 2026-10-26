/**
 * G6 operator CLI: node dist/gl-backfill-cli.mjs --db <path> [--apply] [--exclude-fee 105,127,157,175] [--retry-skipped] [--out report.json]
 * Dated exceptions: --forced-post <file> (default: gl-backfill-forced-post.json next to this file; required, append-only).
 * Default = dry-run (one transaction, rolled back). Prints ids/counts/totals only (no names, no phone numbers).
 * Package G6 guard: --apply is refused on the live database (any path under /opt/nafisvam or /var/lib, or the CRM's
 * configured DB path); applying on live needs a later, separately approved package. Run with the service stopped.
 */
import { DatabaseSync } from "node:sqlite";
import { realpathSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGlBackfill, validateForcedPostList } from "./lib/gl-backfill";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }
const flag = (name: string) => process.argv.includes(name);
const dbPath = arg("--db");
if (!dbPath || !existsSync(dbPath)) { console.error("usage: gl-backfill-cli --db <path> [--apply] [--exclude-fee ids] [--retry-skipped] [--out file]"); process.exit(2); }
const real = realpathSync(dbPath);
const configured = ["CRM_DB_PATH", "DATABASE_PATH", "DB_PATH", "SQLITE_PATH"].map((k) => process.env[k]).filter(Boolean).map((p) => { try { return realpathSync(p as string); } catch { return p as string; } });
const looksLive = real.startsWith("/opt/nafisvam") || real.startsWith("/var/lib") || configured.includes(real);
const apply = flag("--apply");
if (apply && looksLive) { console.error("gl_backfill_apply_refused_on_live: G6 allows --apply only on a copy"); process.exit(3); }
const forcedFile = arg("--forced-post") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "gl-backfill-forced-post.json");
if (!existsSync(forcedFile)) { console.error("gl_forced_post_list_missing: pass --forced-post <file>"); process.exit(2); }
let forcedPost;
try { forcedPost = validateForcedPostList(JSON.parse(readFileSync(forcedFile, "utf8"))); } catch (e) { console.error(String((e as Error).message ?? e).slice(0, 200)); process.exit(2); }
const excludeFees = (arg("--exclude-fee") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
const db = new DatabaseSync(real);
db.exec("PRAGMA foreign_keys=ON"); db.exec("PRAGMA busy_timeout=5000");
try {
  const r = runGlBackfill(db, { apply, excludeFees, forcedPost, retrySkipped: flag("--retry-skipped") });
  const out = JSON.stringify(r, null, 2);
  const file = arg("--out");
  if (file) writeFileSync(file, out, { mode: 0o600 });
  console.log(JSON.stringify({ mode: r.mode, events: r.events, created: r.created, byType: r.byType, controls: r.controls, forcedPosts: r.forcedPosts, exceptions: r.exceptions.length }, null, 2));
} finally { db.close(); }
